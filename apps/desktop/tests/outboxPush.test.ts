import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { LocalSyncOutboxOperation, LocalSyncPushResult } from '../src/db/localTypes'
import { OUTBOX_BUSY_MS, OUTBOX_IDLE_MS, OUTBOX_RETRY_MS, OutboxPusher, pushOutboxOnce, selectPushBatch, validatePushResults, type OutboxStore } from '../src/link/outboxPush'
import { TillDeviceLink } from '../src/link/tillDeviceLink'
import { isLanProxyChannel } from '../src/lan/localNetwork'
import { webRpcChannelAllowed } from '../src/lan/webRpcChannels'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'

// 23.11.2026: власник зберіг у вебі chat ID бота; каса записала його, але на сервер відправка йшла лише з вікна програми
// сесією касира — «Недостатньо прав». У фоні (без вікна) на сервер не йшло нічого. Тепер передає головний процес ключем ПК.
const operation = (sequence: number, over: Partial<LocalSyncOutboxOperation> = {}): LocalSyncOutboxOperation => ({
  sequence, operation_id: 'op-' + sequence, tenant_id: 't', device_id: 'd', aggregate_type: 'settings', aggregate_id: 'local-shop',
  operation_type: 'settings.updated', payload: { n: sequence }, created_at: '2026-11-23T09:32:32.348Z', attempts: 0, last_error: null, ...over,
})
function store(pending: LocalSyncOutboxOperation[]) {
  const applied: LocalSyncPushResult[][] = [], failed: Array<{ sequences: number[]; error: string }> = []
  const value: OutboxStore = {
    listPending: limit => pending.slice(0, limit),
    getPullState: () => ({ reset_generation: 3 }) as never,
    applyPushResults: results => { applied.push(results); for (const result of results) if (result.status === 'synced') pending.splice(pending.findIndex(item => item.sequence === result.sequence), 1) },
    markBatchFailed: (sequences, error) => { failed.push({ sequences, error }) },
  }
  return { value, applied, failed, pending }
}
const synced = (operations: LocalSyncOutboxOperation[]) => ({ results: operations.map(item => ({ sequence: item.sequence, operation_id: item.operation_id, status: 'synced' })) })

describe('one upload of the till queue', () => {
  it('sends the queue in order with the data generation and applies the acknowledgements', async () => {
    const { value, applied } = store([operation(1), operation(2)])
    const sent: unknown[] = []
    const result = await pushOutboxOnce(value, async body => { sent.push(body); return synced(body.operations) })
    expect(sent).toEqual([{ reset_generation: 3, operations: [operation(1), operation(2)] }])
    expect(result).toEqual({ pushed: 2, failed: 0, pending: 0, resetRequired: false })
    expect(applied[0].map(item => item.status)).toEqual(['synced', 'synced'])
  })

  it('nothing to send — no request', async () => {
    const { value } = store([])
    let calls = 0
    expect(await pushOutboxOnce(value, async () => { calls++; return {} })).toEqual({ pushed: 0, failed: 0, pending: 0, resetRequired: false })
    expect(calls).toBe(0)
  })

  it('a lost connection marks the batch for a retry and keeps the documents', async () => {
    const { value, failed, applied, pending } = store([operation(1), operation(2)])
    await expect(pushOutboxOnce(value, async () => { throw new Error('Сервер відповів HTTP 502') })).rejects.toThrow('502')
    expect(failed).toEqual([{ sequences: [1, 2], error: 'Сервер відповів HTTP 502' }])
    expect(applied).toEqual([])
    expect(pending).toHaveLength(2)
  })

  it('accepts acknowledgements only for the documents it sent; a missing one is retried', () => {
    const sent = [operation(1), operation(2)]
    expect(validatePushResults(sent, [{ sequence: 1, operation_id: 'op-1', status: 'synced' }]).map(item => item.status)).toEqual(['synced', 'failed'])
    expect(() => validatePushResults(sent, [{ sequence: 9, operation_id: 'op-9', status: 'synced' }])).toThrow('Некоректне підтвердження')
    expect(() => validatePushResults(sent, [{ sequence: 1, operation_id: 'other', status: 'synced' }])).toThrow('Некоректне підтвердження')
    expect(() => validatePushResults(sent, null)).toThrow('не підтвердив')
  })

  it('never jumps over a document that does not fit; a single oversized one is reported', async () => {
    const big = operation(1, { payload: { text: 'я'.repeat(600) } })
    expect(selectPushBatch([operation(1), big, operation(3)], 0, 700).operations.map(item => item.sequence)).toEqual([1])
    expect(selectPushBatch([big, operation(2)], 0, 300)).toMatchObject({ operations: [], oversized: { sequence: 1 } })
    const { value, failed } = store([operation(1, { payload: { text: 'я'.repeat(2_000_000) } }), operation(2)])
    let calls = 0
    expect(await pushOutboxOnce(value, async () => { calls++; return {} })).toMatchObject({ pushed: 0, failed: 1, pending: 1 })
    expect(calls).toBe(0)
    expect(failed[0].sequences).toEqual([1])
  })
})

