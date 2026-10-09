// Isolated renderer -> compiled preload -> local repository, no shop profile/database/network.
const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { LocalSupplierCatalogRepository } = require('../dist/repositories/supplierCatalogRepository')
const { isDesktopChannelAllowed } = require('../dist/security/desktopAuthorization')
const esbuild = require(path.resolve(__dirname, '../../../node_modules/esbuild'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-import-renderer-'))
const safeRoot = () => path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('forsage-import-renderer-')
app.setPath('userData', path.join(root, 'profile'))
app.on('window-all-closed', () => {})
let db, win, calls = 0, dropWrite = false, dropResolve = false
const timer = setTimeout(() => { console.error('Supplier import renderer timeout'); app.exit(1) }, 45000)
const tenant = '00000000-0000-0000-0000-000000000001'
const scope = 'supplier-import:' + tenant + ':manager'
const payload = { filename: 'test.csv', rows: [{ source_row: 1, sku: 'A', name: 'Fixture', qty: '0.125', price_kopecks: 1200 }],
  options: { supplier_id: null, mode: 'add', user_id: 'manager', tenant_id: tenant } }
const snapshot = () => Object.fromEntries(['supplier_price_items','supplier_price_imports','sync_outbox','app_meta'].map(table =>
  [table, db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all().map(row => ({ ...row }))]))
const bundle = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../../web/src/features/suppliers/supplierImportRequest.ts')],
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'RetryTest',
  alias: { '@': path.resolve(__dirname, '../../web/src') } }).outputFiles[0].text
async function prepare() {
  const file = path.join(root, 'fixture.html')
  await win.loadFile(file)
  await win.webContents.executeJavaScript(bundle + '; true')
  await win.webContents.executeJavaScript(`window.runImport = payload => {
    const bridge = window.forsageDesktop.supplierCatalog;
    if (!bridge.importOperationIds || !bridge.resolveImport) throw Error('Bridge capability missing');
    return RetryTest.submitCatalogImport(${JSON.stringify(scope)}, payload, {
      send: id => bridge.importRows(payload.filename,payload.rows,{...payload.options,operation_id:id}),
      resolve: id => bridge.resolveImport(id), sameSession: () => true
    });
  }; true`)
}
const run = body => win.webContents.executeJavaScript('window.runImport(' + JSON.stringify(body) + ')')
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_details, done) => done({ cancel: true }))
  db = new LocalDatabase(path.join(root, 'fixture-db'))
  const repo = new LocalSupplierCatalogRepository(db)
  for (const channel of ['desktop:supplier-catalog:import-rows','desktop:supplier-catalog:resolve-import']) {
    for (const role of ['owner','admin','manager','storekeeper']) assert(isDesktopChannelAllowed(channel, role))
    for (const role of ['cashier','sto_viewer','tire_worker','unknown']) assert(!isDesktopChannelAllowed(channel, role))
  }
  ipcMain.handle('desktop:supplier-catalog:import-rows', (_event, filename, rows, options) => {
    calls++
    const result = repo.importRows(filename, rows, { ...options, user_id: 'manager', tenant_id: tenant })
    if (dropWrite) throw Error('Injected lost write response')
    return result
  })
  ipcMain.handle('desktop:supplier-catalog:resolve-import', (_event, id) => {
    if (dropResolve) throw Error('Injected lost recovery response')
    return repo.resolveImport(id, 'manager', tenant)
  })
  fs.writeFileSync(path.join(root, 'fixture.html'), '<!doctype html><meta charset="utf-8"><title>Isolated test</title>')
  win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve(__dirname, '../dist/preload.js'), sandbox: true, nodeIntegration: false, contextIsolation: true,
  } })
  await prepare()
  assert(await win.webContents.executeJavaScript('isSecureContext && !!crypto.subtle'))
  dropWrite = true
  assert.equal((await run(payload)).success, true) // Lost write reply, recovered automatically.
  assert.equal(calls, 1); assert.equal(repo.list().data[0].qty, '0.125')
  dropResolve = true
  await assert.rejects(run(payload)) // Both replies lost: keep marker across renderer restart.
  const before = snapshot()
  await prepare()
  dropWrite = false; dropResolve = false
  assert.equal((await run(payload)).success, true)
  assert.deepEqual(snapshot(), before); assert.equal(calls, 3)
  const double = await win.webContents.executeJavaScript('Promise.all([window.runImport('+JSON.stringify(payload)+'),window.runImport('+JSON.stringify(payload)+')])')
  assert.deepEqual(double[0], double[1]); assert.equal(calls, 4)
  assert.equal(repo.list().data[0].qty, '0.375')
  await assert.rejects(run({ ...payload, rows: [{ ...payload.rows[0], qty: 'bad' }] }))
  assert.equal(await win.webContents.executeJavaScript('localStorage.length'), 0)
  await run({ ...payload, rows: [{ ...payload.rows[0], qty: '0.625' }] })
  assert.equal(repo.list().data[0].qty, '1')
  dropWrite = true; dropResolve = true
  await assert.rejects(run(payload))
  const saved = snapshot(), oldCalls = calls
  dropWrite = false; dropResolve = false
  await assert.rejects(run({ ...payload, filename: 'changed.csv' }), /уже збережено/)
  assert.equal(calls, oldCalls); assert.deepEqual(snapshot(), saved)
  assert.equal(await win.webContents.executeJavaScript('localStorage.length'), 0)
  assert.equal(db.prepare('SELECT count(*) n FROM products').get().n, 0)
  console.log(JSON.stringify({ ok: true, rendererScenarios: 5, sandboxedPreload: true, realSQLite: true, network: false, shopDatabaseOpened: false }))
  win.destroy(); win = null; db.close(); db = null
  clearTimeout(timer); app.exit(0)
}).catch(error => { console.error(error); win?.destroy(); db?.close(); clearTimeout(timer); app.exit(1) })
process.on('exit', () => {
  if (safeRoot()) { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* Chromium can briefly hold test-profile cache files. */ } }
})
