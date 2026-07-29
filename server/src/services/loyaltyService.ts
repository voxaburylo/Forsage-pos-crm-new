import { db } from '../db/supabase.js'
import { runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'

// No fallback TENANT_ID
const SETTINGS_TABLE = 'loyalty_settings'

async function expireBonuses(customerId: string, tenantId: string): Promise<number> {
  return runTransaction(async (client) => {
    const customer = await client.query(
      `SELECT COALESCE(bonus_balance, 0) AS bonus_balance
       FROM customers
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [customerId, tenantId],
    )
    if (!customer.rowCount) throw new AppError('NOT_FOUND', 'Клієнта не знайдено', 404)
    const balance = Number(customer.rows[0].bonus_balance ?? 0)
    if (balance <= 0) return 0
    const totals = await client.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (
           WHERE transaction_type = 'earn' AND amount > 0
             AND expires_at IS NOT NULL AND expires_at <= NOW()
         ), 0)::bigint AS expired_earned,
         COALESCE(-SUM(amount) FILTER (WHERE transaction_type = 'spend' AND amount < 0), 0)::bigint AS spent,
         COALESCE(-SUM(amount) FILTER (WHERE transaction_type = 'manual' AND amount < 0), 0)::bigint AS manual_spent,
         COALESCE(-SUM(amount) FILTER (WHERE transaction_type = 'expire' AND amount < 0), 0)::bigint AS already_expired
       FROM bonus_transactions
       WHERE customer_id = $1 AND tenant_id = $2`,
      [customerId, tenantId],
    )
    const row = totals.rows[0] ?? {}
    const amount = Math.min(balance, Math.max(0,
      Number(row.expired_earned ?? 0)
      - Number(row.spent ?? 0)
      - Number(row.manual_spent ?? 0)
      - Number(row.already_expired ?? 0),
    ))
    if (amount <= 0) return 0
    await client.query(
      'UPDATE customers SET bonus_balance = bonus_balance - $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
      [amount, customerId, tenantId],
    )
    await client.query(
      `INSERT INTO bonus_transactions
        (tenant_id, customer_id, amount, transaction_type, description)
       VALUES ($1, $2, $3, 'expire', 'Закінчився строк дії бонусів')`,
      [tenantId, customerId, -amount],
    )
    return amount
  })
}


// ── Налаштування ─────────────────────────────────────────

export async function getSettings(tenantId: string) {
  const { data } = await db
    .from(SETTINGS_TABLE)
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (!data) {
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
}, tenantId: string) {
  const existing = await db
    .from(SETTINGS_TABLE)
    .select('id')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (existing.data) {
    const { data, error } = await db
      .from(SETTINGS_TABLE)
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId)
      .select('*')
      .single()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    return data
  }

  const { data, error } = await db
    .from(SETTINGS_TABLE)
    .insert({ ...input, tenant_id: tenantId })
    .select('*')
    .single()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

// ── Баланс клієнта ────────────────────────────────────────

export async function getBalance(customerId: string, tenantId: string): Promise<number> {
  await expireBonuses(customerId, tenantId)
  const { data, error } = await db
    .from('customers')
    .select('bonus_balance')
    .eq('id', customerId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data?.bonus_balance ?? 0
}

export async function getTransactions(customerId: string, tenantId: string) {
  await expireBonuses(customerId, tenantId)
  const { data, error } = await db
    .from('bonus_transactions')
    .select('*')
    .eq('customer_id', customerId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  const list = data ?? []
  return list.map((t: any) => {
    let typeMapped = 'correction'
    if (t.transaction_type === 'earn') typeMapped = 'accrual'
    else if (t.transaction_type === 'spend') typeMapped = 'redemption'
    else if (t.transaction_type === 'expire') typeMapped = 'expiry'
    else if (t.transaction_type === 'manual') typeMapped = 'correction'

    return {
      id: t.id,
      tenant_id: t.tenant_id,
      customer_id: t.customer_id,
      type: typeMapped,
      amount_kopecks: Math.abs(t.amount),
      sale_id: t.source_sale_id,
      order_id: null,
      note: t.description,
      expires_at: t.expires_at || null,
      created_by: t.created_by || null,
      created_at: t.created_at,
    }
  })
}

// ── Нарахування після продажу ─────────────────────────────

export async function accrueBonus(params: {
  customerId: string
  saleId:     string
  saleTotal:  number
  userId:     string
  tenantId:   string
}): Promise<void> {
  const { data: customer } = await db
    .from('customers')
    .select('id')
    .eq('id', params.customerId)
    .eq('tenant_id', params.tenantId)
    .maybeSingle()

  if (!customer) throw new AppError('NOT_FOUND', 'Клієнта не знайдено', 404)
  const settings = await getSettings(params.tenantId)

  if (!settings.is_enabled) return
  if (params.saleTotal < settings.min_purchase_kopecks) return

  const amount = Math.round(params.saleTotal * (settings.accrual_pct / 100))
  if (amount <= 0) return

  const expiresAt = settings.expiry_days
    ? new Date(Date.now() + settings.expiry_days * 86400000).toISOString()
    : null

  const { error } = await db.rpc('process_bonus_earn', {
    p_customer_id: params.customerId,
    p_amount: amount,
    p_sale_id: params.saleId,
  })

  if (error) {
    throw new AppError('DB_ERROR', error.message, 500)
  }

  if (params.userId || expiresAt) {
    await db.from('bonus_transactions')
      .update({ created_by: params.userId, expires_at: expiresAt })
      .eq('customer_id', params.customerId)
      .eq('tenant_id', params.tenantId)
      .eq('source_sale_id', params.saleId)
      .eq('transaction_type', 'earn')
  }
}

// ── Списання бонусів ──────────────────────────────────────

export async function redeemBonus(params: {
  customerId: string
  amount:     number
  saleId:     string
  userId:     string
  tenantId:   string
}): Promise<void> {
  const { data: customer } = await db
    .from('customers')
    .select('id')
    .eq('id', params.customerId)
    .eq('tenant_id', params.tenantId)
    .maybeSingle()

  if (!customer) throw new AppError('NOT_FOUND', 'Клієнта не знайдено', 404)
  const settings = await getSettings(params.tenantId)
  if (!settings.is_enabled) {
    throw new AppError('LOYALTY_DISABLED', 'Програма лояльності вимкнена', 400)
  }

  const balance = await getBalance(params.customerId, params.tenantId)
  if (params.amount > balance) {
    throw new AppError('INSUFFICIENT_BONUS', 'Недостатньо бонусів', 400)
  }

  const saleId = params.saleId
  const { data: sale } = await db.from('sales')
    .select('id, customer_id, total, bonuses_spent, status')
    .eq('id', saleId)
    .eq('tenant_id', params.tenantId)
    .maybeSingle()
  if (!sale) throw new AppError('NOT_FOUND', 'Продаж не знайдено', 404)
  if (sale.customer_id !== params.customerId) {
    throw new AppError('CUSTOMER_MISMATCH', 'Продаж належить іншому клієнту', 409)
  }
  if (Number(sale.bonuses_spent ?? 0) > 0) {
    throw new AppError('BONUS_ALREADY_REDEEMED', 'Бонуси для цього продажу вже списані', 409)
  }
  const maxAllowed = await maxRedeem(Number(sale.total ?? 0), params.tenantId)
  if (params.amount > maxAllowed) {
    throw new AppError('BONUS_LIMIT_EXCEEDED', 'Сума бонусів перевищує дозволений відсоток чека', 409)
  }

  const { error } = await db.rpc('process_bonus_spend', {
    p_customer_id: params.customerId,
    p_amount: params.amount,
    p_sale_id: saleId,
  })

  if (error) {
    if (error.message === 'INSUFFICIENT_BONUS') {
      throw new AppError('INSUFFICIENT_BONUS', 'Недостатньо бонусів', 400)
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }

  if (params.userId) {
    await db.from('bonus_transactions')
      .update({ created_by: params.userId })
      .eq('customer_id', params.customerId)
      .eq('tenant_id', params.tenantId)
      .eq('source_sale_id', saleId)
      .eq('transaction_type', 'spend')
  }
}

// ── Націнка та сума списання ─────────────────────────────────

export async function maxRedeem(saleTotal: number, tenantId: string): Promise<number> {
  const settings = await getSettings(tenantId)
  if (!settings.is_enabled) return 0
  return Math.floor(saleTotal * (settings.max_redeem_pct / 100))
}
