import { beforeEach, describe, expect, it, vi } from 'vitest'
import { productApi } from './productApi'

const state = vi.hoisted(() => ({
  local: true, ready: true,
  change: vi.fn(), list: vi.fn(),
  remote: { post: vi.fn(), delete: vi.fn(), get: vi.fn() },
}))
vi.mock('@/lib/api', () => ({ api: state.remote }))
vi.mock('@/lib/desktopBridge', () => ({
  desktopBridge: () => state.local ? { catalog: {
    changeCrossNumbers: state.ready ? state.change : undefined, listCrossNumbers: state.list,
  } } : null,
  desktopProductToProduct: (value: unknown) => value,
}))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ offlineMode: true }) } }))

beforeEach(() => {
  vi.resetAllMocks()
  state.local = true; state.ready = true
  state.change.mockResolvedValue([{ id: 'cross-id', number: 'OC195', source: 'Verified catalog' }])
})
describe('product detail cross-number API stays local', () => {
  it('adds a delta through local IPC and returns authoritative rows', async () => {
    const result = await productApi.addCrossNumbers('p', ['OC195'], 'Verified catalog')
    expect(state.change).toHaveBeenCalledWith('p', { add: ['OC195'], source: 'Verified catalog' })
    expect(result.data).toEqual([expect.objectContaining({ id: 'cross-id', number: 'OC195', number_type: 'cross' })])
    expect(state.remote.post).not.toHaveBeenCalled()
  })
  it('removes the exact row from the exact product and returns remaining rows', async () => {
    state.change.mockResolvedValue([])
    expect(await productApi.removeCrossNumber('p', 'cross-id')).toEqual({ data: [] })
    expect(state.change).toHaveBeenCalledWith('p', { removeId: 'cross-id' })
    expect(state.remote.delete).not.toHaveBeenCalled()
  })
  it('does not retry or use a server after an uncertain local write', async () => {
    state.change.mockRejectedValue(Error('lost reply'))
    await expect(productApi.addCrossNumbers('p', ['OC195'], 'Manual')).rejects.toThrow('lost reply')
    expect(state.change).toHaveBeenCalledOnce()
    expect(state.remote.post).not.toHaveBeenCalled()
  })
  it.each(['web', 'old-exe'])('fails closed on %s instead of writing to the server', async mode => {
    state.local = mode !== 'web'; state.ready = false
    await expect(productApi.addCrossNumbers('p', ['OC195'], 'Manual')).rejects.toThrow('локальній')
    await expect(productApi.removeCrossNumber('p', 'cross-id')).rejects.toThrow('локальній')
    expect(state.change).not.toHaveBeenCalled()
    expect(state.remote.post).not.toHaveBeenCalled()
    expect(state.remote.delete).not.toHaveBeenCalled()
  })
  it('keeps cross-numbers readable without internet', async () => {
    state.list.mockResolvedValue([{ id: 'cross-id', number: 'OC195', source: 'Local' }])
    expect((await productApi.getCrossNumbers('p')).data[0].number).toBe('OC195')
    expect(state.remote.get).not.toHaveBeenCalled()
  })
})
