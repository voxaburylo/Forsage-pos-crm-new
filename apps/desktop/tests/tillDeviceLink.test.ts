import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { DEVICE_ANSWER_RETRY_MS, DEVICE_LINK_FAST_MS, DEVICE_LINK_SLOW_MS, TillDeviceLink, type TillDeviceLinkDeps } from '../src/link/tillDeviceLink'
import { RPC_BYTES, RPC_DATE, decodeRpcValue, encodeRpcValue } from '../src/link/rpcCodec'
import { PUBLIC_DESKTOP_CHANNELS, isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { isLanProxyChannel } from '../src/lan/localNetwork'
import { webRpcChannelAllowed } from '../src/lan/webRpcChannels'

// 22.11.2026, «головний ПК — тимчасовий сервер магазину»: веб працював через головний ПК, лише поки в програмі
// хтось увійшов. Тепер зв'язок тримає сама програма ключем ПК — і на екрані входу, і після перезапуску.
const DEVICE = '00000000-0000-4000-8000-000000000004'
const TOKEN = 'k'.repeat(43)
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) })
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) })

function harness(over: Partial<TillDeviceLinkDeps> = {}, key: { token: string; tenant_id: string } | null = { token: TOKEN, tenant_id: 't' }) {
  const calls: Array<{ path: string; body: any; headers: Record<string, string> }> = []
  const timers: Array<{ run: () => void; ms: number }> = []
  const answers = new Map<string, Array<ReturnType<typeof ok> | ReturnType<typeof fail> | Error>>()
  let stored = key
  const deps: TillDeviceLinkDeps = {
    fetch: async (url, init) => {
      const path = url.replace('https://server.example/api/v1/till-device', '')
      calls.push({ path, body: JSON.parse(init.body), headers: init.headers })
      const next = (answers.get(path) ?? []).shift() ?? (path === '/beat' ? ok({ rpc: false, commands: false, web_active: false }) : ok([]))
      if (next instanceof Error) throw next
      return next
    },
    apiUrl: () => 'https://server.example/',
    deviceId: () => DEVICE,
    readKey: () => stored,
    writeKey: value => { stored = value },
    execute: async () => 'done',
    canRun: () => true,
    setTimer: (run, ms) => { timers.push({ run, ms }); return timers.length },
    clearTimer: () => undefined,
    sleep: async () => undefined,
    ...over,
  }
  const link = new TillDeviceLink(deps)
  const answer = (path: string, ...list: Array<ReturnType<typeof ok> | ReturnType<typeof fail> | Error>) => answers.set(path, list)
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  return { link, calls, timers, answer, settle, stored: () => stored }
}

