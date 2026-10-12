import { describe, expect, it, vi } from 'vitest'
import { ACTION_ROUTES, isDraftOrder, isLeadOrder, orderActionCounts, readActionPages } from './orderQueues'

describe('shared action queues', () => {
  it.each([
    ['lead', 'walk_in', [], false, true],
    ['lead', 'phone', [], false, true],
    ['lead', 'mobile_draft', [], true, false],
    ['lead', 'walk_in', [{ is_draft_note: true }], true, false],
    ['quoted', 'walk_in', [], true, false],
    ['ready', 'mobile_draft', [{ is_draft_note: true }], false, false],
  ] as const)('classifies %s/%s consistently with the order list', (status, source, items, draft, lead) => {
    const order = { status, source, items: [...items] }
    expect(isDraftOrder(order)).toBe(draft)
    expect(isLeadOrder(order)).toBe(lead)
  })
  it('counts all four ready statuses, excluding work/completed/cancelled history', () => {
    expect(orderActionCounts(['ready', 'arrived', 'called', 'no_answer', 'new', 'ordered', 'completed', 'canceled']
      .map(status => ({ status })))).toEqual({ drafts: 0, leads: 0, ready: 4 })
  })
  it('links exact filtered lists, including the supported debtor filter', () => {
    expect(ACTION_ROUTES).toEqual({ ready: '/orders?tab=ready&search=', drafts: '/orders?tab=drafts&search=',
      leads: '/orders?tab=leads&search=', debts: '/customers?has_debt=true', waitlist: '/waitlist' })
  })
})

describe('bounded exact action reads', () => {
  it('reads subsequent pages using consumed offset and deduplicates records without mutating them', async () => {
    const rows = [{ id: '1' }, { id: '2' }]
    const read = vi.fn().mockResolvedValueOnce({ data: rows, hasMore: true })
      .mockResolvedValueOnce({ data: [{ id: '2' }, { id: '3' }], hasMore: false })
    expect(await readActionPages(read, () => true)).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }])
    expect(read.mock.calls).toEqual([[1, 0], [2, 2]])
    expect(rows).toEqual([{ id: '1' }, { id: '2' }])
  })
  it('stops an invalidated read before requesting the next page', async () => {
    let current = true
    const read = vi.fn(async () => { current = false; return { data: [{ id: '1' }], hasMore: true } })
    expect(await readActionPages(read, () => current)).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('makes no requests after unmount', async () => {
    const read = vi.fn()
    expect(await readActionPages(read, () => false)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it('rejects a failed page instead of returning partial counts', async () => {
    const read = vi.fn().mockResolvedValueOnce({ data: [{ id: '1' }], hasMore: true }).mockRejectedValueOnce(Error('read failed'))
    await expect(readActionPages(read, () => true)).rejects.toThrow('read failed')
  })
  it.each([{ data: [] }, { data: [{ id: '1' }] }])('rejects an empty/nonprogress page with has_more', async ({ data }) => {
    const read = vi.fn().mockResolvedValueOnce({ data: [{ id: '1' }], hasMore: true }).mockResolvedValue({ data, hasMore: true })
    await expect(readActionPages(read, () => true)).rejects.toThrow('повну вибірку')
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('bounds repeated reads without claiming a truncated count is exact', async () => {
    const read = vi.fn(async (page: number) => ({ data: [{ id: String(page) }], hasMore: true }))
    await expect(readActionPages(read, () => true)).rejects.toThrow('завелика')
    expect(read).toHaveBeenCalledTimes(50)
  })
})
