import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
vi.mock('../../db/supabase.js', () => ({ db: { storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) } } }))
vi.mock('../syncService.js', () => ({ pushLocalOperations: vi.fn() }))
import { devicePushSchema, pushFromMainPc } from '../tillDevicePush.js'
import { readOutboxReport, tillBeat } from '../tillLinkService.js'
import { OUTBOX_STUCK_MINUTES, planOwnerAlerts, type OwnerAlertFacts } from '../ownerAlertService.js'
import { ownerBotReply } from '../../routes/telegramWebhook.js'
import { isWriteAllowed } from '../../middleware/localFirstWriteGuard.js'

// 23.11.2026: власник зберіг у вебі chat ID бота — каса записала його в себе, але на сервер відправка йшла сесією
// касира, який увійшов у програму: «Недостатньо прав». Бот відповідав «chat ID не прив'язаний». У фоні (без вікна)
// на сервер не йшло нічого. Тепер зміни каси приходять ключем самого головного ПК.
const device = { tenant_id: '00000000-0000-4000-8000-000000000001', device_id: '00000000-0000-4000-8000-0000000000aa', created_by: 'owner-1' }
const operation = (over: Record<string, unknown> = {}) => ({
  sequence: 1, operation_id: 'op-1', tenant_id: device.tenant_id, device_id: device.device_id, aggregate_type: 'settings', aggregate_id: 'local-shop',
  operation_type: 'settings.updated', payload: { owner_telegram_chat_id: 42 }, created_at: '2026-11-23T09:32:32.348Z', ...over,
})

describe('changes of the till arrive with the key of the main PC', () => {
  it('are accepted with the owner scope, on behalf of whoever issued the key', async () => {
    const push = vi.fn(async () => ({ results: [], reset_required: false, reset_generation: 0, reset_at: null }))
    await pushFromMainPc(device, devicePushSchema.parse({ operations: [operation()] }), push as never)
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ tenantId: device.tenant_id, userId: 'owner-1', role: 'owner', resetGeneration: 0 }))
    expect(push.mock.calls[0][0].operations[0]).toMatchObject({ operation_type: 'settings.updated', payload: { owner_telegram_chat_id: 42 } })
  })

  it('carries only documents of this very PC', async () => {
    const push = vi.fn()
    const foreign = devicePushSchema.parse({ operations: [operation({ device_id: '00000000-0000-4000-8000-0000000000bb' })] })
    await expect(pushFromMainPc(device, foreign, push as never)).rejects.toMatchObject({ code: 'SYNC_DEVICE_MISMATCH' })
    await expect(pushFromMainPc({ ...device, created_by: null }, devicePushSchema.parse({ operations: [operation()] }), push as never))
      .rejects.toMatchObject({ code: 'TILL_DEVICE_UNAUTHORIZED' })
    expect(push).not.toHaveBeenCalled()
    expect(devicePushSchema.safeParse({ operations: [{ ...operation(), tenant_id: 'not-a-uuid' }] }).success).toBe(false)
    expect(devicePushSchema.safeParse({ operations: Array.from({ length: 101 }, () => operation()) }).success).toBe(false)
  })

  it('the route needs the device key and is open only to the till program', () => {
    const route = readFileSync(new URL('../../routes/tillDevice.ts', import.meta.url), 'utf8')
    expect(route).toContain("tillDeviceRouter.post('/sync/push', requireTillDevice,")
    expect(route).toContain('await pushFromMainPc(req.tillDevice!, parsed.data)')
    const service = readFileSync(new URL('../tillDeviceService.ts', import.meta.url), 'utf8')
    expect(service).toContain("'SELECT tenant_id, token_hash, created_by FROM till_devices WHERE device_id = $1'")
    const request = (client?: string) => ({ method: 'POST', originalUrl: '/api/v1/till-device/sync/push', path: '/api/v1/till-device/sync/push', get: (name: string) => name.toLowerCase() === 'x-forsage-client' ? client : undefined })
    expect(isWriteAllowed(request('desktop') as never)).toBe(true)
    expect(isWriteAllowed(request() as never)).toBe(false)
  })
})

describe('deleting an order reaches the server', () => {
  it('locks the order row without aggregation, then counts payments separately', () => {
    const source = readFileSync(new URL('../sync/orderHandlers.ts', import.meta.url), 'utf8')
    const remove = source.slice(source.indexOf('export async function applyOrderDeleted'), source.indexOf('export async function applyOrderStatusUpdated'))
    // Postgres: «FOR UPDATE is not allowed with GROUP BY clause».
    expect(remove).not.toContain('GROUP BY o.id')
    expect(remove).not.toContain('FOR UPDATE OF o')
    expect(remove).toMatch(/FROM customer_orders o\s+WHERE o\.id = \$1 AND o\.tenant_id = \$2 AND o\.deleted_at IS NULL\s+FOR UPDATE/)
    expect(remove).toContain('FROM order_payments WHERE order_id = $1 AND tenant_id = $2')
    expect(remove).toContain('const row = { ...order.rows[0], ...payments.rows[0] }')
  })
})

