// Real packaged repositories and native SQLite, with synthetic data only.
// Never loads application main, a shop database, Cashalot, printers or sync.
const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')
const NativeDate = Date
const cleanupFs = { existsSync: fs.existsSync, realpathSync: fs.realpathSync, rmSync: fs.rmSync }

if (!app?.whenReady) throw new Error('Run with normal Electron, without ELECTRON_RUN_AS_NODE')
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-tire-settlement-'))
const environment = {
  USERPROFILE: path.join(profileRoot, 'profile'), LOCALAPPDATA: path.join(profileRoot, 'local'),
  APPDATA: path.join(profileRoot, 'appData'), PORTABLE_EXECUTABLE_DIR: profileRoot,
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
const deadline = setTimeout(() => { console.error('Synthetic tire-settlement probe timed out'); app.exit(1) }, 60_000)
let activeDb = null
let checks = 0
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++ }
const ok = (condition, message) => { assert.ok(condition, message); checks++ }
const rejectsHandover = run => { assert.throws(run, /Повторне внесення заборонено/); checks++ }
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]))
const CASHIER = 'synthetic-tire-cashier'
const WORKER = 'synthetic-tire-worker'
const SALE_TIME = '2026-09-22T13:40:00.000Z'
const WORK_DATE = '2026-09-22'
const COMMENT = 'Шиномонтаж: заміна 4 коліс R16'
let clock = NativeDate.parse(SALE_TIME)
class FixtureDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [clock])) }
  static now() { return clock }
}

