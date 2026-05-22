import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizeArticle } from '../validators/productValidator.js'
import { transliterateToCyrillic, isLatinText } from './translitService.js'
import { fixKeyboardLayout } from './keyboardService.js'

const PRODUCTS_TABLE = 'products'

/**
 * Тип результату пошуку (ТЗ ProductSearchResult)
 */
interface SearchResult {
  id: string
  sku: string
  name: string
  barcode: string | null
  photo_url: string | null
  retail_price: number
  qty_on_hand: number
  qty_reserved: number
  qty_available: number
  unit: string
  storage_bin: string | null
  brand: { name: string } | null
  /** Яке поле знайшло товар */
  match_field: string
  /** Значення яке співпало */
  match_value: string
  /** Чи є аналоги */
  has_analogs: boolean
  /** Кількість аналогів */
  analog_count: number
}

/**
 * Пошук товарів для POS-терміналу.
 */

/**
 * Збагачує результати пошуку інформацією про аналоги.
 * Виконує один запит для всіх знайдених товарів замість N окремих.
 */
async function enrichWithAnalogs(results: SearchResult[]): Promise<SearchResult[]> {
  if (!results || results.length === 0) return results

  const productIds = results.map((r) => r.id)

  // Один запит для підрахунку аналогів для всіх товарів
  const { data: analogs, error } = await db
    .from('product_analogs')
    .select('product_id, analog_product_id')
    .in('product_id', productIds)
    .limit(1000) // достатньо для підрахунку

  if (error) { console.warn('[search] product_analogs error:', error.message); return results }

  // Підраховуємо кількість аналогів для кожного товару
  const analogCounts = new Map<string, number>()
  for (const a of analogs ?? []) {
    analogCounts.set(a.product_id, (analogCounts.get(a.product_id) ?? 0) + 1)
  }

  return results.map((r: SearchResult): SearchResult => {
    const count = analogCounts.get(r.id) ?? 0
    return {
      ...r,
      has_analogs: count > 0,
      analog_count: count,
    }
  })
}

/**
 * Збагачує результати пошуку інформацією про доступний залишок.
 * Один запит до products_available view для всіх знайдених товарів.
 */
async function enrichWithAvailability(results: SearchResult[]): Promise<SearchResult[]> {
  if (!results || results.length === 0) return results

  const productIds = results.map((r) => r.id)

  const { data: avail, error } = await db
    .from('products_available')
    .select('product_id, qty_on_hand, qty_reserved, qty_available')
    .in('product_id', productIds)

  if (error) { console.warn('[search] products_available error:', error.message); return results }

  const availMap = new Map<string, { qty_reserved: number; qty_available: number }>()
  for (const a of avail ?? []) {
    availMap.set(a.product_id, {
      qty_reserved: a.qty_reserved ?? 0,
      qty_available: a.qty_available ?? a.qty_on_hand,
    })
  }

  return results.map((r: SearchResult): SearchResult => {
    const a = availMap.get(r.id)
    return {
      ...r,
      qty_reserved: a?.qty_reserved ?? 0,
      qty_available: a?.qty_available ?? r.qty_on_hand,
    }
  })
}
export async function searchProductsForPOS(q: string, limit: number): Promise<SearchResult[]> {
  const searchTerms = [q]

  // [00] Виправлення розкладки клавіатури
  if (isLatinText(q)) {
    const fixed = fixKeyboardLayout(q)
    for (const f of fixed) {
      if (!searchTerms.includes(f)) searchTerms.push(f)
    }
  }

  // [0] Транслітерація
  if (isLatinText(q)) {
    const translit = transliterateToCyrillic(q)
    if (translit !== q.toLowerCase() && !searchTerms.includes(translit)) {
      searchTerms.push(translit)
    }
  }

  // [1] Прямий пошук по товарах
  const results = await directProductSearch(searchTerms, q, limit)
  if (results && results.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(results))

  // [2] Пошук по коду постачальника
  const supplierResults = await supplierCodeSearch(q, limit)
  if (supplierResults && supplierResults.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(supplierResults))

  // [3] Пошук по аліасах
  const aliasResults = await aliasSearch(searchTerms, q, limit)
  if (aliasResults && aliasResults.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(aliasResults))

  // [4] Пошук по додаткових штрихкодах (таблиця product_barcodes)
  const barcodeResults = await barcodeSearch(q, limit)
  if (barcodeResults && barcodeResults.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(barcodeResults))

  // [4b] Пошук по additional_barcodes JSONB колонці products
  const additionalBarcodeResults = await additionalBarcodesSearch(q, limit)
  if (additionalBarcodeResults && additionalBarcodeResults.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(additionalBarcodeResults))

  // [5] Пошук по VIN (тільки від 6 символів)
  if (q.length >= 6) {
    const vinResults = await vinSearch(q, limit)
    if (vinResults && vinResults.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(vinResults))
  }

  return []
}

