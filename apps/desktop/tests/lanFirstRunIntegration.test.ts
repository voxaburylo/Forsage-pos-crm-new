import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalStaffRepository } from '../src/repositories/staffRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalNetworkCoordinator, type LanSession } from '../src/lan/localNetwork'
import { cacheLanIdentity, canPairEmptyClient, loginLanClient } from '../src/lan/clientIdentity'
import { LanOrderQueue } from '../src/lan/orderQueue'
import { LanOrderClient } from '../src/lan/orderClient'
import { createPortableReleaseSource, downloadPortableUpdate } from '../src/updates/portableUpdate'

it('pairs an empty PC, logs in without internet, queues only orders and downloads only the hub binary', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-first-run-integration-'))
  const hubDb = new LocalDatabase(path.join(root, 'hub'))
  const clientDb = new LocalDatabase(path.join(root, 'client'))
  const hubStaff = new LocalStaffRepository(hubDb), clientStaff = new LocalStaffRepository(clientDb)
  const orders = new LocalOrderRepository(hubDb)
  const phone = '+380671112233', password = 'test-only-manager-password'
  const actor = { id: randomUUID(), tenant_id: DEFAULT_TENANT_ID, role: 'manager', full_name: 'Тестовий менеджер', phone, is_active: true }
  hubStaff.saveServerUser(actor, password)
  const oldBinary = Buffer.from('MZ old synthetic binary'), newBinary = Buffer.from('MZ new synthetic binary')
  const executable = path.join(root, 'hub.exe'), clientExecutable = path.join(root, 'manager.exe')
  writeFileSync(executable, newBinary); writeFileSync(clientExecutable, oldBinary)
  const source = createPortableReleaseSource({ packaged: true, portableExecutable: executable, releaseId: '20261013T130000-abcdef123456' })!
  const nativeFetch = globalThis.fetch
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== '127.0.0.1') throw new Error('Internet access forbidden in this test')
    return nativeFetch(input, init)
  })
  const hub = new LocalNetworkCoordinator(hubDb.dataRoot, async (channel, args, session) => {
    expect(session.id).toBe(actor.id)
    if (channel === 'desktop:orders:accept-offline') return orders.acceptOfflineOrder(args[0], session)
    if (channel === 'desktop:orders:list') return orders.listOrders()
    if (channel === 'desktop:orders:get') return orders.getOrder(String(args[0]), session.tenant_id)
    throw new Error('Unexpected hub operation: ' + channel)
  }, id => id === actor.id ? actor : null, {
    discovery: false,
    authenticate: async (login, secret) => hubStaff.loginWithPassword(login, secret),
    updateMetadata: () => source.describe(),
    updateChunk: input => source.chunk(input),
  })
  const client = new LocalNetworkCoordinator(clientDb.dataRoot, async () => { throw new Error('No business command may execute locally') }, () => null, { discovery: false })
  const queue = new LanOrderQueue(clientDb, (channel, args, session) => client.invoke(channel, args, session))
  const gateway = new LanOrderClient(client, queue)
  const probe = createServer()
  try {
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    expect(canPairEmptyClient(clientDb, client.getStatus().mode, queue.hasPending())).toBe(true)
    const config = await hub.update({ mode: 'hub', port, allowedUserId: actor.id })
    await client.pairRemote({ hubAddress: `127.0.0.1:${port}`, accessKey: config.accessKey })
    const login = (secret: string) => loginLanClient({
      remote: () => client.loginRemote(phone, secret),
      cache: profile => cacheLanIdentity(clientDb, profile, phone, secret, config.accessKey),
      local: () => clientStaff.loginWithPassword(phone, secret),
    })
    const user = await login(password)
    const session: LanSession = { id: user.id, tenant_id: user.tenant_id, role: user.role }
    expect(user.id).toBe(actor.id)
    expect(client.getStatus().secureTransport).toBe(1)
    await expect(login('wrong-password')).rejects.toThrow()
    // Source serves the portable binary, not its config, employees, database or a caller-selected file.
    const update = await downloadPortableUpdate({
      localAppData: path.join(root, 'local-app-data'), currentReleaseId: '20261013T120000-abcdef123456',
      transport: { describe: () => client.requestUpdateMetadata(session), chunk: input => client.requestUpdateChunk(input, session) },
    })
    expect(update.state).toBe('ready')
    if (update.state !== 'ready') throw new Error('Missing staged update')
    expect(readFileSync(update.update.filePath)).toEqual(newBinary)
    expect(readFileSync(clientExecutable)).toEqual(oldBinary) // no replacement while application is open
    await hub.stop()
    expect((await login(password)).id).toBe(actor.id)
    const draft: any = await gateway.invoke('desktop:orders:save', [{ operation_id: randomUUID(), items: [
      { name: 'Тестове замовлення', source_type: 'manual', qty: 1, buy_price: 10000, sell_price: 15000 },
    ] }], session)
    expect(draft.lan_sync.state).toBe('pending')
    for (const channel of ['desktop:pos:checkout', 'desktop:supply:save-invoice', 'desktop:inventory:create-session']) {
      await expect(gateway.invoke(channel, [{}], session)).rejects.toThrow()
    }
    // Refreshing credentials must not discard durable pending orders.
    await hub.startConfigured()
    await login(password)
    expect(gateway.status(session).pending).toBe(1)
    await gateway.flush(session)
    await gateway.flush(session)
    expect(orders.listOrders()).toHaveLength(1)
    expect(gateway.status(session).pending).toBe(0)
    for (const table of ['products', 'sales', 'supply_invoices', 'inventory_movements', 'customer_orders', 'sync_outbox']) {
      expect(clientDb.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 })
    }
    expect(fetchSpy).toHaveBeenCalled()
  } finally {
    await hub.stop(); await client.stop(); await queue.settle()
    fetchSpy.mockRestore(); hubDb.close(); clientDb.close()
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('forsage-first-run-integration-')) throw new Error('Unsafe test cleanup path')
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
