export interface CommissionItem {
  product_id: string | null
  item_status?: string | null
  sell_price: number
  buy_price: number
  qty: number
}

export type ProductsMap = Record<string, {
  brand_id: string | null
  category_id: string | null
  sku?: string | null
}>

export type CommissionContext = 'pos' | 'order'

interface CommissionRule {
  user_id?: string | null
  brand_id?: string | null
  category_id?: string | null
  rule_type?: string | null
  pct_from_revenue?: number | null
  pct_from_profit?: number | null
}

function normalizedRuleType(rule: CommissionRule): string {
  return String(rule.rule_type || 'personal_sales')
}

function matchesProduct(
  rule: CommissionRule,
  brandId: string | null,
  categoryId: string | null,
): boolean {
  return (rule.brand_id == null || rule.brand_id === brandId)
    && (rule.category_id == null || rule.category_id === categoryId)
}

function specificity(rule: CommissionRule): number {
  return (rule.user_id ? 100 : 0)
    + (rule.brand_id ? 10 : 0)
    + (rule.category_id ? 1 : 0)
}

function bestRule(
  rules: CommissionRule[],
  userId: string,
  types: string[],
  brandId: string | null,
  categoryId: string | null,
): CommissionRule | null {
  for (const type of types) {
    let best: CommissionRule | null = null
    let bestScore = -1
    for (const rule of rules) {
      if (normalizedRuleType(rule) !== type) continue
      if (rule.user_id !== null && rule.user_id !== undefined && rule.user_id !== userId) continue
      if (!matchesProduct(rule, brandId, categoryId)) continue
      const score = specificity(rule)
      if (score > bestScore) {
        best = rule
        bestScore = score
      }
    }
    if (best) return best
  }
  return null
}

function commissionAmount(rule: CommissionRule, item: CommissionItem): number {
  const revenue = Number(item.sell_price) * Number(item.qty)
  const profit = (Number(item.sell_price) - Number(item.buy_price)) * Number(item.qty)
  return Math.round(revenue * Number(rule.pct_from_revenue ?? 0) / 100)
    + Math.round(profit * Number(rule.pct_from_profit ?? 0) / 100)
}

export function computeCommissionMap(
  items: CommissionItem[],
  productsMap: ProductsMap,
  rules: CommissionRule[],
  activeManagerId: string | null,
  context: CommissionContext = 'pos',
): Map<string, number> {
  const result = new Map<string, number>()
  const totalCashboxUsers = new Set(
    rules
      .filter((rule) => normalizedRuleType(rule) === 'total_cashbox' && rule.user_id)
      .map((rule) => String(rule.user_id)),
  )

  const add = (userId: string, amount: number) => {
    if (amount !== 0) result.set(userId, (result.get(userId) ?? 0) + amount)
  }

  for (const item of items) {
    if (item.item_status === 'canceled') continue
    const product = item.product_id ? productsMap[item.product_id] : null
    const brandId = product?.brand_id ?? null
    const categoryId = product?.category_id ?? null

    if (activeManagerId) {
      const isTireService = context === 'pos' && String(product?.sku ?? '') === 'POS-TIRE-SERVICE'
      const preferredTypes = context === 'order'
        ? ['order_sales', 'personal_sales']
        : isTireService
          ? ['tire_service', 'pos_sales', 'personal_sales']
          : ['pos_sales', 'personal_sales']
      const rule = bestRule(rules, activeManagerId, preferredTypes, brandId, categoryId)
      if (rule) add(activeManagerId, commissionAmount(rule, item))
    }

    for (const userId of totalCashboxUsers) {
      const rule = bestRule(rules, userId, ['total_cashbox'], brandId, categoryId)
      if (rule) add(userId, commissionAmount(rule, item))
    }
  }

  for (const [userId, amount] of result) {
    if (amount <= 0) result.delete(userId)
  }
  return result
}