import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { localRequestFingerprint, pendingLocalRequests } from '@/lib/durableLocalRequest'

const fixture = vi.hoisted(() => ({ local: undefined as any, user: undefined as any, post: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => fixture.local ? { staff: fixture.local } : null }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: fixture.user ? { user: fixture.user } : null }) } }))
vi.mock('@/lib/api', () => ({ api: { post: fixture.post } }))
import { staffApi } from './staffApi'

const values = new Map<string, string>()
const payload = { employee_id: 'worker', employee_name: 'Synthetic worker', amount: 12650,
  type: 'advance', method: 'cash' as const, period: '2026-09', work_date: '2026-09-30', shift_id: 'shift' }
const salary = { id: 'saved-payment', amount: 12650, employee_id: 'worker' }
beforeEach(() => {
  values.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
  fixture.user = { id: 'cashier', app_metadata: { tenant_id: 'tenant' } }
  fixture.local = { createSalary: vi.fn().mockResolvedValue(salary),
    dailyPayout: vi.fn().mockResolvedValue({ amount: 12650, payment: salary }),
    resolveOperation: vi.fn().mockRejectedValue(Error('unknown')) }
  fixture.post.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

it.each(['salary', 'daily-salary'] as const)('reconciles the legacy %s scope after midnight without a second write', async kind => {
  const old = kind === 'salary' ? payload : { ...payload, user_id: 'cashier' }
  values.set('forsage:pending-request:v1:' + kind + ':cashier', JSON.stringify({ [localRequestFingerprint(old)]: 'old-id' }))
  fixture.local.resolveOperation.mockResolvedValue({ status: 'committed', result: kind === 'salary' ? salary : { payment: salary, amount: 12650 } })
  const action = kind === 'salary' ? staffApi.createSalary : staffApi.dailyPayout
  await expect(action({ ...payload, work_date: '2026-10-01' })).rejects.toThrow(/вже збережено/)
  expect(fixture.local.resolveOperation).toHaveBeenCalledExactlyOnceWith(kind, 'old-id')
  expect(fixture.local.createSalary).not.toHaveBeenCalled()
  expect(fixture.local.dailyPayout).not.toHaveBeenCalled()
  expect(fixture.post).not.toHaveBeenCalled()
  expect(values.size).toBe(0)
})
it('preserves daily payout actor injection and validates nested payment identity', async () => {
  expect(await staffApi.dailyPayout(payload)).toEqual({ data: { payment: salary, amount: 12650 } })
  expect(fixture.local.dailyPayout).toHaveBeenCalledExactlyOnceWith({ ...payload, user_id: 'cashier', operation_id: expect.any(String) })
  expect(values.size).toBe(0)
})
it.each(['user', 'tenant', 'bridge'] as const)('keeps the original operation pending if %s changes during IPC', async change => {
  const local = fixture.local
  local.createSalary.mockImplementation(async () => {
    if (change === 'user') fixture.user = { ...fixture.user, id: 'other' }
    if (change === 'tenant') fixture.user = { ...fixture.user, app_metadata: { tenant_id: 'other' } }
    if (change === 'bridge') fixture.local = { ...local }
    return salary
  })
  await expect(staffApi.createSalary(payload)).rejects.toThrow(/Користувач/)
  expect(local.resolveOperation).not.toHaveBeenCalled()
  expect(pendingLocalRequests('salary:cashier')).toHaveLength(1)
})
it('does not fall through to a web write when the old local bridge has no resolver', async () => {
  delete fixture.local.resolveOperation
  await expect(staffApi.createSalary(payload)).rejects.toThrow(/Оновіть/)
  await expect(staffApi.dailyPayout(payload)).rejects.toThrow(/Оновіть/)
  expect(fixture.local.createSalary).not.toHaveBeenCalled()
  expect(fixture.local.dailyPayout).not.toHaveBeenCalled()
  expect(fixture.post).not.toHaveBeenCalled()
})
it('requires a signed-in local actor before writes', async () => {
  fixture.user = undefined
  await expect(staffApi.createSalary(payload)).rejects.toThrow(/Увійдіть/)
  expect(fixture.local.createSalary).not.toHaveBeenCalled()
  expect(values.size).toBe(0)
})
it('leaves the server API path unchanged when there is no desktop bridge', async () => {
  fixture.local = undefined
  fixture.post.mockResolvedValue({ data: salary })
  expect(await staffApi.createSalary(payload)).toEqual({ data: salary })
  expect(fixture.post).toHaveBeenCalledExactlyOnceWith('/api/v1/salary', payload)
  expect(values.size).toBe(0)
})
