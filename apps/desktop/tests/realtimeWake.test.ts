import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RealtimeWake, WAKE_HEARTBEAT_MS, WAKE_RECONNECT_MS, realtimeSocketUrl, type WakeSocket } from '../src/link/realtimeWake'

// 23.11.2026: у фоні (без вікна) сигнал «у вебі є робота» слухав лише... ніхто: запити вебу чекали 1–11 с (замір 12:24–12:46).
class FakeSocket implements WakeSocket {
  readyState = 0; sent: any[] = []; closed = false
  onopen: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null; onerror: (() => void) | null = null
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.closed = true }
  open() { this.readyState = 1; this.onopen?.() }
  push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
  drop() { this.readyState = 3; this.onclose?.() }
}

function setup(overrides: { topic?: string | null } = {}) {
  const sockets: FakeSocket[] = [], timers: Array<{ run: () => void; ms: number; live: boolean }> = []
  let wakes = 0
  const wake = new RealtimeWake({
    url: () => 'https://zuhanlspejgizjbwbnda.supabase.co', apiKey: () => 'anon-key',
    topic: () => overrides.topic === undefined ? 'till-rpc-tenant' : overrides.topic,
    onWake: () => { wakes++ },
    socket: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket },
    setTimer: (run, ms) => { const timer = { run, ms, live: true }; timers.push(timer); return timer },
    clearTimer: handle => { (handle as { live: boolean }).live = false },
  })
  const fire = (ms: number) => { const timer = timers.find(item => item.live && item.ms === ms); if (!timer) throw new Error('no timer ' + ms); timer.live = false; timer.run() }
  return { wake, sockets, timers, fire, wakes: () => wakes }
}

describe('the background till hears the web wake signal', () => {
  it('connects to the realtime socket of the same project and joins the till topic', () => {
    expect(realtimeSocketUrl('https://abc.supabase.co/', 'k e y')).toBe('wss://abc.supabase.co/realtime/v1/websocket?apikey=k%20e%20y&vsn=1.0.0')
    expect(() => realtimeSocketUrl('http://abc.supabase.co', 'k')).toThrow()
    const { wake, sockets, wakes } = setup()
    wake.start()
    sockets[0].open()
    expect(sockets[0].sent[0]).toMatchObject({ topic: 'realtime:till-rpc-tenant', event: 'phx_join' })
    // Після (пере)підключення одразу питає касу: поки з'єднання не було, могла прийти робота.
    expect(wakes()).toBe(1)
  })

  it('a wake for this till wakes it; other topics and events do not', () => {
    const { wake, sockets, wakes } = setup()
    wake.start(); sockets[0].open()
    sockets[0].push({ topic: 'realtime:till-rpc-tenant', event: 'broadcast', payload: { event: 'wake', payload: {} } })
    sockets[0].push({ topic: 'realtime:till-rpc-other', event: 'broadcast', payload: { event: 'wake' } })
    sockets[0].push({ topic: 'realtime:till-rpc-tenant', event: 'broadcast', payload: { event: 'other' } })
    sockets[0].push({ topic: 'realtime:till-rpc-tenant', event: 'phx_reply', payload: { status: 'ok' } })
    sockets[0].onmessage?.({ data: 'not json' })
    expect(wakes()).toBe(2)
  })

  it('keeps the connection alive and comes back after a drop, waiting longer each time', () => {
    const { wake, sockets, fire } = setup()
    wake.start(); sockets[0].open()
    fire(WAKE_HEARTBEAT_MS)
    expect(sockets[0].sent.at(-1)).toMatchObject({ topic: 'phoenix', event: 'heartbeat' })
    sockets[0].drop()
    fire(WAKE_RECONNECT_MS[0])
    expect(sockets).toHaveLength(2)
    sockets[1].drop()
    fire(WAKE_RECONNECT_MS[1])
    expect(sockets).toHaveLength(3)
    // Вдале підключення скидає очікування до найкоротшого.
    sockets[2].open(); sockets[2].drop()
    fire(WAKE_RECONNECT_MS[0])
    expect(sockets).toHaveLength(4)
  })

  it('without the link key (nobody signed in yet) it waits instead of connecting; stop closes everything', () => {
    const quiet = setup({ topic: null })
    quiet.wake.start()
    expect(quiet.sockets).toHaveLength(0)
    expect(quiet.timers.some(timer => timer.live)).toBe(true)
    const { wake, sockets, timers } = setup()
    wake.start(); sockets[0].open(); wake.stop()
    expect(sockets[0].closed).toBe(true)
    expect(timers.every(timer => !timer.live)).toBe(true)
    sockets[0].drop()
    expect(sockets).toHaveLength(1)
  })

  it('is started only in the background mode; the window keeps its own subscription', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')
    const block = main.slice(main.indexOf('getTillDeviceLink().start()'), main.indexOf('// Раз на добу — копія даних'))
    expect(block).toContain('if (backgroundMode) {')
    expect(block).toContain('new RealtimeWake({')
    expect(block).toContain('return tenant ? `till-rpc-${tenant}` : null')
    expect(block).toContain('onWake: () => { void getTillDeviceLink().wake().catch(() => undefined) },')
    // Той самий топік, у який шле сервер.
    const server = readFileSync(new URL('../../../server/src/services/tillWake.ts', import.meta.url), 'utf8')
    expect(server).toContain('return `till-rpc-${tenantId}`')
  })
})
