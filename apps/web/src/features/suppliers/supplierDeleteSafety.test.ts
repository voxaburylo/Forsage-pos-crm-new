import { beforeEach, it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ local: { deleteInvoice: vi.fn() }, sync: vi.fn(), remove: vi.fn(), apiDelete: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => ({ supply: state.local }) }))
vi.mock('@/features/products/productApi', () => ({ requestDesktopSync: state.sync }))
vi.mock('./invoiceDraftStore', () => ({ readInvoiceDraftRecords: vi.fn(), removeInvoiceDrafts: state.remove }))
vi.mock('@/lib/api', () => ({ api: { delete: state.apiDelete } }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({}) } }))
import { supplierApi } from './supplierApi'
beforeEach(() => vi.resetAllMocks())
it('clears all draft aliases and requests sync only after deletion acknowledgement', async () => {
  state.local.deleteInvoice.mockResolvedValue(undefined)
  await supplierApi.deleteInvoice('invoice', 'revision')
  expect(state.local.deleteInvoice).toHaveBeenCalledWith('invoice', undefined, 'revision')
  expect(state.remove).toHaveBeenCalledWith(undefined, 'invoice'); expect(state.sync).toHaveBeenCalledOnce()
  expect(state.remove.mock.invocationCallOrder[0]).toBeGreaterThan(state.local.deleteInvoice.mock.invocationCallOrder[0])
})
it.each(['Накладну не знайдено', 'Стан накладної змінився', 'Не можна видалити оплачену накладну', 'Зв’язок перервано'])('keeps the draft and reports %s without false success', async message => {
    state.local.deleteInvoice.mockRejectedValue(new Error(message))
    await expect(supplierApi.deleteInvoice('invoice', 'revision')).rejects.toThrow(message)
    expect(state.remove).not.toHaveBeenCalled(); expect(state.sync).not.toHaveBeenCalled()
    expect(state.apiDelete).not.toHaveBeenCalled()
  })
it('can finish after a lost reply when the local repository acknowledges exact retry', async () => {
  state.local.deleteInvoice.mockRejectedValueOnce(new Error('Зв’язок перервано')).mockResolvedValueOnce(undefined)
  await expect(supplierApi.deleteInvoice('invoice', 'revision')).rejects.toThrow()
  expect(state.remove).not.toHaveBeenCalled()
  await supplierApi.deleteInvoice('invoice', 'revision')
  expect(state.remove).toHaveBeenCalledOnce(); expect(state.sync).toHaveBeenCalledOnce()
})
