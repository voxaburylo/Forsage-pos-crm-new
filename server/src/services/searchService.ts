import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizeArticle, normalizeOemValue } from '../validators/productValidator.js'
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
  is_service: boolean
  unit: string
  storage_bin: string | null
  brand: { name: string } | null
  requires_core_return?: boolean
  core_deposit_amount?: number
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
  const [
    { data: analogs, error },
    { data: crossNumbers, error: crossError },
  ] = await Promise.all([
    db
      .from('product_analogs')
      .select('product_id, analog_product_id')
      .in('product_id', productIds)
      .limit(1000),
    db
      .from('product_cross_numbers')
      .select('product_id')
      .in('product_id', productIds)
      .limit(2000),
  ])

  if (error) logger.warn({ error: error.message }, '[search] product_analogs error')
  if (crossError) logger.warn({ error: crossError.message }, '[search] product_cross_numbers error')

  // Підраховуємо кількість аналогів для кожного товару
  const analogCounts = new Map<string, number>()
  for (const a of analogs ?? []) {
    analogCounts.set(a.product_id, (analogCounts.get(a.product_id) ?? 0) + 1)
  }
  for (const cross of crossNumbers ?? []) {
    analogCounts.set(cross.product_id, (analogCounts.get(cross.product_id) ?? 0) + 1)
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

  if (error) { logger.warn({ error: error.message }, '[search] products_available error'); return results }

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
function addCyrillicVariants(target: Set<string>, value: string) {
  const clean = value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('uk-UA')
  if (!clean) return
  target.add(clean)

  // У каталозі після імпорту одночасно є українські та російські написання.
  const russianLike = clean
    .replace(/і/g, 'и')
    .replace(/ї/g, 'й')
    .replace(/є/g, 'е')
    .replace(/ґ/g, 'г')
  target.add(russianLike)

  const simplified = clean
    .replace(/ё/g, 'е')
    .replace(/э/g, 'е')
    .replace(/ы/g, 'и')
    .replace(/ъ/g, '')
  target.add(simplified)
}

function replaceLatinTokens(text: string, converter: (token: string) => string): string {
  return text.replace(/[a-z]+/gi, (token) => converter(token))
}

export function buildProductSearchTerms(query: string): string[] {
  const terms = new Set<string>()
  addCyrillicVariants(terms, query)

  // Обробляємо латинські слова навіть усередині змішаного запиту:
  // "фільтр masla" → "фільтр масла", "колодки njhvjpf" → варіант розкладки.
  if (/[a-z]/i.test(query)) {
    addCyrillicVariants(terms, replaceLatinTokens(query, transliterateToCyrillic))
    addCyrillicVariants(terms, replaceLatinTokens(query, (token) => fixKeyboardLayout(token)[0] ?? token))
    addCyrillicVariants(terms, replaceLatinTokens(query, (token) => fixKeyboardLayout(token)[1] ?? token))
  }

  // Зберігаємо колишню поведінку для повністю латинського вводу.
  if (isLatinText(query)) {
    for (const fixed of fixKeyboardLayout(query)) addCyrillicVariants(terms, fixed)
    addCyrillicVariants(terms, transliterateToCyrillic(query))
  }

  return [...terms].filter(Boolean).slice(0, 12)
}

export async function searchProductsForPOS(q: string, limit: number, tenantId: string): Promise<SearchResult[]> {
  const cleanQuery = q.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const searchTerms = buildProductSearchTerms(cleanQuery)

  // [1] Прямий пошук по товарах
  const results = await directProductSearch(searchTerms, cleanQuery, limit, tenantId)
  const firstDirect = results?.[0]
  const directIsStrong = firstDirect && (
    firstDirect.match_field === 'barcode' ||
    firstDirect.match_field === 'name' ||
    normalizeArticle(firstDirect.sku) === normalizeArticle(cleanQuery) ||
    (firstDirect.match_field === 'oem' && normalizeArticle(firstDirect.match_value) === normalizeArticle(cleanQuery))
  )
  if (directIsStrong) return await enrichWithAvailability(await enrichWithAnalogs(results))

  // [2] Пошук по власній базі OE та крос-номерів
  const crossResults = await crossNumberSearch(cleanQuery, limit, tenantId)
  if (crossResults && crossResults.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(crossResults))

  // [3] Пошук по коду постачальника
  const supplierResults = await supplierCodeSearch(cleanQuery, limit, tenantId)
  if (supplierResults && supplierResults.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(supplierResults))

  // [4] Пошук по аліасах
  const aliasResults = await aliasSearch(searchTerms, cleanQuery, limit, tenantId)
  if (aliasResults && aliasResults.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(aliasResults))

  // [5] Пошук по додаткових штрихкодах (таблиця product_barcodes)
  const barcodeResults = await barcodeSearch(cleanQuery, limit, tenantId)
  if (barcodeResults && barcodeResults.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(barcodeResults))

  // [5b] Пошук по additional_barcodes JSONB колонці products
  const additionalBarcodeResults = await additionalBarcodesSearch(cleanQuery, limit, tenantId)
  if (additionalBarcodeResults && additionalBarcodeResults.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(additionalBarcodeResults))

  // [6] Пошук по VIN (тільки від 6 символів)
  if (cleanQuery.length >= 6) {
    const vinResults = await vinSearch(cleanQuery, limit, tenantId)
    if (vinResults && vinResults.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(vinResults))
  }

  // Частковий збіг SKU корисний як fallback, але не повинен перекривати точний
  // крос-номер, код постачальника, аліас або додатковий штрихкод.
  if (results && results.length > 0) return await enrichWithAvailability(await enrichWithAnalogs(results))
  return []
}

async function crossNumberSearch(code: string, limit: number, tenantId: string): Promise<SearchResult[]> {
  const normalized = normalizeOemValue(code)
  const { data: matches, error: matchError } = await db
    .from('product_cross_numbers')
    .select('product_id, number')
    .eq('tenant_id', tenantId)
    .ilike('normalized_number', `%${normalized}%`)
    .limit(limit)

  if (matchError) {
    logger.warn({ error: matchError.message }, '[search] product_cross_numbers error')
    return []
  }
  if (!matches || matches.length === 0) return []

  const productIds = [...new Set(matches.map((row: any) => row.product_id))].slice(0, limit)
  const { data: products, error: productError } = await db
    .from(PRODUCTS_TABLE)
    .select('id, sku, name, barcode, photo_url, retail_price, qty_on_hand, unit, storage_bin, is_service, requires_core_return, core_deposit_amount, brand:brands(name)')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .eq('is_active', true)
    .in('id', productIds)
    .order('qty_on_hand', { ascending: false })
    .limit(limit)

  if (productError) {
    logger.warn({ error: productError.message }, '[search] cross number products error')
    return []
  }

  const matchedByProduct = new Map(matches.map((row: any) => [row.product_id, row.number]))
  return (products ?? []).map((product: any): SearchResult => ({
    ...product,
    match_field: 'cross_number',
    match_value: matchedByProduct.get(product.id) ?? code,
  }))
}

/** [1] Прямий пошук по товарах (sku, name, barcode, oem_number) */
async function directProductSearch(terms: string[], originalQ: string, limit: number, tenantId: string): Promise<SearchResult[]> {
  const fullTerms = terms
    .map((term) => term.replace(/[,()*%]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const wordTerms = fullTerms
    .flatMap((term) => term.split(/\s+/))
    .filter((term) => term.length >= 2)
    .sort((a, b) => b.length - a.length)
  const conditionTerms = [...new Set([...fullTerms, ...wordTerms])].slice(0, 16)

  const conditions = conditionTerms.flatMap((safeTerm) => {
    // Commas and parentheses are PostgREST OR grammar, not search text.
    const normalized = normalizeArticle(safeTerm)
    return [
      `sku.ilike.*${safeTerm}*`,
      `sku.ilike.*${normalized}*`,
      `name.ilike.*${safeTerm}*`,
      `barcode.eq.${safeTerm}`,
      // additional_barcodes виключено з OR — JSONB contains некоректно в or() рядку
      // обробляється окремо в barcodeSearch через product_barcodes таблицю
      `normalized_oem.eq.${normalized}`,
      `oem_number.ilike.*${normalized}*`,
    ]
  })

  const orString = conditions.join(',')
  if (!orString) return []

  const { data, error } = await db
    .from(PRODUCTS_TABLE)
    .select('id, sku, name, barcode, photo_url, oem_number, retail_price, qty_on_hand, unit, storage_bin, is_service, requires_core_return, core_deposit_amount, brand:brands(name)')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .eq('is_active', true)
    .or(orString)
    .order('qty_on_hand', { ascending: false })
    .limit(Math.min(limit * 5, 100))

  if (error) { logger.warn({ error: error.message }, '[search] directProductSearch error'); return [] }
  if (!data || data.length === 0) return []

  const normalizedOriginal = normalizeArticle(originalQ)
  const lowerTerms = terms.map((term) => term.toLocaleLowerCase('uk-UA'))
  const tokenGroups = lowerTerms
    .map((term) => term.split(/\s+/).filter((token) => token.length >= 2))
    .filter((tokens) => tokens.length > 1)
  const score = (p: any): { value: number; field: string; match: string } => {
    const barcode = String(p.barcode ?? '')
    const sku = String(p.sku ?? '')
    const oem = String(p.oem_number ?? '')
    const name = String(p.name ?? '')
    const normalizedSku = normalizeArticle(sku)
    const normalizedOem = normalizeArticle(oem)
    const lowerName = name.toLocaleLowerCase('uk-UA')

    if (barcode === originalQ) return { value: 10000, field: 'barcode', match: barcode }
    if (normalizedSku === normalizedOriginal) return { value: 9500, field: 'sku', match: sku }
    if (normalizedOem === normalizedOriginal) return { value: 9000, field: 'oem', match: oem }

    let best = { value: 0, field: 'name', match: name }
    for (const tokens of tokenGroups) {
      const matched = tokens.filter((token) => lowerName.includes(token)).length
      if (matched === tokens.length) {
        best = { value: Math.max(best.value, 7800 + Math.min(tokens.length, 5) * 20), field: 'name', match: name }
      } else if (matched > 0) {
        best = { value: Math.max(best.value, 3000 + matched * 100), field: 'name', match: name }
      }
    }
    for (const term of lowerTerms) {
      const normalizedTerm = normalizeArticle(term)
      if (lowerName === term) best = { value: Math.max(best.value, 8500), field: 'name', match: name }
      else if (lowerName.startsWith(term)) best = { value: Math.max(best.value, 8000), field: 'name', match: name }
      else if (lowerName.includes(term)) best = { value: Math.max(best.value, 7000), field: 'name', match: name }
      else if (normalizedSku.startsWith(normalizedTerm)) best = { value: Math.max(best.value, 6500), field: 'sku', match: sku }
      else if (normalizedSku.includes(normalizedTerm)) best = { value: Math.max(best.value, 6000), field: 'sku', match: sku }
      else if (normalizedOem.includes(normalizedTerm)) best = { value: Math.max(best.value, 5500), field: 'oem', match: oem }
    }
    return best
  }

  return data
    .map((p: any) => ({ product: p, rank: score(p) }))
    .sort((a, b) => b.rank.value - a.rank.value || Number(b.product.qty_on_hand ?? 0) - Number(a.product.qty_on_hand ?? 0))
    .slice(0, limit)
    .map(({ product, rank }): SearchResult => ({
      ...product,
      match_field: rank.field,
      match_value: rank.match,
    }))
}

/** [2] Пошук по коду постачальника (product_supplier_codes) */
async function supplierCodeSearch(code: string, limit: number, tenantId: string): Promise<SearchResult[]> {
  const normalized = normalizeArticle(code)

  const { data: scResults, error: scError } = await db
    .from('product_supplier_codes')
    .select('product_id, supplier_code')
    .eq('tenant_id', tenantId)
    .or(`supplier_code.ilike.%${normalized}%,normalized_supplier_article.eq.${normalized}`)
    .limit(limit)

  if (scError) { logger.warn({ error: scError.message }, '[search] product_supplier_codes error'); return [] }
  if (!scResults || scResults.length === 0) return []

  const productIds = [...new Set(scResults.map((r: any) => r.product_id))].slice(0, limit)

  const { data: products, error: prodError } = await db
    .from(PRODUCTS_TABLE)
    .select('id, sku, name, barcode, photo_url, retail_price, qty_on_hand, unit, storage_bin, is_service, requires_core_return, core_deposit_amount, brand:brands(name)')
    .eq('tenant_id', tenantId)
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
async function aliasSearch(terms: string[], originalQ: string, limit: number, tenantId: string): Promise<SearchResult[]> {
  const conditions = terms.map((t) => `alias.ilike.%${t}%`).join(',')
  if (!conditions) return []

  const { data: aliasResults, error: aliasError } = await db
    .from('product_aliases')
    .select('product_id, alias')
    .eq('tenant_id', tenantId)
    .or(conditions)
    .limit(limit)

  if (aliasError) { logger.warn({ error: aliasError.message }, '[search] product_aliases error'); return [] }
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
    .select('id, sku, name, barcode, photo_url, retail_price, qty_on_hand, unit, storage_bin, is_service, requires_core_return, core_deposit_amount, brand:brands(name)')
    .eq('tenant_id', tenantId)
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
async function barcodeSearch(barcode: string, limit: number, tenantId: string): Promise<SearchResult[]> {
  const { data: barcodeResults, error: bcError } = await db
    .from('product_barcodes')
    .select('product_id, barcode')
    .eq('tenant_id', tenantId)
    .eq('barcode', barcode)
    .limit(limit)

  if (bcError) { logger.warn({ error: bcError.message }, '[search] product_barcodes error'); return [] }
  if (!barcodeResults || barcodeResults.length === 0) return []

  const productIds = [...new Set(barcodeResults.map((r: any) => r.product_id))].slice(0, limit)

  const { data: products, error: prodError } = await db
    .from(PRODUCTS_TABLE)
    .select('id, sku, name, barcode, photo_url, retail_price, qty_on_hand, unit, storage_bin, is_service, requires_core_return, core_deposit_amount, brand:brands(name)')
    .eq('tenant_id', tenantId)
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
async function additionalBarcodesSearch(barcode: string, limit: number, tenantId: string): Promise<SearchResult[]> {
  try {
    const { data, error } = await db
      .from(PRODUCTS_TABLE)
      .select('id, sku, name, barcode, photo_url, retail_price, qty_on_hand, unit, storage_bin, is_service, requires_core_return, core_deposit_amount, brand:brands(name)')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .eq('is_active', true)
      .contains('additional_barcodes', JSON.stringify([barcode]))
      .limit(limit)

    if (error) { logger.warn({ error: error.message }, '[search] additional_barcodes error'); return [] }
    if (!data || data.length === 0) return []

    return data.map((p: any): SearchResult => ({
      ...p, match_field: 'barcode', match_value: barcode,
    }))
  } catch { return [] }
}

/** [5] Пошук по VIN — знайти товари сумісні з авто */
async function vinSearch(vin: string, limit: number, tenantId: string): Promise<SearchResult[]> {
  if (vin.length < 6) return []

  const { data: vehicles, error: vehError } = await db
    .from('customer_vehicles')
    .select('brand, model, year')
    .eq('tenant_id', tenantId)
    .ilike('vin', `${vin}%`)
    .limit(5)

  if (vehError) { logger.warn({ error: vehError.message }, '[search] customer_vehicles error'); return [] }
  if (!vehicles || vehicles.length === 0) return []

  const productIds = new Set<string>()

  for (const v of vehicles) {
    const { data: fitments } = await db
      .from('product_fitment')
      .select('product_id')
      .eq('tenant_id', tenantId)
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
    .select('id, sku, name, barcode, photo_url, retail_price, qty_on_hand, unit, storage_bin, is_service, requires_core_return, core_deposit_amount, brand:brands(name)')
    .eq('tenant_id', tenantId)
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
