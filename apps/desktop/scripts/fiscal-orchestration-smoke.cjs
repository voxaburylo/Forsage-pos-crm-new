// Packaged orchestration + packaged Cashalot + real, disposable LocalDatabase.
// No application main, shop database, network, registry, COM or physical printer.
const { app, safeStorage } = require('electron')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')
const cleanupFs = { existsSync: fs.existsSync, realpathSync: fs.realpathSync, rmSync: fs.rmSync }
const nativeSetTimeout = global.setTimeout
const nativeClearTimeout = global.clearTimeout

if (!app?.whenReady) throw new Error('Run with normal Electron, without ELECTRON_RUN_AS_NODE')
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-fiscal-orchestration-'))
const environment = {
  USERPROFILE: path.join(profileRoot, 'profile'), LOCALAPPDATA: path.join(profileRoot, 'local'),
  APPDATA: path.join(profileRoot, 'appData'), ProgramFiles: path.join(profileRoot, 'program-files'),
  'ProgramFiles(x86)': path.join(profileRoot, 'program-files-x86'), PORTABLE_EXECUTABLE_DIR: profileRoot,
}
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
Object.assign(process.env, environment)
for (const name of ['appData', 'userData', 'sessionData', 'crashDumps']) {
  const directory = path.join(profileRoot, name)
  fs.mkdirSync(directory, { recursive: true })
  app.setPath(name, directory)
}
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
const compiledArg = process.argv.indexOf('--compiled-dir')
if (compiledArg >= 0 && (!process.argv[compiledArg + 1] || process.argv[compiledArg + 1].startsWith('--'))) {
  throw new Error('Missing --compiled-dir value')
}
const dist = compiledArg >= 0 ? path.resolve(process.argv[compiledArg + 1])
  : process.argv.includes('--staged')
    ? path.resolve(process.cwd(), 'apps/desktop/release/staged/win-unpacked/resources/app.asar/dist')
    : path.resolve(__dirname, '../dist')
const deadline = nativeSetTimeout(() => { console.error('Synthetic fiscal orchestration probe timed out'); app.exit(1) }, 60_000)
let checks = 0
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++ }
const ok = (condition, message) => { assert.ok(condition, message); checks++ }
const noThrow = (run, message) => { assert.doesNotThrow(run, message); checks++ }
const flush = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve() }
const observe = promise => {
  const state = { settled: false, value: undefined, error: undefined }
  promise.then(value => { state.settled = true; state.value = value }, error => {
    state.settled = true; state.error = error instanceof Error ? error.message : String(error)
  })
  return state
}
const line = response => Buffer.from(JSON.stringify(response), 'utf8').toString('base64') + '\n'