app.whenReady().then(() => {
  // Resolve all packaged modules before restricting subsequent fixture I/O.
  const { LocalDatabase } = require(path.join(dist, 'db/localDatabase.js'))
  const { DEFAULT_TENANT_ID: tenant } = require(path.join(dist, 'db/localTypes.js'))
  const { LocalCatalogRepository } = require(path.join(dist, 'repositories/catalogRepository.js'))
  const { LocalPosRepository } = require(path.join(dist, 'repositories/posRepository.js'))
  const { LocalStaffRepository } = require(path.join(dist, 'repositories/staffRepository.js'))
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

  function runCase(name, run) {
    const dataRoot = path.join(profileRoot, `fixture-${reports.length}`)
    equal(cleanupFs.existsSync(dataRoot), false, 'Every case owns a fresh synthetic database')
    const firstCheck = checks
    let db = null, pos, catalog, staff, shift, product
    let processAttempts = 0, networkAttempts = 0, reopenCount = 0
    const descriptors = new Set()
    const savedFs = Object.fromEntries(['readFileSync', 'writeFileSync', 'statSync', 'existsSync', 'mkdirSync',
      'readdirSync', 'openSync', 'closeSync', 'fsyncSync', 'renameSync', 'unlinkSync', 'copyFileSync', 'rmSync']
      .map(key => [key, fs[key]]))
    const savedProcesses = Object.fromEntries(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
      .map(key => [key, childProcess[key]]))
    const savedNetwork = networkTargets.map(([target, key]) => [target, key, target[key]])
    const assertOwned = filename => {
      assert.equal(typeof filename, 'string', 'Only explicit fixture paths are allowed')
      const resolved = path.resolve(filename)
      assert.ok(resolved === dataRoot || resolved.startsWith(dataRoot + path.sep), `Outside fixture path: ${resolved}`)
    }
    const fsGuards = Object.fromEntries(['readFileSync', 'statSync', 'existsSync', 'readdirSync', 'mkdirSync', 'unlinkSync']
      .map(key => [key, (filename, ...args) => { assertOwned(filename); return savedFs[key](filename, ...args) }]))
    Object.assign(fsGuards, {
      writeFileSync(filename, ...args) {
        if (typeof filename === 'number') assert.ok(descriptors.has(filename))
        else assertOwned(filename)
        return savedFs.writeFileSync(filename, ...args)
      },
      openSync(filename, ...args) { assertOwned(filename); const fd = savedFs.openSync(filename, ...args); descriptors.add(fd); return fd },
      closeSync(fd) { assert.ok(descriptors.has(fd)); const result = savedFs.closeSync(fd); descriptors.delete(fd); return result },
      fsyncSync(fd) { assert.ok(descriptors.has(fd)); return savedFs.fsyncSync(fd) },
      renameSync(from, to) { assertOwned(from); assertOwned(to); return savedFs.renameSync(from, to) },
      copyFileSync(from, to, ...args) { assertOwned(from); assertOwned(to); return savedFs.copyFileSync(from, to, ...args) },
      rmSync(filename, ...args) { assertOwned(filename); assert.notEqual(path.resolve(filename), dataRoot); return savedFs.rmSync(filename, ...args) },
    })
    const forbidProcess = () => { processAttempts++; throw new Error('Synthetic probe forbids subprocesses, registry and COM') }
    const forbidNetwork = () => { networkAttempts++; throw new Error('Synthetic probe forbids network') }
    const connect = () => {
      assertOwned(dataRoot)
      db = new LocalDatabase(dataRoot)
      activeDb = db
      equal(path.resolve(db.databasePath), path.join(dataRoot, 'data', 'forsage.db'))
      pos = new LocalPosRepository(db)
      catalog = new LocalCatalogRepository(db)
      staff = new LocalStaffRepository(db)
    }
    const snapshot = () => db.readSnapshot(() => Object.fromEntries(
      db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
        .map(({ name: table }) => [table, db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])))
    const restart = () => {
      const previous = db, previousPath = db.databasePath, device = db.deviceId
      db.close(); db = null; activeDb = null
      connect(); reopenCount++
      ok(db !== previous, 'Database really closes and reopens')
      equal(db.databasePath, previousPath)
      equal(db.deviceId, device)
    }
    try {
      Object.assign(fs, fsGuards)
      for (const key of Object.keys(savedProcesses)) childProcess[key] = forbidProcess
      for (const [target, key] of networkTargets) target[key] = forbidNetwork
      global.Date = FixtureDate
      clock = NativeDate.parse(SALE_TIME)
      for (const [key, value] of Object.entries(fsGuards)) equal(fs[key], value)
      for (const key of Object.keys(savedProcesses)) equal(require('child_process')[key], forbidProcess)
      for (const [target, key] of networkTargets) equal(target[key], forbidNetwork)
      connect()
      for (const [id, name, role] of [[CASHIER, 'Никита', 'cashier'], [WORKER, 'Андрій', 'tire_worker']]) {
        db.prepare(`INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at)
          VALUES(?,?,?,?,1,0,'day',?,?)`).run(id, tenant, name, role, SALE_TIME, SALE_TIME)
      }
      shift = pos.openShift({ cashier_id: CASHIER, opening_cash: 1000 })
      product = catalog.upsertProduct({ id: 'synthetic-tire-service', sku: 'POS-TIRE-SERVICE',
        name: 'Шиномонтаж', is_service: true, retail_price: 36000, purchase_price: 0, qty_on_hand: 0 })
      staff.createCommissionRule({ user_id: WORKER, rule_type: 'tire_service', pct_from_revenue: 35, pct_from_profit: 0 })
      const checkout = { client_operation_id: 'synthetic-tire-sale', tenant_id: tenant,
        cashier_id: CASHIER, manager_id: WORKER, shift_id: shift, notes: COMMENT, is_fiscal: false,
        items: [
          { product_id: product.id, description: 'Заміна коліс', qty: 1, unit_price: 24000 },
          { product_id: product.id, description: 'Балансування', qty: 1, unit_price: 12000 },
        ], payments: [{ method: 'cash', amount: 36000 }] }
      const handover = amount => ({ operation_id: 'synthetic-blocked-handover', tenant_id: tenant,
        employee_id: WORKER, work_date: WORK_DATE, shift_id: shift, amount, user_id: CASHIER })
      const payout = { operation_id: 'synthetic-tire-payout', tenant_id: tenant, employee_id: WORKER,
        method: 'cash', fund_source: 'cashbox', shift_id: shift, work_date: WORK_DATE, user_id: CASHIER }
      run({ get db() { return db }, get pos() { return pos }, get staff() { return staff },
        get catalog() { return catalog }, shift, product, checkout, handover, payout, restart, snapshot,
        setTime: value => { clock = NativeDate.parse(value); assert.ok(Number.isFinite(clock)) } })
      equal(db.prepare('PRAGMA integrity_check').get(), { integrity_check: 'ok' })
      equal(db.prepare('PRAGMA foreign_key_check').all(), [])
      equal(processAttempts, 0)
      equal(networkAttempts, 0)
      equal(descriptors.size, 0)
      ok(reopenCount > 0, 'Every scenario exercises a real database reopen')
      reports.push({ name, checks: checks - firstCheck, reopenCount })
    } finally {
      try { db?.close() } finally {
        activeDb = null
        global.Date = NativeDate
        Object.assign(fs, savedFs)
        Object.assign(childProcess, savedProcesses)
        for (const [target, key, value] of savedNetwork) target[key] = value
      }
    }
  }

  runCase('checkout cash is counted once; mature payout and retries survive native reopen', f => {
    equal(f.pos.getExpectedCash(CASHIER).expected_amount, 1000)
    const sale = f.pos.checkout(f.checkout)
    equal(sale.total, 36000)
    equal(f.pos.getExpectedCash(CASHIER).expected_amount, 37000)
    const committed = f.snapshot()
    f.restart()
    equal(f.snapshot(), committed)
    equal(f.pos.checkout(f.checkout), sale)
    const report = f.staff.tireServiceReport(WORK_DATE)
    equal(report.receipts.length, 1)
    equal(pick(report.receipts[0], ['id', 'cashier_id', 'employee_id', 'notes', 'cash_register_received', 'commission_earned']),
      { id: sale.sale_id, cashier_id: CASHIER, employee_id: WORKER, notes: COMMENT, cash_register_received: 36000, commission_earned: 12600 })
    equal(report.receipts[0].services.map(row => row.description).sort(), ['Балансування', 'Заміна коліс'])
    equal(pick(report.data[0], ['earned', 'due', 'cash_pending', 'cash_register_received']),
      { earned: 12600, due: 12600, cash_pending: 0, cash_register_received: 36000 })
    rejectsHandover(() => f.staff.tireCashHandover(f.handover(10000)))
    rejectsHandover(() => f.staff.tireCashHandover(f.handover(36000)))
    assert.throws(() => f.staff.dailyPayout(f.payout), /2026-09-24/); checks++
    equal(f.snapshot(), committed, 'Report and all denied premature/duplicate operations write nothing')
    f.setTime('2026-09-25T07:30:00.000Z')
    const paid = f.staff.dailyPayout(f.payout)
    equal(paid.amount, 12600)
    equal(f.pos.getExpectedCash(CASHIER).expected_amount, 24400)
    equal(pick(f.staff.tireServiceReport(WORK_DATE).data[0], ['earned', 'paid', 'due', 'cash_pending']),
      { earned: 12600, paid: 12600, due: 0, cash_pending: 0 })
    equal(f.db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(f.product.id), { qty_on_hand: 0 })
    equal(f.db.prepare('SELECT * FROM inventory_movements WHERE source_id=?').all(sale.sale_id), [])
    const settled = f.snapshot()
    f.restart()
    equal(f.pos.checkout(f.checkout), sale)
    equal(f.staff.dailyPayout(f.payout), paid)
    rejectsHandover(() => f.staff.tireCashHandover(f.handover(36000)))
    equal(f.snapshot(), settled, 'No duplicate receipt, salary, cash, stock, audit or outbox')
    equal(f.pos.getExpectedCash(CASHIER).expected_amount, 24400)
  })

  runCase('mixed receipt discount allocates 16200 cash to tyre service', f => {
    const goods = f.catalog.upsertProduct({ id: 'synthetic-goods', sku: 'SYNTHETIC-GOODS', name: 'Контрольний товар',
      qty_on_hand: 5, retail_price: 24000, purchase_price: 15000, is_service: false })
    const request = { ...f.checkout, discount: 6000,
      items: [...f.checkout.items, { product_id: goods.id, qty: 1, unit_price: 24000 }],
      payments: [{ method: 'cash', amount: 27000 }, { method: 'card', amount: 27000 }] }
    const sale = f.pos.checkout(request)
    equal(sale.total, 54000)
    equal(f.pos.getExpectedCash(CASHIER).expected_amount, 28000)
    const committed = f.snapshot()
    for (const reopened of [false, true]) {
      if (reopened) f.restart()
      const report = f.staff.tireServiceReport(WORK_DATE)
      equal(pick(report.receipts[0], ['id', 'cash_revenue', 'cash_register_received', 'commission_earned']),
        { id: sale.sale_id, cash_revenue: 16200, cash_register_received: 16200, commission_earned: 11340 })
      equal(report.data[0].cash_pending, 0)
      equal(report.totals.cash_register_received, 16200)
      equal(f.catalog.findById(goods.id).qty_on_hand, 4)
      equal(f.pos.checkout(request), sale)
      rejectsHandover(() => f.staff.tireCashHandover(f.handover(16200)))
      equal(f.snapshot(), committed)
    }
  })

  runCase('overnight service uses current cashier shift and actual off-duty worker', f => {
    f.pos.closeShift(CASHIER, 1000, 'Synthetic previous shift', f.shift)
    f.setTime('2026-09-23T07:00:00.000Z')
    const nextCashier = 'synthetic-next-cashier'
    f.db.prepare(`INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at)
      VALUES(?,?,'Олена','cashier',1,0,'day',?,?)`).run(nextCashier, tenant, SALE_TIME, SALE_TIME)
    const shift = f.pos.openShift({ cashier_id: nextCashier, opening_cash: 0 })
    const request = { ...f.checkout, cashier_id: nextCashier, manager_id: WORKER, shift_id: shift,
      notes: 'Внесено вранці за вечірню роботу Андрія' }
    const sale = f.pos.checkout(request)
    equal(f.db.prepare('SELECT cashier_id,manager_id,shift_id FROM sales WHERE id=?').get(sale.sale_id),
      { cashier_id: nextCashier, manager_id: WORKER, shift_id: shift })
    equal(f.pos.getExpectedCash(CASHIER), null)
    equal(f.pos.getExpectedCash(nextCashier).expected_amount, 36000)
    equal(f.staff.tireServiceReport(WORK_DATE).receipts, [])
    const report = f.staff.tireServiceReport('2026-09-23')
    equal(pick(report.receipts[0], ['cashier_id', 'employee_id', 'notes', 'commission_earned', 'cash_register_received']),
      { cashier_id: nextCashier, employee_id: WORKER, notes: request.notes, commission_earned: 12600, cash_register_received: 36000 })
    equal(report.data[0].cash_pending, 0)
    const committed = f.snapshot()
    f.restart()
    equal(f.pos.checkout(request), sale)
    equal(f.staff.tireServiceReport('2026-09-23'), report)
    equal(f.snapshot(), committed)
  })

  runCase('historical manual cash evidence is preserved without allowing another handover', f => {
    f.pos.checkout(f.checkout)
    // Deliberately model pre-upgrade history, not an endorsed new operation.
    f.db.prepare(`INSERT INTO cash_operations(id,tenant_id,shift_id,user_id,type,source,amount,employee_id,work_date,notes,created_at,updated_at)
      VALUES('synthetic-historical-handover',?,?,?,'cash_in','cashbox',5000,?,?,'Historical synthetic evidence',?,?)`)
      .run(tenant, f.shift, CASHIER, WORKER, WORK_DATE, SALE_TIME, SALE_TIME)
    const committed = f.snapshot()
    const drawer = f.pos.getExpectedCash(CASHIER).expected_amount
    for (const reopened of [false, true]) {
      if (reopened) f.restart()
      const report = f.staff.tireServiceReport(WORK_DATE)
      equal(report.data[0].cash_pending, 0)
      equal(report.data[0].cash_register_received, 36000)
      ok(report.cash_handovers.some(row => row.id === 'synthetic-historical-handover'), 'Old manual evidence remains visible')
      rejectsHandover(() => f.staff.tireCashHandover(f.handover(1000)))
      equal(f.pos.getExpectedCash(CASHIER).expected_amount, drawer, 'No automatic historical cash repair')
      equal(f.snapshot(), committed, 'Historical rows remain byte-for-byte equivalent at the field level')
    }
  })

  console.log(JSON.stringify({ ok: true, runtime: 'electron-application', build, checks, cases: reports,
    realTemporaryLocalDatabase: true, realPackagedCheckout: true, shopDatabaseOpened: false,
    networkRequests: false, realComCalls: 0, realRegistryCalls: 0, realWorkerProcesses: 0, physicalPrinterJobs: 0 }))
  clearTimeout(deadline)
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })

app.on('quit', () => {
  try { activeDb?.close() } catch { /* Best effort if a deadline interrupted the fixture. */ }
  global.Date = NativeDate
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (path.dirname(profileRoot) === path.resolve(os.tmpdir())
    && path.basename(profileRoot).startsWith('forsage-tire-settlement-')
    && cleanupFs.existsSync(profileRoot) && cleanupFs.realpathSync(profileRoot) === profileRoot) {
    try { cleanupFs.rmSync(profileRoot, { recursive: true, force: true }) }
    catch { /* Windows may briefly hold its isolated Electron cache. */ }
  }
})
