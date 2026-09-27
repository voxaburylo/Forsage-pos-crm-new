import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ urls: [] as URL[], fail: false, rangeError: false }))
vi.mock('../../db/supabase.js', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  return { db: createClient('https://database.invalid', 'test-only-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url: any) => {
      state.urls.push(new URL(String(url)))
      if (state.rangeError && state.urls.length === 1) return new Response(JSON.stringify({ code: 'PGRST103', message: 'Requested range not satisfiable' }), { status: 416, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify(state.fail ? { message: 'query failed' } : [{ id: 'one', matched_items: [{ product: { id: 'p' } }] }]),
        { status: state.fail ? 400 : 200, headers: { 'content-type': 'application/json', 'content-range': '20-20/25' } })
    } },
  }) }
})
vi.mock('../../db/pg.js', () => ({ runTransaction: vi.fn() }))
vi.mock('../shiftService.js', () => ({ getShiftCashBreakdown: vi.fn() }))
import { listSupplyInvoices, listSuppliers } from '../supplierService.js'
import { supplyInvoiceListSchema } from '../../validators/supplierSchema.js'
import { literalContainsFilter } from '../../lib/postgrestLiteralSearch.js'
beforeEach(() => { state.urls = []; state.fail = false; state.rangeError = false })
it('builds an inner product search with tenant/deletion guards, exact pagination and deterministic ordering', async () => {
  const result = await listSupplyInvoices(supplyInvoiceListSchema.parse({ search: 'Фільтр WA9428', page: 2, per_page: 20, status: 'posted' }), 'shop')
  const query = state.urls[0].searchParams
  expect(query.get('select')).toContain('supply_invoice_items!inner(product:products!inner(id))')
  expect(query.get('tenant_id')).toBe('eq.shop')
  expect(query.get('matched_items.tenant_id')).toBe('eq.shop')
  expect(query.get('matched_items.product.tenant_id')).toBe('eq.shop')
  expect(query.get('deleted_at')).toBe('is.null')
  expect(query.has('matched_items.deleted_at')).toBe(false)
  expect(query.getAll('matched_items.product.or')).toHaveLength(2)
  expect(query.get('offset')).toBe('20'); expect(query.get('limit')).toBe('20')
  expect(query.get('order')).toBe('created_at.desc,id.desc')
  expect(result.pagination.total).toBe(25)
  expect(result.data).toEqual([{ id: 'one' }])
})
it('quotes supplier input with punctuation and literal LIKE wildcards', async () => {
  const search = 'A%,_("B")\\C'
  await listSuppliers({ search, page: 1, per_page: 50 }, 'shop')
  expect(state.urls[0].searchParams.get('or')).toBe('(' + literalContainsFilter(['name', 'contact_name', 'phone'], search) + ')')
  expect(literalContainsFilter(['name'], '100%_')).toBe('name.ilike."%100\\\\%\\\\_%"')
})
it('does not silently discard search or return partial data on errors', async () => {
  expect(supplyInvoiceListSchema.safeParse({ search: 'a'.repeat(201) }).success).toBe(false)
  state.fail = true
  await expect(listSupplyInvoices(supplyInvoiceListSchema.parse({ search: '5449000351081' }), 'shop')).rejects.toThrow('query failed')
})
it('recovers a removed last page without losing filters or raising a range error', async () => {
  state.rangeError = true
  const result = await listSupplyInvoices(supplyInvoiceListSchema.parse({ page: 99, search: 'WIX' }), 'shop')
  expect(state.urls).toHaveLength(2)
  expect(state.urls[1].searchParams.get('offset')).toBe('0')
  expect(state.urls[1].searchParams.get('matched_items.product.or')).toContain('WIX')
  expect(result.pagination.total).toBe(25)
  expect(result.data).toEqual([])
})
