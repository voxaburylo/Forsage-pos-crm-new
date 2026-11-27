import { beforeEach, describe, expect, it, vi } from 'vitest'

// 27.11.2026, завдання власника: оплачені онлайн замовлення сайту самі стають замовленнями програми (бронь товару),
// перенесене позначається на сайті orders.mark_synced, двічі не створюється. База підмінена; дані з літерою «s».
const db = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; params: any[] }>,
  orders: new Map<string, { id: string; program_order_id: string | null; program_order_number: string | null }>(),
  commands: new Map<string, string>(), seq: 0, conflicts: [] as any[],
}))
vi.mock('../../db/pg.js', () => {
  const query = async (text: string, params: any[] = []) => {
    db.calls.push({ text, params })
    if (/INSERT INTO site_orders/.test(text)) {
      if (!db.orders.has(params[1])) db.orders.set(params[1], { id: `00000000-0000-4000-8000-00000000000${++db.seq}`, program_order_id: null, program_order_number: null })
      return { rows: [], rowCount: 1 }
    }
    if (/SELECT id::text AS id, program_order_id/.test(text)) { const row = db.orders.get(params[1]); return { rows: row ? [{ ...row }] : [] } }
    if (/INSERT INTO till_commands/.test(text)) {
      const status = db.commands.get(params[1])
      if (status && status !== 'expired') return { rows: [], rowCount: 0 }
      db.commands.set(params[1], 'pending')
      return { rows: [], rowCount: 1 }
    }
    if (/c.result->>'conflict' = 'true'/.test(text)) return { rows: db.conflicts }
    if (/INSERT INTO owner_alert_log/.test(text)) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }
  return { pool: { query, connect: async () => ({ query, release: () => undefined }) } }
})
vi.mock('../tillWake.js', () => ({ wakeTill: vi.fn(async () => undefined) }))
const telegram = vi.hoisted(() => ({ sent: [] as Array<{ chat: number; text: string }> }))
vi.mock('../ownerAlertService.js', () => ({ sendOwnerTelegram: async (chat: number, text: string) => { telegram.sent.push({ chat, text }); return true } }))
import { paidTillOrderPayload, pullPaidSiteOrders, sitePaidInfo } from '../sitePaidOrders.js'

const paid21 = {
  id: 21, created_at: '2026-11-27T10:00:00Z', status: 'new', customer_name: 'Ольга s', customer_phone: '0991112233', total: 500,
  paid: true, paid_at: '2026-11-27T10:05:00Z', paid_amount: 500, program_order_id: null,
  items: [{ product_id: 7, program_product_id: '11111111-2222-4333-8444-555555555555', title: 'Фільтр s', qty: 2, price: 250 }],
}

beforeEach(() => { db.calls = []; db.orders.clear(); db.commands.clear(); db.seq = 0; db.conflicts = []; telegram.sent = [] })

describe('paid site orders', () => {
  it('reads the paid fields; an unpaid order is not taken', () => {
    expect(sitePaidInfo(paid21)).toEqual({ amount: 50000, paid_at: '2026-11-27T10:05:00.000Z' })
    expect(sitePaidInfo({ ...paid21, paid: false })).toBeNull()
    expect(paidTillOrderPayload({ ...paid21, paid: undefined })).toBeNull()
    const prepared = paidTillOrderPayload(paid21)!
    expect(prepared.payload).toMatchObject({ source: 'site', paid: { amount: 50000 }, items: [{ product_id: '11111111-2222-4333-8444-555555555555', qty: 2, sell_price: 25000 }] })
  })

  it('asks the site only for paid and not yet synced orders and queues one till command per order, however many passes', async () => {
    const calls: Array<{ action: string; params: Record<string, unknown> }> = []
    const gateway = async (action: string, params: Record<string, unknown>) => { calls.push({ action, params }); return action === 'orders.list' ? [paid21, { ...paid21, id: 22, paid: false }] : null }
    expect(await pullPaidSiteOrders('t', 'u', { gateway })).toMatchObject({ seen: 2, queued: 1, synced: 0 })
    expect(calls[0]).toEqual({ action: 'orders.list', params: { paid: true, synced: false, limit: 50, offset: 0 } })
    expect(await pullPaidSiteOrders('t', 'u', { gateway })).toMatchObject({ queued: 0, synced: 0 })
    expect(calls.some(call => call.action === 'orders.mark_synced')).toBe(false)
  })

  it('once the till created the order, marks it synced on the site with the program number', async () => {
    const calls: Array<{ action: string; params: Record<string, unknown> }> = []
    const gateway = async (action: string, params: Record<string, unknown>) => { calls.push({ action, params }); return action === 'orders.list' ? [paid21] : null }
    await pullPaidSiteOrders('t', 'u', { gateway })
    const row = db.orders.get('21')!
    row.program_order_id = '99999999-8888-4777-8666-555555555555'; row.program_order_number = '1042'
    expect(await pullPaidSiteOrders('t', 'u', { gateway })).toMatchObject({ synced: 1, queued: 0 })
    expect(calls.find(call => call.action === 'orders.mark_synced')?.params).toEqual({ id: '21', program_order_id: '99999999-8888-4777-8666-555555555555', program_order_number: '1042' })
  })

  it('a command that expired while the till was off is queued again', async () => {
    const gateway = async (action: string) => action === 'orders.list' ? [paid21] : null
    await pullPaidSiteOrders('t', 'u', { gateway })
    db.commands.set(db.orders.get('21')!.id, 'expired')
    expect((await pullPaidSiteOrders('t', 'u', { gateway })).queued).toBe(1)
  })

  it('tells the owner once when the till had to create the paid order without enough stock', async () => {
    db.conflicts = [{ external_id: '21', program_order_number: '1042', note: '«Фільтр s» (вільно 1, треба 2)', chat: '555' }]
    const result = await pullPaidSiteOrders('t', 'u', { gateway: async () => [] })
    expect(result.conflicts).toBe(1)
    expect(telegram.sent[0].text).toContain('№ 21')
    expect(telegram.sent[0].text).toContain('вільно 1, треба 2')
  })
})
