import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LanOrderQueue, LanUnavailableError, type OrderSender } from '../src/lan/orderQueue'
import { LanOrderClient } from '../src/lan/orderClient'
import type { LanSession, LocalNetworkCoordinator } from '../src/lan/localNetwork'

describe('manager order-only offline workspace', () => {
  let roots: string[], client: LocalDatabase, hub: LocalDatabase, orders: LocalOrderRepository, queue: LanOrderQueue
  let connected: boolean, loseReply: boolean, productId: string, sent: number
  let session: LanSession, send: OrderSender
  beforeEach(() => {
    roots = [mkdtempSync(path.join(tmpdir(), 'forsage-lan-orders-client-')), mkdtempSync(path.join(tmpdir(), 'forsage-lan-orders-hub-'))]
    client = new LocalDatabase(roots[0]); hub = new LocalDatabase(roots[1]); orders = new LocalOrderRepository(hub)
    session = { id: randomUUID(), tenant_id: DEFAULT_TENANT_ID, role: 'manager' }
    productId = randomUUID(); connected = false; loseReply = false; sent = 0
    const now = new Date().toISOString()
    hub.prepare('INSERT INTO products(id,tenant_id,sku,name,retail_price,purchase_price,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(productId, DEFAULT_TENANT_ID, 'TEST-1', 'Тестова деталь', 15000, 10000, 10, now, now)
    send = async (channel, args, actor) => {
      if (!connected) throw new LanUnavailableError('Тест: ПК вимкнено')
      if (channel === 'desktop:orders:list') return orders.listOrders(args[0] as any)
      if (channel === 'desktop:orders:get') return orders.getOrder(String(args[0]), actor.tenant_id)
      if (channel !== 'desktop:orders:accept-offline') throw new Error('Unexpected channel ' + channel)
      sent++
      const result = orders.acceptOfflineOrder(args[0], actor)
      if (loseReply) { loseReply = false; throw new LanUnavailableError('Тест: відповідь загубилася') }
      return result
    }
    queue = new LanOrderQueue(client, send)
  })
  afterEach(() => {
    client.close(); hub.close()
    for (const root of roots) if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-lan-orders-')) rmSync(root, { recursive: true, force: true })
  })
  const payload = (product?: string) => ({ operation_id: randomUUID(), comment: 'Офлайн клієнт: +380501234567',
    items: [{ name: 'Тестова деталь', qty: 2, sell_price: 15000, buy_price: 10000, product_id: product, source_type: product ? 'warehouse' : 'supplier' }] })
  const count = (db: LocalDatabase, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n)

  it('persists offline orders without touching either stock, money, reservations or cloud queue', async () => {
    const beforeOutbox = count(client, 'sync_outbox')
    const saved = await queue.save('hub-A', session, payload(productId))
    expect(saved.lan_sync.state).toBe('pending')
    expect(saved.id).toMatch(/^lan-/)
    for (const table of ['customer_orders', 'customer_order_items', 'stock_reserves', 'inventory_movements', 'sales', 'order_payments']) expect(count(client, table)).toBe(0)
    expect(count(client, 'sync_outbox')).toBe(beforeOutbox)
    expect(count(hub, 'customer_orders')).toBe(0)
    expect((await queue.list('hub-A', session)).map(row => row.id)).toEqual([saved.id])
    client.close(); client = new LocalDatabase(roots[0]); queue = new LanOrderQueue(client, send)
    expect((await queue.get('hub-A', session, saved.id)).items[0].qty).toBe(2)
    connected = true
    await queue.flush('hub-A', session)
    expect(count(hub, 'customer_orders')).toBe(1)
    expect(count(hub, 'stock_reserves')).toBe(1)
    expect((hub.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(productId) as any).qty_on_hand).toBe(10)
    expect((await queue.get('hub-A', session, saved.id)).lan_sync).toBeUndefined()
  })
  it('recovers form save acknowledgments locally, including edits, without re-enqueueing', async () => {
    const create=payload(), first=await queue.save('hub-A',session,create)
    expect(queue.getSaveResult('hub-A',session,create.operation_id).id).toBe(first.id)
    const update={...payload(),expected_updated_at:first.updated_at,items:[{...first.items[0],qty:3}]}
    const edited=await queue.save('hub-A',session,update,first.id)
    expect(queue.hasPending()).toBe(true)
    client.close();client=new LocalDatabase(roots[0]);queue=new LanOrderQueue(client,send)
    expect(queue.getSaveResult('hub-A',session,update.operation_id,first.id).items[0].qty).toBe(3)
    expect(queue.getSaveResult('hub-A',{...session,id:randomUUID()},update.operation_id,first.id)).toBeNull()
    expect((await queue.save('hub-A',session,update,first.id)).updated_at).toBe(edited.updated_at)
    await expect(queue.save('hub-A',session,{...update,comment:'Changed'},first.id)).rejects.toThrow(/інші дані/)
    connected=true;await queue.flush('hub-A',session)
    expect(sent).toBe(2);expect(count(hub,'customer_orders')).toBe(1)
    expect(queue.getSaveResult('hub-A',session,update.operation_id,first.id).items[0].qty).toBe(3)
    expect(queue.hasPending()).toBe(false)
  })
  it('replays a lost acknowledgment after restart, without a second order or reservation', async () => {
    connected = true; loseReply = true
    const body = payload(productId), saved = await queue.save('hub-A', session, body)
    expect(saved.lan_sync.state).toBe('pending')
    expect(count(hub, 'customer_orders')).toBe(1)
    client.close(); client = new LocalDatabase(roots[0]); queue = new LanOrderQueue(client, send)
    const repeated = await queue.save('hub-A', session, body)
    expect(repeated.lan_sync).toBeUndefined()
    expect(sent).toBe(2)
    expect(count(hub, 'customer_orders')).toBe(1)
    expect(count(hub, 'stock_reserves')).toBe(1)
  })
  it('includes the returnable core deposit in the offline total and keeps the same total after delivery', async () => {
    const body = payload()
    const input = { ...body, items: [{ ...body.items[0], core_deposit_amount: 5000 }] }
    const draft = await queue.save('hub-A', session, input)
    expect(draft.total_amount).toBe(40000)
    connected = true; await queue.flush('hub-A', session)
    expect((await queue.get('hub-A', session, draft.id)).total_amount).toBe(40000)
    expect(count(hub, 'order_payments')).toBe(0)
  })
  it('rejects an overflowing aggregate or invalid amount without persisting a partial offline order', () => {
    const body = payload()
    for (const amount of [Infinity, NaN, true, ' ']) {
      expect(() => queue.enqueue('hub-A', session, { ...body, items: [{ ...body.items[0], sell_price: amount }] })).toThrow()
    }
    expect(() => queue.enqueue('hub-A', session, { ...body, items: [1,2].map(() => ({ ...body.items[0], qty: 1, sell_price: 1500000000 })) })).toThrow('Сума замовлення')
    expect(queue.hasPending()).toBe(false)
    expect(count(hub, 'customer_orders')).toBe(0)
  })
  it('preserves multiple offline edits in sequence with server versions from acknowledgments', async () => {
    const first = await queue.save('hub-A', session, payload())
    const second = await queue.save('hub-A', session, { ...payload(), comment: 'Друга правка', expected_updated_at: first.updated_at }, first.id)
    const third = await queue.save('hub-A', session, { ...payload(), comment: 'Третя правка', expected_updated_at: second.updated_at }, second.id)
    expect(third.comment).toBe('Третя правка')
    connected = true
    await queue.flush('hub-A', session)
    expect(count(hub, 'customer_orders')).toBe(1)
    expect((await queue.get('hub-A', session, first.id)).comment).toBe('Третя правка')
  })
  it('blocks conflicting changes and retains the manager copy', async () => {
    connected = true
    const serverOrder = orders.saveOrder({ ...payload(), manager_id: session.id })
    const cached = await queue.get('hub-A', session, serverOrder.id)
    connected = false
    const pending = await queue.save('hub-A', session, { ...payload(), comment: 'Мої правки', expected_updated_at: cached.updated_at }, cached.id)
    orders.saveOrder({ ...payload(), comment: 'Правки касира' }, cached.id)
    connected = true
    await queue.flush('hub-A', session)
    const blocked = await queue.get('hub-A', session, pending.id)
    expect(blocked.lan_sync.state).toBe('blocked')
    expect(blocked.comment).toBe('Мої правки')
    expect(orders.getOrder(cached.id).comment).toBe('Правки касира')
    queue.discard('hub-A', session, pending.id)
    expect(orders.getOrder(cached.id).comment).toBe('Правки касира')
  })
  it('retains changes when the hub cannot reserve the requested quantity', async () => {
    const body = payload(productId); body.items[0].qty = 20
    const saved = await queue.save('hub-A', session, body)
    connected = true; await queue.flush('hub-A', session)
    expect((await queue.get('hub-A', session, saved.id)).lan_sync.state).toBe('blocked')
    expect(count(hub, 'customer_orders')).toBe(0)
    expect(count(hub, 'stock_reserves')).toBe(0)
  })
  it('never accepts payments, exchanges, status changes or another tenant into the queue', () => {
    for (const changes of [{ prepayment: 1 }, { prepayment_method: 'cash' }, { exchange_source_order_id: 'other' }, { tenant_id: 'other' }]) {
      expect(() => queue.enqueue('hub-A', session, { ...payload(), ...changes })).toThrow()
    }
    const body = payload()
    expect(() => queue.enqueue('hub-A', session, { ...body, items: [{ ...body.items[0], item_status: 'arrived' }] })).toThrow()
    expect(() => queue.enqueue('hub-A', { ...session, role: 'cashier' }, body)).toThrow()
    expect(queue.hasPending()).toBe(false)
  })
  it('isolates drafts and cached records by employee, tenant and hub', async () => {
    const saved = await queue.save('hub-A', session, payload())
    for (const [scope, actor] of [['hub-B', session], ['hub-A', { ...session, id: randomUUID() }], ['hub-A', { ...session, tenant_id: 'other' }]] as const) {
      expect(await queue.list(scope, actor)).toEqual([])
      await expect(queue.get(scope, actor, saved.id)).rejects.toThrow()
    }
  })
  it('does not silently overwrite an edit made in another local window', async () => {
    const first = await queue.save('hub-A', session, payload())
    await queue.save('hub-A', session, { ...payload(), expected_updated_at: first.updated_at }, first.id)
    await expect(queue.save('hub-A', session, { ...payload(), expected_updated_at: first.updated_at }, first.id)).rejects.toThrow('вже змінено')
  })
  it('paginates pending and hub rows without skipping products or duplicating edited orders', async () => {
    for (let i = 0; i < 6; i++) orders.saveOrder({ ...payload(), manager_id: session.id, comment: 'hub-' + i })
    for (let i = 0; i < 3; i++) await queue.save('hub-A', session, payload())
    connected = true
    const all: string[] = []
    for (let offset = 0; offset < 9; offset += 2) all.push(...(await queue.list('hub-A', session, { offset, limit: 2 })).map(row => row.id))
    expect(all).toHaveLength(9); expect(new Set(all).size).toBe(9)
  })
  it('does not allow deleting an order with an unknown delivery result', async () => {
    const draft = await queue.save('hub-A', session, payload())
    expect(() => queue.discard('hub-A', session, draft.id)).toThrow('невідомий')
  })
  it('rejects a changed replay payload on the hub', () => {
    const input = { operation_id: randomUUID(), input: payload() }
    orders.acceptOfflineOrder(input, session)
    expect(() => orders.acceptOfflineOrder({ ...input, input: { ...input.input, comment: 'changed' } }, session)).toThrow('інші дані')
    expect(count(hub, 'customer_orders')).toBe(1)
  })
  it('does not overwrite a newer hub edit after an old acknowledgment was lost', async () => {
    connected = true; loseReply = true
    const first = await queue.save('hub-A', session, payload())
    const server = orders.listOrders()[0]
    orders.saveOrder({ ...payload(), comment: 'Нове на касі' }, server.id)
    connected = false
    await queue.save('hub-A', session, { ...payload(), comment: 'Моя друга правка', expected_updated_at: first.updated_at }, first.id)
    connected = true; await queue.flush('hub-A', session)
    const blocked = await queue.get('hub-A', session, first.id)
    expect(blocked.lan_sync.state).toBe('blocked')
    expect(blocked.comment).toBe('Моя друга правка')
    expect(orders.getOrder(server.id).comment).toBe('Нове на касі')
    await queue.retry('hub-A', session, first.id)
    expect((await queue.get('hub-A', session, first.id)).lan_sync.state).toBe('blocked')
    expect(orders.getOrder(server.id).comment).toBe('Нове на касі')
  })
  it('retains a concurrent local edit while the previous revision is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const delayed = new LanOrderQueue(client, async (channel, args, actor) => { await gate; return send(channel, args, actor) })
    const first = delayed.enqueue('hub-A', session, payload())
    connected = true
    const flying = delayed.flush('hub-A', session)
    const next = delayed.enqueue('hub-A', session, { ...payload(), comment: 'Поки передавалось', expected_updated_at: first.updated_at }, first.id)
    expect(next.comment).toBe('Поки передавалось')
    release(); await flying
    expect(orders.listOrders()[0].comment).toBe('Поки передавалось')
    expect(count(hub, 'customer_orders')).toBe(1)
  })
  it('checks exact create replay content locally and preserves the original', async () => {
    const body = payload(), first = await queue.save('hub-A', session, body)
    await expect(queue.save('hub-A', session, { ...body, comment: 'different' })).rejects.toThrow('інші дані')
    expect((await queue.get('hub-A', session, first.id)).comment).toBe(body.comment)
  })
  it('allows later editing from a freshly fetched version rather than a stale acknowledged snapshot', async () => {
    connected = true
    const first = await queue.save('hub-A', session, payload())
    orders.saveOrder({ ...payload(), comment: 'Hub edit' }, first.id)
    const current = await queue.get('hub-A', session, first.id)
    const saved = await queue.save('hub-A', session, { ...payload(), comment: 'Fresh edit', expected_updated_at: current.updated_at }, current.id)
    expect(saved.lan_sync).toBeUndefined()
    expect(orders.getOrder(first.id).comment).toBe('Fresh edit')
  })
  it('has no offline fallback for revision, receiving, cash, stock or staff mutations', async () => {
    const invoke = vi.fn().mockRejectedValue(new LanUnavailableError('Немає зв’язку'))
    const network = { getStatus: () => ({ hubAddress: 'hub-A', accessKey: 'key', mode: 'client' }), invoke } as unknown as LocalNetworkCoordinator
    const gateway = new LanOrderClient(network, queue)
    for (const channel of ['desktop:inventory:complete', 'desktop:supply:post-invoice', 'desktop:pos:checkout', 'desktop:catalog:save-product', 'desktop:staff:update-user']) {
      await expect(gateway.invoke(channel, [{}], session)).rejects.toThrow('Немає зв’язку')
    }
    expect(invoke).toHaveBeenCalledTimes(5)
    expect(queue.hasPending()).toBe(false)
    expect(count(client, 'sync_outbox')).toBe(0)
  })
  it('keeps exchanges and cashier saves online-only without breaking the existing online routes', async () => {
    const invoke = vi.fn().mockResolvedValue({ id: 'hub-order' })
    const network = { getStatus: () => ({ hubAddress: 'hub-A', accessKey: 'key', mode: 'client' }), invoke } as unknown as LocalNetworkCoordinator
    const gateway = new LanOrderClient(network, queue)
    const exchange = { ...payload(), exchange_source_order_id: 'source-order' }
    await expect(gateway.invoke('desktop:orders:save', [exchange], session)).resolves.toEqual({ id: 'hub-order' })
    await expect(gateway.invoke('desktop:orders:save', [payload()], { ...session, role: 'cashier' })).resolves.toEqual({ id: 'hub-order' })
    invoke.mockRejectedValue(new LanUnavailableError('Немає зв’язку'))
    await expect(gateway.invoke('desktop:orders:save', [exchange], session)).rejects.toThrow('Немає зв’язку')
    expect(queue.hasPending()).toBe(false)
  })
})
