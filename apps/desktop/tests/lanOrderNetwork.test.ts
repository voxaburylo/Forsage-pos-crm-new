import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalNetworkCoordinator, type LanSession } from '../src/lan/localNetwork'
import { LanOrderQueue } from '../src/lan/orderQueue'
import { LanOrderClient } from '../src/lan/orderClient'

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}
async function stop(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

describe('order queue over real LAN HTTP transport', () => {
  const roots: string[] = [], databases: LocalDatabase[] = [], peers: LocalNetworkCoordinator[] = [], servers: Server[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await stop(server)
    for (const peer of peers.splice(0)) await peer.stop()
    for (const db of databases.splice(0)) db.close()
    for (const root of roots.splice(0)) {
      if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('forsage-lan-http-')) throw new Error('Unexpected test directory')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([false, true])('recovers after disconnected hub; lost committed reply: %s', async (loseReply) => {
    const hubRoot = mkdtempSync(path.join(tmpdir(), 'forsage-lan-http-hub-'))
    const clientRoot = mkdtempSync(path.join(tmpdir(), 'forsage-lan-http-client-'))
    roots.push(hubRoot, clientRoot)
    const hubDb = new LocalDatabase(hubRoot), clientDb = new LocalDatabase(clientRoot)
    databases.push(hubDb, clientDb)
    const orders = new LocalOrderRepository(hubDb)
    const session: LanSession = { id: randomUUID(), tenant_id: DEFAULT_TENANT_ID, role: 'manager' }
    const productId = randomUUID(), now = new Date().toISOString()
    hubDb.prepare('INSERT INTO products(id,tenant_id,sku,name,retail_price,purchase_price,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(productId, DEFAULT_TENANT_ID, 'TEST-LAN', 'Мережевий тест', 10000, 5000, 8, now, now)
    const free = createServer(), hubPort = await listen(free)
    await stop(free)
    const hub = new LocalNetworkCoordinator(hubRoot, async (channel, args, actor) => {
      expect(actor).toEqual(session)
      if (channel === 'desktop:orders:accept-offline') return orders.acceptOfflineOrder(args[0], actor)
      if (channel === 'desktop:orders:list') return orders.listOrders(args[0] as any)
      if (channel === 'desktop:orders:get') return orders.getOrder(String(args[0]), actor.tenant_id)
      throw new Error('Unexpected hub command ' + channel)
    }, id => id === session.id ? session : null)
    peers.push(hub)
    const config = await hub.update({ mode: 'hub', port: hubPort, allowedUserId: session.id })
    let dropNextWriteReply = loseReply
    const proxy = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks).toString('utf8')
        const upstream = await fetch(`http://127.0.0.1:${hubPort}${request.url}`, {
          method: request.method,
          headers: { Authorization: String(request.headers.authorization), 'Content-Type': 'application/json' },
          ...(request.method === 'POST' ? { body } : {}),
        })
        const reply = await upstream.text()
        if (dropNextWriteReply && body.includes('desktop:orders:accept-offline') && upstream.ok) {
          dropNextWriteReply = false
          response.destroy() // hub committed; manager never receives its receipt
          return
        }
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(reply)
      } catch { response.writeHead(503).end('{}') }
    })
    servers.push(proxy)
    const port = await listen(proxy)
    const client = new LocalNetworkCoordinator(clientRoot, async () => { throw new Error('Must never execute locally') }, () => null)
    peers.push(client)
    await client.update({ mode: 'client', hubAddress: `127.0.0.1:${port}`, port, accessKey: config.accessKey })
    const queue = new LanOrderQueue(clientDb, (channel, args, actor) => client.invoke(channel, args, actor))
    const gateway = new LanOrderClient(client, queue)
    await hub.stop()
    const draft: any = await gateway.invoke('desktop:orders:save', [{ operation_id: randomUUID(),
      items: [{ name: 'Мережевий тест', product_id: productId, source_type: 'warehouse', qty: 2, buy_price: 5000, sell_price: 10000 }] }], session)
    expect(draft.lan_sync.state).toBe('pending')
    for (const channel of ['desktop:inventory:create-session', 'desktop:supply:save-invoice', 'desktop:pos:checkout']) {
      await expect(gateway.invoke(channel, [{}], session)).rejects.toThrow(/зв’язок/)
    }
    expect(orders.listOrders()).toHaveLength(0)
    for (const table of ['customer_orders', 'stock_reserves', 'inventory_movements', 'sales', 'supply_invoices']) {
      expect((clientDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n).toBe(0)
    }
    await hub.startConfigured()
    await gateway.flush(session)
    if (loseReply) {
      expect(gateway.status(session).pending).toBe(1)
      expect(orders.listOrders()).toHaveLength(1)
      await gateway.flush(session)
    }
    expect(gateway.status(session).pending).toBe(0)
    expect(orders.listOrders()).toHaveLength(1)
    expect((hubDb.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(productId) as any).qty_on_hand).toBe(8)
    expect((hubDb.prepare('SELECT COUNT(*) AS n FROM stock_reserves WHERE released_at IS NULL').get() as any).n).toBe(1)
    const accepted: any = await gateway.invoke('desktop:orders:get', [draft.id], session)
    expect(accepted.items[0].qty).toBe(2)
    await hub.stop()
    const cached: any = await gateway.invoke('desktop:orders:get', [draft.id], session)
    expect(cached.lan_sync.state).toBe('cached')
    expect(cached.id).toBe(accepted.id)
    expect(gateway.status(session).connected).toBe(false)
    await hub.startConfigured()
    await gateway.flush(session) // empty queue still detects the hub returning
    expect(gateway.status(session).connected).toBe(true)
    const refreshed: any = await gateway.invoke('desktop:orders:get', [draft.id], session)
    expect(refreshed.lan_sync).toBeUndefined()
  })
})
