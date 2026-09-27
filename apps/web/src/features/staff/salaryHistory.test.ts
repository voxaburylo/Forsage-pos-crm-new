import { expect, it, vi } from 'vitest'
import { collectSalaryHistory } from './salaryHistory'
it('loads all 451 rows, including pages containing only excluded owners', async () => {
  const fetch = vi.fn(async (page: number) => ({ data: page === 2 ? [] : Array.from({ length: page === 4 ? 51 : 200 }, (_, i) => ({ id: `${page}-${i}` })), has_more: page < 4 }))
  expect(await collectSalaryHistory(fetch)).toHaveLength(451)
  expect(fetch).toHaveBeenCalledTimes(4)
})
it('does not present a partial month when a later page fails', async () => {
  await expect(collectSalaryHistory(async page => { if (page === 2) throw new Error('Disconnected'); return { data: [{ id: 'first' }], has_more: true } })).rejects.toThrow('Disconnected')
})
it('detects an old backend ignoring pagination instead of looping indefinitely', async () => {
  const fetch = vi.fn(async () => ({ data: [{ id: 'first' }], has_more: true }))
  await expect(collectSalaryHistory(fetch)).rejects.toThrow('повну історію')
  expect(fetch).toHaveBeenCalledTimes(2)
})