describe('the main PC keeps its own link to the server', () => {
  it('idle: one light question every 30 seconds, authorised by the key of the PC', async () => {
    const h = harness()
    h.link.start(); await h.settle()
    expect(h.calls.map(call => call.path)).toEqual(['/beat'])
    expect(h.calls[0].headers).toMatchObject({ Authorization: `Device ${DEVICE}.${TOKEN}`, 'X-Forsage-Client': 'desktop' })
    expect(h.timers.at(-1)!.ms).toBe(DEVICE_LINK_SLOW_MS)
    expect(h.link.status()).toMatchObject({ registered: true, rejected: false, tenant_id: 't', commands_pending: false })
    h.link.stop()
  })

  it('someone works in the web: asks every 3 seconds and tells the window about waiting commands', async () => {
    const h = harness()
    h.answer('/beat', ok({ rpc: false, commands: true, web_active: true }))
    h.link.start(); await h.settle()
    expect(h.timers.at(-1)!.ms).toBe(DEVICE_LINK_FAST_MS)
    expect(h.link.status().commands_pending).toBe(true)
    h.link.commandsTaken()
    expect(h.link.status().commands_pending).toBe(false)
    h.link.stop()
  })

  it('executes a web request with the rights of its web user and returns the answer', async () => {
    const execute = vi.fn(async () => ({ posted: true, at: new Date('2026-11-22T10:00:00Z'), photo: Uint8Array.from([1, 2, 3]) }))
    const h = harness({ execute })
    h.answer('/beat', ok({ rpc: true, commands: false, web_active: true }))
    h.answer('/rpc/claim', ok([{ id: 'r1', user_id: 'u1', channel: 'desktop:supply:post-invoice', args: [{ id: 'i1', file: { [RPC_BYTES]: 'AQI=' } }] }]))
    h.link.start(); await h.settle()
    expect(execute).toHaveBeenCalledTimes(1)
    const [userId, channel, args] = execute.mock.calls[0] as unknown as [string, string, any[]]
    expect([userId, channel]).toEqual(['u1', 'desktop:supply:post-invoice'])
    expect(args[0].file).toBeInstanceOf(ArrayBuffer)
    const result = h.calls.find(call => call.path === '/rpc/r1/result')!
    expect(result.body.outcome).toEqual({ status: 'done', result: { posted: true, at: { [RPC_DATE]: '2026-11-22T10:00:00.000Z' }, photo: { [RPC_BYTES]: 'AQID' } } })
    h.link.stop()
  })

  it('a refusal of the till goes to the web as a refusal, not as silence', async () => {
    const h = harness({ execute: async () => { throw new Error('Недостатньо прав для цієї дії') } })
    h.answer('/beat', ok({ rpc: true }))
    h.answer('/rpc/claim', ok([{ id: 'r1', user_id: 'u1', channel: 'desktop:staff:list-users', args: [] }]))
    h.link.start(); await h.settle()
    expect(h.calls.find(call => call.path === '/rpc/r1/result')!.body.outcome).toEqual({ status: 'failed', error: 'Недостатньо прав для цієї дії' })
    h.link.stop()
  })

  it('retries delivering the answer through network blips, and stops when the request is already closed', async () => {
    const h = harness()
    h.answer('/beat', ok({ rpc: true }))
    h.answer('/rpc/claim', ok([{ id: 'r1', user_id: 'u1', channel: 'desktop:supply:list', args: [] }]))
    h.answer('/rpc/r1/result', new Error('offline'), fail(503), ok({ ok: true }))
    h.link.start(); await h.settle()
    expect(h.calls.filter(call => call.path === '/rpc/r1/result')).toHaveLength(3)
    const closed = harness()
    closed.answer('/beat', ok({ rpc: true }))
    closed.answer('/rpc/claim', ok([{ id: 'r2', user_id: 'u1', channel: 'desktop:supply:list', args: [] }]))
    closed.answer('/rpc/r2/result', fail(404))
    closed.link.start(); await closed.settle()
    expect(closed.calls.filter(call => call.path === '/rpc/r2/result')).toHaveLength(1)
    expect(DEVICE_ANSWER_RETRY_MS.length).toBeGreaterThanOrEqual(4)
    h.link.stop(); closed.link.stop()
  })

  it('a signal from the window makes the till look at once and claim', async () => {
    const h = harness()
    h.link.start(); await h.settle()
    h.calls.length = 0
    const status = await h.link.wake()
    expect(h.calls.map(call => call.path)).toEqual(['/beat', '/rpc/claim'])
    expect(status.registered).toBe(true)
    expect(h.timers.at(-1)!.ms).toBe(DEVICE_LINK_FAST_MS)
    h.link.stop()
  })

  it('without a key, on the manager PC or during database maintenance it stays silent', async () => {
    for (const h of [harness({}, null), harness({ canRun: () => false }), harness({ apiUrl: () => null })]) {
      h.link.start(); await h.settle()
      expect(h.calls).toEqual([])
      expect(h.timers.at(-1)!.ms).toBe(DEVICE_LINK_SLOW_MS)
      h.link.stop()
    }
    expect(harness({}, null).link.status()).toMatchObject({ registered: false, tenant_id: null })
    // Збірка без адреси сервера: ключ є, але зв'язку немає — «підключено» не показуємо.
    expect(harness({ apiUrl: () => null }).link.status()).toMatchObject({ registered: false, rejected: false })
  })

  it('a key the server rejects is not hammered; a new key from the owner restores the link', async () => {
    const h = harness()
    h.answer('/beat', fail(401))
    h.link.start(); await h.settle()
    expect(h.link.status()).toMatchObject({ registered: false, rejected: true })
    h.timers.at(-1)!.run(); await h.settle()
    expect(h.calls).toHaveLength(1)
    h.link.register('n'.repeat(43), 't'); await h.settle()
    expect(h.stored()).toEqual({ token: 'n'.repeat(43), tenant_id: 't' })
    expect(h.link.status()).toMatchObject({ registered: true, rejected: false })
    expect(h.calls.at(-2)!.headers.Authorization).toBe(`Device ${DEVICE}.${'n'.repeat(43)}`)
    expect(() => h.link.register('bad key', 't')).toThrow('Некоректний ключ')
    h.link.stop()
  })
})

