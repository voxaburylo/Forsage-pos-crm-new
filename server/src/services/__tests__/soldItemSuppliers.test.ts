import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ from: vi.fn(), read: vi.fn() }))
vi.mock('../../db/supabase.js', () => ({ db: { from: mocks.from } }))
vi.mock('../../lib/readReportPages.js', () => ({ readReportPages: mocks.read }))
import { loadSoldItemSuppliers } from '../soldItemSuppliers.js'
describe('web sold item supplier reads', () => {
  let query: any
  beforeEach(() => {
    vi.resetAllMocks()
    query = Object.fromEntries(['select', 'eq', 'is', 'gt', 'in'].map(method => [method, vi.fn().mockReturnThis()]))
    mocks.from.mockReturnValue(query)
    mocks.read.mockResolvedValue({ data: [], error: null })
  })
  it('uses complete paginated batches and tenant/deletion guards for every relation', async () => {
    mocks.read.mockResolvedValue({ data: [{ product_id: 'p', invoice: { supplier: { id: 'a', name: 'Автокомфорт' } } },
      { product_id: 'p', invoice: { supplier: { id: 'a', name: 'Автокомфорт' } } },
      { product_id: 'p', invoice: { supplier: { id: 'b', name: 'Інший' } } },
      { product_id: 'p', deleted_at: 'deleted', invoice: { supplier: { id: 'deleted', name: 'Deleted' } } }], error: null })
    const rows = await loadSoldItemSuppliers('tenant', ['p'])
    expect(rows.get('p')).toHaveLength(2)
    for (const column of ['tenant_id', 'invoice.tenant_id', 'invoice.supplier.tenant_id']) expect(query.eq).toHaveBeenCalledWith(column, 'tenant')
    for (const column of ['invoice.deleted_at', 'invoice.supplier.deleted_at']) expect(query.is).toHaveBeenCalledWith(column, null)
    expect(query.eq).toHaveBeenCalledWith('invoice.status', 'posted')
    expect(query.gt).toHaveBeenCalledWith('qty', 0)
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })
  it('skips empty lists, batches identifiers and never returns partial history on failure', async () => {
    expect((await loadSoldItemSuppliers('tenant', [])).size).toBe(0)
    expect(mocks.from).not.toHaveBeenCalled()
    const ids = Array.from({ length: 205 }, (_, i) => String(i))
    await loadSoldItemSuppliers('tenant', [...ids, ...ids])
    expect(mocks.read).toHaveBeenCalledTimes(3)
    expect(query.in).toHaveBeenLastCalledWith('product_id', ids.slice(200))
    mocks.read.mockResolvedValueOnce({ data: [], error: { message: 'offline' } })
    await expect(loadSoldItemSuppliers('tenant', ['p'])).rejects.toThrow('Не вдалося визначити постачальників')
  })
})