describe('the main process keeps uploading on its own', () => {
  function setup(pending: LocalSyncOutboxOperation[], options: { available?: () => boolean; send?: (body: { operations: LocalSyncOutboxOperation[] }) => Promise<unknown> } = {}) {
    const { value } = store(pending)
    const timers: Array<{ run: () => void; ms: number; live: boolean }> = []
    let sends = 0
    const pusher = new OutboxPusher({
      available: options.available ?? (() => true), store: () => value,
      send: async body => { sends++; return options.send ? options.send(body) : synced(body.operations) },
      setTimer: (run, ms) => { const timer = { run, ms, live: true }; timers.push(timer); return timer },
      clearTimer: handle => { (handle as { live: boolean }).live = false },
    })
    return { pusher, timers, sends: () => sends, next: () => timers.filter(timer => timer.live).at(-1) }
  }

  it('without the PC key it does nothing and says so, so the window can upload the old way', async () => {
    const { pusher, sends } = setup([operation(1)], { available: () => false })
    expect(await pusher.pushNow()).toBeNull()
    expect(sends()).toBe(0)
  })

  it('concurrent requests share one upload', async () => {
    const { pusher, sends } = setup([operation(1)])
    const [first, second] = await Promise.all([pusher.pushNow(), pusher.pushNow()])
    expect(first).toBe(second)
    expect(sends()).toBe(1)
  })

  it('comes back soon while there is work, rarely when idle, and with growing pauses after a failure', async () => {
    const busy = setup([operation(1)]); busy.pusher.start()
    await busy.pusher.pushNow()
    expect(busy.next()?.ms).toBe(OUTBOX_BUSY_MS)
    await busy.pusher.pushNow()
    expect(busy.next()?.ms).toBe(OUTBOX_IDLE_MS)
    const broken = setup([operation(1)], { send: async () => { throw new Error('offline') } }); broken.pusher.start()
    await expect(broken.pusher.pushNow()).rejects.toThrow('offline')
    expect(broken.next()?.ms).toBe(OUTBOX_RETRY_MS[0])
    await expect(broken.pusher.pushNow()).rejects.toThrow('offline')
    expect(broken.next()?.ms).toBe(OUTBOX_RETRY_MS[1])
    broken.pusher.stop()
    expect(broken.timers.every(timer => !timer.live)).toBe(true)
  })

  it('a web action asks for an upload right away', () => {
    const { pusher, next } = setup([operation(1)]); pusher.start()
    pusher.soon()
    expect(next()?.ms).toBe(1_500)
  })
})

