import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../../routes/customerOrders.ts', import.meta.url),
  'utf8',
)

function section(start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  expect(from, `missing section ${start}`).toBeGreaterThanOrEqual(0)
  expect(to, `missing section terminator ${end}`).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe('customer order tenant isolation regressions', () => {
  it('tenant-scopes every direct order read and write route', () => {
    const routeSections = [
      section("router.put('/:id/draft'", "router.post('/:id/convert'"),
      section("router.post('/:id/convert'", "router.post('/:id/send-telegram'"),
      section("router.post('/:id/send-telegram'", "router.post('/:id/payments'"),
      section("router.patch('/:id/status'", "router.post('/:id/complete'"),
      section("router.post('/:id/complete'", "router.get('/pending-items'"),
      section("router.put('/:id'", "router.delete('/:id'"),
    ]

    for (const routeSource of routeSections) {
      expect(routeSource).toContain(".eq('tenant_id', req.user!.tenant_id)")
    }
  })

  it('scopes payment and pending-item reads through the active tenant', () => {
    const payments = section("router.get('/:id/payments'", 'export async function updateOrderStatus')
    expect(payments).toContain(".eq('tenant_id', req.user!.tenant_id)")

    const pending = section("router.get('/pending-items'", "router.get('/:id'")
    expect(pending).toContain(".eq('order.tenant_id', req.user!.tenant_id)")
  })

  it('validates child item ownership through a tenant-scoped parent order', () => {
    const itemStatus = section("router.patch('/:id/items/:itemId/status'", "router.patch('/:id/status'")
    expect(itemStatus).toContain(".eq('order.tenant_id', req.user!.tenant_id)")
    expect(itemStatus).toContain("'ITEM_NOT_FOUND'")

    const updater = section("router.put('/:id'", "router.delete('/:id'")
    expect(updater).toContain("'Позиція не належить цьому замовленню'")
    expect(updater).toContain("'Один або кілька постачальників не знайдено'")
    expect(updater).toContain("'Один або кілька товарів не знайдено'")
  })

  it('keeps order completion receipt-only and replay-safe', () => {
    const status = section("router.patch('/:id/status'", "router.post('/:id/complete'")
    expect(status).toContain(
      "status: z.enum(['lead', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready'])",
    )
    expect(status).toContain("['completed', 'canceled', 'archived'].includes(oldOrder.status)")

    const completion = section("router.post('/:id/complete'", "router.get('/pending-items'")
    expect(completion).toContain("requireRole('owner', 'admin', 'cashier')")
    expect(completion).toContain('order.status === \'completed\' && order.sale_id')
    expect(completion).toContain('result?.replayed === true')
  })

  it('uses one search pipeline and supports ORD-prefixed numbers', () => {
    const list = section("router.get('/',", "router.put('/:id/draft'")
    expect(list.match(/const searchRaw/g)).toHaveLength(1)
    expect(list).toContain("replace(/^(ORD-?|#)/i, '')")
    expect(list).not.toContain('const search = String(req.query.search')
  })
})