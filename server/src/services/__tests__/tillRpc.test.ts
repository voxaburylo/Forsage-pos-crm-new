import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
const wake = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
vi.mock('../tillWake.js', () => ({ wakeTill: wake, tillWakeTopic: (tenant: string) => 'till-rpc-' + tenant }))
import { callTill, claimRpc, finishRpc, readRpc, rpcRequestSchema, webRpcChannelAllowed } from '../tillRpcService.js'
import { BEAT_FAST_MS, BEAT_SLOW_MS, RPC_CLAIM_SECONDS, tillBeat, touchWebPresence } from '../tillLinkService.js'
import { TILL_ONLINE_SECONDS, createCommand } from '../tillCommandService.js'
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

  // 22.11.2026: «спробуйте ще раз» після мовчання каси могло виконати дію двічі. Тепер веб чекає відповіді
  // на ТОЙ САМИЙ запит за його номером і нічого не надсилає вдруге.
  it('a claimed request without an answer hands the web its number instead of asking to repeat', async () => {
    expect(rpcRequestSchema.safeParse({ channel: 'desktop:supply:list', args: [], pending_ok: true }).success).toBe(true)
    query.mockResolvedValueOnce(online(true)).mockResolvedValueOnce({ rows: [{ id: id(1) }] })
      .mockResolvedValue({ rows: [{ status: 'claimed' }], rowCount: 0 })
    await expect(callTill('t', 'u', { channel: 'desktop:supply:post-invoice', args: [], pending_ok: true }, noWake, 200))
      .rejects.toMatchObject({ code: 'TILL_PENDING', status: 202, details: { request_id: id(1) } })
    // Не забраний касою запит, як і раніше, гаситься — навіть коли веб уміє чекати.
    query.mockReset()
    query.mockResolvedValueOnce(online(true)).mockResolvedValueOnce({ rows: [{ id: id(1) }] })
      .mockResolvedValue({ rows: [{ status: 'pending' }], rowCount: 1 })
    await expect(callTill('t', 'u', { channel: 'desktop:supply:list', args: [], pending_ok: true }, noWake, 200)).rejects.toMatchObject({ code: 'TILL_OFFLINE' })
  })

  it('a slow till action is still awaited after the claim, longer than an unclaimed request', async () => {
    query.mockResolvedValueOnce(online(true)).mockResolvedValueOnce({ rows: [{ id: id(1) }] })
    let asked = 0
    query.mockImplementation(async () => ({ rows: [++asked < 4 ? { status: 'claimed' } : { status: 'done', result: { ok: 1 } }], rowCount: 0 }))
    // Незабраний запит чекали б 100 мс; забраний чекаємо до 5 с — відповідь приходить після 4-го питання.
    await expect(callTill('t', 'u', { channel: 'desktop:supply:list', args: [] }, noWake, 5_000, 100)).resolves.toEqual({ ok: 1 })
  })

  it('the web reads the fate of its own request only', async () => {
    query.mockResolvedValueOnce({ rows: [{ status: 'done', result: { posted: true } }] })
    await expect(readRpc('t', 'u', id(1))).resolves.toEqual({ status: 'done', result: { posted: true } })
    expect(query.mock.calls[0][0]).toContain('user_id = $2')
    expect(query.mock.calls[0][1]).toEqual(['t', 'u', id(1)])
    query.mockResolvedValueOnce({ rows: [{ status: 'failed', error: 'Недостатньо прав' }] })
    await expect(readRpc('t', 'u', id(1))).resolves.toEqual({ status: 'failed', error: 'Недостатньо прав' })
    query.mockResolvedValueOnce({ rows: [{ status: 'claimed' }] })
    await expect(readRpc('t', 'u', id(1))).resolves.toEqual({ status: 'pending' })
    query.mockResolvedValueOnce({ rows: [{ status: 'expired' }] })
    await expect(readRpc('t', 'u', id(1))).resolves.toEqual({ status: 'expired' })
    query.mockResolvedValueOnce({ rows: [] })
    await expect(readRpc('t', 'other', id(1))).rejects.toMatchObject({ status: 404 })
    await expect(readRpc('t', 'u', 'not-an-id')).rejects.toMatchObject({ status: 422 })
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

// 22.11.2026, «каса головна; сервер — лише передавач»: каса питала сервер 1 920 разів на годину.
describe('the main PC asks the server rarely and often only while someone works in the web', () => {
  beforeEach(() => { query.mockReset(); wake.mockClear() })

  it('one light question tells the till whether there is work and how soon to ask again', async () => {
    query.mockResolvedValueOnce({ rows: [{ web_active: false, rpc: false, commands: false }] })
    await expect(tillBeat('t', id(4))).resolves.toEqual({ rpc: false, commands: false, web_active: false, next_ms: BEAT_SLOW_MS })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('INSERT INTO till_presence')
    expect(query.mock.calls[0][1]).toEqual(['t', id(4), 90, RPC_CLAIM_SECONDS])
    query.mockResolvedValueOnce({ rows: [{ web_active: true, rpc: true, commands: true }] })
    await expect(tillBeat('t', id(4))).resolves.toEqual({ rpc: true, commands: true, web_active: true, next_ms: BEAT_FAST_MS })
    await expect(tillBeat('t', 'not-a-device')).rejects.toMatchObject({ status: 422 })
    // Рідке опитування мусить устигати і в «касу видно», і у вікно, поки запит ще можна забрати.
    expect(BEAT_SLOW_MS / 1000).toBeLessThan(RPC_CLAIM_SECONDS)
    expect(BEAT_SLOW_MS / 1000 * 2).toBeLessThan(TILL_ONLINE_SECONDS)
  })

  it('the web opening a page wakes the till once, not on every status check', async () => {
    query.mockResolvedValueOnce({ rows: [{ seen_at: '2026-11-22T10:00:00Z', online: true, was_active: false }] })
    await expect(touchWebPresence('t', wake)).resolves.toEqual({ online: true, seen_at: '2026-11-22T10:00:00.000Z' })
    expect(wake).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('SET web_seen_at = now()')
    query.mockResolvedValueOnce({ rows: [{ seen_at: '2026-11-22T10:00:00Z', online: true, was_active: true }] })
    await touchWebPresence('t', wake)
    expect(wake).toHaveBeenCalledTimes(1)
    // Каса не на зв'язку — будити нікого; каси ще не було зовсім — просто «не на зв'язку».
    query.mockResolvedValueOnce({ rows: [{ seen_at: '2026-11-22T10:00:00Z', online: false, was_active: false }] })
    await expect(touchWebPresence('t', wake)).resolves.toMatchObject({ online: false })
    query.mockResolvedValueOnce({ rows: [] })
    await expect(touchWebPresence('t', wake)).resolves.toEqual({ online: false, seen_at: null })
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it('a new command wakes the till, since it no longer polls every few seconds', async () => {
    query.mockResolvedValueOnce({ rows: [{ seen_at: '2026-11-22T10:00:00Z', online: true }] })
      .mockResolvedValueOnce({ rows: [{ operation_id: id(1), status: 'pending' }] })
    await createCommand('t', id(2), { operation_id: id(1), command: 'product.update', payload: { product_id: id(3), base: { retail_price: 100 }, changes: { retail_price: 200 } } })
    expect(wake).toHaveBeenCalledWith('t')
  })

  it('only the till program may ask for work', () => {
    const req = (desktop: boolean) => ({ method: 'POST', path: '/api/v1/till-link/beat', get: (name: string) => (desktop && name === 'x-forsage-client' ? 'desktop' : undefined) })
    expect(isWriteAllowed(req(false) as never)).toBe(false)
    expect(isWriteAllowed(req(true) as never)).toBe(true)
  })
})

describe('PIN and password from the web while the main PC is off (owner decision 22.11.2026)', () => {
  beforeEach(() => query.mockReset())
  it('the web may change them; the till gets only a hash, never the secret', async () => {
    const req = (method: string, path: string) => ({ method, path, get: () => undefined })
    expect(isWriteAllowed(req('POST', '/api/v1/auth/set-pin') as never)).toBe(true)
    expect(isWriteAllowed(req('PUT', `/api/v1/admin/users/${id(1)}/password`) as never)).toBe(true)
    expect(isWriteAllowed(req('PUT', `/api/v1/admin/users/${id(1)}`) as never)).toBe(false)
    const { queueStaffSecret } = await import('../tillCommandService.js')
    const { hashSecret } = await import('../../lib/secretHash.js')
    query.mockResolvedValue({ rows: [] })
    await queueStaffSecret('t', id(2), id(1), 'pin', hashSecret('1234', 10_000))
    const payload = JSON.parse(query.mock.calls[0][1][2])
    expect(query.mock.calls[0][1][1]).toBe('staff.secret')
    expect(payload).toMatchObject({ user_id: id(1), kind: 'pin' })
    expect(JSON.stringify(payload)).not.toContain('1234')
    await expect(queueStaffSecret('t', id(2), id(1), 'pin', '1234')).rejects.toMatchObject({ status: 422 })
  })
})
