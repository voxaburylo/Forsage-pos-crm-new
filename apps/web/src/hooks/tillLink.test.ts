import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/api', () => ({ api: { post: vi.fn(), get: vi.fn() } }))

import { LINK_FAST_HOLD_MS, LINK_FAST_MS, LINK_LEGACY_MS, LINK_SLOW_MS, nextBeatDelay } from './tillLinkTiming'
import { ANSWER_RETRY_DELAYS_MS, deliverTillAnswer } from './useTillRpc'
import { TILL_ANSWER_UNKNOWN, waitForTillAnswer, type TillAnswerState } from '@/lib/remoteDesktop/tillAnswer'
import { isUserWatching, USER_IDLE_MS } from '@/lib/userActivity'

// 22.11.2026, «каса головна; сервер — лише передавач»: каса питала сервер 1 920 разів на годину,
// а «спробуйте ще раз» після мовчання каси могло виконати дію двічі.
describe('the main PC asks the server rarely, and often only while the web is in use', () => {
  it('idle: every 30 seconds; web in use: every 3 seconds; old server: as before', () => {
    expect(nextBeatDelay(1_000, 0, false)).toBe(LINK_SLOW_MS)
    expect(nextBeatDelay(1_000, 1_000 + LINK_FAST_HOLD_MS, false)).toBe(LINK_FAST_MS)
    expect(nextBeatDelay(1_000 + LINK_FAST_HOLD_MS, 1_000 + LINK_FAST_HOLD_MS, false)).toBe(LINK_SLOW_MS)
    expect(nextBeatDelay(1_000, 0, true)).toBe(LINK_LEGACY_MS)
    // Було 1 200 + 720 запитів на годину; стало 120.
    expect(3_600_000 / LINK_SLOW_MS).toBe(120)
  })

  it('one link replaces the two separate polls', () => {
    const agent = readFileSync(new URL('../components/LocalSyncAgent.tsx', import.meta.url), 'utf8')
    expect(agent).toContain('useTillLink(serverOnline)')
    expect(agent).not.toMatch(/useTillRpc\(|useTillCommands\(/)
    for (const file of ['./useTillRpc.ts', './useTillCommands.ts'])
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toContain('setInterval')
  })

  it('a forgotten or hidden web tab does not keep the till polling often', () => {
    const now = Date.now()
    expect(isUserWatching(now, false)).toBe(true)
    expect(isUserWatching(now, true)).toBe(false)
    expect(isUserWatching(now + USER_IDLE_MS + 1, false)).toBe(false)
    expect(readFileSync(new URL('../components/TillOnly.tsx', import.meta.url), 'utf8')).toContain("isUserWatching() ? '' : '?watch=0'")
  })
})

// 22.11.2026, «головний ПК — тимчасовий сервер магазину»: зв'язок тримає сама програма ключем ПК.
describe('the PC key: fetched by the owner once, then the web works through the PC without anyone signed in', () => {
  const hook = readFileSync(new URL('./useTillLink.ts', import.meta.url), 'utf8')

  it('only the owner or administrator on the main PC brings the key; nobody else can', () => {
    expect(hook).toContain("LINK_KEY_ROLES: readonly string[] = ['owner', 'admin']")
    expect(hook).toContain('status?.main_till && !status.registered && serverOnline && !offlineMode && user && LINK_KEY_ROLES.includes(role)')
    expect(hook).toContain("'/api/v1/till-device/register'")
  })

  it('with the key the window only relays the wake signal and runs commands that need a staff session', () => {
    const device = hook.slice(hook.indexOf('// 2. Ключ ПК'), hook.indexOf('// 3. Ключа ПК немає'))
    expect(device).toContain("if (link.mode !== 'device'")
    expect(device).toContain('deviceLink.wake()')
    expect(device).toContain('claimTillCommands(')
    expect(device).not.toContain('claimWebRequests(')
    expect(device).not.toContain("'/api/v1/till-link/beat'")
  })

  it('without the key the previous way stays: the window keeps the link under the signed-in employee', () => {
    const session = hook.slice(hook.indexOf('// 3. Ключа ПК немає'))
    expect(session).toContain("if (link.mode !== 'session'")
    expect(session).toContain('claimWebRequests(context)')
    expect(session).toContain("'/api/v1/till-link/beat'")
  })
})

describe('the answer of the main PC is never lost and the action is never sent twice', () => {
  const noSleep = async () => undefined

  it('the till retries delivering its answer through network blips', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(Object.assign(new Error('auth'), { status: 401 })).mockResolvedValue({})
    const waits: number[] = []
    await expect(deliverTillAnswer(send, async ms => { waits.push(ms) })).resolves.toBe(true)
    expect(send).toHaveBeenCalledTimes(3)
    expect(waits).toEqual(ANSWER_RETRY_DELAYS_MS.slice(0, 2))
  })

  it('stops when the server says the request is already closed, or after the last pause', async () => {
    const closed = vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }))
    await expect(deliverTillAnswer(closed, noSleep)).resolves.toBe(false)
    expect(closed).toHaveBeenCalledTimes(1)
    const dead = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(deliverTillAnswer(dead, noSleep)).resolves.toBe(false)
    expect(dead).toHaveBeenCalledTimes(ANSWER_RETRY_DELAYS_MS.length + 1)
  })

  it('the web waits for the same request by its number instead of repeating the action', async () => {
    const states: TillAnswerState[] = [{ status: 'pending' }, { status: 'pending' }, { status: 'done', result: { posted: true } }]
    const read = vi.fn(async () => states.shift()!)
    await expect(waitForTillAnswer(read, noSleep)).resolves.toEqual({ posted: true })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('a network blip while waiting only delays the answer', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ status: 'done', result: 7 })
    await expect(waitForTillAnswer(read, noSleep)).resolves.toBe(7)
  })

  it('a refusal of the till and a request the till never took are told apart', async () => {
    await expect(waitForTillAnswer(async () => ({ status: 'failed', error: 'Недостатньо прав' }), noSleep)).rejects.toThrow('Недостатньо прав')
    await expect(waitForTillAnswer(async () => ({ status: 'expired' }), noSleep)).rejects.toThrow('Дію не виконано')
  })

  it('after the limit the web says honestly that the result is unknown', async () => {
    let clock = 0
    const read = vi.fn(async (): Promise<TillAnswerState> => ({ status: 'pending' }))
    await expect(waitForTillAnswer(read, async ms => { clock += ms }, 10_000, () => clock)).rejects.toThrow(TILL_ANSWER_UNKNOWN)
    expect(read).toHaveBeenCalledTimes(5)
  })
})
