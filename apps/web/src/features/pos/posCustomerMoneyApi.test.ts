import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ pay: vi.fn(), add: vi.fn(), payout: vi.fn(), remote: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => ({ pos: { payDebt: mocks.pay, addCustomerDeposit: mocks.add, payOutCustomerDeposit: mocks.payout } }) }))
vi.mock('@/lib/api', () => ({ api: { post: mocks.remote } }))
vi.mock('@/features/products/productApi', () => ({ requestDesktopSync: vi.fn() }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: { user: { id: 'cashier' } } }) } }))
import { posCustomerMoneyApi } from './posCustomerMoneyApi'

describe('local cashier money retry identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) })
  })
  afterEach(() => vi.unstubAllGlobals())
  it.each(['payDebt', 'addDeposit', 'payOutDeposit'] as const)('%s reuses identity after a lost reply without a server fallback', async (method) => {
    const call = method === 'payDebt' ? mocks.pay : method === 'addDeposit' ? mocks.add : mocks.payout
    call.mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce({ data: { balance: 200 } })
    const body = { amount: 100, method: 'card' as const }
    await expect(posCustomerMoneyApi[method]('customer', body)).rejects.toThrow('reply lost')
    await posCustomerMoneyApi[method]('customer', body)
    const id = method === 'payOutDeposit' ? 'payout_id' : 'operation_id'
    expect(call.mock.calls[0][0][id]).toBeTruthy()
    expect(call.mock.calls[1][0][id]).toBe(call.mock.calls[0][0][id])
    expect(mocks.remote).not.toHaveBeenCalled()
  })
})
