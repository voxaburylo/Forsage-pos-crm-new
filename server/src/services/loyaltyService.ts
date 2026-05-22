import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'
const SETTINGS_TABLE     = 'loyalty_settings'
const TRANSACTION_TABLE  = 'loyalty_transactions'

// ── Налаштування ─────────────────────────────────────────

export async function getSettings() {
  const { data } = await db
    .from(SETTINGS_TABLE)
    .select('*')
    .eq('tenant_id', TENANT_ID)
    .maybeSingle()

  if (!data) {
    // Повертаємо дефолт якщо налаштувань ще немає
    return {
      is_enabled:           false,
      accrual_pct:          2,
      max_redeem_pct:       30,
      expiry_days:          null as number | null,
      min_purchase_kopecks: 10000,
    }
  }
  return data
}

export async function updateSettings(input: {
  is_enabled?:           boolean
  accrual_pct?:          number
  max_redeem_pct?:       number
  expiry_days?:          number | null
  min_purchase_kopecks?: number
}) {
  const existing = await db
    .from(SETTINGS_TABLE)
    .select('id')
    .eq('tenant_id', TENANT_ID)
    .maybeSingle()

  if (existing.data) {
    const { data, error } = await db
      .from(SETTINGS_TABLE)
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('tenant_id', TENANT_ID)
      .select('*')
      .single()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    return data
  }

  const { data, error } = await db
    .from(SETTINGS_TABLE)
    .insert({ ...input, tenant_id: TENANT_ID })
    .select('*')
    .single()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

// ── Баланс клієнта ────────────────────────────────────────

export async function getBalance(customerId: string): Promise<number> {
  const { data, error } = await db
    .from(TRANSACTION_TABLE)
    .select('type, amount_kopecks')
    .eq('customer_id', customerId)

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  const list = data ?? []
  return list.reduce((sum, t) => {
    if (t.type === 'accrual')    return sum + t.amount_kopecks
    if (t.type === 'redemption') return sum - t.amount_kopecks
    if (t.type === 'expiry')     return sum - t.amount_kopecks
    return sum
  }, 0)
}

export async function getTransactions(customerId: string) {
  const { data, error } = await db
    .from(TRANSACTION_TABLE)
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

// ── Нарахування після продажу ─────────────────────────────

export async function accrueBonus(params: {
  customerId: string
  saleId:     string
  saleTotal:  number   // копійки — сума на яку нараховуємо
  userId:     string
}): Promise<void> {
  const settings = await getSettings()

  if (!settings.is_enabled) return
  if (params.saleTotal < settings.min_purchase_kopecks) return

  const amount = Math.round(params.saleTotal * (settings.accrual_pct / 100))
  if (amount <= 0) return

  const expiresAt = settings.expiry_days
    ? new Date(Date.now() + settings.expiry_days * 86400000).toISOString()
    : null

  await db.from(TRANSACTION_TABLE).insert({
    tenant_id:     TENANT_ID,
    customer_id:   params.customerId,
    type:          'accrual',
    amount_kopecks: amount,
    sale_id:       params.saleId,
    created_by:    params.userId,
    expires_at:    expiresAt,
  })
}

// ── Списання бонусів ──────────────────────────────────────

export async function redeemBonus(params: {
  customerId: string
  amount:     number   // копійки
  saleId?:    string
  userId:     string
}): Promise<void> {
  const settings = await getSettings()
  if (!settings.is_enabled) {
    throw new AppError('LOYALTY_DISABLED', 'Програма лояльності вимкнена', 400)
  }

  const balance = await getBalance(params.customerId)
  if (params.amount > balance) {
    throw new AppError('INSUFFICIENT_BONUS', 'Недостатньо бонусів', 400)
  }

  await db.from(TRANSACTION_TABLE).insert({
    tenant_id:      TENANT_ID,
    customer_id:    params.customerId,
    type:           'redemption',
    amount_kopecks: params.amount,
    sale_id:        params.saleId ?? null,
    created_by:     params.userId,
    expires_at:     null,
  })
}

// ── Максимально дозволена сума списання для чека ──────────

export async function maxRedeem(saleTotal: number): Promise<number> {
  const settings = await getSettings()
  if (!settings.is_enabled) return 0
  return Math.floor(saleTotal * (settings.max_redeem_pct / 100))
}