describe('the link of the main PC carries the upload and reports the queue', () => {
  function link(overrides: Partial<ConstructorParameters<typeof TillDeviceLink>[0]> = {}) {
    const calls: Array<{ url: string; body: any; auth: string }> = []
    const value = new TillDeviceLink({
      fetch: async (url, init) => { calls.push({ url, body: JSON.parse(String((init as { body: string }).body)), auth: String((init as { headers: Record<string, string> }).headers.Authorization) }); return { ok: true, status: 200, json: async () => ({ data: { results: [] } }) } },
      apiUrl: () => 'https://server.example', deviceId: () => '00000000-0000-4000-8000-0000000000aa',
      readKey: () => ({ token: 'k'.repeat(43), tenant_id: 't' }), writeKey: () => undefined,
      execute: async () => null, canRun: () => true, setTimer: () => 1, clearTimer: () => undefined, ...overrides,
    })
    return { value, calls }
  }

  it('posts the documents to the device route with the PC key', async () => {
    const { value, calls } = link()
    await value.syncPush({ reset_generation: 0, operations: [] })
    expect(calls[0].url).toBe('https://server.example/api/v1/till-device/sync/push')
    expect(calls[0].auth).toBe('Device 00000000-0000-4000-8000-0000000000aa.' + 'k'.repeat(43))
  })

  it('refuses without a key or on a manager PC; a rejected key stops further uploads', async () => {
    await expect(link({ readKey: () => null }).value.syncPush({})).rejects.toThrow('не налаштовано')
    expect(link({ canRun: () => false }).value.available()).toBe(false)
    const rejected = link({ fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) })
    await expect(rejected.value.syncPush({})).rejects.toThrow('401')
    expect(rejected.value.available()).toBe(false)
  })

  it('tells the server the state of the queue with every heartbeat', async () => {
    const { value, calls } = link({ outboxSummary: () => ({ waiting: 4, oldest_at: '2026-11-23T09:32:32.348Z', error: 'Недостатньо прав' }) })
    const settle = () => new Promise(resolve => setTimeout(resolve, 20))
    value.start(); await settle()
    expect(calls[0].url).toContain('/till-device/beat')
    expect(calls[0].body).toEqual({ outbox: { waiting: 4, oldest_at: '2026-11-23T09:32:32.348Z', error: 'Недостатньо прав' } })
    const plain = link({ outboxSummary: () => { throw new Error('database closed') } })
    plain.value.start(); await settle()
    expect(plain.calls[0].body).toEqual({})
  })
})

describe('wiring', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')
  const main = read('../src/main.ts')

  it('the main process starts the uploader, kicks it after every web action and stops it on exit', () => {
    expect(main).toContain('getTillDeviceLink().start()\n  getOutboxPusher().start()')
    expect(main).toContain('available: () => Boolean(localSync) && getTillDeviceLink().available(),')
    expect(main).toContain('try { return await executeLanCommand(channel, list, session) } finally { getOutboxPusher().soon() }')
    expect(main).toContain('tillDeviceLink?.stop(); outboxPusher?.stop()')
    expect(main).toContain("handleDesktopIpc('desktop:link:push-outbox', () => getOutboxPusher().pushNow())")
  })

  it('anyone at the till may ask for an upload; it never leaves this computer', () => {
    for (const role of ['owner', 'admin', 'manager', 'cashier', 'storekeeper']) expect(isDesktopChannelAllowed('desktop:link:push-outbox', role)).toBe(true)
    expect(isLanProxyChannel('desktop:link:push-outbox')).toBe(false)
    expect(webRpcChannelAllowed('desktop:link:push-outbox')).toBe(false)
  })

  it('the window uses the main PC upload first and falls back to its own session only without the key', () => {
    const web = read('../../web/src/lib/desktopSyncApi.ts')
    expect(web).toContain('const viaMainPc = await desktop.link?.pushOutbox?.()\n    if (viaMainPc) return viaMainPc\n    if (!await canUseCloudBackground())')
    expect(read('../src/desktopApi.ts')).toContain("pushOutbox: () => ipcRenderer.invoke('desktop:link:push-outbox'),")
  })
})
