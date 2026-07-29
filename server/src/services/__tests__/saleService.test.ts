import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { calculateSaleAmounts, saleRequestHash } from '../salePayment.js'

describe('calculateSaleAmounts', () => {
  it('should assign full amount to cash for cash payment', () => {
    const result = calculateSaleAmounts({ payment_method: 'cash' } as any, 10000)
    expect(result.cashAmount).toBe(10000)
    expect(result.cardAmount).toBe(0)
  })

  it('should assign full amount to card for card payment', () => {
    const result = calculateSaleAmounts({ payment_method: 'card' } as any, 5000)
    expect(result.cashAmount).toBe(0)
    expect(result.cardAmount).toBe(5000)
  })

  it('should split amounts for mixed payment', () => {
    const result = calculateSaleAmounts(
      { payment_method: 'mixed', cash_amount: 3000, card_amount: 7000 } as any,
      10000
    )
    expect(result.cashAmount).toBe(3000)
    expect(result.cardAmount).toBe(7000)
  })

  it('rejects a mixed split that does not equal the receipt total', () => {
    expect(() => calculateSaleAmounts(
      { payment_method: 'mixed', cash_amount: 3000, card_amount: 6000 } as any,
      10000,
    )).toThrow(/має дорівнювати сумі чека/)
  })

  it('assigns the full receipt to bank transfer', () => {
    const result = calculateSaleAmounts({ payment_method: 'transfer' } as any, 4200)
    expect(result.transferAmount).toBe(4200)
    expect(result.cashAmount).toBe(0)
    expect(result.cardAmount).toBe(0)
  })

  it('should assign zero for debt payment', () => {
    const result = calculateSaleAmounts({ payment_method: 'debt' } as any, 10000)
    expect(result.cashAmount).toBe(0)
    expect(result.cardAmount).toBe(0)
  })

  it('should always initialize bonusesEarned to 0', () => {
    const result = calculateSaleAmounts({ payment_method: 'cash' } as any, 10000)
    expect(result.bonusesEarned).toBe(0)
  })
})

describe('sale idempotency payload', () => {
  it('is stable across object key order and changes when payment data changes', () => {
    const first = {
      shift_id: '00000000-0000-0000-0000-000000000001',
      items: [{ product_id: '00000000-0000-0000-0000-000000000002', qty: 1, unit_price: 1000, discount: 0 }],
      payment_method: 'cash', discount: 0, cash_amount: 0, card_amount: 0,
      is_fiscal: false, bonuses_spent: 0,
    } as any
    const reordered = {
      bonuses_spent: 0, is_fiscal: false, card_amount: 0, cash_amount: 0,
      discount: 0, payment_method: 'cash', items: first.items, shift_id: first.shift_id,
    } as any
    expect(saleRequestHash(first)).toBe(saleRequestHash(reordered))
    expect(saleRequestHash(first)).not.toBe(saleRequestHash({ ...first, discount: 1 }))
  })
})

describe('discount calculation', () => {
  it('should calculate discounted total correctly', () => {
    const items = [
      { unit_price: 5000, qty: 2, discount: 0 },
      { unit_price: 3000, qty: 1, discount: 0 },
    ]
    const subtotal = items.reduce((s, i) => s + i.unit_price * i.qty, 0)
    const discount = 1000
    const discountedTotal = Math.max(0, subtotal - discount)
    expect(subtotal).toBe(13000)
    expect(discountedTotal).toBe(12000)
  })

  it('should not allow negative discounted total', () => {
    const subtotal = 5000
    const discount = 10000
    const discountedTotal = Math.max(0, subtotal - discount)
    expect(discountedTotal).toBe(0)
  })
})

describe('sale number formatting', () => {
  it('should pad sale number to 6 digits', () => {
    const saleNumber = String(42).padStart(6, '0')
    expect(saleNumber).toBe('000042')
  })

  it('should handle large numbers', () => {
    const saleNumber = String(999999).padStart(6, '0')
    expect(saleNumber).toBe('999999')
  })
})
describe('sale transaction tenant isolation regressions', () => {
  const source = readFileSync(new URL('../saleService.ts', import.meta.url), 'utf8')

  it('scopes customer bonus and linked order writes to the active tenant', () => {
    expect(source).toContain(
      'UPDATE customers SET bonus_balance = COALESCE(bonus_balance, 0) + $1 WHERE id = $2 AND tenant_id = $3',
    )
    expect(source).toContain(
      'SELECT id, status, sale_id FROM customer_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    )
    expect(source).toContain(
      'UPDATE inventory_reserves SET released_at = NOW() WHERE order_id = $1 AND tenant_id = $2 AND released_at IS NULL',
    )
    expect(source).toContain(
      "UPDATE customer_orders SET status = 'completed', sale_id = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3",
    )
  })

  it('does not bind a fourth value to the three-placeholder order activity query', () => {
    expect(source).not.toMatch(/cashierId,\s*'completed',\s*JSON\.stringify/)
    expect(source).toMatch(/cashierId,\s*JSON\.stringify\(\{ sale_id:/)
  })

  it('validates a selected customer in the current tenant even without bonus spending', () => {
    expect(source).toContain(
      'SELECT id FROM customers WHERE id = $1 AND tenant_id = $2 FOR SHARE',
    )
  })

  it('commits sale and idempotency result in the same transaction', () => {
    expect(source).toContain('client_operation_id')
    expect(source).toContain("status = 'completed', response = $1::jsonb, request_hash = $2")
  })

  it('does not mark a failed fiscal attempt as fiscalized', () => {
    expect(source).toContain("extraData.fiscal_status = fiscalNumber ? 'completed' : 'failed'")
    expect(source).not.toContain('if (input.is_fiscal) extraData.is_fiscal = true')
  })
})