app.whenReady().then(async () => {
  // All compiled/ASAR module loading precedes filesystem and subprocess guards.
  const { LocalDatabase } = require(path.join(dist, 'db/localDatabase.js'))
  const { DEFAULT_TENANT_ID: tenant } = require(path.join(dist, 'db/localTypes.js'))
  const { LocalBootstrapRepository } = require(path.join(dist, 'repositories/bootstrapRepository.js'))
  const { LocalCatalogRepository } = require(path.join(dist, 'repositories/catalogRepository.js'))
  const { LocalPosRepository } = require(path.join(dist, 'repositories/posRepository.js'))
  const { CashalotService } = require(path.join(dist, 'fiscal/cashalotService.js'))
  const { fiscalizeSale, processFiscalReturn } = require(path.join(dist, 'fiscal/fiscalOrchestration.js'))
  const cashalotPaths = require(path.join(dist, 'fiscal/cashalotPaths.js'))
  const buildPath = path.join(dist, 'build-info.json')
  const build = fs.existsSync(buildPath) ? JSON.parse(fs.readFileSync(buildPath, 'utf8')).releaseId : null
  const reports = []
  const networkTargets = [
    [require('node:http'), 'request'], [require('node:http'), 'get'],
    [require('node:https'), 'request'], [require('node:https'), 'get'],
    [require('node:net'), 'connect'], [require('node:net'), 'createConnection'],
    [require('node:net').Socket.prototype, 'connect'], [require('node:tls'), 'connect'],
    [require('node:dgram'), 'createSocket'], [require('node:dns'), 'lookup'],
    [require('node:dns'), 'resolve'], [global, 'fetch'],
  ]

  async function runCase(name, kind, run) {
    const dataRoot = path.join(profileRoot, `fixture-${reports.length}`)
    equal(cleanupFs.existsSync(dataRoot), false, 'Every database starts in a fresh owned directory')
    const configPath = path.join(dataRoot, 'fiscal.json')
    const scriptPath = path.join(dataRoot, 'cashalot-worker.ps1')
    const installation = path.join(dataRoot, 'synthetic-cashalot')
    const nonce = Object.freeze({ name })
    const configText = JSON.stringify({ enabled: true, cashalotDir: installation,
      fiscalNumberRRO: 'SYNTHETIC-RRO', certificateDir: null, encryptedKeyPassword: null })
    const workers = []
    const services = []
    const callTimers = new Map()
    const ownedDescriptors = new Set()
    let forbiddenProcessAttempts = 0
    let networkAttempts = 0
    let workerScriptWrites = 0
    let db = null
    let pos
    let catalog
    let service
    const savedFs = Object.fromEntries(['readFileSync', 'writeFileSync', 'statSync', 'existsSync', 'mkdirSync',
      'readdirSync', 'openSync', 'closeSync', 'fsyncSync', 'renameSync', 'unlinkSync', 'copyFileSync', 'rmSync']
      .map(key => [key, fs[key]]))
    const savedStorage = Object.fromEntries(['isEncryptionAvailable', 'encryptString', 'decryptString'].map(key => [key, safeStorage[key]]))
    const savedProcesses = Object.fromEntries(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
      .map(key => [key, childProcess[key]]))
    const savedPaths = Object.fromEntries(['cashalotSearchDirs', 'resolveCashalotDir', 'detectCashalotDir', 'hasCashalotDll']
      .map(key => [key, cashalotPaths[key]]))
    const savedNetwork = networkTargets.map(([target, key]) => [target, key, target[key]])
    const assertOwned = filename => {
      assert.equal(typeof filename, 'string', 'Filesystem paths must be explicit fixture paths')
      const resolved = path.resolve(filename)
      assert.ok(resolved === dataRoot || resolved.startsWith(dataRoot + path.sep), `Outside fixture filesystem: ${resolved}`)
      return resolved
    }
    const guardedRead = (method, filename, ...args) => {
      if (method === 'readFileSync' && filename === configPath) return configText
      assertOwned(filename)
      return savedFs[method](filename, ...args)
    }
    const fsMocks = {
      readFileSync: (filename, ...args) => guardedRead('readFileSync', filename, ...args),
      existsSync: filename => guardedRead('existsSync', filename),
      statSync: (filename, ...args) => guardedRead('statSync', filename, ...args),
      readdirSync: (filename, ...args) => guardedRead('readdirSync', filename, ...args),
      mkdirSync: (filename, ...args) => { assertOwned(filename); return savedFs.mkdirSync(filename, ...args) },
      writeFileSync(filename, ...args) {
        if (filename === scriptPath) { workerScriptWrites++; return }
        if (typeof filename === 'number') assert.ok(ownedDescriptors.has(filename), 'Only fixture descriptors can be written')
        else assertOwned(filename)
        assert.notEqual(filename, configPath, 'This fixture never changes fiscal configuration')
        return savedFs.writeFileSync(filename, ...args)
      },
      openSync(filename, ...args) {
        assertOwned(filename)
        const descriptor = savedFs.openSync(filename, ...args)
        ownedDescriptors.add(descriptor)
        return descriptor
      },
      closeSync(descriptor) {
        assert.ok(ownedDescriptors.has(descriptor))
        const result = savedFs.closeSync(descriptor)
        ownedDescriptors.delete(descriptor)
        return result
      },
      fsyncSync: descriptor => { assert.ok(ownedDescriptors.has(descriptor)); return savedFs.fsyncSync(descriptor) },
      renameSync: (source, target) => { assertOwned(source); assertOwned(target); return savedFs.renameSync(source, target) },
      copyFileSync: (source, target, ...args) => { assertOwned(source); assertOwned(target); return savedFs.copyFileSync(source, target, ...args) },
      unlinkSync: filename => { assertOwned(filename); return savedFs.unlinkSync(filename) },
      rmSync: (filename, ...args) => { assertOwned(filename); assert.notEqual(path.resolve(filename), dataRoot); return savedFs.rmSync(filename, ...args) },
    }
    class FakeWorker extends EventEmitter {
      constructor() {
        super()
        Object.defineProperty(this, 'syntheticNonce', { value: nonce, writable: false, configurable: false })
        this.pid = 8000 + workers.length
        this.exitCode = null
        this.requests = []
        this.kills = 0
        this.ends = 0
        this.stdout = new EventEmitter()
        this.stdout.setEncoding = encoding => equal(encoding, 'utf8')
        this.stderr = new EventEmitter()
        this.stdin = new EventEmitter()
        this.stdin.write = encoded => {
          assert.equal(this.syntheticNonce, nonce)
          this.requests.push(JSON.parse(Buffer.from(String(encoded).trim(), 'base64').toString('utf8')))
          return true
        }
        this.stdin.end = () => { this.ends++ }
      }
      kill() { this.kills++; return true }
      respond(request, number) {
        this.stdout.emit('data', line({ id: request.id, ok: true,
          result: { Return: true, ReceiptFiscalNum: number, FSKOReceiptLink: `https://example.invalid/${number}` } }))
      }
    }
    const spawnMock = (command, args, options) => {
      equal(command, 'powershell.exe')
      equal(args[args.indexOf('-File') + 1], scriptPath)
      equal(options.windowsHide, true)
      equal(options.stdio, ['pipe', 'pipe', 'pipe'])
      const worker = new FakeWorker()
      workers.push(worker)
      equal(Object.getOwnPropertyDescriptor(worker, 'syntheticNonce').writable, false)
      equal(worker.syntheticNonce, nonce)
      return worker
    }
    const forbidProcess = () => { forbiddenProcessAttempts++; throw new Error('Synthetic harness forbids subprocess/registry/COM') }
    const forbidNetwork = () => { networkAttempts++; throw new Error('Synthetic harness forbids network') }
    const storageMocks = { isEncryptionAvailable: () => true,
      encryptString: text => Buffer.from('synthetic:' + text), decryptString: value => value.toString().replace(/^synthetic:/, '') }
    const pathMocks = { cashalotSearchDirs: () => [installation], resolveCashalotDir: stored => stored || installation,
      detectCashalotDir: () => installation, hasCashalotDll: directory => directory === installation }
    const timerMock = (callback, milliseconds, ...args) => {
      if (milliseconds !== 180_000) return nativeSetTimeout(callback, milliseconds, ...args)
      const token = Object.freeze({ nonce, index: callTimers.size })
      callTimers.set(token, () => callback(...args))
      return token
    }
    const clearTimerMock = token => {
      if (token?.nonce === nonce) { callTimers.delete(token); return }
      return nativeClearTimeout(token)
    }
    const createService = () => {
      const next = new CashalotService(dataRoot)
      services.push(next)
      ok(next.isEnabled(), 'Synthetic Cashalot configuration is enabled')
      return next
    }
    const openDb = () => {
      assertOwned(dataRoot)
      db = new LocalDatabase(dataRoot)
      equal(path.resolve(db.databasePath), path.join(dataRoot, 'data', 'forsage.db'), 'Only owned native SQLite opens')
      pos = new LocalPosRepository(db)
      catalog = new LocalCatalogRepository(db)
    }
    const snapshot = () => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'fiscal_sale_intents' ORDER BY name")
      .all().map(({ name: table }) => [table, db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all()])
    const calls = () => workers.reduce((sum, worker) => sum + worker.requests.length, 0)
    try {
      Object.assign(fs, fsMocks)
      Object.assign(safeStorage, storageMocks)
      Object.assign(cashalotPaths, pathMocks)
      for (const key of Object.keys(savedProcesses)) childProcess[key] = key === 'spawn' ? spawnMock : forbidProcess
      for (const [target, key] of networkTargets) target[key] = forbidNetwork
      global.setTimeout = timerMock
      global.clearTimeout = clearTimerMock
      for (const [key, value] of Object.entries(fsMocks)) equal(fs[key], value, `Owned-only fs.${key}`)
      for (const [key, value] of Object.entries(storageMocks)) equal(safeStorage[key], value, `Synthetic storage.${key}`)
      for (const [key, value] of Object.entries(pathMocks)) equal(cashalotPaths[key], value, `Synthetic path helper ${key}`)
      for (const key of Object.keys(savedProcesses)) {
        equal(require('node:child_process')[key], key === 'spawn' ? spawnMock : forbidProcess)
        equal(require('child_process')[key], key === 'spawn' ? spawnMock : forbidProcess, `CJS ${key} cannot bypass guard`)
      }
      for (const [target, key] of networkTargets) equal(target[key], forbidNetwork)
      equal(global.setTimeout, timerMock)
      equal(global.clearTimeout, clearTimerMock)
      openDb()
      new LocalBootstrapRepository(db).importSnapshot({ exported_at: '2026-10-11T00:00:00.000Z', tenant_id: tenant,
        staff: [{ id: 'synthetic-cashier', full_name: 'Synthetic Cashier', role: 'cashier', is_active: true }] })
      const product = catalog.upsertProduct({ id: 'synthetic-product', sku: 'FISCAL-SYNTHETIC',
        name: 'Synthetic fiscal safety product', barcode: '2777777777777', retail_price: 1500, purchase_price: 900, qty_on_hand: 3 })
      const shiftId = pos.openShift({ cashier_id: 'synthetic-cashier', opening_cash: 0 })
      const items = [{ name: product.name, vendor_code: product.sku, barcode: product.barcode, unit: product.unit,
        qty: 1, unit_price: 1500, amount: 1500, discount: 0 }]
      const pay = { cash: 1500, card: 0, bank: 0, check_total: 1500 }
      const saleRequest = id => ({ operation_id: id, checkout: { tenant_id: tenant, client_operation_id: id,
        cashier_id: 'synthetic-cashier', shift_id: shiftId, items: [{ product_id: product.id, qty: 1 }],
        payments: [{ method: 'cash', amount: 1500, is_fiscal: true, fiscal_number: null }],
        is_fiscal: true, fiscal_number: null, fiscal_qr_url: null }, items, pay })
      const completeSale = (request, fiscalNumber) => pos.checkout({ ...request.checkout,
        fiscal_number: fiscalNumber, fiscal_qr_url: `https://example.invalid/${fiscalNumber}`,
        payments: request.checkout.payments.map(payment => ({ ...payment, fiscal_number: fiscalNumber })) })
      let request = saleRequest('synthetic-sale-operation')
      if (kind === 'return') {
        const seed = saleRequest('synthetic-existing-sale')
        pos.prepareFiscalSaleIntent(seed)
        pos.startFiscalSaleIntent(seed.operation_id)
        pos.markFiscalSaleIntentFiscalized(seed.operation_id, { Return: true, ReceiptFiscalNum: 'SYNTHETIC-SEED',
          FSKOReceiptLink: 'https://example.invalid/SYNTHETIC-SEED' })
        const sale = completeSale(seed, 'SYNTHETIC-SEED')
        const available = pos.getSaleForReturn(sale.sale_id)
        request = { operation_id: 'synthetic-return-operation', original_fiscal_number: 'SYNTHETIC-SEED', items, pay,
          return_input: { tenant_id: tenant, sale_id: sale.sale_id, approved_by: 'synthetic-cashier', shift_id: shiftId,
            reason: 'other', reason_note: 'Synthetic fiscal return', refund_method: 'cash', stock_action: 'return_to_stock',
            items: [{ sale_item_id: available.items[0].id, product_id: product.id, quantity: 1, condition: 'good' }] } }
      }
      service = createService()
      const invoke = (getService = () => service) => kind === 'sale'
        ? fiscalizeSale(pos, getService, request) : processFiscalReturn(pos, getService, request)
      const noExternalLookup = () => { throw new Error('Existing intent must not access Cashalot service') }
      const restart = async () => {
        service.stopWorker()
        await flush()
        db.close()
        db = null
        openDb()
        service = createService()
      }
      const failCompletion = () => db.exec(`CREATE TRIGGER synthetic_completion_failure BEFORE UPDATE OF state ON fiscal_sale_intents
        WHEN NEW.state='completed' AND NEW.operation_id='${request.operation_id}'
        BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_COMPLETION_ABORT'); END`)
      const expireCall = () => {
        equal(callTimers.size, 1, 'Exactly one real service timeout callback is pending')
        const [token, callback] = [...callTimers.entries()][0]
        callTimers.delete(token)
        callback()
      }
      const totals = () => ({
        stock: catalog.findById(product.id).qty_on_hand,
        sales: Number(db.prepare('SELECT count(*) n FROM sales').get().n),
        payments: Number(db.prepare('SELECT coalesce(sum(amount),0) n FROM sale_payments').get().n),
        returns: Number(db.prepare('SELECT count(*) n FROM customer_returns').get().n),
        refunds: Number(db.prepare('SELECT coalesce(sum(refund_kopecks),0) n FROM customer_returns').get().n),
      })
      await run({ request, invoke, noExternalLookup, completeSale, restart, snapshot, calls, workers, expireCall,
        failCompletion, dropFailure: () => db.exec('DROP TRIGGER synthetic_completion_failure'),
        intent: () => pos.getFiscalSaleIntent(request.operation_id), totals,
        worker: () => workers[workers.length - 1] })
      // Validate outside stdin.write: production correctly catches transport
      // throws, so assertions inside write could otherwise look like an expected
      // unknown-outcome error and leave a wrong fiscal command unnoticed.
      for (const worker of workers) {
        for (const captured of worker.requests) {
          equal(captured.method, 'call', 'Only the expected COM-call envelope is sent')
          equal(captured.comMethod, kind === 'sale' ? 'FiscalizeCheck' : 'FiscalizeReturnCheck',
            'The orchestration selects the correct sale/return command')
          ok(Array.isArray(captured.args))
          equal(captured.args.length, kind === 'sale' ? 3 : 4)
          equal(captured.args[0], 'SYNTHETIC-RRO')
          if (kind === 'return') equal(captured.args[captured.args.length - 1], 'SYNTHETIC-SEED',
            'Every return references the original fiscal receipt')
        }
      }
      equal(forbiddenProcessAttempts, 0)
      equal(networkAttempts, 0)
      equal(callTimers.size, 0, 'No leaked synthetic fiscal timeout')
      equal(ownedDescriptors.size, 0)
      reports.push({ name, kind, workerCalls: calls(), workerScriptWrites, databaseWasTemporary: true })
    } finally {
      // All callbacks settle while their database and process guards still exist.
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          for (const active of services) active.stopWorker()
          await flush()
        }
        if (db) { db.close(); db = null }
        for (const descriptor of ownedDescriptors) { try { savedFs.closeSync(descriptor) } catch {} }
      } finally {
        // Even an unexpected native close failure cannot leave process/network
        // stubs installed while Electron shuts down its disposable profile.
        callTimers.clear()
        global.setTimeout = nativeSetTimeout
        global.clearTimeout = nativeClearTimeout
        for (const [target, key, original] of savedNetwork) target[key] = original
        Object.assign(cashalotPaths, savedPaths)
        Object.assign(childProcess, savedProcesses)
        Object.assign(safeStorage, savedStorage)
        Object.assign(fs, savedFs)
      }
    }
  }

  for (const kind of ['sale', 'return']) {
    for (const failure of ['worker-error', 'timeout']) {
      await runCase(`${kind}: ${failure}, late response and true DB reopen never repeat the operation`, kind, async fixture => {
        const before = fixture.snapshot()
        const beforeTotals = fixture.totals()
        const current = observe(fixture.invoke())
        await flush()
        equal(fixture.calls(), 1)
        equal(fixture.intent().state, 'fiscalizing')
        equal(fixture.snapshot(), before, 'Sending to Cashalot changes no business rows')
        const worker = fixture.worker()
        const externalRequest = worker.requests[0]
        if (failure === 'worker-error') noThrow(() => worker.emit('error', new Error('synthetic transport failure')))
        else fixture.expireCall()
        await flush()
        equal(current.settled, true)
        ok(current.error?.startsWith(`FISCAL_INTENT_UNKNOWN|${fixture.request.operation_id}|`))
        ok(current.error?.includes(failure === 'timeout' ? 'FISCAL_CALL_TIMEOUT' : 'FISCAL_CALL_FAILED'))
        equal(fixture.intent().state, 'unknown')
        equal(fixture.snapshot(), before, 'Unknown outcome must not create stock/money/audit/outbox effects')
        worker.respond(externalRequest, 'SYNTHETIC-LATE-RECEIPT')
        await flush()
        equal(fixture.intent().state, 'unknown', 'A late worker response cannot silently resolve persisted uncertainty')
        equal(fixture.snapshot(), before)
        const sameProcessRetry = observe(fixture.invoke(fixture.noExternalLookup))
        await flush()
        ok(sameProcessRetry.error?.startsWith('FISCAL_INTENT_UNKNOWN|'))
        await fixture.restart()
        equal(fixture.intent().state, 'unknown')
        equal(fixture.snapshot(), before, 'Real LocalDatabase close/reopen leaves business rows unchanged')
        const reopenedRetry = observe(fixture.invoke(fixture.noExternalLookup))
        await flush()
        ok(reopenedRetry.error?.startsWith('FISCAL_INTENT_UNKNOWN|'))
        equal(fixture.calls(), 1, 'Retry before or after reopen never re-sends')
        equal(fixture.totals(), beforeTotals)
        equal(fixture.snapshot(), before)
      })
    }

    await runCase(`${kind}: successful completion and duplicate after DB reopen`, kind, async fixture => {
      const current = observe(fixture.invoke())
      await flush()
      const worker = fixture.worker()
      worker.respond(worker.requests[0], 'SYNTHETIC-SUCCESS')
      await flush()
      equal(current.error, undefined)
      equal(current.settled, true)
      if (kind === 'sale') {
        equal(current.value.state, 'fiscalized')
        fixture.completeSale(fixture.request, 'SYNTHETIC-SUCCESS')
      }
      equal(fixture.intent().state, 'completed')
      const completedIntent = fixture.intent()
      const completedRows = fixture.snapshot()
      equal(fixture.totals(), kind === 'sale'
        ? { stock: 2, sales: 1, payments: 1500, returns: 0, refunds: 0 }
        : { stock: 3, sales: 1, payments: 1500, returns: 1, refunds: 1500 })
      await fixture.restart()
      const duplicate = observe(fixture.invoke(fixture.noExternalLookup))
      await flush()
      equal(duplicate.error, undefined)
      equal(duplicate.settled, true)
      equal(kind === 'sale' ? duplicate.value : duplicate.value.intent, completedIntent)
      if (kind === 'sale') fixture.completeSale(fixture.request, 'SYNTHETIC-SUCCESS')
      equal(fixture.snapshot(), completedRows, 'A duplicate does not reapply payments, stock, audit or outbox')
      equal(fixture.calls(), 1)
    })

    await runCase(`${kind}: failed completed-state write rolls back; persisted fiscal result resumes`, kind, async fixture => {
      const before = fixture.snapshot()
      const beforeTotals = fixture.totals()
      fixture.failCompletion()
      const current = observe(fixture.invoke())
      await flush()
      const worker = fixture.worker()
      worker.respond(worker.requests[0], 'SYNTHETIC-RESUME')
      await flush()
      if (kind === 'sale') {
        equal(current.error, undefined)
        equal(current.value.state, 'fiscalized')
        assert.throws(() => fixture.completeSale(fixture.request, 'SYNTHETIC-RESUME'), /SYNTHETIC_COMPLETION_ABORT/)
        checks++
      } else {
        ok(current.error?.includes('SYNTHETIC_COMPLETION_ABORT'))
        ok(!current.error?.startsWith('FISCAL_INTENT_UNKNOWN|'), 'Local completion failure is not a second external uncertainty')
      }
      equal(fixture.intent().state, 'fiscalized', 'Confirmed external result survives local rollback')
      equal(fixture.intent().fiscal_result.ReceiptFiscalNum, 'SYNTHETIC-RESUME')
      equal(fixture.snapshot(), before, 'Failed completion rolls back all business side effects, including audit/outbox')
      equal(fixture.totals(), beforeTotals)
      await fixture.restart()
      equal(fixture.intent().state, 'fiscalized')
      equal(fixture.snapshot(), before)
      fixture.dropFailure()
      const resumed = observe(fixture.invoke(fixture.noExternalLookup))
      await flush()
      equal(resumed.error, undefined)
      equal(resumed.settled, true)
      if (kind === 'sale') fixture.completeSale(fixture.request, 'SYNTHETIC-RESUME')
      equal(fixture.intent().state, 'completed')
      equal(fixture.totals(), kind === 'sale'
        ? { stock: 2, sales: 1, payments: 1500, returns: 0, refunds: 0 }
        : { stock: 3, sales: 1, payments: 1500, returns: 1, refunds: 1500 })
      equal(fixture.calls(), 1, 'Local completion resume never re-fiscalizes')
      const completeRows = fixture.snapshot()
      const completedIntent = fixture.intent()
      const duplicate = observe(fixture.invoke(fixture.noExternalLookup))
      await flush()
      equal(duplicate.settled, true, 'Duplicate after rollback/resume really completes')
      equal(duplicate.error, undefined)
      const duplicateIntent = kind === 'sale' ? duplicate.value : duplicate.value?.intent
      equal(duplicateIntent?.state, 'completed')
      equal(duplicateIntent, completedIntent, 'Duplicate returns the saved completed intent')
      equal(fixture.snapshot(), completeRows)
      equal(fixture.calls(), 1)
    })
  }

  console.log(JSON.stringify({ ok: true, runtime: 'electron-application', build, checks, cases: reports,
    realTemporaryLocalDatabase: true, realPackagedOrchestration: true, shopDatabaseOpened: false,
    networkRequests: false, realComCalls: 0, realRegistryCalls: 0, realWorkerProcesses: 0,
    physicalPrinterJobs: 0, fiscalActions: 0 }))
  nativeClearTimeout(deadline)
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })

app.on('quit', () => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  // Captured originals stay usable even if Electron exits while a guard is active.
  if (path.dirname(profileRoot) === path.resolve(os.tmpdir())
    && path.basename(profileRoot).startsWith('forsage-fiscal-orchestration-')
    && cleanupFs.existsSync(profileRoot) && cleanupFs.realpathSync(profileRoot) === profileRoot) {
    try { cleanupFs.rmSync(profileRoot, { recursive: true, force: true }) } catch { /* Electron may briefly hold its isolated profile. */ }
  }
})
