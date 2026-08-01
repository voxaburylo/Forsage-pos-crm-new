import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const bulkArrivalSource = readFileSync(new URL('../orderBulkArrivalService.ts', import.meta.url), 'utf8')
const cancellationSource = readFileSync(new URL('../orderCancellationService.ts', import.meta.url), 'utf8')
const returnSource = readFileSync(new URL('../returnService.ts', import.meta.url), 'utf8')
const syncSource = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')
const customerOrdersSource = readFileSync(new URL('../../routes/customerOrders.ts', import.meta.url), 'utf8')
const coreReturnsSource = readFileSync(new URL('../../routes/coreReturns.ts', import.meta.url), 'utf8')

describe('order child synchronization safety', () => {
  it('tenant-scopes bulk arrival through the parent order and touches its sync timestamp', () => {
    expect(bulkArrivalSource).not.toContain('i.tenant_id')
    expect(bulkArrivalSource).not.toContain('i.deleted_at')
    expect(bulkArrivalSource).not.toContain("SET item_status = 'arrived', updated_at")
    expect(bulkArrivalSource).toContain('UPDATE customer_orders')
    expect(bulkArrivalSource).toContain('SET updated_at = NOW()')
  })

  it('cancels child rows through a tenant-scoped parent without nonexistent child columns', () => {
    expect(cancellationSource).not.toContain('i.tenant_id')
    expect(cancellationSource).toContain('i.order_id = o.id')
    expect(cancellationSource).toContain('o.tenant_id = $2')
  })

  it('makes returned order-item status visible to local pull in both web and offline flows', () => {
    expect(returnSource).toContain(".from('customer_orders')")
    expect(returnSource).toContain(".update({ updated_at: new Date().toISOString() })")
    const start = syncSource.indexOf('const returnedOrderItems = await client.query')
    const end = syncSource.indexOf('const remainingResult = await client.query', start)
    const block = syncSource.slice(start, end)
    expect(block).not.toContain("SET item_status = 'returned', updated_at")
    expect(block).toContain('UPDATE customer_orders SET updated_at = $3')
  })

  it('touches the parent even when picking changes an item without changing the aggregate status', () => {
    expect(customerOrdersSource).toContain('if (currentOrder.status === newStatus) {')
    expect(customerOrdersSource).toContain(".update({ updated_at: new Date().toISOString() })")
  })

  it('touches every parent document when a core-return child changes', () => {
    expect(coreReturnsSource).toContain('UPDATE supply_invoices')
    expect(coreReturnsSource).toContain('UPDATE sales')
    expect(coreReturnsSource).toContain('UPDATE customer_orders')
    expect(coreReturnsSource.match(/SET updated_at = clock_timestamp\(\)/g)).toHaveLength(3)
    expect(coreReturnsSource).toContain('FOR UPDATE OF invoice')
  })

  it('keeps core-return child changes and their parent sync stamp in one transaction', () => {
    expect(coreReturnsSource.match(/runTransaction\(async \(pgClient\) =>/g)).toHaveLength(2)
    expect(coreReturnsSource).not.toContain('UPDATE customer_orders SET updated_at = NOW()')
  })
})