describe('the owner hears about a stuck upload queue', () => {
  beforeEach(() => query.mockReset())
  const at = (kyiv: string) => new Date(`2026-11-23T${kyiv}:00+02:00`)
  const facts = (outbox: OwnerAlertFacts['outbox']): OwnerAlertFacts =>
    ({ till_seen_at: at('11:59').toISOString(), open_shifts: [], closed_shifts: [], negative_products: [], last_backup_at: at('07:00').toISOString(), outbox })

  it('reads the report of the till and ignores anything malformed', () => {
    expect(readOutboxReport({ waiting: 4, oldest_at: '2026-11-23T09:32:32.348Z', error: 'Недостатньо прав' }))
      .toEqual({ waiting: 4, oldest_at: '2026-11-23T09:32:32.348Z', error: 'Недостатньо прав' })
    expect(readOutboxReport({ waiting: 0, oldest_at: '2026-11-23T09:32:32.348Z', error: 'old' })).toEqual({ waiting: 0, oldest_at: null, error: null })
    for (const bad of [null, 'x', { waiting: -1 }, { waiting: 1.5 }, { waiting: 'many' }]) expect(readOutboxReport(bad)).toBeNull()
    expect(readOutboxReport({ waiting: 1, oldest_at: 'yesterday' })).toEqual({ waiting: 1, oldest_at: null, error: null })
  })

  it('stores the report with the heartbeat without letting it break the link', async () => {
    query.mockImplementation(async (sql: string) => { if (String(sql).startsWith('UPDATE till_presence SET outbox_waiting')) throw new Error('column missing'); return { rows: [{}] } })
    await expect(tillBeat('t', '00000000-0000-4000-8000-0000000000aa', { waiting: 2, oldest_at: '2026-11-23T09:32:32.348Z', error: 'x' })).resolves.toMatchObject({ rpc: false })
    const update = query.mock.calls.find(call => String(call[0]).startsWith('UPDATE till_presence SET outbox_waiting'))
    expect(update?.[1]).toEqual(['t', 2, '2026-11-23T09:32:32.348Z', 'x'])
  })

  it('alerts once per jam, only when the report is fresh and the oldest change waits half an hour', () => {
    const stuck = { waiting: 4, oldest_at: at('11:32').toISOString(), error: 'Недостатньо прав для цієї операції синхронізації', reported_at: at('12:04').toISOString() }
    const plan = (outbox: OwnerAlertFacts['outbox'], now: Date) => planOwnerAlerts(facts(outbox), now).filter(alert => alert.key.startsWith('outbox:'))
    const alerts = plan(stuck, at('12:05'))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].text).toContain('Каса не може передати на сервер 4 змін')
    expect(alerts[0].text).toContain('Причина: Недостатньо прав')
    expect(alerts[0].key).toBe('outbox:' + at('11:32').toISOString())
    // Той самий затор за годину — той самий ключ, повтору не буде.
    expect(plan({ ...stuck, reported_at: at('13:04').toISOString() }, at('13:05')).map(alert => alert.key)).toEqual([alerts[0].key])
    expect(OUTBOX_STUCK_MINUTES).toBe(30)
    expect(plan({ ...stuck, oldest_at: at('11:50').toISOString() }, at('12:05'))).toEqual([])
    expect(plan({ ...stuck, waiting: 0, oldest_at: null }, at('12:05'))).toEqual([])
    // Каса давно мовчить — про це окрема тривога «каса не в мережі», старий звіт про чергу не повторюємо.
    expect(plan({ ...stuck, reported_at: at('11:40').toISOString() }, at('12:05'))).toEqual([])
    expect(plan(null, at('12:05'))).toEqual([])
  })
})

describe('the bot tells where to save the number', () => {
  it('in the program — at the till or in the web', () => {
    expect(ownerBotReply('/id', 42, false)?.reply).toContain('на касі чи у вебі')
    expect(ownerBotReply('/zvit', 42, false)?.reply).toContain('на касі чи у вебі')
    expect(ownerBotReply('/zvit', 42, false)?.reply).toContain('зачекайте хвилину')
    expect(ownerBotReply('/tryvogy', 42, false)?.reply).toContain('не прив’язаний')
  })
})