/** [1] Прямий пошук по товарах (sku, name, barcode, oem_number) */
async function directProductSearch(terms: string[], originalQ: string, limit: number): Promise<SearchResult[]> {
  const conditions = terms.flatMap((t) => {
    const normalized = normalizeArticle(t)
    return [
      `sku.ilike.%${normalized}%`,
      `name.ilike.%${t}%`,
      `barcode.eq.${t}`,
      // additional_barcodes виключено з OR — JSONB contains некоректно в or() рядку
      // обробляється окремо в barcodeSearch через product_barcodes таблицю
      `normalized_oem.eq.${normalized}`,
      `oem_number.ilike.%${normalized}%`,
    ]
  })

  const orString = conditions.join(',')
  if (!orString) return []

  const { data, error } = await db
    .from(PRODUCTS_TABLE)
    .select('id, sku, name, barcode, photo_url, oem_number, retail_price, qty_on_hand, unit, storage_bin, brand:brands(name)')
    .is('deleted_at', null)
    .eq('is_active', true)
    .or(orString)
    .order('qty_on_hand', { ascending: false })
    .limit(limit)

  if (error) { console.warn('[search] directProductSearch error:', error.message); return [] }
  if (!data || data.length === 0) return []

  return data.map((p: any): SearchResult => {
    const normalized = normalizeArticle(originalQ)
    // Визначаємо яке поле співпало (в порядку пріоритету)
    if (p.barcode && normalizeArticle(p.barcode) === normalized) {
      return { ...p, match_field: 'barcode', match_value: p.barcode }
    }
    if (p.oem_number && normalizeArticle(p.oem_number) === normalized) {
      return { ...p, match_field: 'oem', match_value: p.oem_number }
    }
    if (p.sku && normalizeArticle(p.sku).includes(normalized)) {
      return { ...p, match_field: 'sku', match_value: p.sku }
    }
    if (p.name && p.name.toLowerCase().includes(originalQ.toLowerCase())) {
      return { ...p, match_field: 'name', match_value: p.name }
    }
    return { ...p, match_field: 'oem', match_value: p.oem_number ?? '' }
  })
}

/** [2] Пошук по коду постачальника (product_supplier_codes) */
async function supplierCodeSearch(code: string, limit: number): Promise<SearchResult[]> {
  const normalized = normalizeArticle(code)

  const { data: scResults, error: scError } = await db
    .from('product_supplier_codes')
    .select('product_id, supplier_code')
    .or(`supplier_code.ilike.%${normalized}%,normalized_supplier_article.eq.${normalized}`)
    .limit(limit)

  if (scError) { console.warn('[search] product_supplier_codes error:', scError.message); return [] }
  if (!scResults || scResults.length === 0) return []

  const productIds = [...new Set(scResults.map((r: any) => r.product_id))].slice(0, limit)

  const { data: products, error: prodError } = await db
    .from(PRODUCTS_TABLE)
    .select('id, sku, name, barcode, photo_url, retail_price, qty_on_hand, unit, storage_bin, brand:brands(name)')
    .is('deleted_at', null)
    .eq('is_active', true)
    .in('id', productIds)
    .order('qty_on_hand', { ascending: false })
    .limit(limit)

  if (prodError) throw new AppError('DB_ERROR', prodError.message, 500)
  if (!products || products.length === 0) return []

  const matchedCode = scResults[0]?.supplier_code ?? code
  return products.map((p: any): SearchResult => ({
    ...p,
    match_field: 'supplier',
    match_value: matchedCode,
  }))
}

/** [3] Пошук по аліасах */
async function aliasSearch(terms: string[], originalQ: string, limit: number): Promise<SearchResult[]> {
  const conditions = terms.map((t) => `alias.ilike.%${t}%`).join(',')
  if (!conditions) return []

  const { data: aliasResults, error: aliasError } = await db
    .from('product_aliases')
    .select('product_id, alias')
    .or(conditions)
    .limit(limit)

  if (aliasError) { console.warn('[search] product_aliases error:', aliasError.message); return [] }
  if (!aliasResults || aliasResults.length === 0) return []

  // Знаходимо аліас який співпав (перший по terms)
  let matchedAlias = aliasResults[0]?.alias ?? originalQ
  for (const t of terms) {
    const found = aliasResults.find((r: any) => r.alias.toLowerCase().includes(t.toLowerCase()))
    if (found) {
      matchedAlias = found.alias
      break
    }
  }

  const productIds = [...new Set(aliasResults.map((r: any) => r.product_id))].slice(0, limit)

  const { data: products, error: prodError } = await db
    .from(PRODUCTS_TABLE)
    .select('id, sku, name, barcode, photo_url, retail_price, qty_on_hand, unit, storage_bin, brand:brands(name)')
    .is('deleted_at', null)
    .eq('is_active', true)
    .in('id', productIds)
    .order('qty_on_hand', { ascending: false })
    .limit(limit)

  if (prodError) throw new AppError('DB_ERROR', prodError.message, 500)
  if (!products || products.length === 0) return []

  return products.map((p: any): SearchResult => ({
    ...p,
    match_field: 'alias',
    match_value: matchedAlias,
  }))
}

