import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizeArticle } from '../validators/productValidator.js'
import type { CreateProductInput, UpdateProductInput, ProductListQuery } from '../validators/productValidator.js'

const TABLE = 'products'

export async function listProducts(query: ProductListQuery) {
  const { search, category_id, brand_id, is_active, low_stock, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(TABLE)
    .select('*, brand:brands(id,name), category:categories(id,name)', { count: 'exact' })
    .is('deleted_at', null)
    .order('name', { ascending: true })
    .range(offset, offset + per_page - 1)

  if (search) {
    const normalized = normalizeArticle(search)
    q = q.or(`sku.ilike.%${normalized}%,name.ilike.%${search}%,barcode.ilike.%${search}%`)
  }
  if (category_id) q = q.eq('category_id', category_id)
  if (brand_id)    q = q.eq('brand_id', brand_id)
  if (is_active !== undefined) q = q.eq('is_active', is_active === 'true')

  // Фильтр "мало на складе": qty_on_hand <= reorder_point через PostgreSQL функцию
  if (low_stock === 'true') {
    q = q.filter('qty_on_hand', 'lte', 'reorder_point')
    q = q.order('qty_on_hand', { ascending: true })
  }

  const { data, error, count } = await q
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return {
    data: data ?? [],
    pagination: {
      page,
      per_page,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / per_page),
    },
  }
}

export async function getProduct(id: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*, brand:brands(id,name), category:categories(id,name)')
    .eq('id', id)
    .is('deleted_at', null)
    .single()

  if (error || !data) throw new AppError('PRODUCT_NOT_FOUND', 'Товар не знайдено', 404)
  return data
}

export async function createProduct(input: CreateProductInput) {
  const { data: existing } = await db
    .from(TABLE)
    .select('id')
    .eq('sku', input.sku)
    .is('deleted_at', null)
    .maybeSingle()

  if (existing) throw new AppError('SKU_DUPLICATE', `Артикул "${input.sku}" вже існує`, 409)

  const { data, error } = await db
    .from(TABLE)
    .insert(input)
    .select('*, brand:brands(id,name), category:categories(id,name)')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
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

  const { data, error } = await db
    .from(TABLE)
    .update({ ...input, updated_at: new Date().toISOString() })
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
  }

  return data
}

export async function deleteProduct(id: string) {
  await getProduct(id)
  const { error } = await db
    .from(TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

export async function searchForPOS(q: string, limit: number) {
  const normalized = normalizeArticle(q)

  const { data, error } = await db
    .from(TABLE)
    .select('id, sku, name, barcode, retail_price, qty_on_hand, unit, brand:brands(name)')
    .is('deleted_at', null)
    .eq('is_active', true)
    .or(`sku.ilike.%${normalized}%,name.ilike.%${q}%,barcode.eq.${q}`)
    .order('qty_on_hand', { ascending: false })
    .limit(limit)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
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
