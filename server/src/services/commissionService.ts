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

  let totalCommission = 0

  // 5. Calculate commission for each item
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
      // User matching constraint
      if (rule.user_id !== null && rule.user_id !== order.manager_id) {
        continue
      }
      // Brand matching constraint
      if (rule.brand_id !== null && rule.brand_id !== brandId) {
        continue
      }
      // Category matching constraint
      if (rule.category_id !== null && rule.category_id !== categoryId) {
        continue
      }

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
      totalCommission += itemComm

      logger.debug(
        { itemId: item.id, score: maxScore, pctRevenue, pctProfit, itemComm },
        'Matched commission rule'
      )
    }
  }

  if (totalCommission <= 0) {
    logger.info({ orderId }, 'Calculated commission is 0 or less')
    return
  }

  // 6. Resolve manager full name
  let managerName = 'Менеджер'
  try {
    const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(order.manager_id)
    if (userError || !userData?.user) {
      logger.warn({ managerId: order.manager_id, error: userError?.message }, 'Failed to fetch manager from auth')
    } else {
      managerName = userData.user.user_metadata?.full_name || userData.user.email || 'Менеджер'
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'Error retrieving manager name')
  }

  // 7. Write to salary_payments
  const date = new Date()
  const period = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

  try {
    const { data: payment, error: insertErr } = await db
      .from('salary_payments')
      .insert({
        tenant_id: tenantId,
        employee_id: order.manager_id,
        employee_name: managerName,
        amount: totalCommission,
        type: 'bonus',
        method: 'cash',
        period,
        note: `Автоматична комісія за замовлення #${order.id.slice(0, 8)}`,
        created_by: createdBy,
        commission_source_order_id: order.id,
      })
      .select('*')
      .single()

    if (insertErr) {
      if (insertErr.code === '23505') { // Unique constraint violation code in PostgreSQL
        logger.warn({ orderId }, 'Commission already processed for this order (duplicate prevent)')
      } else {
        logger.error({ orderId, error: insertErr.message }, 'Failed to insert commission payment')
      }
    } else {
      logger.info({ orderId, paymentId: payment.id, amount: totalCommission }, 'Commission payment created successfully')
    }
  } catch (err: any) {
    logger.error({ orderId, err: err.message }, 'Exception while recording commission payment')
  }
}