/** [4] Пошук по додаткових штрихкодах */
async function barcodeSearch(barcode: string, limit: number): Promise<SearchResult[]> {
  const { data: barcodeResults, error: bcError } = await db
    .from('product_barcodes')
    .select('product_id, barcode')
    .eq('barcode', barcode)
    .limit(limit)

  if (bcError) { console.warn('[search] product_barcodes error:', bcError.message); return [] }
  if (!barcodeResults || barcodeResults.length === 0) return []

  const productIds = [...new Set(barcodeResults.map((r: any) => r.product_id))].slice(0, limit)

  const { data: products, error: prodError } = await db
    .from(PRODUCTS_TABLE)
    .select('id, sku, name, barcode, photo_url, retail_price, qty_on_hand, unit, storage_bin, brand:brands(name)')
    .is('deleted_at', null)
    .eq('is_active', true)
    .in('id', productIds)
    .order('qty_on_hand', { ascending: false })
    .limit(limit)

  if (prodError) throw new AppError('DB_ERROR', prodError.message, 500)
  if (!products || products.length === 0) return []

  const matchedBarcode = barcodeResults[0]?.barcode ?? barcode
  return products.map((p: any): SearchResult => ({
    ...p,
    match_field: 'barcode',
    match_value: matchedBarcode,
  }))
}

/** [4b] Пошук по additional_barcodes JSONB колонці на таблиці products */
async function additionalBarcodesSearch(barcode: string, limit: number): Promise<SearchResult[]> {
  try {
    const { data, error } = await db
      .from(PRODUCTS_TABLE)
      .select('id, sku, name, barcode, photo_url, retail_price, qty_on_hand, unit, storage_bin, brand:brands(name)')
      .is('deleted_at', null)
      .eq('is_active', true)
      .contains('additional_barcodes', JSON.stringify([barcode]))
      .limit(limit)

    if (error) { console.warn('[search] additional_barcodes error:', error.message); return [] }
    if (!data || data.length === 0) return []

    return data.map((p: any): SearchResult => ({
      ...p, match_field: 'barcode', match_value: barcode,
    }))
  } catch { return [] }
}

/** [5] Пошук по VIN — знайти товари сумісні з авто */
async function vinSearch(vin: string, limit: number): Promise<SearchResult[]> {
  if (vin.length < 6) return []

  const { data: vehicles, error: vehError } = await db
    .from('customer_vehicles')
    .select('brand, model, year')
    .ilike('vin', `${vin}%`)
    .limit(5)

  if (vehError) { console.warn('[search] customer_vehicles error:', vehError.message); return [] }
  if (!vehicles || vehicles.length === 0) return []

  const productIds = new Set<string>()

  for (const v of vehicles) {
    const { data: fitments } = await db
      .from('product_fitment')
      .select('product_id')
      .eq('make', v.brand)
      .eq('model', v.model)
      .lte('year_from', v.year ?? 9999)
      .gte('year_to', v.year ?? 0)
      .limit(limit)

    for (const f of fitments ?? []) {
      productIds.add(f.product_id)
    }
  }

  if (productIds.size === 0) return []

  const ids = [...productIds].slice(0, limit)

  const { data: products, error: prodError } = await db
    .from(PRODUCTS_TABLE)
    .select('id, sku, name, barcode, photo_url, retail_price, qty_on_hand, unit, storage_bin, brand:brands(name)')
    .is('deleted_at', null)
    .eq('is_active', true)
    .in('id', ids)
    .order('qty_on_hand', { ascending: false })
    .limit(limit)

  if (prodError) throw new AppError('DB_ERROR', prodError.message, 500)
  if (!products || products.length === 0) return []

  const vehicleInfo = `${vehicles[0].brand} ${vehicles[0].model} (${vehicles[0].year ?? ''})`
  return products.map((p: any): SearchResult => ({
    ...p,
    match_field: 'vin',
    match_value: vehicleInfo,
  }))
}
