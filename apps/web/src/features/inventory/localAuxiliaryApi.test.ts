import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ bridge: vi.fn(), reserve: vi.fn(), movement: vi.fn(), consumption: vi.fn(), generate: vi.fn(), remote: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: mocks.bridge }))
vi.mock('@/lib/api', () => ({ api: { get: mocks.remote, post: mocks.remote } }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: { user: { id: 'manager' } } }) } }))
import { warehouseApi } from './warehouseApi'
import { purchaseApi } from '@/features/autoPurchase/purchaseApi'

describe('local auxiliary API boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
    mocks.bridge.mockReturnValue({ warehouse: { createReserve: mocks.reserve, createMovement: mocks.movement, createConsumption: mocks.consumption }, purchases: { generateInvoices: mocks.generate } })
  })
  afterEach(() => vi.unstubAllGlobals())
  it.each(['reserve', 'movement', 'consumption', 'generate'] as const)('%s preserves retry identity and never writes remotely', async name => {
    const fn = mocks[name]
    fn.mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce({ ok: true })
    const run = () => name === 'reserve' ? warehouseApi.createReserve({ product_id: 'p', qty: 1 })
      : name === 'movement' ? warehouseApi.createMovement({ product_id: 'p', qty: 1, to_bin: 'A' })
        : name === 'consumption' ? warehouseApi.createConsumption({ employee_id: 'e', items: [{ product_id: 'p', qty: 1 }] })
          : purchaseApi.generateInvoices()
    await expect(run()).rejects.toThrow('reply lost')
    await run()
    expect(fn.mock.calls[0][0].operation_id).toBeTruthy()
    expect(fn.mock.calls[1][0].operation_id).toBe(fn.mock.calls[0][0].operation_id)
    expect(mocks.remote).not.toHaveBeenCalled()
  })
  it('does not fall back to the server when local modules are missing', async () => {
    mocks.bridge.mockReturnValue({})
    await expect(purchaseApi.listRules()).rejects.toThrow('Локальні закупівлі')
    await expect(warehouseApi.listConsumptions('2026-09')).rejects.toThrow('Локальне складське')
    expect(mocks.remote).not.toHaveBeenCalled()
  })
})
