import { syncFunctionBody } from './helpers/syncSource.js'
import { describe, expect, it } from 'vitest'

const completionSource = syncFunctionBody('applyOrderCompleted')

describe('offline order completion sync regression', () => {
  it('selects every non-canceled line when the order has no linked sale', () => {
    const itemSelection = completionSource.match(
      /const itemResult = await client\.query\(([\s\S]*?)if \(!itemResult\.rowCount\)/,
    )?.[1]

    expect(itemSelection).toContain("AND item.item_status <> 'canceled'")
    expect(itemSelection).not.toContain("item_status <> 'handed'")
    expect(itemSelection).not.toContain('$2::boolean')
    expect(itemSelection).toContain('parent.tenant_id = $2')
  })

  it('includes core_deposit_amount per quantity in sale and sale-item totals', () => {
    expect(completionSource).toContain(
      'const lineTotal = merchandiseTotal + Math.round(coreDepositAmount * qty)',
    )
    expect(completionSource).toContain('subtotal += lineTotal')
    expect(completionSource).toContain('total: lineTotal')
  })

  it('replays an existing linked sale before any stock update and repairs a missing sale', () => {
    const linkedReplay = completionSource.indexOf('if (linkedSaleId)')
    const itemLoad = completionSource.indexOf('const itemResult = await client.query')
    const stockUpdate = completionSource.indexOf("'UPDATE products SET qty_on_hand = qty_on_hand - $1")

    expect(linkedReplay).toBeGreaterThanOrEqual(0)
    expect(linkedReplay).toBeLessThan(itemLoad)
    expect(itemLoad).toBeLessThan(stockUpdate)
    expect(completionSource).not.toContain("if (order.status === 'completed') return")
    expect(completionSource).not.toContain('INSERT INTO cash_operations')
    expect(completionSource).toContain('tenant_id = $3 AND released_at IS NULL')
    expect(completionSource).toContain('SYNC_SALE_TENANT_CONFLICT')
  })
})

describe('order paid with bonuses (owner decision 20.11.2026)', () => {
  const cancelSource = syncFunctionBody('applyOrderCanceled')
  it('counts bonus payments toward the order and records them on the sale like a till sale', () => {
    expect(completionSource).toContain("if (payment.method === 'bonus') paymentTotals.bonus += amount")
    expect(completionSource).toContain('paymentTotals.cash + paymentTotals.card + paymentTotals.transfer + paymentTotals.bonus')
    expect(completionSource).toContain('const discount = orderDiscount + bonusesSpent')
    expect(completionSource).toContain('pickup_cell, bonuses_spent')
  })
  it('returns the bonus part to bonuses and only the rest to the prepayment account on cancel', () => {
    expect(cancelSource).toContain("FILTER (WHERE method = 'bonus')")
    expect(cancelSource).toContain("VALUES ($1, $2, $3, $4, 'refund'")
    expect(cancelSource).toContain('const depositPaid = paidAmount - bonusPaid')
    expect(cancelSource).toContain('if (!operation.balance_mirrored)')
  })
})
