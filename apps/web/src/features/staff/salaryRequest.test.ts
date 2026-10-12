import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localRequestFingerprint, pendingLocalRequests } from '@/lib/durableLocalRequest'
import { submitSalaryRequest, type SalaryRequestKind } from './salaryRequest'

const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) } } as Storage
const payload = { employee_id: 'worker', amount: 12650, method: 'cash', type: 'advance',
  period: '2026-09', work_date: '2026-09-30', note: 'Retained form', shift_id: 'old-shift' }
const salary = { id: 'saved-payment', employee_id: 'worker', amount: 12650 }
const results = { salary, 'daily-salary': { payment: salary, amount: 12650, earned: 12650, previously_paid: 0, penalty: 0 } }
function marker(scope: string, entries: Array<{ id: string; body: unknown }>) {
  values.set('forsage:pending-request:v1:' + scope,
    JSON.stringify(Object.fromEntries(entries.map(({ id, body }) => [localRequestFingerprint(body), id]))))
}
beforeEach(() => values.clear())
afterEach(() => vi.restoreAllMocks())

describe.each(['salary', 'daily-salary'] as SalaryRequestKind[])('%s request recovery', kind => {
  const scope = kind + ':cashier'
  const result = results[kind]
  const transport = () => ({ send: vi.fn().mockResolvedValue(result),
    resolve: vi.fn().mockRejectedValue(Error('offline')), sameSession: () => true })
  const submit = (body: unknown, t = transport(), store = storage) => submitSalaryRequest(kind, scope, body, t, store)

  it('persists the original payload and ID before IPC, then acknowledges a valid result', async () => {
    const t = transport()
    t.send.mockImplementation(async (id, body) => {
      expect(pendingLocalRequests(scope, storage)).toEqual([{ operationId: id, payload }])
      expect(body).toEqual(payload)
      return result
    })
    expect(await submit(payload, t)).toEqual(result)
    expect(values.size).toBe(0)
    expect(t.resolve).not.toHaveBeenCalled()
  })
  it('recovers a lost acknowledgement without sending a second write', async () => {
    const t = transport()
    t.send.mockRejectedValue(Error('reply lost after commit'))
    t.resolve.mockResolvedValue({ status: 'committed', result })
    expect(await submit(payload, t)).toEqual(result)
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.resolve).toHaveBeenCalledExactlyOnceWith(t.send.mock.calls[0][0])
    expect(values.size).toBe(0)
  })
  it('retains unknown evidence and resolves an exact retry through its original ID without replaying', async () => {
    const t = transport(); t.send.mockRejectedValueOnce(Error('reply lost'))
    await expect(submit(payload, t)).rejects.toThrow('reply lost')
    const id = t.send.mock.calls[0][0]
    expect(pendingLocalRequests(scope, storage)[0].operationId).toBe(id)
    t.resolve.mockResolvedValue({ status: 'committed', result })
    expect(await submit({ ...payload }, t)).toEqual(result)
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.resolve.mock.calls).toEqual([[id], [id]])
    expect(values.size).toBe(0)
  })
  it('blocks a changed day/shift after discovering the previous payment was already committed', async () => {
    marker(scope, [{ id: 'yesterday-id', body: payload }])
    const t = transport(); t.resolve.mockResolvedValue({ status: 'committed', result })
    await expect(submit({ ...payload, work_date: '2026-10-01', shift_id: 'new-shift' }, t))
      .rejects.toThrow(/Попередню.*вже збережено.*історію/)
    expect(t.resolve).toHaveBeenCalledExactlyOnceWith('yesterday-id')
    expect(t.send).not.toHaveBeenCalled()
    expect(values.size).toBe(0)
  })
  it('checks every other pending attempt before any changed payload is sent', async () => {
    marker(scope, [{ id: 'older-a', body: { ...payload, note: 'a' } }, { id: 'older-b', body: { ...payload, note: 'b' } }])
    const t = transport()
    t.resolve.mockResolvedValueOnce({ status: 'not_committed' }).mockResolvedValueOnce({ status: 'committed', result })
    await expect(submit(payload, t)).rejects.toThrow(/вже збережено/)
    expect(t.resolve.mock.calls).toEqual([['older-a'], ['older-b']])
    expect(t.send).not.toHaveBeenCalled()
    expect(values.size).toBe(0)
  })
  it('does not skip a different unknown attempt merely because this exact payload also has an ID', async () => {
    marker(scope, [{ id: 'same-id', body: payload }, { id: 'unknown-id', body: { ...payload, note: 'different' } }])
    const t = transport()
    await expect(submit(payload, t)).rejects.toThrow('offline')
    expect(t.resolve).toHaveBeenCalledExactlyOnceWith('same-id')
    expect(t.send).not.toHaveBeenCalled()
    expect(pendingLocalRequests(scope, storage)).toHaveLength(2)
  })
  it('immediately reports a known commit instead of losing it behind another unknown attempt', async () => {
    marker(scope, [{ id: 'committed-a', body: { ...payload, note: 'a' } }, { id: 'unknown-b', body: { ...payload, note: 'b' } }])
    const t = transport()
    t.resolve.mockResolvedValueOnce({ status: 'committed', result })
    await expect(submit(payload, t)).rejects.toThrow(/Попередню.*вже збережено.*історію/)
    expect(t.resolve).toHaveBeenCalledExactlyOnceWith('committed-a')
    expect(t.send).not.toHaveBeenCalled()
    expect(pendingLocalRequests(scope, storage)).toEqual([{ operationId: 'unknown-b', payload: { ...payload, note: 'b' } }])
  })
  it('only a confirmed cancellation fence permits a fresh changed request', async () => {
    marker(scope, [{ id: 'cancelled-a', body: { ...payload, note: 'a' } }, { id: 'cancelled-b', body: { ...payload, note: 'b' } }])
    const t = transport(); t.resolve.mockResolvedValue({ status: 'not_committed' })
    t.send.mockImplementation(async id => {
      expect(t.resolve.mock.calls).toEqual([['cancelled-a'], ['cancelled-b']])
      expect(id).not.toBe('cancelled-a'); expect(id).not.toBe('cancelled-b')
      expect(pendingLocalRequests(scope, storage)).toEqual([{ operationId: id, payload }])
      return result
    })
    expect(await submit(payload, t)).toEqual(result)
    expect(t.send).toHaveBeenCalledTimes(1)
  })
  it('uses a fresh identity after an exact pending request was authoritatively fenced as absent', async () => {
    marker(scope, [{ id: 'fenced-same-id', body: payload }])
    const t = transport(); t.resolve.mockResolvedValue({ status: 'not_committed' })
    expect(await submit(payload, t)).toEqual(result)
    expect(t.resolve).toHaveBeenCalledExactlyOnceWith('fenced-same-id')
    expect(t.send.mock.calls[0][0]).not.toBe('fenced-same-id')
    expect(values.size).toBe(0)
  })
  it('does not replay or clear an exact request when strict receipt verification rejects it', async () => {
    marker(scope, [{ id: 'corrupt-receipt-id', body: payload }])
    const t = transport()
    t.resolve.mockRejectedValue(Error('receipt amount/work_date mismatch'))
    // The old replay path could return this superficially valid identity.
    t.send.mockResolvedValue(kind === 'salary' ? { ...salary, amount: 1 } : { payment: { ...salary, amount: 1 }, amount: 1 })
    await expect(submit(payload, t)).rejects.toThrow('receipt amount/work_date mismatch')
    expect(t.send).not.toHaveBeenCalled()
    expect(pendingLocalRequests(scope, storage)).toEqual([{ operationId: 'corrupt-receipt-id', payload }])
  })
  it('does not send or erase other attempts when an exact pending request is confirmed', async () => {
    marker(scope, [{ id: 'same-id', body: payload }, { id: 'other-id', body: { ...payload, note: 'other' } }])
    const t = transport(); t.resolve.mockResolvedValue({ status: 'committed', result })
    expect(await submit(payload, t)).toEqual(result)
    expect(t.send).not.toHaveBeenCalled()
    expect(t.resolve).toHaveBeenCalledExactlyOnceWith('same-id')
    expect(pendingLocalRequests(scope, storage)).toEqual([{ operationId: 'other-id', payload: { ...payload, note: 'other' } }])
  })
  it('clears a confirmed rejected write but never automatically sends it again', async () => {
    const t = transport(); t.send.mockRejectedValueOnce(Error('invalid shift'))
    t.resolve.mockResolvedValue({ status: 'not_committed' })
    await expect(submit(payload, t)).rejects.toThrow('invalid shift')
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(values.size).toBe(0)
    expect(await submit(payload, t)).toEqual(result)
    expect(t.send.mock.calls[1][0]).not.toBe(t.send.mock.calls[0][0])
  })
  it.each([null, {}, [], { status: 'unknown' }, { status: 'committed', result: {} }])(
    'keeps evidence and blocks a changed write on malformed/unknown resolution %j', async response => {
      marker(scope, [{ id: 'prior-id', body: payload }])
      const t = transport(); t.resolve.mockResolvedValue(response)
      await expect(submit({ ...payload, work_date: '2026-10-01' }, t)).rejects.toThrow(/підтвердити/)
      expect(t.send).not.toHaveBeenCalled()
      expect(pendingLocalRequests(scope, storage)).toEqual([{ operationId: 'prior-id', payload }])
    })
  it.each([null, {}, [], { id: ' ' }, { payment: { id: ' ' } }])('never accepts a malformed direct success %j', async response => {
    const t = transport(); t.send.mockResolvedValue(response)
    await expect(submit(payload, t)).rejects.toThrow(/підтвердити/)
    expect(pendingLocalRequests(scope, storage)).toHaveLength(1)
    expect(t.resolve).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, null, '12650', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'does not acknowledge a payment identity with invalid money %s', async amount => {
      const payment = { ...salary, amount }
      const t = transport(); t.send.mockResolvedValue(kind === 'salary' ? payment : { ...result, payment, amount })
      await expect(submit(payload, t)).rejects.toThrow(/підтвердити/)
      expect(pendingLocalRequests(scope, storage)).toHaveLength(1)
    })
  it('shares exact simultaneous requests and refuses varied payloads before fencing or writing', async () => {
    const t = transport()
    const first = submit(payload, t)
    const same = submit({ ...payload }, t)
    expect(same).toBe(first)
    await expect(submit({ ...payload, work_date: '2026-10-01' }, t)).rejects.toThrow(/Дочекайтеся/)
    expect(await first).toEqual(result)
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.resolve).not.toHaveBeenCalled()
  })
  it('takes a payload snapshot before awaiting IPC', async () => {
    const mutable = { ...payload }
    const t = transport(); const task = submit(mutable, t)
    mutable.amount = 99999; mutable.work_date = '2026-10-01'
    await task
    expect(t.send.mock.calls[0][1]).toEqual(payload)
  })
  it('fails closed on an old desktop bridge even without existing evidence', async () => {
    const t = transport()
    await expect(submitSalaryRequest(kind, scope, payload, { send: t.send, sameSession: () => true }, storage))
      .rejects.toThrow(/Оновіть локальну програму/)
    expect(t.send).not.toHaveBeenCalled()
    expect(values.size).toBe(0)
  })
  it('does not clear prior evidence if the user changes while resolving', async () => {
    marker(scope, [{ id: 'prior-id', body: payload }])
    let current = true
    const t = transport(); t.sameSession = () => current
    t.resolve.mockImplementation(async () => { current = false; return { status: 'committed', result } })
    await expect(submit({ ...payload, work_date: '2026-10-01' }, t)).rejects.toThrow(/Користувач/)
    expect(t.send).not.toHaveBeenCalled()
    expect(pendingLocalRequests(scope, storage)).toHaveLength(1)
  })
  it('does not resolve or clear a write after a user switch', async () => {
    let current = true
    const t = transport(); t.sameSession = () => current
    t.send.mockImplementation(async () => { current = false; return result })
    await expect(submit(payload, t)).rejects.toThrow(/Користувач/)
    expect(t.resolve).not.toHaveBeenCalled()
    expect(pendingLocalRequests(scope, storage)).toHaveLength(1)
  })
  it('requires the same session before any storage, resolve or send', async () => {
    const t = transport(); t.sameSession = () => false
    await expect(submit(payload, t)).rejects.toThrow(/Користувач/)
    expect(t.send).not.toHaveBeenCalled(); expect(t.resolve).not.toHaveBeenCalled()
    expect(values.size).toBe(0)
  })
  it('does not resolve or send when the pending journal is malformed', async () => {
    values.set('forsage:pending-request:v1:' + scope, 'invalid json')
    const t = transport()
    await expect(submit(payload, t)).rejects.toThrow()
    expect(t.send).not.toHaveBeenCalled(); expect(t.resolve).not.toHaveBeenCalled()
  })
  it('cannot write without first durably preserving its identity', async () => {
    const t = transport()
    await expect(submit(payload, t, { ...storage, setItem: () => { throw Error('storage full') } }))
      .rejects.toThrow('storage full')
    expect(t.send).not.toHaveBeenCalled()
  })
  it('resolves the original ID without replay when acknowledgement cleanup failed', async () => {
    const t = transport()
    await expect(submit(payload, t, { ...storage, removeItem: () => { throw Error('storage unavailable') } }))
      .rejects.toThrow('storage unavailable')
    const id = t.send.mock.calls[0][0]
    t.resolve.mockResolvedValue({ status: 'committed', result })
    await submit(payload, t)
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.resolve).toHaveBeenCalledExactlyOnceWith(id)
  })
})

it.each([undefined, null, 12649, '12650'])('requires a matching top-level daily payout amount %s', async amount => {
  const scope = 'daily-salary:cashier'
  const t = { send: vi.fn().mockResolvedValue({ payment: salary, amount }),
    resolve: vi.fn().mockRejectedValue(Error('offline')), sameSession: () => true }
  await expect(submitSalaryRequest('daily-salary', scope, payload, t, storage)).rejects.toThrow(/підтвердити/)
  expect(pendingLocalRequests(scope, storage)).toHaveLength(1)
})
