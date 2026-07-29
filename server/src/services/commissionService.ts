import { createHash } from 'node:crypto'
import { db } from '../db/supabase.js'
import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { AppError } from '../middleware/errorHandler.js'
import { logger } from '../lib/logger.js'
import { computeCommissionMap, type CommissionItem, type ProductsMap } from './commissionCalculator.js'
export { computeCommissionMap } from './commissionCalculator.js'

export interface CreateCommissionRuleInput {
  user_id?: string | null
  brand_id?: string | null
  category_id?: string | null
  pct_from_revenue: number
  pct_from_profit: number
  rule_type?: string
}

const TABLE = 'commission_rules'

function commissionReversalId(returnId: string, employeeId: string): string {
  const hex = createHash('sha256').update(`commission-reversal:${returnId}:${employeeId}`).digest('hex').slice(0, 32)
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// List all commission rules for a tenant
export async function listCommissionRules(tenantId: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

// Create a new commission rule
export async function createCommissionRule(input: CreateCommissionRuleInput, tenantId: string) {
  const { data, error } = await db
    .from(TABLE)
    .insert({
      tenant_id: tenantId,
      user_id: input.user_id || null,
      brand_id: input.brand_id || null,
      category_id: input.category_id || null,
      pct_from_revenue: input.pct_from_revenue,
      pct_from_profit: input.pct_from_profit,
      rule_type: input.rule_type || 'personal_sales',
    })
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

// Delete a commission rule
export async function deleteCommissionRule(id: string, tenantId: string) {
  const { error } = await db
    .from(TABLE)
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return { success: true }
}

// ── Спільний рушій нарахування комісії ────────────────────────────────────────
async function fetchProductsMap(productIds: (string | null)[], tenantId: string): Promise<ProductsMap> {
  const ids = productIds.filter((id): id is string => !!id)
  if (ids.length === 0) return {}
  const { data } = await db.from('products').select('id, brand_id, category_id, sku')
    .eq('tenant_id', tenantId).in('id', ids)
  const map: ProductsMap = {}
  for (const p of data ?? []) map[p.id] = { brand_id: p.brand_id, category_id: p.category_id, sku: p.sku }
  return map
}

function currentPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function currentWorkDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

async function resolveEmployeeName(userId: string, isManager: boolean): Promise<string> {
  const fallback = isManager ? 'Менеджер' : 'Співробітник'
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId)
    return data?.user?.user_metadata?.full_name || data?.user?.email || fallback
  } catch { return fallback }
}

/**
 * Комісія за прямий продаж на касі (модель «кожен за свої категорії»).
 * Викликати ЛИШЕ для продажів без замовлення — інакше комісія нарахується за замовленням.
 */
export async function calculateSaleCommission(saleId: string, tenantId: string, createdBy: string | null) {
  const { data: sale } = await db
    .from('sales').select('id, sale_number, manager_id').eq('id', saleId).eq('tenant_id', tenantId).single()
  if (!sale) return

  const { data: items } = await db
    .from('sale_items').select('product_id, qty, unit_price, cost_price').eq('sale_id', saleId).eq('tenant_id', tenantId)
  if (!items || items.length === 0) return

  const { data: rules } = await db.from(TABLE).select('*').eq('tenant_id', tenantId)
  if (!rules || rules.length === 0) return

  const productsMap = await fetchProductsMap(items.map((i) => i.product_id), tenantId)
  const commItems: CommissionItem[] = items.map((i) => ({
    product_id: i.product_id, sell_price: i.unit_price, buy_price: i.cost_price ?? 0, qty: Number(i.qty),
  }))
  const commMap = computeCommissionMap(commItems, productsMap, rules, sale.manager_id, 'pos')
  const period = currentPeriod()
  const workDate = currentWorkDate()

  for (const [candidateId, amount] of commMap) {
    if (amount <= 0) continue
    const isManager = candidateId === sale.manager_id
    const name = await resolveEmployeeName(candidateId, isManager)
    try {
      const { error } = await db.from('salary_payments').insert({
        tenant_id: tenantId, employee_id: candidateId, employee_name: name,
        amount, type: 'bonus', method: 'cash', period,
        source: 'commission', work_date: workDate,
        note: `Комісія за продаж (чек #${sale.sale_number})`,
        created_by: createdBy, commission_source_sale_id: sale.id,
      })
      if (error && error.code !== '23505') logger.error({ saleId, candidateId, error: error.message }, 'Failed to insert sale commission')
    } catch (err: any) { logger.error({ saleId, candidateId, err: err.message }, 'Exception while recording sale commission') }
  }
}

/**
 * Сторно комісії за повернені позиції: відʼємний бонус тим самим людям.
 * Щоб менеджеру не лишалась зарплата за товар, який клієнт повернув.
 */
export async function reverseCommissionForReturn(
  returnId: string,
  saleId: string,
  returnedItems: Array<{ product_id: string; quantity: number; sale_item_id: string }>,
  tenantId: string,
  createdBy: string | null,
) {
  const { data: sale } = await db
    .from('sales').select('id, sale_number, manager_id').eq('id', saleId).eq('tenant_id', tenantId).single()
  if (!sale) return

  // активний менеджер як при нарахуванні: для продажу по замовленню — менеджер замовлення
  const { data: order } = await db
    .from('customer_orders').select('manager_id')
    .eq('sale_id', saleId).eq('tenant_id', tenantId).maybeSingle()
  const activeManagerId = order?.manager_id ?? sale.manager_id

  const { data: rules } = await db.from(TABLE).select('*').eq('tenant_id', tenantId)
  if (!rules || rules.length === 0) return

  const { data: saleItems } = await db
    .from('sale_items').select('id, product_id, unit_price, cost_price').eq('tenant_id', tenantId).eq('sale_id', saleId).in('id', returnedItems.map((i) => i.sale_item_id))
  const priceMap = new Map((saleItems ?? []).map((si) => [si.id, si]))

  const commItems: CommissionItem[] = returnedItems.map((ri) => {
    const si = priceMap.get(ri.sale_item_id)
    return { product_id: si?.product_id ?? ri.product_id, sell_price: si?.unit_price ?? 0, buy_price: si?.cost_price ?? 0, qty: Number(ri.quantity) }
  })
  const productsMap = await fetchProductsMap(commItems.map((i) => i.product_id), tenantId)
  const commMap = computeCommissionMap(commItems, productsMap, rules, activeManagerId, order ? 'order' : 'pos')
  const period = currentPeriod()
  const workDate = currentWorkDate()

  for (const [candidateId, amount] of commMap) {
    if (amount <= 0) continue
    const isManager = candidateId === activeManagerId
    const name = await resolveEmployeeName(candidateId, isManager)
    const { error } = await db.from('salary_payments').insert({
      id: commissionReversalId(returnId, candidateId),
      tenant_id: tenantId, employee_id: candidateId, employee_name: name,
      amount: -amount, type: 'bonus', method: 'cash', period,
      source: 'commission_reversal', work_date: workDate,
      note: `Сторно комісії за повернення (чек #${sale.sale_number})`,
      created_by: createdBy, commission_source_return_id: returnId,
    })
    if (error && error.code !== '23505') {
      throw new AppError('COMMISSION_REVERSAL_FAILED', 'Не вдалося сторнувати комісію повернення', 500, error)
    }
  }
}

// Calculate and record manager commission for a completed order
export async function calculateAndRecordCommission(
  orderId: string,
  tenantId: string,
  createdBy: string | null
) {
  logger.info({ orderId, tenantId }, 'Starting commission calculation')

  // 1. Fetch the order
  const { data: order, error: orderErr } = await db
    .from('customer_orders')
    .select('*')
    .eq('id', orderId)
    .eq('tenant_id', tenantId)
    .single()

  if (orderErr || !order) {
    logger.error({ orderId, tenantId, error: orderErr?.message }, 'Order not found for commission calculation')
    return
  }

  // 2. Fetch order items
  const { data: items, error: itemsErr } = await db
    .from('customer_order_items')
    .select('*')
    .eq('order_id', orderId)

  if (itemsErr || !items || items.length === 0) {
    logger.info({ orderId }, 'No items found for commission calculation')
    return
  }

  // 3. Fetch product brand/category for all items that have product_id
  const productIds = items.map((i) => i.product_id).filter((id): id is string => !!id)
  let productsMap: ProductsMap = {}

  if (productIds.length > 0) {
    const { data: products, error: productsErr } = await db
      .from('products')
      .select('id, brand_id, category_id, sku')
      .eq('tenant_id', tenantId)
      .in('id', productIds)

    if (productsErr) {
      logger.error({ orderId, error: productsErr.message }, 'Failed to fetch product details for commission')
    } else if (products) {
      productsMap = products.reduce((acc, p) => {
        acc[p.id] = { brand_id: p.brand_id, category_id: p.category_id, sku: p.sku }
        return acc
      }, {} as typeof productsMap)
    }
  }

  // 4. Fetch all commission rules for this tenant
  const { data: rules, error: rulesErr } = await db
    .from(TABLE)
    .select('*')
    .eq('tenant_id', tenantId)

  if (rulesErr || !rules || rules.length === 0) {
    logger.info({ orderId, tenantId }, 'No commission rules defined for tenant')
    return
  }

  // 5-6. Розрахунок комісії по кожному отримувачу (спільний рушій)
  const commMap = computeCommissionMap(items as CommissionItem[], productsMap, rules, order.manager_id, 'order')
  const period = currentPeriod()
  const workDate = currentWorkDate()

  // 7-8. Запис у salary_payments
  for (const [candidateId, candidateCommission] of commMap) {
    if (candidateCommission <= 0) continue
    const isActiveManager = candidateId === order.manager_id
    const employeeName = await resolveEmployeeName(candidateId, isActiveManager)
    try {
      const { error: insertErr } = await db
        .from('salary_payments')
        .insert({
          tenant_id: tenantId,
          employee_id: candidateId,
          employee_name: employeeName,
          amount: candidateCommission,
          type: 'bonus',
          method: 'cash',
          source: 'commission',
          work_date: workDate,
          period,
          note: `Автоматична комісія за замовлення #${order.id.slice(0, 8)}${!isActiveManager ? ' (відсоток від каси)' : ''}`,
          created_by: createdBy,
          commission_source_order_id: order.id,
        })
      if (insertErr) {
        if (insertErr.code === '23505') logger.warn({ orderId, candidateId }, 'Commission already processed for this employee and order')
        else logger.error({ orderId, candidateId, error: insertErr.message }, 'Failed to insert commission payment')
      } else {
        logger.info({ orderId, candidateId, amount: candidateCommission }, 'Commission payment created successfully')
      }
    } catch (err: any) {
      logger.error({ orderId, candidateId, err: err.message }, 'Exception while recording commission payment')
    }
  }
}

