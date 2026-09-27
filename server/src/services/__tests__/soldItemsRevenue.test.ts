import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { allocateReceiptRevenue } from '../../lib/receiptRevenue.js'
const mocks = vi.hoisted(() => ({ from: vi.fn(), read: vi.fn(), suppliers: vi.fn() }))
vi.mock('../../db/supabase.js', () => ({ db: { from: mocks.from } }))
vi.mock('../../lib/readReportPages.js', () => ({ readReportPages: mocks.read }))
vi.mock('../soldItemSuppliers.js', () => ({ loadSoldItemSuppliers: mocks.suppliers }))
import { getSoldItems } from '../reportService.js'

describe('sold product revenue after receipt discount', () => {
  let data: Record<string, any[]>, queries: any[]
  beforeEach(() => {
    vi.resetAllMocks(); queries = []
    data = { sales: [{ id: 'sale', total: 27000 }], sale_items: [
      { id: 'goods', sale_id: 'sale', product_id: 'p', total: 20000, qty: 2, product: { name: 'Фільтр', is_service: false } },
      { id: 'service', sale_id: 'sale', product_id: 's', total: 5000, qty: 1, product: { is_service: true } },
      { id: 'free', sale_id: 'sale', product_id: null, total: 5000, qty: 1 },
    ], returns: [{ id: 'r' }], return_items: [{ product_id: 'p', quantity: 1, total_kopecks: 9000 }] }
    mocks.from.mockImplementation(table => {
      const query = { table, ...Object.fromEntries(['select', 'eq', 'in', 'gte', 'lt', 'order'].map(key => [key, vi.fn().mockReturnThis()])) }
      queries.push(query); return query
    })
    mocks.read.mockImplementation(async query => ({ data: data[query.table] ?? [], error: null }))
    mocks.suppliers.mockResolvedValue(new Map([['p', [{ id: 'supplier', name: 'Автокомфорт' }]]]))
  })
  it('allocates over all lines before excluding services, subtracts the actual refund, retains suppliers', async () => {
    expect(await getSoldItems('2026-09-20', '2026-09-20', 'tenant')).toEqual([expect.objectContaining({
      product_id: 'p', qty_sold: 2, qty_returned: 1, qty_net: 1, revenue: 18000, refund_total: 9000, net_revenue: 9000,
      suppliers: [{ id: 'supplier', name: 'Автокомфорт' }],
    })])
    for (const query of queries) expect(query.eq).toHaveBeenCalledWith('tenant_id', 'tenant')
    expect(queries.find(q => q.table === 'sales').select).toHaveBeenCalledWith('id, total')
    expect(queries.find(q => q.table === 'sale_items').select.mock.calls[0][0]).toContain('id, sale_id, product_id, qty, total')
  })
  it('does not subtract item discounts twice or turn a zero-price receipt into revenue', async () => {
    data.sales[0].total = 18000
    data.sale_items = [{ ...data.sale_items[0], total: 18000 }]
    data.returns = []
    expect((await getSoldItems('2026-09-20', '2026-09-20', 'tenant'))[0].revenue).toBe(18000)
    data.sales[0].total = 0
    expect((await getSoldItems('2026-09-20', '2026-09-20', 'tenant'))[0].revenue).toBe(0)
  })
  it('fails rather than silently returning a partial report on a read failure', async () => {
    mocks.read.mockResolvedValueOnce({ data: [], error: { message: 'test read failure' } })
    await expect(getSoldItems('2026-09-20', '2026-09-20', 'tenant')).rejects.toThrow('test read failure')
    expect(mocks.suppliers).not.toHaveBeenCalled()
  })
})

describe('exact receipt allocation', () => {
  it('keeps compiled desktop and server implementations identical without runtime TS imports', () => {
    const local = readFileSync(new URL('../../../../apps/desktop/src/lib/receiptRevenue.ts', import.meta.url), 'utf8')
    const server = readFileSync(new URL('../../lib/receiptRevenue.ts', import.meta.url), 'utf8')
    expect(local.replaceAll('\r\n', '\n')).toBe(server.replaceAll('\r\n', '\n'))
  })
  it('preserves every kopeck and does not depend on query order', () => {
    for (let n = 1; n <= 100; n++) {
      const lines = Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(3, '0'), total: (i * 117 + n) % 1051 }))
      const sum = lines.reduce((s, l) => s + l.total, 0), total = Math.floor(sum * .73)
      const result = allocateReceiptRevenue(total, lines)
      expect([...result.values()].reduce((a, b) => a + b, 0)).toBe(total)
      expect(allocateReceiptRevenue(total, [...lines].reverse())).toEqual(result)
      for (const line of lines) expect(result.get(line.id)).toBeLessThanOrEqual(line.total)
    }
    expect(allocateReceiptRevenue(1, [{ id: 'b', total: 1 }, { id: 'a', total: 1 }])).toEqual(new Map([['a', 1], ['b', 0]]))
  })
  it('rejects corrupt, missing, fractional or duplicate amounts instead of inventing money', () => {
    for (const total of [NaN, Infinity, -1, .5, 2]) expect(() => allocateReceiptRevenue(total, [{ id: 'a', total: 1 }])).toThrow()
    expect(() => allocateReceiptRevenue(1, [])).toThrow()
    expect(() => allocateReceiptRevenue(1, [{ id: 'a', total: 1 }, { id: 'a', total: 1 }])).toThrow()
    expect(allocateReceiptRevenue(0, [])).toEqual(new Map())
  })
  it('protects the paid core deposit from the product discount, including a fully discounted receipt', () => {
    const lines = [{ id: 'a', total: 200, coreTotal: 100 }, { id: 'b', total: 100 }]
    expect(allocateReceiptRevenue(270, lines)).toEqual(new Map([['a', 185], ['b', 85]]))
    expect(allocateReceiptRevenue(50, lines)).toEqual(new Map([['a', 50], ['b', 0]]))
    expect(allocateReceiptRevenue(0, lines)).toEqual(new Map([['a', 0], ['b', 0]]))
    expect(() => allocateReceiptRevenue(100, [{ id: 'a', total: 100, coreTotal: 101 }])).toThrow()
  })
})
