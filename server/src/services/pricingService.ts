import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

// ── Цінові рівні ──────────────────────────────────────────

export async function listPriceTiers() {
  const { data, error } = await db
    .from('price_tiers')
    .select('*')
    .eq('tenant_id', TENANT_ID)
    .order('sort_order', { ascending: true })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function createPriceTier(input: {
  name:         string
  discount_pct: number
  is_default?:  boolean
  sort_order?:  number
}) {
  if (input.is_default) {
    // Знімаємо прапор default з усіх існуючих
    await db.from('price_tiers')
      .update({ is_default: false })
      .eq('tenant_id', TENANT_ID)
  }

  const { data, error } = await db
    .from('price_tiers')
    .insert({ ...input, tenant_id: TENANT_ID })
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function updatePriceTier(id: string, input: {
  name?:         string
  discount_pct?: number
  is_default?:   boolean
  sort_order?:   number
}) {
  if (input.is_default) {
    await db.from('price_tiers')
      .update({ is_default: false })
      .eq('tenant_id', TENANT_ID)
  }

  const { data, error } = await db
    .from('price_tiers')
    .update(input)
    .eq('id', id)
    .eq('tenant_id', TENANT_ID)
    .select('*')
    .single()

  if (error || !data) throw new AppError('NOT_FOUND', 'Рівень не знайдено', 404)
  return data
}

export async function deletePriceTier(id: string) {
  const { error } = await db
    .from('price_tiers')
    .delete()
    .eq('id', id)
    .eq('tenant_id', TENANT_ID)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

// ── Наценки по категоріях ─────────────────────────────────

export async function listCategoryMarkups() {
  const { data, error } = await db
    .from('category_markups')
    .select('*, category:categories(id,name)')
    .eq('tenant_id', TENANT_ID)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function getCategoryMarkup(categoryId: string): Promise<number | null> {
  const { data } = await db
    .from('category_markups')
    .select('markup_pct')
    .eq('tenant_id', TENANT_ID)
    .eq('category_id', categoryId)
    .maybeSingle()

  return data?.markup_pct ?? null
}

export async function upsertCategoryMarkup(categoryId: string, markupPct: number, minMarkupPct = 0) {
  const { data: existing } = await db
    .from('category_markups')
    .select('id')
    .eq('tenant_id', TENANT_ID)
    .eq('category_id', categoryId)
    .maybeSingle()

  if (existing) {
    const { data, error } = await db
      .from('category_markups')
      .update({ markup_pct: markupPct, min_markup_pct: minMarkupPct })
      .eq('id', existing.id)
      .select('*')
      .single()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    return data
  }

  const { data, error } = await db
    .from('category_markups')
    .insert({ tenant_id: TENANT_ID, category_id: categoryId, markup_pct: markupPct, min_markup_pct: minMarkupPct })
    .select('*')
    .single()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function deleteCategoryMarkup(categoryId: string) {
  const { error } = await db
    .from('category_markups')
    .delete()
    .eq('tenant_id', TENANT_ID)
    .eq('category_id', categoryId)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

// ── Розрахунок ціни ───────────────────────────────────────

interface PriceCalcParams {
  purchasePrice:  number   // копійки
  retailPrice:    number   // копійки (base)
  categoryId?:    string
  customerId?:    string
  quantity?:      number
}

interface PriceCalcResult {
  retail_price:    number   // базова роздрібна
  tier_price:      number   // ціна з урахуванням рівня клієнта
  discount_pct:    number   // знижка рівня %
  tier_name:       string | null
  min_price:       number   // мінімальна ціна (закупівля + min_markup)
}

export async function calculatePrice(params: PriceCalcParams): Promise<PriceCalcResult> {
  let retailPrice = params.retailPrice

  // Якщо є наценка категорії і базова роздрібна = 0 → розрахувати
  if (params.categoryId && retailPrice === 0 && params.purchasePrice > 0) {
    const markupPct = await getCategoryMarkup(params.categoryId)
    if (markupPct !== null) {
      retailPrice = Math.round(params.purchasePrice * (1 + markupPct / 100))
    }
  }

  // Мінімальна ціна
  let minPrice = params.purchasePrice
  if (params.categoryId) {
    const { data: markup } = await db
      .from('category_markups')
      .select('min_markup_pct')
      .eq('category_id', params.categoryId)
      .eq('tenant_id', TENANT_ID)
      .maybeSingle()
    if (markup) {
      minPrice = Math.round(params.purchasePrice * (1 + markup.min_markup_pct / 100))
    }
  }

  // Ціновий рівень клієнта
  let tierPrice = retailPrice
  let discountPct = 0
  let tierName: string | null = null

  if (params.customerId) {
    const { data: customer } = await db
      .from('customers')
      .select('price_tier_id')
      .eq('id', params.customerId)
      .maybeSingle()

    if (customer?.price_tier_id) {
      const { data: tier } = await db
        .from('price_tiers')
        .select('name, discount_pct')
        .eq('id', customer.price_tier_id)
        .maybeSingle()

      if (tier) {
        discountPct = Number(tier.discount_pct)
        tierName    = tier.name
        tierPrice   = Math.round(retailPrice * (1 - discountPct / 100))
        tierPrice   = Math.max(tierPrice, minPrice)
      }
    }
  }

  return { retail_price: retailPrice, tier_price: tierPrice, discount_pct: discountPct, tier_name: tierName, min_price: minPrice }
}

// ── Авто-розрахунок роздрібної при зміні закупівлі ───────

export async function autoRetailPrice(purchasePrice: number, categoryId?: string): Promise<number | null> {
  if (!categoryId) return null
  const markupPct = await getCategoryMarkup(categoryId)
  if (markupPct === null) return null
  return Math.round(purchasePrice * (1 + markupPct / 100))
}
