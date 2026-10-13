// Compiled/Electron smoke only: two disposable databases, no internet or live shop files.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createServer } = require('node:http')
const { randomUUID } = require('node:crypto')
if (!process.versions.electron) throw Error('Run through Electron with ELECTRON_RUN_AS_NODE=1')
const dist = path.resolve(process.argv[2] || path.join(__dirname, '../dist'))
const { LocalDatabase } = require(path.join(dist, 'db/localDatabase.js'))
const { DEFAULT_TENANT_ID } = require(path.join(dist, 'db/localTypes.js'))
const { LocalStaffRepository } = require(path.join(dist, 'repositories/staffRepository.js'))
const { LocalOrderRepository } = require(path.join(dist, 'repositories/orderRepository.js'))
const { LocalNetworkCoordinator } = require(path.join(dist, 'lan/localNetwork.js'))
const { cacheLanIdentity, assertLanIdentityConnection } = require(path.join(dist, 'lan/clientIdentity.js'))
const { LanOrderQueue } = require(path.join(dist, 'lan/orderQueue.js'))
const { LanOrderClient } = require(path.join(dist, 'lan/orderClient.js'))
const { createPortableReleaseSource, downloadPortableUpdate } = require(path.join(dist, 'updates/portableUpdate.js'))

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-native-first-run-'))
  const mainDb = new LocalDatabase(path.join(root, 'main')), clientDb = new LocalDatabase(path.join(root, 'client'))
  const staff = new LocalStaffRepository(mainDb), orders = new LocalOrderRepository(mainDb)
  const actor = { id: randomUUID(), tenant_id: DEFAULT_TENANT_ID, role: 'manager', phone: '+380671110099', full_name: 'Synthetic manager', is_active: true }
  const password = 'synthetic-password-only'
  staff.saveServerUser(actor, password)
  const executable = path.join(root, 'synthetic.exe'), bytes = Buffer.from('MZ synthetic file never executed')
  fs.writeFileSync(executable, bytes)
  const source = createPortableReleaseSource({ packaged: true, portableExecutable: executable, releaseId: '20261013T200000-aaaaaaaaaaaa' })
  const hub = new LocalNetworkCoordinator(mainDb.dataRoot, async (channel, args, session) => {
    if (channel === 'desktop:orders:accept-offline') return orders.acceptOfflineOrder(args[0], session)
    throw Error('Unexpected business channel')
  }, id => id === actor.id ? actor : null, { discovery: false,
    authenticate: (phone, secret) => staff.loginWithPassword(phone, secret),
    updateMetadata: () => source.describe(), updateChunk: input => source.chunk(input) })
  const client = new LocalNetworkCoordinator(clientDb.dataRoot, async () => { throw Error('Unexpected local write') }, () => null, { discovery: false })
  const queue = new LanOrderQueue(clientDb, (channel, args, session) => client.invoke(channel, args, session))
  const gateway = new LanOrderClient(client, queue)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input.href)
    assert.equal(url.hostname, '127.0.0.1', 'Internet access is forbidden')
    return originalFetch(input, options)
  }
  try {
    const probe = createServer()
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    const config = await hub.update({ mode: 'hub', port, allowedUserId: actor.id })
    await client.pairRemote({ hubAddress: `127.0.0.1:${port}`, accessKey: config.accessKey })
    const profile = await client.loginRemote(actor.phone, password)
    cacheLanIdentity(clientDb, profile, actor.phone, password, config.accessKey)
    assertLanIdentityConnection(clientDb, client.getStatus())
    assert.throws(() => assertLanIdentityConnection(clientDb, { ...client.getStatus(), secureTransport: undefined }))
    assert.equal(new LocalStaffRepository(clientDb).loginWithPassword(actor.phone, password).id, actor.id)
    const update = await downloadPortableUpdate({ localAppData: path.join(root, 'app-data'), currentReleaseId: '20261012T200000-bbbbbbbbbbbb',
      transport: { describe: () => client.requestUpdateMetadata(actor), chunk: input => client.requestUpdateChunk(input, actor) } })
    assert.equal(update.state, 'ready'); assert.deepEqual(fs.readFileSync(update.update.filePath), bytes)
    await hub.stop()
    const draft = await gateway.invoke('desktop:orders:save', [{ operation_id: randomUUID(), items: [{ name: 'Synthetic', source_type: 'manual', qty: 1, buy_price: 100, sell_price: 200 }] }], actor)
    assert.equal(draft.lan_sync.state, 'pending')
    await hub.startConfigured(); await gateway.flush(actor); await gateway.flush(actor)
    assert.equal(orders.listOrders().length, 1)
    for (const table of ['products', 'sales', 'customer_orders', 'inventory_movements', 'supply_invoices', 'sync_outbox']) {
      assert.equal(clientDb.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0)
    }
    console.log(JSON.stringify({ passed: true, electron: process.versions.electron, compiledDist: dist,
      pair: true, offlineLogin: true, singleOrderAfterReconnect: true, stagedBinary: true, liveDatabaseUsed: false, installed: false }))
  } finally {
    await hub.stop(); await client.stop(); await queue.settle()
    globalThis.fetch = originalFetch; mainDb.close(); clientDb.close()
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('forsage-native-first-run-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
