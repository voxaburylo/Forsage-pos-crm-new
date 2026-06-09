import { db } from '../db/supabase.js'
import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { AppError } from '../middleware/errorHandler.js'
import { logger } from '../lib/logger.js'

export interface CreateCommissionRuleInput {
  user_id?: string | null
  brand_id?: string | null
  category_id?: string | null
  pct_from_revenue: number
  pct_from_profit: number
  rule_type?: string
}

const TABLE = 'commission_rules'

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
  let productsMap: Record<string, { brand_id: string | null; category_id: string | null }> = {}

  if (productIds.length > 0) {
    const { data: products, error: productsErr } = await db
      .from('products')
      .select('id, brand_id, category_id')
      .in('id', productIds)

    if (productsErr) {
      logger.error({ orderId, error: productsErr.message }, 'Failed to fetch product details for commission')
    } else if (products) {
      productsMap = products.reduce((acc, p) => {
        acc[p.id] = { brand_id: p.brand_id, category_id: p.category_id }
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

  // 5. Gather potential commission recipients
  const candidates = new Set<string>()
  if (order.manager_id) candidates.add(order.manager_id)
  for (const rule of rules) {
    if (rule.rule_type === 'total_cashbox' && rule.user_id) {
      candidates.add(rule.user_id)
    }
  }

  const date = new Date()
  const period = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

  // 6. Calculate commission per candidate
  for (const candidateId of candidates) {
    let candidateCommission = 0
    const isActiveManager = candidateId === order.manager_id

    for (const item of items) {
      // Skip canceled items
      if (item.item_status === 'canceled') continue

      const prodInfo = item.product_id ? productsMap[item.product_id] : null
      const brandId = prodInfo?.brand_id || null
      const categoryId = prodInfo?.category_id || null

      const revenue = item.sell_price * item.qty
      const profit = (item.sell_price - item.buy_price) * item.qty

      let bestRule: any = null
      let maxScore = -1

      for (const rule of rules) {
        // Match user constraint
        let matchesUser = false
        if (rule.user_id === candidateId) {
          if (rule.rule_type === 'total_cashbox' || isActiveManager) {
            matchesUser = true
          }
        } else if (rule.user_id === null && isActiveManager) {
          if (!rule.rule_type || rule.rule_type === 'personal_sales') {
            matchesUser = true
          }
        }

        if (!matchesUser) continue

        // Brand matching constraint
        if (rule.brand_id !== null && rule.brand_id !== brandId) continue

        // Category matching constraint
        if (rule.category_id !== null && rule.category_id !== categoryId) continue

        // Calculate rule score
        let score = 0
        if (rule.user_id !== null) score += 100
        if (rule.brand_id !== null) score += 10
        if (rule.category_id !== null) score += 1

        if (score > maxScore) {
          maxScore = score
          bestRule = rule
        }
      }

      if (bestRule) {
        const pctRevenue = Number(bestRule.pct_from_revenue) || 0
        const pctProfit = Number(bestRule.pct_from_profit) || 0

        const itemComm = Math.round(revenue * (pctRevenue / 100)) + Math.round(profit * (pctProfit / 100))
        candidateCommission += itemComm
      }
    }

    if (candidateCommission <= 0) continue

    // 7. Resolve employee name
    let employeeName = isActiveManager ? 'Менеджер' : 'Співробітник'
    try {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(candidateId)
      if (userData?.user) {
        employeeName = userData.user.user_metadata?.full_name || userData.user.email || (isActiveManager ? 'Менеджер' : 'Співробітник')
      }
    } catch (err: any) {
      logger.error({ candidateId, err: err.message }, 'Error retrieving employee name for commission')
    }

    // 8. Write to salary_payments
    try {
      const { data: payment, error: insertErr } = await db
        .from('salary_payments')
        .insert({
          tenant_id: tenantId,
          employee_id: candidateId,
          employee_name: employeeName,
          amount: candidateCommission,
          type: 'bonus',
          method: 'cash',
          period,
          note: `Автоматична комісія за замовлення #${order.id.slice(0, 8)}${!isActiveManager ? ' (відсоток від каси)' : ''}`,
          created_by: createdBy,
          commission_source_order_id: order.id,
        })
        .select('*')
        .single()

      if (insertErr) {
        if (insertErr.code === '23505') { // Unique constraint violation
          logger.warn({ orderId, candidateId }, 'Commission already processed for this employee and order')
        } else {
          logger.error({ orderId, candidateId, error: insertErr.message }, 'Failed to insert commission payment')
        }
      } else {
        logger.info({ orderId, candidateId, paymentId: payment.id, amount: candidateCommission }, 'Commission payment created successfully')
      }
    } catch (err: any) {
      logger.error({ orderId, candidateId, err: err.message }, 'Exception while recording commission payment')
    }
  }
}

