import { db } from '../db/supabase.js'
import { applyMarkup, roundingFromSettings, type MarkupRule } from '../lib/markup.js'
import { logger } from '../lib/logger.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizeArticle, normalizeOemValue } from '../validators/productValidator.js'
import { logAction } from './auditService.js'
import { buildProductSearchTerms } from './searchService.js'
import { SimpleCache } from '../lib/simpleCache.js'
import type {
  CreateProductInput,
  UpdateProductInput,
  ProductListQuery,
  BulkCrossNumbersInput,
} from '../validators/productValidator.js'

const TABLE = 'products'

// Кеш пошукових запитів (30 сек TTL) — для POS касира
const searchCache = new SimpleCache<string, any>(30_000)
const analogCache = new SimpleCache<string, any>(30_000)

export async function clearProductSearchCache(): Promise<void> {
  await searchCache.clear()
  await analogCache.clear()
}
function cleanProductSearchTerm(value: string): string {
  return value.replace(/[,()*%]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function normalizeCatalogCode(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleUpperCase('uk-UA')
    .replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
}

export function catalogCodesFromName(value: string | null | undefined): string[] {
  const pieces = String(value ?? '')
    .normalize('NFKC')
    .toLocaleUpperCase('uk-UA')
    .split(/\s+/)
    .map((piece) => piece.replace(/^[^A-ZА-ЯІЇЄҐ0-9]+|[^A-ZА-ЯІЇЄҐ0-9]+$/g, ''))
    .filter(Boolean)
  const codes = new Set<string>()
  for (const piece of pieces) {
    const code = normalizeCatalogCode(piece)
    if (code.length >= 4 && /[A-ZА-ЯІЇЄҐ]/.test(code) && /\d/.test(code)) codes.add(code)
  }
  for (let index = 0; index + 1 < pieces.length; index += 1) {
    const left = pieces[index]
    const right = pieces[index + 1]
    if (/^[A-Z]{1,3}$/.test(left) && /^\d[\d./_-]*$/.test(right)) {
      const code = normalizeCatalogCode(left + right)
      if (code.length >= 4) codes.add(code)
    }
  }
  return [...codes]
}

function catalogNameVariants(code: string): string[] {
  const values = new Set<string>([code])
  const match = code.match(/^([A-ZА-ЯІЇЄҐ]{1,5})(\d{2,})$/)
  if (match) {
    values.add(`${match[1]} ${match[2]}`)
    values.add(`${match[1]}-${match[2]}`)
    values.add(`${match[1]}/${match[2]}`)
  }
  return [...values].map(cleanProductSearchTerm).filter(Boolean)
}

function productListSearchTerms(search: string): string[] {
  const values = new Set<string>()
  const clean = cleanProductSearchTerm(search)
  if (clean) values.add(clean)
  for (const term of buildProductSearchTerms(search)) {
    const safeTerm = cleanProductSearchTerm(term)
    if (safeTerm) values.add(safeTerm)
  }
  for (const token of clean.split(/\s+/)) {
    if (token.length >= 2) values.add(token)
  }
  for (const [pattern, replacement] of [
    [/\bbooster\b/gi, 'бустер'],
    [/\bboost\b/gi, 'бустер'],
    [/\bwires?\b/gi, 'провода'],
    [/бустер/gi, 'booster'],
    [/провод/gi, 'wire'],
  ] as Array<[RegExp, string]>) {
    const variant = cleanProductSearchTerm(search.replace(pattern, replacement))
    if (variant) values.add(variant)
    for (const token of variant.split(/\s+/)) {
      if (token.length >= 2) values.add(token)
    }
  }
  return [...values].filter(Boolean).slice(0, 16)
}

function productIdCondition(productIds: string[]): string[] {
  const ids = [...new Set(productIds)].filter(Boolean)
  return ids.length > 0 ? [`id.in.(${ids.join(',')})`] : []
}

function productListSearchOr(search: string, relatedProductIds: string[] = []): string {
  const conditions: string[] = []
  for (const term of productListSearchTerms(search)) {
    const normalized = normalizeArticle(term)
    conditions.push(`sku.ilike.%${term}%`)
    if (normalized) conditions.push(`sku.ilike.%${normalized}%`)
    conditions.push(`name.ilike.%${term}%`)
    conditions.push(`barcode.ilike.%${term}%`)
    if (normalized) {
      conditions.push(`normalized_oem.ilike.%${normalized}%`)
      conditions.push(`normalized_supplier_article.ilike.%${normalized}%`)
      conditions.push(`oem_number.ilike.%${normalized}%`)
    }
  }
  conditions.push(...productIdCondition(relatedProductIds))
  return [...new Set(conditions)].join(',')
}

function productListOemSearchOr(search: string, relatedProductIds: string[] = []): string {
  const normalized = normalizeOemValue(search)
  const conditions = normalized
    ? [`normalized_oem.ilike.%${normalized}%`, `normalized_supplier_article.ilike.%${normalized}%`, `oem_number.ilike.%${normalized}%`]
    : []
  conditions.push(...productIdCondition(relatedProductIds))
  return [...new Set(conditions)].join(',')
}

async function collectProductIdsFromRelatedSearch(search: string, tenantId: string): Promise<string[]> {
  const source = search.startsWith('oem:') ? search.slice(4).trim() : search
  const terms = productListSearchTerms(source)
  const normalizedTerms = [...new Set(terms.map((term) => normalizeArticle(term)).filter(Boolean))]
  const normalizedOem = normalizeOemValue(source)
  const compactBarcode = String(source ?? '').replace(/[\s\u00a0\u202f-]/g, '').trim()
  const ids = new Set<string>()

  const addRows = (rows: any[] | null | undefined) => {
    for (const row of rows ?? []) {
      if (row?.product_id) ids.add(row.product_id)
    }
  }

  const queries: Array<PromiseLike<void>> = []

  if (terms.length > 0) {
    const aliasOr = terms.map((term) => `alias.ilike.%${term}%`).join(',')
    queries.push(db
      .from('product_aliases')
      .select('product_id')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .or(aliasOr)
      .limit(500)
      .then(({ data, error }) => {
        if (error) logger.warn({ error: error.message }, '[productService] alias list search error')
        else addRows(data)
      }))
  }

  if (normalizedTerms.length > 0) {
    const supplierOr = normalizedTerms
      .flatMap((term) => [`supplier_code.ilike.%${term}%`, `normalized_supplier_article.ilike.%${term}%`])
      .join(',')
    queries.push(db
      .from('product_supplier_codes')
      .select('product_id')
      .eq('tenant_id', tenantId)
      .or(supplierOr)
      .limit(500)
      .then(({ data, error }) => {
        if (error) logger.warn({ error: error.message }, '[productService] supplier-code list search error')
        else addRows(data)
      }))
  }

  if (normalizedOem) {
    queries.push(db
      .from('product_cross_numbers')
      .select('product_id')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .ilike('normalized_number', `%${normalizedOem}%`)
      .limit(500)
      .then(({ data, error }) => {
        if (error) logger.warn({ error: error.message }, '[productService] cross-number list search error')
        else addRows(data)
      }))
  }

  const barcodeTerms = [...new Set([compactBarcode, ...normalizedTerms].filter((term) => term.length >= 4))]
  if (barcodeTerms.length > 0) {
    const barcodeOr = barcodeTerms.flatMap((term) => [`barcode.eq.${term}`, `barcode.ilike.%${term}%`]).join(',')
    queries.push(db
      .from('product_barcodes')
      .select('product_id')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .or(barcodeOr)
      .limit(500)
      .then(({ data, error }) => {
        if (error) logger.warn({ error: error.message }, '[productService] barcode list search error')
        else addRows(data)
      }))
  }

  await Promise.all(queries)
  return [...ids].slice(0, 500)
}

async function enrichWithAvailability(products: any[]): Promise<any[]> {
  if (!products || products.length === 0) return products

  const productIds = products.map((p) => p.id)

  const { data: avail, error } = await db
    .from('products_available')
    .select('product_id, qty_reserved, qty_available')
    .in('product_id', productIds)

  if (error) {
    logger.warn({ error: error.message }, '[productService] products_available error')
    return products
  }

  const availMap = new Map<string, { qty_reserved: number; qty_available: number }>()
  for (const a of avail ?? []) {
    availMap.set(a.product_id, {
      qty_reserved: a.qty_reserved ?? 0,
      qty_available: a.qty_available ?? 0,
    })
  }

  return products.map((p) => {
    const a = availMap.get(p.id)
    return {
      ...p,
      qty_reserved: a?.qty_reserved ?? 0,
      qty_available: a?.qty_available ?? p.qty_on_hand,
    }
  })
}

export async function listProducts(query: ProductListQuery, tenantId: string) {
  const { search, category_id, brand_id, is_active, low_stock, stock_filter, page, per_page, sort_field, sort_dir } = query
  const offset = (page - 1) * per_page

  // Звичайний запит — перевіряємо кеш (тільки для пошукових запитів)
  const isCacheable = !!search && !category_id && !brand_id && is_active === undefined && low_stock !== 'true' && !stock_filter
  const cacheKey = isCacheable ? JSON.stringify({ tenantId, search, page, per_page, sort_field, sort_dir }) : null
  if (cacheKey) {
    const cached = await searchCache.get(cacheKey)
    if (cached) return cached
  }

  const relatedProductIds = search ? await collectProductIdsFromRelatedSearch(search, tenantId) : []

  // Фільтр "мало на складі": PostgREST не вміє порівнювати дві колонки →
  // завантажуємо всі відфільтровані записи, фільтруємо в JS, пагінуємо вручну
  if (low_stock === 'true') {
    let allQ = db
      .from(TABLE)
      .select('*, brand:brands(id,name), category:categories(id,name)')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)

    if (search) {
      const searchOr = search.startsWith('oem:')
        ? productListOemSearchOr(search.slice(4).trim(), relatedProductIds)
        : productListSearchOr(search, relatedProductIds)
      if (searchOr) allQ = allQ.or(searchOr)
    }
    if (category_id === '__uncategorized') allQ = allQ.is('category_id', null)
    else if (category_id) allQ = allQ.eq('category_id', category_id)
    if (brand_id) allQ = allQ.eq('brand_id', brand_id)
    if (is_active !== undefined) allQ = allQ.eq('is_active', is_active === 'true')

    const { data: allData, error: allError } = await allQ
    if (allError) throw new AppError('DB_ERROR', allError.message, 500)

    const filtered = (allData ?? [])
      .filter((p) => p.qty_on_hand <= p.reorder_point)
      .sort((a, b) => a.qty_on_hand - b.qty_on_hand)

    const total = filtered.length
    const paginated = filtered.slice(offset, offset + per_page)
    const enriched = await enrichWithAvailability(paginated)

    return {
      data: enriched,
      pagination: {
        page,
        per_page,
        total,
        total_pages: Math.ceil(total / per_page) || 1,
      },
    }
  }


  const orderCol = sort_field ?? 'name'
  const orderAsc = sort_dir !== 'desc'

  let q = db
    .from(TABLE)
    .select('*, brand:brands(id,name), category:categories(id,name)', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

  if (search && !sort_field) {
    q = q
      .order('qty_on_hand', { ascending: false })
      .order('is_service', { ascending: false })
      .order('is_favorite', { ascending: false })
      .order('name', { ascending: true })
      .order('id', { ascending: true })
  } else {
    q = q.order(orderCol, { ascending: orderAsc })
    if (orderCol !== 'name') q = q.order('name', { ascending: true })
    q = q.order('id', { ascending: true })
  }
  q = q.range(offset, offset + per_page - 1)

  if (search) {
    const searchOr = search.startsWith('oem:')
      ? productListOemSearchOr(search.slice(4).trim(), relatedProductIds)
      : productListSearchOr(search, relatedProductIds)
    if (searchOr) q = q.or(searchOr)
  }
  if (category_id === '__uncategorized') q = q.is('category_id', null)
  else if (category_id) q = q.eq('category_id', category_id)
  if (brand_id) q = q.eq('brand_id', brand_id)
  if (is_active !== undefined) q = q.eq('is_active', is_active === 'true')
  if (stock_filter === 'negative') q = q.lt('qty_on_hand', 0)
  if (stock_filter === 'no_price') q = q.eq('retail_price', 0)

  const { data, error, count } = await q
  if (error) {
    const status = Number((error as any).status ?? 0)
    const message = String((error as any).message ?? '')
    if (status === 416 || /Requested range not satisfiable/i.test(message)) {
      if (page > 1) {
        return listProducts({ ...query, page: 1 }, tenantId)
      }
      return {
        data: [],
        pagination: {
          page: 1,
          per_page,
          total: 0,
          total_pages: 1,
        },
      }
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }

  const enriched = await enrichWithAvailability(data ?? [])
  if (sort_field === 'qty_on_hand') {
    enriched.sort((left: any, right: any) => {
      const leftQty = Number(left.qty_available ?? left.qty_on_hand ?? 0)
      const rightQty = Number(right.qty_available ?? right.qty_on_hand ?? 0)
      const qtyDiff = leftQty - rightQty
      if (qtyDiff !== 0) return sort_dir === 'desc' ? -qtyDiff : qtyDiff
      return String(left.name ?? '').localeCompare(String(right.name ?? ''), 'uk', { sensitivity: 'base' })
        || String(left.id ?? '').localeCompare(String(right.id ?? ''))
    })
  } else if (search && !sort_field) {
    enriched.sort((left: any, right: any) => {
      const leftAvailable = Number(left.qty_available ?? left.qty_on_hand ?? 0) > 0 || left.is_service === true
      const rightAvailable = Number(right.qty_available ?? right.qty_on_hand ?? 0) > 0 || right.is_service === true
      return Number(rightAvailable) - Number(leftAvailable)
        || Number(right.is_favorite === true) - Number(left.is_favorite === true)
        || String(left.name ?? '').localeCompare(String(right.name ?? ''), 'uk', { sensitivity: 'base' })
        || String(left.id ?? '').localeCompare(String(right.id ?? ''))
    })
  }

  const result = {
    data: enriched,
    pagination: {
      page,
      per_page,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / per_page) || 1,
    },
  }

  if (cacheKey) await searchCache.set(cacheKey, result)
  return result
}

export async function getProduct(id: string, tenantId: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*, brand:brands(id,name), category:categories(id,name)')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .single()

  if (error || !data) throw new AppError('PRODUCT_NOT_FOUND', 'Товар не знайдено', 404)

  const [enriched] = await enrichWithAvailability([data])
  return enriched
}

// Замінити ВЕСЬ набір крос-номерів товару списком із картки товару.
// numbers=[] очищає; використовується у create/update продукту.
export async function setProductCrossNumbers(productId: string, numbers: string[], tenantId: string, userId: string) {
  const unique = new Map<string, string>()
  for (const raw of numbers) {
    const num = String(raw ?? '').trim()
    const normalized = normalizeOemValue(num)
    if (normalized) unique.set(normalized, num)
  }

  const updatedAt = new Date().toISOString()
  const { data: existing, error: existingError } = await db
    .from('product_cross_numbers')
    .select('id,normalized_number,deleted_at')
    .eq('tenant_id', tenantId)
    .eq('product_id', productId)
  if (existingError) throw new AppError('DB_ERROR', existingError.message, 500)

  const removedIds = (existing ?? [])
    .filter((row: any) => !row.deleted_at && !unique.has(String(row.normalized_number)))
    .map((row: any) => String(row.id))
  if (removedIds.length > 0) {
    const { error } = await db
      .from('product_cross_numbers')
      .update({ deleted_at: updatedAt, updated_at: updatedAt })
      .eq('tenant_id', tenantId)
      .eq('product_id', productId)
      .in('id', removedIds)
      .is('deleted_at', null)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
  }

  if (unique.size === 0) return
  const rows = [...unique.entries()].map(([normalized, num]) => ({
    tenant_id: tenantId,
    product_id: productId,
    number: num,
    normalized_number: normalized,
    number_type: 'cross',
    source: 'Картка товару',
    is_verified: true,
    created_by: userId,
    updated_at: updatedAt,
    deleted_at: null,
  }))
  const { error } = await db
    .from('product_cross_numbers')
    .upsert(rows, { onConflict: 'tenant_id,product_id,normalized_number' })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
}
export async function createProduct(input: CreateProductInput, _userId: string, tenantId: string) {
  // cross_numbers зберігаються в окрему таблицю, у колонки products їх не пишемо.
  const { cross_numbers: crossNumbers, ...productInput } = input as CreateProductInput & { cross_numbers?: string[] }
  // Унікальний індекс products_tenant_id_sku_key покриває і soft-deleted рядки,
  // тому шукаємо дубль БЕЗ фільтра deleted_at — інакше «привид» у кошику
  // валив insert сирою помилкою constraint.
  const { data: existing } = await db
    .from(TABLE)
    .select('id, deleted_at')
    .eq('sku', input.sku)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (existing && !existing.deleted_at) {
    throw new AppError('SKU_DUPLICATE', `Артикул "${input.sku}" вже існує`, 409)
  }

  if (input.barcode) {
    const { data: barcodeDuplicate } = await db
      .from(TABLE)
      .select('id, name')
      .eq('barcode', input.barcode)
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .maybeSingle()
    if (barcodeDuplicate) {
      throw new AppError('BARCODE_TAKEN', `Штрихкод "${input.barcode}" вже у товара "${barcodeDuplicate.name}"`, 409)
    }
  }

  const normalized = {
    normalized_oem: normalizeOemValue(input.oem_number),
    normalized_supplier_article: normalizeOemValue((input as any).supplier_article),
  }

  // Дубль лише серед видалених — «воскрешаємо» той самий рядок під новими даними
  // (створити новий не дасть унікальний індекс, а відновлення зберігає історію товару)
  if (existing && existing.deleted_at) {
    const { data, error } = await db
      .from(TABLE)
      .update({ ...productInput, ...normalized, deleted_at: null, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .eq('tenant_id', tenantId)
      .select('*, brand:brands(id,name), category:categories(id,name)')
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    if (crossNumbers !== undefined) await setProductCrossNumbers(data.id, crossNumbers, tenantId, _userId)
    await searchCache.clear()
  await analogCache.clear()
    return data
  }

  const { data, error } = await db
    .from(TABLE)
    .insert({ ...productInput, ...normalized, tenant_id: tenantId })
    .select('*, brand:brands(id,name), category:categories(id,name)')
    .single()

  if (error) {
    if (error.code === '23505') {
      const message = String((error as any).message ?? '')
      const details = String((error as any).details ?? '')
      if (/barcode/i.test(message) || /barcode/i.test(details)) {
        throw new AppError('BARCODE_TAKEN', `Штрихкод "${input.barcode}" вже використовується іншим товаром`, 409)
      }
      throw new AppError('SKU_DUPLICATE', `Артикул "${input.sku}" вже існує`, 409)
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }
  if (crossNumbers !== undefined) await setProductCrossNumbers(data.id, crossNumbers, tenantId, _userId)
  await searchCache.clear()
  await analogCache.clear()
  return data
}

export async function updateProduct(id: string, input: UpdateProductInput, userId: string, tenantId: string) {
  const existing = await getProduct(id, tenantId)

  // Перевірка унікальності SKU при зміні артикулу
  if (input.sku !== undefined && input.sku !== existing.sku) {
    const { data: dup } = await db
      .from(TABLE)
      .select('id')
      .eq('sku', input.sku)
      .eq('tenant_id', existing.tenant_id)
      .neq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (dup) throw new AppError('SKU_DUPLICATE', `Артикул "${input.sku}" вже існує`, 409)
  }

  // Перевірка унікальності штрихкоду (індекс products.barcode НЕ unique — стережемо в коді,
  // інакше два товари з однаковим ШК → неоднозначне сканування в касі).
  if (input.barcode !== undefined && input.barcode !== null && input.barcode !== '' && input.barcode !== existing.barcode) {
    const { data: bdup } = await db
      .from(TABLE)
      .select('id, name')
      .eq('barcode', input.barcode)
      .eq('tenant_id', existing.tenant_id)
      .neq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (bdup) throw new AppError('BARCODE_TAKEN', `Штрихкод "${input.barcode}" вже у товара "${bdup.name}"`, 409)
  }

  const priceChanges: Array<{ price_type: string; old_price: number; new_price: number }> = []
  if (input.retail_price !== undefined && input.retail_price !== existing.retail_price) {
    priceChanges.push({ price_type: 'retail', old_price: existing.retail_price, new_price: input.retail_price })
  }
  if (input.purchase_price !== undefined && input.purchase_price !== existing.purchase_price) {
    priceChanges.push({ price_type: 'purchase', old_price: existing.purchase_price, new_price: input.purchase_price })
  }

  const { cross_numbers: crossNumbers, ...productInput } = input as UpdateProductInput & { cross_numbers?: string[] }
  const updateData: any = { ...productInput, updated_at: new Date().toISOString() }
  if (input.oem_number !== undefined) {
    updateData.normalized_oem = normalizeOemValue(input.oem_number)
  }
  if ((input as any).supplier_article !== undefined) {
    updateData.normalized_supplier_article = normalizeOemValue((input as any).supplier_article)
  }

  const { data, error } = await db
    .from(TABLE)
    .update(updateData)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .select('*, brand:brands(id,name), category:categories(id,name)')
    .single()

  if (error) {
    if (error.code === '23505') {
      throw new AppError('SKU_DUPLICATE', `Артикул "${input.sku}" вже існує (можливо, у видаленому товарі)`, 409)
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }

  if (priceChanges.length > 0) {
    await db.from('product_price_history').insert(
      priceChanges.map((c) => ({
        tenant_id: existing.tenant_id,
        product_id: id,
        price_type: c.price_type,
        old_price: c.old_price,
        new_price: c.new_price,
        changed_by: userId,
      })),
    )
    void logAction({
      tenantId: existing.tenant_id,
      userId: userId,
      userRole: 'manager',
      action: 'product.price_changed',
      entityType: 'product',
      entityId: id,
      entityLabel: data?.name ?? id,
      oldValue: Object.fromEntries(priceChanges.map((c) => [c.price_type, c.old_price])),
      newValue: Object.fromEntries(priceChanges.map((c) => [c.price_type, c.new_price])),
    })
  }

  if (crossNumbers !== undefined) await setProductCrossNumbers(id, crossNumbers, existing.tenant_id, userId)
  await searchCache.clear()
  await analogCache.clear()
  return data
}

export async function deleteProduct(id: string, tenantId: string) {
  await getProduct(id, tenantId)
  const deletedAt = new Date().toISOString()
  const { error } = await db
    .from(TABLE)
    .update({ deleted_at: deletedAt, updated_at: deletedAt, is_active: false })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  await searchCache.clear()
  await analogCache.clear()
}

/**
 * Порівняння закупівельних цін постачальників по товару:
 * остання ціна кожного постачальника з проведених накладних, від найдешевшої.
 */
export async function getSupplierPrices(productId: string, tenantId: string) {
  const { data, error } = await db
    .from('supply_invoice_items')
    .select('purchase_price, created_at, invoice:supply_invoices!inner(tenant_id, status, posted_at, supplier:suppliers(id, name))')
    .eq('product_id', productId)
    .eq('invoice.tenant_id', tenantId)
    .eq('invoice.status', 'posted')
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  // остання ціна по кожному постачальнику
  const bySupplier = new Map<string, { supplier_id: string; supplier_name: string; price: number; date: string }>()
  for (const row of data ?? []) {
    const supplier = (row.invoice as any)?.supplier
    if (!supplier?.id || bySupplier.has(supplier.id)) continue
    bySupplier.set(supplier.id, {
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      price: row.purchase_price,
      date: (row.invoice as any)?.posted_at ?? row.created_at,
    })
  }

  return [...bySupplier.values()].sort((a, b) => a.price - b.price)
}

export async function searchForPOS(q: string, limit: number, tenantId: string) {
  // Делегуємо в searchService — там буде нарощуватись логіка пошуку
  const { searchProductsForPOS } = await import('./searchService.js')
  return searchProductsForPOS(q, limit, tenantId)
}


/**
 * Отримати аналоги товару, згруповані по brand_tier (ТЗ Analog Display Logic)
 * 
 * Відповідь групується:
 *   original → premium → standard → budget
 */

/**
 * Корекція залишку товару (ТЗ Product CRUD API — PUT /products/:id/stock)
 * Оновлює qty_on_hand та записує в аудит
 */
export async function updateStock(productId: string, input: { qty_on_hand: number; reason?: string }, userId: string, tenantId: string) {
  // 1. Поточний стан
  const { data: current, error: getError } = await db
    .from(TABLE)
    .select('id, sku, name, qty_on_hand, tenant_id')
    .eq('id', productId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .single()

  if (getError) throw new AppError('DB_ERROR', getError.message, 500)
  if (!current) throw new AppError('PRODUCT_NOT_FOUND', 'Товар з таким ID не знайдено', 404)

  const oldQty = current.qty_on_hand
  const newQty = input.qty_on_hand

  // 2. Оновлюємо
  const { data: updated, error: updateError } = await db
    .from(TABLE)
    .update({ qty_on_hand: newQty, updated_at: new Date().toISOString() })
    .eq('id', productId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .select('id, sku, name, qty_on_hand')
    .single()

  if (updateError) throw new AppError('DB_ERROR', updateError.message, 500)

  // 3a. Авто-сповіщення з листа очікування
  if (oldQty <= 0 && newQty > 0) {
    const { notifyWaitlistCustomers } = await import('../routes/waitlist.js').catch(() => ({ notifyWaitlistCustomers: null }))
    if (notifyWaitlistCustomers) void notifyWaitlistCustomers(productId, tenantId)
  }

  // 3. Аудит
  void logAction({
    tenantId: current.tenant_id,
    userId: userId,
    userRole: 'manager',
    action: 'stock_correction',
    entityType: 'product',
    entityId: productId,
    entityLabel: `${current.sku} - ${current.name}`,
    oldValue: oldQty,
    newValue: newQty,
    note: input.reason ?? 'Корекція залишку',
  })

  return updated
}

/**
 * Додати аналог до товару (ТЗ — POST /products/:id/analogs)
 */
export async function addProductAnalog(
  productId: string,
  input: { analog_product_id: string; analog_type: string; priority: number },
  userId: string,
  tenantId: string,
) {
  // Перевіряємо чи обидва товари існують
  const { data: products, error: checkError } = await db
    .from(TABLE)
    .select('id, sku, name')
    .in('id', [productId, input.analog_product_id])
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

  if (checkError) throw new AppError('DB_ERROR', checkError.message, 500)
  if (!products || products.length !== 2) {
    throw new AppError('PRODUCT_NOT_FOUND', 'Один з товарів не знайдено', 404)
  }

  const source = products.find((p: any) => p.id === productId)

  const { data, error } = await db
    .from('product_analogs')
    .insert({
      tenant_id: tenantId,
      product_id: productId,
      analog_product_id: input.analog_product_id,
      analog_type: input.analog_type,
      priority: input.priority,
    })
    .select('*, analog:analog_product_id(id, sku, name, retail_price, brand_id)')
    .single()

  if (error) {
    if (error.code === '23505') {
      throw new AppError('DUPLICATE_ANALOG', 'Такий аналог вже існує', 409)
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }

  // Аудит
  void logAction({
    tenantId: tenantId,
    userId: userId,
    userRole: 'manager',
    action: 'add_analog',
    entityType: 'product',
    entityId: productId,
    entityLabel: source?.sku ?? productId,
    newValue: input.analog_product_id,
    note: `Додано аналог типу "${input.analog_type}"`,
  })

  return data
}

export interface ProductCrossNumber {
  id: string
  number: string
  normalized_number: string
  number_type: 'cross' | 'oe' | 'supplier' | 'other'
  brand: string | null
  source: string
  is_verified: boolean
  created_at: string
}

export async function getProductCrossNumbers(productId: string, tenantId: string): Promise<ProductCrossNumber[]> {
  await getProduct(productId, tenantId)
  const { data, error } = await db
    .from('product_cross_numbers')
    .select('id, number, normalized_number, number_type, brand, source, is_verified, created_at')
    .eq('tenant_id', tenantId)
    .eq('product_id', productId)
    .is('deleted_at', null)
    .order('number_type')
    .order('number')

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return (data ?? []) as ProductCrossNumber[]
}

export async function addProductCrossNumbers(
  productId: string,
  input: BulkCrossNumbersInput,
  userId: string,
  userRole: string,
  tenantId: string,
): Promise<ProductCrossNumber[]> {
  const product = await getProduct(productId, tenantId)

  const unique = new Map<string, string>()
  for (const raw of input.numbers) {
    const number = raw.trim()
    const normalized = normalizeOemValue(number)
    if (normalized) unique.set(normalized, number)
  }
  if (unique.size === 0) throw new AppError('VALIDATION_ERROR', 'Список номерів порожній', 422)

  const normalizedNumbers = [...unique.keys()]
  const { data: existing, error: existingError } = await db
    .from('product_cross_numbers')
    .select('normalized_number')
    .eq('tenant_id', tenantId)
    .eq('product_id', productId)
    .is('deleted_at', null)
    .in('normalized_number', normalizedNumbers)

  if (existingError) throw new AppError('DB_ERROR', existingError.message, 500)
  const existingSet = new Set((existing ?? []).map((row: any) => row.normalized_number))

  const updatedAt = new Date().toISOString()
  const rows = normalizedNumbers
    .filter((normalized) => !existingSet.has(normalized))
    .map((normalized) => ({
      tenant_id: tenantId,
      product_id: productId,
      number: unique.get(normalized)!,
      normalized_number: normalized,
      number_type: input.number_type,
      source: input.source || 'Внесено менеджером',
      is_verified: true,
      created_by: userId,
      updated_at: updatedAt,
      deleted_at: null,
    }))

  if (rows.length > 0) {
    const { error } = await db.from('product_cross_numbers')
      .upsert(rows, { onConflict: 'tenant_id,product_id,normalized_number' })
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    void logAction({
      tenantId,
      userId,
      userRole,
      action: 'product_cross_numbers_added',
      entityType: 'product',
      entityId: productId,
      entityLabel: `${product.sku} - ${product.name}`,
      newValue: rows.map((row) => ({
        number: row.number,
        type: row.number_type,
        source: row.source,
      })),
      note: `Додано номерів: ${rows.length}`,
    })
    await searchCache.clear()
  await analogCache.clear()
  }

  return getProductCrossNumbers(productId, tenantId)
}

export async function removeProductCrossNumber(
  productId: string,
  crossNumberId: string,
  userId: string,
  userRole: string,
  tenantId: string,
): Promise<void> {
  const product = await getProduct(productId, tenantId)
  const { data: crossNumber, error: getError } = await db
    .from('product_cross_numbers')
    .select('id, number, number_type, source')
    .eq('id', crossNumberId)
    .eq('product_id', productId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (getError) throw new AppError('DB_ERROR', getError.message, 500)
  if (!crossNumber) throw new AppError('CROSS_NUMBER_NOT_FOUND', 'Крос-номер не знайдено', 404)

  const deletedAt = new Date().toISOString()
  const { error } = await db
    .from('product_cross_numbers')
    .update({ deleted_at: deletedAt, updated_at: deletedAt })
    .eq('id', crossNumberId)
    .eq('product_id', productId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  void logAction({
    tenantId,
    userId,
    userRole,
    action: 'product_cross_number_removed',
    entityType: 'product',
    entityId: productId,
    entityLabel: `${product.sku} - ${product.name}`,
    oldValue: crossNumber,
    note: `Видалено номер ${crossNumber.number}`,
  })
  await searchCache.clear()
  await analogCache.clear()
}

// ─── Масовий імпорт крос-номерів ─────────────────────────────────────────────
// Формат рядка: "наш_артикул <роздільник> крос1 <роздільник> крос2 ..."
// Роздільники: таб / ; / кома. Товар шукається за нормалізованим артикулом,
// далі за штрихкодом. Дублікати номерів пропускаються (унікальність у БД).
export async function importCrossNumbersBulk(
  text: string,
  source: string,
  userId: string,
  tenantId: string,
): Promise<{ linked: number; products: number; not_found: number; not_found_skus: string[]; skipped_dup: number }> {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) throw new AppError('VALIDATION_ERROR', 'Порожній список', 422)

  // Розбираємо рядки: перший стовпець — наш артикул, решта — кроси
  const bySku = new Map<string, Set<string>>() // normalizedSku -> set оригінальних кросів
  const skuOriginal = new Map<string, string>()
  for (const line of lines) {
    const parts = line.split(/[\t;,]+/).map((s) => s.trim()).filter(Boolean)
    if (parts.length < 2) continue
    const skuNorm = normalizeArticle(parts[0])
    if (!skuNorm) continue
    skuOriginal.set(skuNorm, parts[0])
    const set = bySku.get(skuNorm) ?? new Set<string>()
    for (const cross of parts.slice(1)) {
      if (normalizeOemValue(cross)) set.add(cross)
    }
    bySku.set(skuNorm, set)
  }
  if (bySku.size === 0) {
    throw new AppError('VALIDATION_ERROR',
      'Не розпізнано жодного рядка. Формат: "наш артикул; крос1; крос2" (роздільники таб/;/кома)', 422)
  }

  // Знаходимо товари порціями (щоб не впертись у ліміт URL PostgREST)
  const skus = [...bySku.keys()]
  const productBySku = new Map<string, string>() // normalizedSku -> product_id
  for (let i = 0; i < skus.length; i += 200) {
    const { data } = await db.from('products')
      .select('id, sku')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .in('sku', skus.slice(i, i + 200))
    for (const p of data ?? []) productBySku.set(String(p.sku), p.id)
  }

  const notFound: string[] = []
  const rows: any[] = []
  for (const [skuNorm, crosses] of bySku) {
    const productId = productBySku.get(skuNorm)
    if (!productId) { notFound.push(skuOriginal.get(skuNorm) ?? skuNorm); continue }
    const seen = new Set<string>()
    for (const cross of crosses) {
      const normalized = normalizeOemValue(cross)
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      rows.push({
        tenant_id: tenantId,
        product_id: productId,
        number: cross,
        normalized_number: normalized,
        number_type: 'cross',
        source: source || 'Масовий імпорт',
        is_verified: true,
        created_by: userId,
        updated_at: new Date().toISOString(),
        deleted_at: null,
      })
    }
  }

  // Upsert також відновлює раніше видалений зв'язок з тим самим номером.
  let linked = 0
  let skippedDup = 0
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { data, error } = await db.from('product_cross_numbers')
      .upsert(chunk, { onConflict: 'tenant_id,product_id,normalized_number' })
      .select('id')
    if (error) {
      logger.warn({ err: error.message, from: i }, '[cross-import] порція не вдалася')
      continue
    }
    linked += (data ?? []).length
    skippedDup += chunk.length - (data ?? []).length
  }

  await searchCache.clear()
  await analogCache.clear()
  logger.info({ linked, products: productBySku.size, notFound: notFound.length }, '[cross-import] масовий імпорт кросів')

  return {
    linked,
    products: productBySku.size,
    not_found: notFound.length,
    not_found_skus: notFound.slice(0, 50),
    skipped_dup: skippedDup,
  }
}

export async function getProductAnalogs(productId: string, tenantId: string) {
  const cacheKey = `${tenantId}:${productId}`
  const cached = await analogCache.get(cacheKey)
  if (cached) return cached

  const [sourceResult, sourceCrossesResult, explicitResult] = await Promise.all([
    db
      .from(TABLE)
      .select('id, name')
      .eq('id', productId)
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .single(),
    db
      .from('product_cross_numbers')
      .select('number, normalized_number')
      .eq('tenant_id', tenantId)
      .eq('product_id', productId)
      .is('deleted_at', null),
    db
      .from('product_analogs')
      .select('product_id, analog_product_id, analog_type, priority')
      .eq('tenant_id', tenantId)
      .or(`product_id.eq.${productId},analog_product_id.eq.${productId}`),
  ])

  if (sourceResult.error || !sourceResult.data) {
    throw new AppError('PRODUCT_NOT_FOUND', 'Товар не знайдено', 404)
  }
  if (sourceCrossesResult.error) throw new AppError('DB_ERROR', sourceCrossesResult.error.message, 500)
  if (explicitResult.error) throw new AppError('DB_ERROR', explicitResult.error.message, 500)
  const source = sourceResult.data
  const sourceCrosses = sourceCrossesResult.data
  const explicitRows = explicitResult.data

  const lookupCodes = new Set<string>(catalogCodesFromName(source.name))
  for (const row of sourceCrosses ?? []) {
    const normalized = normalizeCatalogCode(row.normalized_number || row.number)
    if (normalized.length >= 4) lookupCodes.add(normalized)
    for (const code of catalogCodesFromName(row.number)) lookupCodes.add(code)
  }

  const explicitMeta = new Map<string, { analog_type: string; priority: number }>()
  for (const row of explicitRows ?? []) {
    const otherId = row.product_id === productId ? row.analog_product_id : row.product_id
    if (!otherId || otherId === productId) continue
    const priority = Number(row.priority ?? 100)
    const current = explicitMeta.get(otherId)
    if (!current || priority < current.priority) {
      explicitMeta.set(otherId, { analog_type: row.analog_type ?? 'substitute', priority })
    }
  }

  const candidateIds = new Set<string>(explicitMeta.keys())
  const matchedByCross = new Set<string>()
  const codes = [...lookupCodes].filter((code) => code.length >= 4)

  const crossQueries = Array.from({ length: Math.ceil(codes.length / 100) }, (_, chunkIndex) => {
    const chunk = codes.slice(chunkIndex * 100, chunkIndex * 100 + 100)
    return db
      .from('product_cross_numbers')
      .select('product_id')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .in('normalized_number', chunk)
      .neq('product_id', productId)
      .limit(500)
  })
  const productQueries = Array.from({ length: Math.ceil(codes.length / 8) }, (_, chunkIndex) => {
    const chunk = codes.slice(chunkIndex * 8, chunkIndex * 8 + 8)
    const conditions = chunk.flatMap((code) => [
      `sku.eq.${code}`,
      `barcode.eq.${code}`,
      `normalized_oem.eq.${code}`,
      `normalized_supplier_article.eq.${code}`,
      ...catalogNameVariants(code).map((term) => `name.ilike.%${term}%`),
    ])
    return db
      .from(TABLE)
      .select('id')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .eq('is_active', true)
      .neq('id', productId)
      .or(conditions.join(','))
      .limit(500)
  })

  const [crossResults, productResults] = await Promise.all([
    Promise.all(crossQueries),
    Promise.all(productQueries),
  ])
  for (const result of crossResults) {
    if (result.error) throw new AppError('DB_ERROR', result.error.message, 500)
    for (const row of result.data ?? []) {
      candidateIds.add(row.product_id)
      matchedByCross.add(row.product_id)
    }
  }
  for (const result of productResults) {
    if (result.error) throw new AppError('DB_ERROR', result.error.message, 500)
    for (const row of result.data ?? []) candidateIds.add(row.id)
  }

  if (candidateIds.size === 0) {
    const empty = { analogs: [], grouped: { original: [], premium: [], standard: [], budget: [] } }
    await analogCache.set(cacheKey, empty)
    return empty
  }

  const candidateProducts: any[] = []
  const ids = [...candidateIds]
  for (let index = 0; index < ids.length; index += 100) {
    const { data, error } = await db
      .from(TABLE)
      .select('id, sku, name, barcode, retail_price, qty_on_hand, unit, normalized_oem, normalized_supplier_article, brand:brands(id, name, tier)')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .eq('is_active', true)
      .in('id', ids.slice(index, index + 100))
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    candidateProducts.push(...(data ?? []))
  }

  const result = candidateProducts
    .filter((candidate) => {
      if (explicitMeta.has(candidate.id) || matchedByCross.has(candidate.id)) return true
      const candidateCodes = new Set<string>([
        ...catalogCodesFromName(candidate.name),
        normalizeCatalogCode(candidate.sku),
        normalizeCatalogCode(candidate.barcode),
        normalizeCatalogCode(candidate.normalized_oem),
        normalizeCatalogCode(candidate.normalized_supplier_article),
      ].filter((code) => code.length >= 4))
      return codes.some((code) => candidateCodes.has(code))
    })
    .map((candidate) => {
      const explicit = explicitMeta.get(candidate.id)
      return {
        id: candidate.id,
        sku: candidate.sku,
        name: candidate.name,
        barcode: candidate.barcode,
        retail_price: candidate.retail_price,
        qty_on_hand: candidate.qty_on_hand,
        unit: candidate.unit,
        brand: candidate.brand,
        analog_type: explicit?.analog_type ?? 'cross',
        priority: explicit?.priority ?? 500,
      }
    })

  const enriched = (await enrichWithAvailability(result))
    .sort((left: any, right: any) =>
      Number(Number(right.qty_available ?? right.qty_on_hand) > 0)
      - Number(Number(left.qty_available ?? left.qty_on_hand) > 0)
      || Number(left.priority ?? 500) - Number(right.priority ?? 500)
      || String(left.name ?? '').localeCompare(String(right.name ?? ''), 'uk', { sensitivity: 'base' }),
    )

  const grouped: Record<string, typeof enriched> = {
    original: enriched.filter((row: any) => row.analog_type === 'oem' || row.brand?.tier === 'original'),
    premium: enriched.filter((row: any) => row.brand?.tier === 'premium'),
    standard: enriched.filter((row: any) =>
      row.brand?.tier === 'standard'
      || (!row.brand?.tier && row.analog_type !== 'oem'),
    ),
    budget: enriched.filter((row: any) => row.brand?.tier === 'budget'),
  }

  const response = { analogs: enriched, grouped }
  await analogCache.set(cacheKey, response)
  return response
}

/**
 * Отримати сумісність товару з автомобілями (ТЗ — GET /products/:id/fitment)
 * Читає з product_fitment для конкретного товару
 */
export async function getProductFitment(productId: string, tenantId: string) {
  await getProduct(productId, tenantId)
  const { data, error } = await db
    .from('product_fitment')
    .select('id, make, model, year_from, year_to, engine_code, body_code, source')
    .eq('product_id', productId)
    .eq('tenant_id', tenantId)
    .order('make', { ascending: true })
    .order('model', { ascending: true })

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  // Групуємо по make для зручності
  const grouped: Record<string, Array<typeof data[0]>> = {}
  for (const row of data ?? []) {
    if (!grouped[row.make]) grouped[row.make] = []
    grouped[row.make].push(row)
  }

  return { fitments: data ?? [], grouped }
}

/**
 * Отримати історію товару: зміни цін, продажі, повернення, списання (ТЗ — GET /products/:id/history)
 * Об'єднує дані з 4 джерел в єдиний хронологічний список
 */
export async function getProductHistory(productId: string, tenantId: string) {
  await getProduct(productId, tenantId)
  const results: Array<{
    type: 'price_change' | 'sale' | 'return' | 'writeoff'
    date: string
    details: Record<string, unknown>
  }> = []

  // 1. Продажі (фільтр по tenant_id якщо передано)
  let salesQ = db
    .from('sale_items')
    .select('qty, unit_price, total, created_at, sale:sales(id, payment_method)')
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .limit(50)
  salesQ = salesQ.eq('tenant_id', tenantId)

  const { data: sales } = await salesQ

  for (const s of sales ?? []) {
    results.push({
      type: 'sale',
      date: s.created_at,
      details: { qty: s.qty, unit_price: s.unit_price, total: s.total, payment_method: (s.sale as any)?.payment_method },
    })
  }

  // 2. Повернення (quantity/unit_price_kopecks/total_kopecks — реальні колонки з міграції 006)
  let returnsQ = db
    .from('return_items')
    .select('quantity, unit_price_kopecks, total_kopecks, condition, created_at, ret:returns(id, reason)')
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .limit(50)
  returnsQ = returnsQ.eq('tenant_id', tenantId)

  const { data: returns } = await returnsQ

  for (const r of returns ?? []) {
    results.push({
      type: 'return',
      date: r.created_at,
      details: { qty: r.quantity, unit_price: r.unit_price_kopecks, total: r.total_kopecks, condition: r.condition },
    })
  }

  // 3. Списання (qty/cost_kopecks — реальні колонки з міграції 007)
  const { data: writeoffs } = await db
    .from('inventory_writeoff_items')
    .select('qty, cost_kopecks, created_at, writeoff:inventory_writeoffs(id, reason, notes, tenant_id)')
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .limit(50)

  for (const w of writeoffs ?? []) {
    if (tenantId && (w.writeoff as any)?.tenant_id && (w.writeoff as any).tenant_id !== tenantId) continue
    results.push({
      type: 'writeoff',
      date: w.created_at,
      details: { qty: w.qty, cost: w.cost_kopecks, reason: (w.writeoff as any)?.reason, notes: (w.writeoff as any)?.notes },
    })
  }

  results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  return results
}
export async function getPriceHistory(productId: string, tenantId: string) {
  await getProduct(productId, tenantId)
  const { data, error } = await db
    .from('product_price_history')
    .select('*')
    .eq('product_id', productId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

/**
 * Генерує унікальний внутрішній штрих-код (EAN-13 сумісний).
 * Формат: 200 + 9 цифр унікального номера + контрольна цифра.
 * Перевіряє унікальність у БД.
 */
export async function generateBarcode(tenantId: string): Promise<string> {
  const EAN_PREFIX = '200'
  let attempts = 0

  while (attempts < 50) {
    attempts++
    // 9 випадкових цифр
    const uniquePart = String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')
    const code12 = EAN_PREFIX + uniquePart

    // Обчислюємо контрольну цифру EAN-13
    let sum = 0
    for (let i = 0; i < 12; i++) {
      const digit = parseInt(code12[i], 10)
      sum += i % 2 === 0 ? digit : digit * 3
    }
    const checksum = (10 - (sum % 10)) % 10
    const barcode = code12 + checksum

    // Перевіряємо унікальність
    const { data } = await db
      .from('products')
      .select('id')
      .eq('barcode', barcode)
      .eq('tenant_id', tenantId)
      .maybeSingle()

    if (!data) return barcode
  }

  throw new AppError('BARCODE_GEN_FAILED', 'Не вдалося згенерувати унікальний штрих-код', 500)
}

export async function getStockBreakdown(productId: string, tenantId: string) {
  await getProduct(productId, tenantId)
  const { data, error } = await db
    .from('v_product_stock')
    .select('qty_on_hand, qty_reserved, qty_available')
    .eq('product_id', productId)
    .maybeSingle()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  if (!data) throw new AppError('PRODUCT_NOT_FOUND', 'Товар з таким ID не знайдено', 404)

  return {
    on_hand: data.qty_on_hand as number,
    reserved: data.qty_reserved as number,
    available: data.qty_available as number,
  }
}


async function findOrCreateBrandByName(name: string, tenantId: string): Promise<string | null> {
  const normalizedBrand = name.trim()
  if (!normalizedBrand) return null

  const { data: existingBrand, error: lookupError } = await db
    .from('brands')
    .select('id')
    .eq('tenant_id', tenantId)
    .ilike('name', normalizedBrand)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()

  if (lookupError) throw new AppError('DB_ERROR', lookupError.message, 500)

  if (existingBrand) {
    return existingBrand.id
  }

  const { data: newBrand, error } = await db
    .from('brands')
    .insert({
      tenant_id: tenantId,
      name: normalizedBrand,
      tier: 'standard',
      deleted_at: null,
    })
    .select('id')
    .single()

  if (error) {
    const { data: concurrentBrand } = await db
      .from('brands')
      .select('id')
      .eq('tenant_id', tenantId)
      .ilike('name', normalizedBrand)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()
    if (concurrentBrand) return concurrentBrand.id

    logger.warn({ error: error.message, brand: normalizedBrand }, 'Failed to auto-create brand')
    return null
  }

  return newBrand.id
}
export async function importFromCatalog(
  input: { sku: string; brandName: string; name: string; supplierId: string | null; purchasePrice: number; retailPrice?: number },
  tenantId: string
) {
  const { sku, brandName, name, supplierId, purchasePrice } = input
  const normalizedSku = normalizeArticle(sku)

  const { data: existing } = await db
    .from(TABLE)
    .select('*, brand:brands(id,name), category:categories(id,name)')
    .eq('sku', normalizedSku)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (existing) {
    return existing
  }

  let brandId: string | null = null
  if (brandName) {
    brandId = await findOrCreateBrandByName(brandName, tenantId)
  }

  const { data: settings } = await db
    .from('shop_settings')
    .select('markup_rules, price_rounding_enabled, price_rounding_step, price_rounding_dir')
    .eq('tenant_id', tenantId)
    .single()

  const markupRules = (settings as any)?.markup_rules as MarkupRule[] | undefined

  let retailPrice = input.retailPrice
  if (retailPrice === undefined || retailPrice === null) {
    retailPrice = applyMarkup(purchasePrice, markupRules, 30, roundingFromSettings(settings))
  }

  const normalized = {
    normalized_oem: '',
    normalized_supplier_article: normalizeOemValue(sku),
  }

  const { data: newProd, error } = await db
    .from(TABLE)
    .insert({
      tenant_id: tenantId,
      sku: normalizedSku,
      name,
      brand_id: brandId,
      purchase_price: purchasePrice,
      retail_price: retailPrice,
      qty_on_hand: 0,
      unit: 'шт',
      status: 'active',
      is_active: true,
      ...normalized
    })
    .select('*, brand:brands(id,name), category:categories(id,name)')
    .single()

  if (error) {
    throw new AppError('DB_ERROR', 'Не вдалося створити товар: ' + error.message, 500)
  }

  if (supplierId) {
    const { error: codeErr } = await db
      .from('product_supplier_codes')
      .insert({
        tenant_id: tenantId,
        product_id: newProd.id,
        supplier_id: supplierId,
        supplier_code: sku,
        supplier_price: purchasePrice,
        normalized_supplier_article: normalizeOemValue(sku)
      })

    if (codeErr) {
      logger.warn({ error: codeErr.message }, 'Failed to link supplier code to imported product')
    }
  }

  await searchCache.clear()
  await analogCache.clear()

  return newProd
}




