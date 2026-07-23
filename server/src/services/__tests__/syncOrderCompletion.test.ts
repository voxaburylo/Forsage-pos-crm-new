import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')
const completionSource = source.slice(
  source.indexOf('export async function applyOrderCompleted'),
  source.indexOf('function normalizePaymentMethod'),
)

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
