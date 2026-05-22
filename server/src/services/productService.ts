import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizeArticle, normalizeOemValue } from '../validators/productValidator.js'
import { logAction } from './auditService.js'
import { SimpleCache } from '../lib/simpleCache.js'
import type { CreateProductInput, UpdateProductInput, ProductListQuery } from '../validators/productValidator.js'

const TABLE = 'products'

// Кеш пошукових запитів (30 сек TTL) — для POS касира
const searchCache = new SimpleCache<string, any>(30_000)

async function enrichWithAvailability(products: any[]): Promise<any[]> {
  if (!products || products.length === 0) return products

  const productIds = products.map((p) => p.id)

  const { data: avail, error } = await db
    .from('products_available')
    .select('product_id, qty_reserved, qty_available')
    .in('product_id', productIds)

  if (error) {
    console.warn('[productService] products_available error:', error.message)
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

export async function listProducts(query: ProductListQuery) {
  const { search, category_id, brand_id, is_active, low_stock, page, per_page, sort_field, sort_dir } = query
  const offset = (page - 1) * per_page

  // Фільтр "мало на складі": PostgREST не вміє порівнювати дві колонки →
  // завантажуємо всі відфільтровані записи, фільтруємо в JS, пагінуємо вручну
  if (low_stock === 'true') {
    let allQ = db
      .from(TABLE)
      .select('*, brand:brands(id,name), category:categories(id,name)')
      .is('deleted_at', null)

    if (search) {
      if (search.startsWith('oem:')) {
        const oem = search.slice(4).trim()
        const normalized = normalizeOemValue(oem)
        allQ = allQ.or(`normalized_oem.ilike.%${normalized}%,normalized_supplier_article.ilike.%${normalized}%`)
      } else {
        const normalized = normalizeArticle(search)
        allQ = allQ.or(`sku.ilike.%${normalized}%,name.ilike.%${search}%,barcode.ilike.%${search}%`)
      }
    }
    if (category_id) allQ = allQ.eq('category_id', category_id)
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

  // Звичайний запит — перевіряємо кеш (тільки для пошукових запитів)
  const isCacheable = !!search && !category_id && !brand_id && is_active === undefined
  const cacheKey = isCacheable ? JSON.stringify({ search, page, per_page, sort_field, sort_dir }) : null
  if (cacheKey) {
    const cached = searchCache.get(cacheKey)
    if (cached) return cached
  }

  const orderCol = sort_field ?? 'name'
  const orderAsc = sort_dir !== 'desc'

  let q = db
    .from(TABLE)
    .select('*, brand:brands(id,name), category:categories(id,name)', { count: 'exact' })
    .is('deleted_at', null)
    .order(orderCol, { ascending: orderAsc })
    .range(offset, offset + per_page - 1)

  if (search) {
    if (search.startsWith('oem:')) {
      const oem = search.slice(4).trim()
      const normalized = normalizeOemValue(oem)
      q = q.or(`normalized_oem.ilike.%${normalized}%,normalized_supplier_article.ilike.%${normalized}%`)
    } else {
      const normalized = normalizeArticle(search)
      q = q.or(`sku.ilike.%${normalized}%,name.ilike.%${search}%,barcode.ilike.%${search}%`)
    }
  }
  if (category_id) q = q.eq('category_id', category_id)
  if (brand_id) q = q.eq('brand_id', brand_id)
  if (is_active !== undefined) q = q.eq('is_active', is_active === 'true')

  const { data, error, count } = await q
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  const enriched = await enrichWithAvailability(data ?? [])

  const result = {
    data: enriched,
    pagination: {
      page,
      per_page,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / per_page) || 1,
    },
  }

  if (cacheKey) searchCache.set(cacheKey, result)
  return result
}

export async function getProduct(id: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*, brand:brands(id,name), category:categories(id,name)')
    .eq('id', id)
    .is('deleted_at', null)
    .single()

  if (error || !data) throw new AppError('PRODUCT_NOT_FOUND', 'Товар не знайдено', 404)

  const [enriched] = await enrichWithAvailability([data])
  return enriched
}

export async function createProduct(input: CreateProductInput, _userId: string, tenantId: string) {
  const { data: existing } = await db
    .from(TABLE)
    .select('id')
    .eq('sku', input.sku)
    .is('deleted_at', null)
    .maybeSingle()

  if (existing) throw new AppError('SKU_DUPLICATE', `Артикул "${input.sku}" вже існує`, 409)

  const normalized = {
    normalized_oem: normalizeOemValue(input.oem_number),
    normalized_supplier_article: normalizeOemValue((input as any).supplier_article),
  }

  const { data, error } = await db
    .from(TABLE)
    .insert({ ...input, ...normalized, tenant_id: tenantId })
    .select('*, brand:brands(id,name), category:categories(id,name)')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  searchCache.clear()
  return data
}

export async function updateProduct(id: string, input: UpdateProductInput, userId: string) {
  const existing = await getProduct(id)

  const priceChanges: Array<{ price_type: string; old_price: number; new_price: number }> = []
  if (input.retail_price !== undefined && input.retail_price !== existing.retail_price) {
    priceChanges.push({ price_type: 'retail', old_price: existing.retail_price, new_price: input.retail_price })
  }
  if (input.purchase_price !== undefined && input.purchase_price !== existing.purchase_price) {
    priceChanges.push({ price_type: 'purchase', old_price: existing.purchase_price, new_price: input.purchase_price })
  }

  const updateData: any = { ...input, updated_at: new Date().toISOString() }
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
    .is('deleted_at', null)
    .select('*, brand:brands(id,name), category:categories(id,name)')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  if (priceChanges.length > 0) {
    await db.from('product_price_history').insert(
      priceChanges.map((c) => ({
        product_id: id,
        price_type: c.price_type,
        old_price: c.old_price,
        new_price: c.new_price,
        changed_by: userId,
      })),
    )
    void logAction({
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

  searchCache.clear()
  return data
}

export async function deleteProduct(id: string) {
  await getProduct(id)
  const { error } = await db
    .from(TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  searchCache.clear()
}

export async function searchForPOS(q: string, limit: number) {
  // Делегуємо в searchService — там буде нарощуватись логіка пошуку
  const { searchProductsForPOS } = await import('./searchService.js')
  return searchProductsForPOS(q, limit)
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
export async function updateStock(productId: string, input: { qty_on_hand: number; reason?: string }, userId: string) {
  // 1. Поточний стан
  const { data: current, error: getError } = await db
    .from(TABLE)
    .select('id, sku, name, qty_on_hand')
    .eq('id', productId)
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
    .is('deleted_at', null)
    .select('id, sku, name, qty_on_hand')
    .single()

  if (updateError) throw new AppError('DB_ERROR', updateError.message, 500)

  // 3a. Авто-сповіщення з листа очікування
  if (oldQty <= 0 && newQty > 0) {
    const { notifyWaitlistCustomers } = await import('../routes/waitlist.js').catch(() => ({ notifyWaitlistCustomers: null }))
    if (notifyWaitlistCustomers) void notifyWaitlistCustomers(productId)
  }

  // 3. Аудит
  void logAction({
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
export async function getProductAnalogs(productId: string) {
  // 1. Отримуємо всі аналоги з brand.tier
  const { data: analogs, error } = await db
    .from('product_analogs')
    .select(`
      analog_product_id,
      analog_type,
      priority,
      analog:analog_product_id (
        id, sku, name, barcode, retail_price, qty_on_hand, unit,
        brand:brands(id, name, tier)
      )
    `)
    .eq('product_id', productId)
    .order('priority', { ascending: true })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  if (!analogs || analogs.length === 0) return { analogs: [], grouped: {} }

  const result = analogs.map((a: any) => ({
    id: a.analog.id,
    sku: a.analog.sku,
    name: a.analog.name,
    barcode: a.analog.barcode,
    retail_price: a.analog.retail_price,
    qty_on_hand: a.analog.qty_on_hand,
    unit: a.analog.unit,
    brand: a.analog.brand,
    analog_type: a.analog_type,
    priority: a.priority,
  }))

  const enriched = await enrichWithAvailability(result)

  // Групування по brand_tier (ТЗ Analog Display Logic)
  const grouped: Record<string, typeof enriched> = {
    original: enriched.filter((r: any) => r.analog_type === 'oem' || r.brand?.tier === 'original'),
    premium: enriched.filter((r: any) => r.brand?.tier === 'premium'),
    standard: enriched.filter((r: any) => r.brand?.tier === 'standard' || !r.brand),
    budget: enriched.filter((r: any) => r.brand?.tier === 'budget'),
  }

  return { analogs: enriched, grouped }
}

/**
 * Отримати сумісність товару з автомобілями (ТЗ — GET /products/:id/fitment)
 * Читає з product_fitment для конкретного товару
 */
export async function getProductFitment(productId: string) {
  const { data, error } = await db
    .from('product_fitment')
    .select('id, make, model, year_from, year_to, engine_code, body_code, source')
    .eq('product_id', productId)
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
export async function getProductHistory(productId: string, tenantId?: string) {
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
  if (tenantId) salesQ = salesQ.eq('tenant_id', tenantId)

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
  if (tenantId) returnsQ = returnsQ.eq('tenant_id', tenantId)

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
export async function getPriceHistory(productId: string) {
  await getProduct(productId)
  const { data, error } = await db
    .from('product_price_history')
    .select('*')
    .eq('product_id', productId)
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
export async function generateBarcode(): Promise<string> {
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
      .maybeSingle()

    if (!data) return barcode
  }

  throw new AppError('BARCODE_GEN_FAILED', 'Не вдалося згенерувати унікальний штрих-код', 500)
}

export async function getStockBreakdown(productId: string) {
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
