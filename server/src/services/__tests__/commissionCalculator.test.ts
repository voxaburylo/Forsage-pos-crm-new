import { describe, expect, it } from 'vitest'
import { computeCommissionMap, type ProductsMap } from '../commissionCalculator.js'

const manager = 'manager'
const cashboxOwner = 'cashbox-owner'
const products: ProductsMap = {
  regular: { brand_id: null, category_id: 'parts', sku: 'PART-1' },
  tire: { brand_id: null, category_id: 'service', sku: 'POS-TIRE-SERVICE' },
}
const item = (product_id: string) => ({
  product_id,
  sell_price: 10_000,
  buy_price: 5_000,
  qty: 1,
})

describe('commission calculation contexts', () => {
  it('prefers POS rules over a more specific personal fallback', () => {
    const result = computeCommissionMap([item('regular')], products, [
      { user_id: manager, category_id: 'parts', brand_id: null, rule_type: 'personal_sales', pct_from_revenue: 20 },
      { user_id: null, category_id: null, brand_id: null, rule_type: 'pos_sales', pct_from_revenue: 5 },
    ], manager, 'pos')

    expect(result.get(manager)).toBe(500)
  })

  it('prefers tyre-service rules for the dedicated service item', () => {
    const result = computeCommissionMap([item('tire')], products, [
      { user_id: manager, category_id: null, brand_id: null, rule_type: 'personal_sales', pct_from_revenue: 2 },
      { user_id: manager, category_id: null, brand_id: null, rule_type: 'pos_sales', pct_from_revenue: 5 },
      { user_id: manager, category_id: null, brand_id: null, rule_type: 'tire_service', pct_from_revenue: 12 },
    ], manager, 'pos')

    expect(result.get(manager)).toBe(1_200)
  })

  it('uses order rules for an order and falls back to personal only when needed', () => {
    const orderRule = computeCommissionMap([item('regular')], products, [
      { user_id: manager, category_id: null, brand_id: null, rule_type: 'pos_sales', pct_from_revenue: 20 },
      { user_id: manager, category_id: null, brand_id: null, rule_type: 'order_sales', pct_from_revenue: 7 },
      { user_id: manager, category_id: null, brand_id: null, rule_type: 'personal_sales', pct_from_revenue: 2 },
    ], manager, 'order')
    expect(orderRule.get(manager)).toBe(700)

    const fallback = computeCommissionMap([item('regular')], products, [
      { user_id: manager, category_id: 'other', brand_id: null, rule_type: 'order_sales', pct_from_revenue: 7 },
      { user_id: manager, category_id: null, brand_id: null, rule_type: 'personal_sales', pct_from_revenue: 2 },
    ], manager, 'order')
    expect(fallback.get(manager)).toBe(200)
  })

  it('adds an assigned total-cashbox rule independently of the active manager rule', () => {
    const result = computeCommissionMap([item('regular')], products, [
      { user_id: manager, category_id: null, brand_id: null, rule_type: 'pos_sales', pct_from_revenue: 5 },
      { user_id: cashboxOwner, category_id: null, brand_id: null, rule_type: 'total_cashbox', pct_from_revenue: 3 },
    ], manager, 'pos')

    expect(result.get(manager)).toBe(500)
    expect(result.get(cashboxOwner)).toBe(300)
  })

  it('uses the same context result for a return reversal base and skips canceled rows', () => {
    const rules = [
      { user_id: manager, category_id: null, brand_id: null, rule_type: 'order_sales', pct_from_revenue: 7 },
    ]
    const earned = computeCommissionMap([item('regular')], products, rules, manager, 'order')
    const reversalBase = computeCommissionMap([item('regular')], products, rules, manager, 'order')
    expect(reversalBase).toEqual(earned)

    const canceled = computeCommissionMap([
      { ...item('regular'), item_status: 'canceled' },
    ], products, rules, manager, 'order')
    expect(canceled.size).toBe(0)
  })
})