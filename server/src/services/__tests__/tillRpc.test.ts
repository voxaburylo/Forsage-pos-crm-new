import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { callTill, claimRpc, finishRpc, webRpcChannelAllowed } from '../tillRpcService.js'
import { isWriteAllowed } from '../../middleware/localFirstWriteGuard.js'

// 22.11.2026, рішення власника «веб повний, але тільки через головний ПК, щоб нічого не задвоїлось».
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const online = (value: boolean) => ({ rows: [{ seen_at: '2026-11-22T10:00:00Z', online: value }] })
const noWake = async () => undefined

describe('web works through the main PC', () => {
  beforeEach(() => query.mockReset())

  it('never forwards session, network, printing, fiscal or backup actions', () => {
    for (const channel of ['desktop:supply:post-invoice', 'desktop:inventory:count', 'desktop:staff:set-pin', 'desktop:ai:chat'])
      expect(webRpcChannelAllowed(channel)).toBe(true)
    for (const channel of ['desktop:auth:login', 'desktop:lan:update', 'desktop:print:receipt', 'desktop:fiscal:sale', 'desktop:backup:restore',
      'desktop:backup-now', 'desktop:sync:push', 'desktop:web-rpc:execute', 'desktop:get-runtime-info', 'evil', 'desktop:../x'])
      expect(webRpcChannelAllowed(channel)).toBe(false)
  })

  it('refuses when the main PC is offline and stores nothing', async () => {
    query.mockResolvedValueOnce(online(false))
    await expect(callTill('t', 'u', { channel: 'desktop:supply:list', args: [] }, noWake)).rejects.toMatchObject({ status: 409, code: 'TILL_OFFLINE' })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('returns what the main PC answered', async () => {
    query.mockResolvedValueOnce(online(true))
      .mockResolvedValueOnce({ rows: [{ id: id(1) }] })
      .mockResolvedValueOnce({ rows: [{ status: 'claimed' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'done', result: { posted: true } }] })
    await expect(callTill('t', 'u', { channel: 'desktop:supply:post-invoice', args: [{ id: id(2) }] }, noWake)).resolves.toEqual({ posted: true })
    expect(query.mock.calls[1][1]).toEqual(['t', 'u', 'desktop:supply:post-invoice', JSON.stringify([{ id: id(2) }])])
  })

  it('passes the refusal of the main PC to the web', async () => {
    query.mockResolvedValueOnce(online(true)).mockResolvedValueOnce({ rows: [{ id: id(1) }] })
      .mockResolvedValueOnce({ rows: [{ status: 'failed', error: 'Недостатньо прав' }] })
    await expect(callTill('t', 'u', { channel: 'desktop:supply:list', args: [] }, noWake)).rejects.toMatchObject({ status: 422, message: 'Недостатньо прав' })
  })

  it('an unclaimed request is cancelled, never run late; a claimed one without answer says check on the till', async () => {
    query.mockResolvedValueOnce(online(true)).mockResolvedValueOnce({ rows: [{ id: id(1) }] })
      .mockResolvedValue({ rows: [{ status: 'pending' }], rowCount: 1 })
    await expect(callTill('t', 'u', { channel: 'desktop:supply:list', args: [] }, noWake, 200)).rejects.toMatchObject({ code: 'TILL_OFFLINE' })
    expect(query.mock.calls.at(-1)![0]).toContain("status = 'expired'")
    query.mockReset()
    query.mockResolvedValueOnce(online(true)).mockResolvedValueOnce({ rows: [{ id: id(1) }] })
      .mockResolvedValue({ rows: [{ status: 'claimed' }], rowCount: 0 })
    await expect(callTill('t', 'u', { channel: 'desktop:supply:list', args: [] }, noWake, 200)).rejects.toMatchObject({ code: 'TILL_TIMEOUT' })
  })

  it('the till claims fresh requests once and answers only its own', async () => {
    query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: id(1), user_id: id(3), channel: 'desktop:supply:list', args: [] }] })
      .mockResolvedValue({ rows: [] })
    await expect(claimRpc('t', id(4))).resolves.toEqual([{ id: id(1), user_id: id(3), channel: 'desktop:supply:list', args: [] }])
    expect(query.mock.calls[1][0]).toContain('FOR UPDATE SKIP LOCKED')
    query.mockReset().mockResolvedValueOnce({ rowCount: 0 })
    await expect(finishRpc('t', id(4), id(1), { status: 'done', result: {} })).rejects.toMatchObject({ status: 404 })
    expect(query.mock.calls[0][0]).toContain("status = 'claimed'")
    await expect(claimRpc('t', 'not-a-device')).rejects.toMatchObject({ status: 422 })
  })

  it('the web may send a request to the main PC; claim and answer stay with the till program', () => {
    const req = (path: string, desktop = false) => ({ method: 'POST', path, get: (name: string) => (desktop && name === 'x-forsage-client' ? 'desktop' : undefined) })
    expect(isWriteAllowed(req('/api/v1/till-rpc') as never)).toBe(true)
    expect(isWriteAllowed(req('/api/v1/till-rpc/claim') as never)).toBe(false)
    expect(isWriteAllowed(req('/api/v1/till-rpc/claim', true) as never)).toBe(true)
  })
})