describe('the main PC takes the cloud-only data for its own copies', () => {
  it('asks with its key; without a key or a connection it simply waits for the next time', async () => {
    const h = harness()
    h.answer('/server-data', ok({ version: 1, tables: {} }))
    await expect(h.link.serverData()).resolves.toEqual({ version: 1, tables: {} })
    expect(h.calls.at(-1)).toMatchObject({ path: '/server-data', headers: { Authorization: `Device ${DEVICE}.${TOKEN}` } })
    h.answer('/server-data', new Error('offline'))
    await expect(h.link.serverData()).resolves.toBeNull()
    await expect(harness({}, null).link.serverData()).resolves.toBeNull()
    await expect(harness({ canRun: () => false }).link.serverData()).resolves.toBeNull()
  })
})

describe('the link actions belong to this PC only', () => {
  it('the web and the manager PC can never call them; the key is brought only by the owner', () => {
    for (const channel of ['desktop:link:status', 'desktop:link:wake', 'desktop:link:register', 'desktop:link:commands-taken']) {
      expect(webRpcChannelAllowed(channel), channel).toBe(false)
      expect(isLanProxyChannel(channel), channel).toBe(false)
    }
    expect(PUBLIC_DESKTOP_CHANNELS.has('desktop:link:status')).toBe(true)
    expect(PUBLIC_DESKTOP_CHANNELS.has('desktop:link:wake')).toBe(true)
    expect(PUBLIC_DESKTOP_CHANNELS.has('desktop:link:register')).toBe(false)
    for (const role of ['owner', 'admin']) expect(isDesktopChannelAllowed('desktop:link:register', role)).toBe(true)
    for (const role of ['manager', 'cashier', 'storekeeper', 'tire_worker']) expect(isDesktopChannelAllowed('desktop:link:register', role)).toBe(false)
    expect(isDesktopChannelAllowed('desktop:link:commands-taken', 'cashier')).toBe(true)
    const server = readFileSync(new URL('../../../server/src/services/tillRpcService.ts', import.meta.url), 'utf8')
    expect(server).toContain("'desktop:link:'")
  })

  it('the request format is the same as in the web', () => {
    const web = readFileSync(new URL('../../web/src/lib/tillRpcCodec.ts', import.meta.url), 'utf8')
    expect(web).toContain(`const BYTES = '${RPC_BYTES}'`)
    expect(web).toContain(`const DATE = '${RPC_DATE}'`)
    const value = { a: [1, 'x', null], when: new Date('2026-11-22T10:00:00Z'), bytes: Uint8Array.from([0, 255, 7]) }
    const decoded = decodeRpcValue(JSON.parse(JSON.stringify(encodeRpcValue(value)))) as any
    expect(decoded.a).toEqual([1, 'x', null])
    expect(decoded.when).toEqual(value.when)
    expect(new Uint8Array(decoded.bytes)).toEqual(value.bytes)
    expect(() => encodeRpcValue({ run: () => 1 })).toThrow()
  })
})
