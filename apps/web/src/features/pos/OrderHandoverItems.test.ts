import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { handoverRows } from './OrderHandoverItems'

const item = (over: Record<string, unknown> = {}) => ({ id: 'i1', product_id: null, sku: 'GDB1330', name: 'Колодки передні', sell_price: 125000, qty: 2, item_status: 'ordered', source_type: 'supplier' as const, ...over })

describe('order items at handover (stage 5, owner decision 22.11.2026: handover with photos)', () => {
  it('shows what is here, what is still on the way and what was already handed', () => {
    expect(handoverRows([
      item(),
      item({ id: 'i2', item_status: 'arrived' }),
      item({ id: 'i3', item_status: 'pending', source_type: 'warehouse', product_id: 'p3' }),
      item({ id: 'i4', item_status: 'pending' }),
      item({ id: 'i5', item_status: 'handed' }),
    ]).map(row => [row.id, row.state, row.productId])).toEqual([
      ['i1', 'waiting', null], ['i2', 'here', null], ['i3', 'here', 'p3'], ['i4', 'waiting', null], ['i5', 'handed', null],
    ])
  })
  it('hides cancelled and returned items and counts the line total', () => {
    const rows = handoverRows([item(), item({ id: 'x', item_status: 'canceled' }), item({ id: 'y', item_status: 'returned' })])
    expect(rows).toEqual([{ id: 'i1', productId: null, name: 'Колодки передні', sku: 'GDB1330', qty: 2, total: 250000, state: 'waiting' }])
    expect(handoverRows([item({ qty: Number.NaN, sell_price: 'x', sku: null })])[0]).toMatchObject({ qty: 0, total: 0, sku: '' })
  })
  it('is shown in both layouts of the handover panel and only reads data', () => {
    const panel = readFileSync(new URL('./ReadyOrdersPanel.tsx', import.meta.url), 'utf8')
    // 24.11.2026 (план C2): разом із позиціями — мініатюри позицій замовлення (orderId).
    expect(panel.split('<OrderHandoverItems items={order.items ?? []} orderId={order.id} />').length - 1).toBe(2)
    const source = readFileSync(new URL('./OrderHandoverItems.tsx', import.meta.url), 'utf8')
    for (const banned of ['addPayment', 'complete(', 'updateItemStatus', 'save(']) expect(source).not.toContain(banned)
  })
})
