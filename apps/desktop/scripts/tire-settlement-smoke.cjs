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

  function runCase(name, run, { openingCash = 1000, openingTime = SALE_TIME } = {}) {
    assert.ok(Number.isSafeInteger(openingCash) && openingCash >= 0, 'Synthetic opening cash must be whole nonnegative kopecks')
    assert.ok(Number.isFinite(NativeDate.parse(openingTime)), 'Synthetic opening time must be a valid date')
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
      clock = NativeDate.parse(openingTime)
      for (const [key, value] of Object.entries(fsGuards)) equal(fs[key], value)
      for (const key of Object.keys(savedProcesses)) equal(require('child_process')[key], forbidProcess)
      for (const [target, key] of networkTargets) equal(target[key], forbidNetwork)
      connect()
      for (const [id, name, role] of [[CASHIER, 'Никита', 'cashier'], [WORKER, 'Андрій', 'tire_worker']]) {
        db.prepare(`INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at)
          VALUES(?,?,?,?,1,0,'day',?,?)`).run(id, tenant, name, role, SALE_TIME, SALE_TIME)
      }
      shift = pos.openShift({ cashier_id: CASHIER, opening_cash: openingCash })
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
      equal(pick(db.prepare('PRAGMA integrity_check').get(), ['integrity_check']), { integrity_check: 'ok' })
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
    equal(pick(f.db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(f.product.id), ['qty_on_hand']), { qty_on_hand: 0 })
    equal(f.db.prepare('SELECT * FROM inventory_movements WHERE source_id=?').all(sale.sale_id), [])
    const settled = f.snapshot()
    f.restart()
    equal(f.pos.checkout(f.checkout), sale)
    // The persisted replay is JSON; the original payment is a native SQLite
    // row with a null prototype. Compare every field, not runtime prototypes.
    equal(f.staff.dailyPayout(f.payout), { ...paid, payment: { ...paid.payment } })
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
    equal(pick(f.db.prepare('SELECT cashier_id,manager_id,shift_id FROM sales WHERE id=?').get(sale.sale_id),
      ['cashier_id', 'manager_id', 'shift_id']),
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

  runCase('partial then full service refunds preserve gross history and reverse commission on each actual day', f => {
    const checkout = { ...f.checkout,
      items: [{ product_id: f.product.id, description: 'Шиномонтаж', qty: 2, unit_price: 18000 }] }
    const sale = f.pos.checkout(checkout)
    equal(sale.total, 36000)
    equal(f.pos.getExpectedCash(CASHIER).expected_amount, 37000)
    const item = f.pos.getSaleForReturn(sale.sale_id).items[0]
    equal(item.available_qty, 2)
    const originalReceipt = f.staff.tireServiceReport(WORK_DATE).receipts[0]
    const originalHistory = () => ({
      sale: f.db.prepare('SELECT sale_number,total,cash_amount,completed_at,cashier_id,manager_id FROM sales WHERE id=?').get(sale.sale_id),
      lines: f.db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(sale.sale_id),
      cash: f.db.prepare("SELECT * FROM cash_operations WHERE sale_id=? AND type='sale_cash' ORDER BY id").all(sale.sale_id),
      commission: f.db.prepare("SELECT * FROM salary_payments WHERE commission_source_sale_id=? AND source='commission' ORDER BY id").all(sale.sale_id),
    })
    const initialHistory = originalHistory()
    equal(initialHistory.cash.length, 1)
    equal(initialHistory.cash[0].amount, 36000)
    equal(initialHistory.commission.length, 1)
    equal(initialHistory.commission[0].amount, 12600)
    const completedReturns = []
    for (const [index, workDate] of ['2026-09-23', '2026-09-24'].entries()) {
      const timestamp = workDate + 'T09:00:00.000Z'
      f.setTime(timestamp)
      const request = { tenant_id: tenant, sale_id: sale.sale_id, approved_by: CASHIER,
        shift_id: f.shift, client_operation_id: `synthetic-tire-refund-${index + 1}`,
        is_fiscal: false, reason: 'other', refund_method: 'cash', stock_action: 'return_to_stock',
        items: [{ sale_item_id: item.id, product_id: f.product.id, quantity: 1, condition: 'good' }] }
      const returned = f.pos.createReturn(request)
      equal(returned.refund_kopecks, 18000)
      equal(returned.created_at, timestamp)
      completedReturns.push({ request, result: returned })
      const committed = f.snapshot()
      for (const reopened of [false, true]) {
        if (reopened) f.restart()
        const originalDay = f.staff.tireServiceReport(WORK_DATE)
        equal(originalDay.receipts, [originalReceipt], 'Full return must not hide or rewrite the original service receipt')
        equal(pick(originalDay.data[0], ['services_qty', 'service_revenue', 'cash_revenue', 'cash_register_received', 'commission_earned', 'earned', 'cash_pending']),
          { services_qty: 2, service_revenue: 36000, cash_revenue: 36000, cash_register_received: 36000,
            commission_earned: 12600, earned: 12600, cash_pending: 0 })
        equal(originalHistory(), initialHistory, 'Gross line, sale cash and initial commission evidence stay unchanged')
        for (const prior of completedReturns) {
          const returnDay = prior.result.created_at.slice(0, 10)
          const dayReport = f.staff.tireServiceReport(returnDay)
          equal(dayReport.receipts, [], 'The refund day does not acquire a second original receipt')
          equal(pick(dayReport.data[0], ['service_revenue', 'cash_register_received', 'commission_earned', 'earned', 'paid', 'cash_pending']),
            { service_revenue: 0, cash_register_received: 0, commission_earned: -6300,
              earned: -6300, paid: 0, cash_pending: 0 })
          equal(dayReport.salary_operations.map(row => pick(row, ['source', 'amount', 'sale_id', 'employee_id', 'work_date', 'created_at'])),
            [{ source: 'commission_reversal', amount: -6300, sale_id: sale.sale_id, employee_id: WORKER,
              work_date: returnDay, created_at: prior.result.created_at }])
          equal(f.pos.createReturn(prior.request), prior.result, 'A replay returns the existing refund without another cash or salary movement')
        }
        equal(f.pos.getExpectedCash(CASHIER).expected_amount, index === 0 ? 19000 : 1000)
        equal(f.pos.getSaleForReturn(sale.sale_id).sale.status, index === 0 ? 'completed' : 'returned')
        equal(f.pos.getSaleForReturn(sale.sale_id).items[0].available_qty, index === 0 ? 1 : 0)
        equal(f.catalog.findById(f.product.id).qty_on_hand, 0)
        equal(f.db.prepare('SELECT * FROM inventory_movements WHERE source_id IN (?,?,?)')
          .all(sale.sale_id, completedReturns[0].result.id, completedReturns[1]?.result.id ?? ''), [])
        equal(f.db.prepare("SELECT amount,created_at FROM cash_operations WHERE type='return_cash' ORDER BY created_at,id").all()
          .map(row => pick(row, ['amount', 'created_at'])),
        completedReturns.map(prior => ({ amount: 18000, created_at: prior.result.created_at })))
        equal(f.db.prepare('SELECT COUNT(*) n FROM customer_returns WHERE sale_id=?').get(sale.sale_id).n, index + 1)
        rejectsHandover(() => f.staff.tireCashHandover(f.handover(36000)))
        equal(f.snapshot(), committed, 'Reads, reopens, blocked handovers and refund retries leave every table unchanged')
      }
    }
    equal(f.db.prepare("SELECT SUM(amount) amount FROM salary_payments WHERE commission_source_sale_id=? AND source IN ('commission','commission_reversal')")
      .get(sale.sale_id).amount, 0, 'The two reversals exactly offset the original commission')
  })

  runCase('already paid September work keeps its payout while October refunds reverse commission on their own dates', f => {
    const workDate = '2026-09-29'
    const saleTime = workDate + 'T13:40:00.000Z'
    const payoutTime = '2026-10-01T09:00:00.000Z'
    f.setTime(saleTime)
    equal(f.pos.getExpectedCash(CASHIER).expected_amount, 20000)
    const checkout = { ...f.checkout,
      items: [{ product_id: f.product.id, description: 'Шиномонтаж', qty: 2, unit_price: 18000 }] }
    const sale = f.pos.checkout(checkout)
    equal(sale.total, 36000)
    equal(f.pos.getExpectedCash(CASHIER).expected_amount, 56000)
    const item = f.pos.getSaleForReturn(sale.sale_id).items[0]
    const originalReceipt = f.staff.tireServiceReport(workDate).receipts[0]
    equal(originalReceipt.completed_at, saleTime)
    equal(pick(f.staff.salarySummary('2026-09')[0], ['earned', 'paid', 'balance']),
      { earned: 12600, paid: 0, balance: 12600 })
    const payout = { ...f.payout, work_date: workDate }
    f.setTime(payoutTime)
    equal(f.staff.tireServiceReport(workDate).data[0].salary_ready, true)
    const paid = f.staff.dailyPayout(payout)
    const replayPayout = { ...paid, payment: { ...paid.payment } }
    equal(paid.amount, 12600)
    equal(pick(paid.payment, ['period', 'work_date', 'created_at', 'amount']),
      { period: '2026-09', work_date: workDate, created_at: payoutTime, amount: 12600 })
    equal(f.pos.getExpectedCash(CASHIER).expected_amount, 43400)
    const paidHistory = () => ({
      receiptLines: f.db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(sale.sale_id),
      customerCash: f.db.prepare("SELECT * FROM cash_operations WHERE sale_id=? AND type='sale_cash' ORDER BY id").all(sale.sale_id),
      initialCommission: f.db.prepare("SELECT * FROM salary_payments WHERE commission_source_sale_id=? AND source='commission' ORDER BY id").all(sale.sale_id),
      payout: f.db.prepare('SELECT * FROM salary_payments WHERE id=?').get(paid.payment.id),
      payoutCash: f.db.prepare('SELECT * FROM cash_operations WHERE id=?').get(paid.payment.cash_operation_id),
    })
    const initialPaidHistory = paidHistory()
    equal(pick(initialPaidHistory.payoutCash, ['type', 'amount', 'work_date', 'created_at']),
      { type: 'salary_payout', amount: 12600, work_date: workDate, created_at: payoutTime })
    const paidSnapshot = f.snapshot()
    f.restart()
    equal(f.staff.dailyPayout(payout), replayPayout)
    equal(f.pos.checkout(checkout), sale)
    equal(f.snapshot(), paidSnapshot, 'A restart does not pay the September wage twice')
    const completedReturns = []
    for (const [index, returnDate] of ['2026-10-02', '2026-10-03'].entries()) {
      const timestamp = returnDate + 'T09:00:00.000Z'
      f.setTime(timestamp)
      const request = { tenant_id: tenant, sale_id: sale.sale_id, approved_by: CASHIER,
        shift_id: f.shift, client_operation_id: `synthetic-paid-tire-refund-${index + 1}`,
        is_fiscal: false, reason: 'other', refund_method: 'cash', stock_action: 'return_to_stock',
        items: [{ sale_item_id: item.id, product_id: f.product.id, quantity: 1, condition: 'good' }] }
      const returned = f.pos.createReturn(request)
      equal(returned.refund_kopecks, 18000)
      equal(returned.created_at, timestamp)
      completedReturns.push({ request, result: returned })
      const committed = f.snapshot()
      for (const reopened of [false, true]) {
        if (reopened) f.restart()
        const originalDay = f.staff.tireServiceReport(workDate)
        equal(originalDay.receipts, [originalReceipt], 'Later refunds preserve the original gross service and customer cash')
        equal(pick(originalDay.data[0], ['service_revenue', 'cash_register_received', 'earned', 'paid', 'balance', 'due']),
          { service_revenue: 36000, cash_register_received: 36000, earned: 12600, paid: 12600, balance: 0, due: 0 })
        equal(pick(f.staff.salarySummary('2026-09')[0], ['earned', 'paid', 'balance']),
          { earned: 12600, paid: 12600, balance: 0 }, 'October payment creation time does not move its September work-date accounting')
        equal(pick(f.staff.salarySummary('2026-10')[0], ['earned', 'paid', 'balance']),
          { earned: -6300 * (index + 1), paid: 0, balance: -6300 * (index + 1) })
        equal(f.staff.dailySummary('2026-10-01'), [], 'No wage is silently reattributed to the payout calendar date')
        equal(paidHistory(), initialPaidHistory, 'Refund commission adjustments never rewrite or reverse the already paid wage cash row')
        for (const prior of completedReturns) {
          const date = prior.result.created_at.slice(0, 10)
          const report = f.staff.tireServiceReport(date)
          equal(report.receipts, [])
          equal(pick(report.data[0], ['earned', 'paid', 'balance', 'cash_register_received']),
            { earned: -6300, paid: 0, balance: -6300, cash_register_received: 0 })
          equal(report.salary_operations.map(row => pick(row, ['source', 'amount', 'work_date', 'created_at', 'sale_id'])),
            [{ source: 'commission_reversal', amount: -6300, work_date: date,
              created_at: prior.result.created_at, sale_id: sale.sale_id }])
          equal(f.pos.createReturn(prior.request), prior.result)
        }
        equal(f.staff.dailyPayout(payout), replayPayout)
        equal(f.pos.checkout(checkout), sale)
        equal(f.pos.getExpectedCash(CASHIER).expected_amount, index === 0 ? 25400 : 7400)
        equal(f.pos.getSaleForReturn(sale.sale_id).sale.status, index === 0 ? 'completed' : 'returned')
        equal(f.pos.getSaleForReturn(sale.sale_id).items[0].available_qty, index === 0 ? 1 : 0)
        equal(f.catalog.findById(f.product.id).qty_on_hand, 0)
        equal(f.db.prepare("SELECT COUNT(*) n FROM cash_operations WHERE type='salary_payout'").get().n, 1)
        equal(f.db.prepare("SELECT COUNT(*) n, SUM(amount) amount FROM cash_operations WHERE type='return_cash'").get().amount,
          18000 * (index + 1))
        equal(f.db.prepare('SELECT COUNT(*) n FROM customer_returns WHERE sale_id=?').get(sale.sale_id).n, index + 1)
        rejectsHandover(() => f.staff.tireCashHandover({ ...f.handover(36000), work_date: workDate }))
        equal(f.snapshot(), committed, 'All report reads and retries preserve every table after actual close/reopen')
      }
    }
  }, { openingCash: 20000 })

  runCase('closed cash shifts preserve accepted counts across paid September work and October refunds', f => {
    const workDate = '2026-09-29'
    const nextCashier = 'synthetic-october-cashier'
    f.db.prepare(`INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at)
      VALUES(?,?,'Олена','cashier',1,0,'day',?,?)`).run(nextCashier, tenant, workDate + 'T08:00:00.000Z', workDate + 'T08:00:00.000Z')
    const checkout = { ...f.checkout,
      items: [{ product_id: f.product.id, description: 'Шиномонтаж', qty: 2, unit_price: 18000 }] }
    f.setTime(workDate + 'T13:40:00.000Z')
    const sale = f.pos.checkout(checkout)
    const item = f.pos.getSaleForReturn(sale.sale_id).items[0]
    const originalReceipt = f.staff.tireServiceReport(workDate).receipts[0]
    const closed = [], returned = []
    let payout, paid
    const closedEvidence = id => ({
      shift: f.db.prepare('SELECT * FROM shifts WHERE id=?').get(id),
      cash: f.db.prepare('SELECT * FROM cash_operations WHERE shift_id=? ORDER BY id').all(id),
      events: f.db.prepare("SELECT * FROM sync_outbox WHERE aggregate_type='shift' AND aggregate_id=? ORDER BY operation_id").all(id),
      backups: f.db.prepare('SELECT * FROM shift_backups WHERE id=?').all(id),
    })
    const assertClosed = () => {
      for (const previous of closed) equal(closedEvidence(previous.id), previous.evidence,
        'Future work never rewrites accepted closed cash, shift events or its pending backup evidence')
    }
    const assertReplays = () => {
      const before = f.snapshot()
      equal(f.pos.checkout(checkout), sale)
      if (paid) equal(f.staff.dailyPayout(payout), { ...paid, payment: { ...paid.payment } })
      for (const previous of returned) equal(f.pos.createReturn(previous.request), previous.result)
      for (const previous of closed) equal(f.pos.closeShift(...previous.request), { ok: true, id: previous.id })
      assertClosed()
      equal(f.snapshot(), before, 'Replaying old receipts, payouts, returns and closes does not touch the active or closed shifts')
    }
    const verifyOpen = (cashier, id, opening, sales, refunds, wages) => {
      const report = f.pos.getShiftReport(cashier)
      equal(report.shift.id, id)
      equal(report.shift.cashier_id, cashier)
      equal(pick(report, ['total_sales', 'gross_revenue', 'refund_total', 'total_revenue',
        'payment_received_total', 'payment_refunded_total', 'payment_net_total', 'unassigned_refunds_count']),
      { total_sales: sales ? 1 : 0, gross_revenue: sales, refund_total: refunds, total_revenue: sales - refunds,
        payment_received_total: sales, payment_refunded_total: refunds, payment_net_total: sales - refunds,
        unassigned_refunds_count: 0 })
      equal(report.cash_breakdown, { opening_cash: opening, cash_sales: sales, cash_returns: refunds,
        cash_in: 0, cash_out: wages, expected_amount: opening + sales - refunds - wages })
      equal(f.pos.getExpectedCash(cashier), report.cash_breakdown)
      equal(report.by_method, { cash: sales, card: 0, transfer: 0, account: 0, debt: 0 })
      equal(report.refunds_by_method, { cash: refunds, card: 0, transfer: 0, account: 0, debt: 0 })
      return report
    }
    const close = (cashier, id, actual, timestamp) => {
      f.setTime(timestamp)
      const request = [cashier, actual, 'Synthetic accepted drawer', id]
      equal(f.pos.closeShift(...request), { ok: true, id })
      equal(f.pos.getExpectedCash(cashier), null)
      equal(f.pos.getShiftReport(cashier), null, 'The existing report API only exposes the currently open shift')
      const evidence = closedEvidence(id)
      equal(pick(evidence.shift, ['status', 'closing_cash', 'expected_cash', 'cash_variance', 'closed_at']),
        { status: 'closed', closing_cash: actual, expected_cash: actual, cash_variance: 0, closed_at: timestamp })
      equal(evidence.backups.length, 1)
      equal(evidence.events.map(row => row.operation_type).sort(), ['shift.closed', 'shift.opened'])
      closed.push({ id, request, evidence })
      const before = f.snapshot()
      f.restart()
      equal(f.snapshot(), before)
      assertReplays()
    }
    const openNext = (timestamp, expectedOpening) => {
      f.setTime(timestamp)
      // The application submits a counted opening amount; the repository does
      // not automatically carry cash between shifts. Model that explicit input.
      const accepted = closed.at(-1).evidence.shift.closing_cash
      equal(accepted, expectedOpening)
      const request = { cashier_id: nextCashier, opening_cash: accepted }
      const id = f.pos.openShift(request)
      equal(f.pos.getOpenShift(nextCashier).opened_at, timestamp)
      const before = f.snapshot()
      equal(f.pos.openShift(request), id)
      assertReplays()
      equal(f.snapshot(), before, 'Old close retries must not close the newly opened shift')
      equal(f.pos.getOpenShift(nextCashier).id, id)
      equal(f.pos.getExpectedCash(CASHIER), null)
      return id
    }

    equal(pick(f.pos.getOpenShift(CASHIER), ['id', 'opening_cash', 'opened_at']),
      { id: f.shift, opening_cash: 20000, opened_at: workDate + 'T08:00:00.000Z' })
    verifyOpen(CASHIER, f.shift, 20000, 36000, 0, 0)
    close(CASHIER, f.shift, 56000, workDate + 'T17:00:00.000Z')
    const rejectsOldShiftPayout = () => {
      const before = f.snapshot()
      assert.throws(() => f.staff.dailyPayout({ ...f.payout, work_date: workDate,
        operation_id: 'synthetic-closed-shift-payout' }), /Касова зміна не відкрита/); checks++
      equal(f.snapshot(), before, 'Matured salary cannot be paid from the original closed cashier shift')
    }
    f.setTime('2026-10-01T08:00:00.000Z')
    rejectsOldShiftPayout()
    const wageShift = openNext('2026-10-01T08:00:00.000Z', 56000)
    rejectsOldShiftPayout()
    f.setTime('2026-10-01T09:00:00.000Z')
    payout = { ...f.payout, shift_id: wageShift, user_id: nextCashier, work_date: workDate }
    paid = f.staff.dailyPayout(payout)
    equal(pick(paid.payment, ['employee_id', 'created_by', 'shift_id', 'period', 'work_date', 'amount']),
      { employee_id: WORKER, created_by: nextCashier, shift_id: wageShift, period: '2026-09', work_date: workDate, amount: 12600 })
    verifyOpen(nextCashier, wageShift, 56000, 0, 0, 12600)
    assertClosed()
    close(nextCashier, wageShift, 43400, '2026-10-01T17:00:00.000Z')
    for (const [index, date] of ['2026-10-02', '2026-10-03'].entries()) {
      const opening = index === 0 ? 43400 : 25400, expected = opening - 18000
      const shift = openNext(date + 'T08:00:00.000Z', opening)
      f.setTime(date + 'T09:00:00.000Z')
      const request = { tenant_id: tenant, sale_id: sale.sale_id, approved_by: nextCashier,
        shift_id: shift, client_operation_id: `synthetic-closed-shift-refund-${index + 1}`,
        is_fiscal: false, reason: 'other', refund_method: 'cash', stock_action: 'return_to_stock',
        items: [{ sale_item_id: item.id, product_id: f.product.id, quantity: 1, condition: 'good' }] }
      const result = f.pos.createReturn(request)
      returned.push({ request, result })
      equal(pick(result, ['approved_by', 'refund_kopecks', 'created_at']),
        { approved_by: nextCashier, refund_kopecks: 18000, created_at: date + 'T09:00:00.000Z' })
      // The public return DTO omits shift_id; verify the actual saved link,
      // independently of the current-shift report and its cash-row evidence.
      equal(pick(f.db.prepare('SELECT shift_id,approved_by,created_at FROM customer_returns WHERE id=?').get(result.id),
        ['shift_id', 'approved_by', 'created_at']),
      { shift_id: shift, approved_by: nextCashier, created_at: date + 'T09:00:00.000Z' })
      verifyOpen(nextCashier, shift, opening, 0, 18000, 0)
      equal(f.staff.tireServiceReport(workDate).receipts, [originalReceipt])
      equal(pick(f.staff.salarySummary('2026-09')[0], ['employee_id', 'earned', 'paid', 'balance']),
        { employee_id: WORKER, earned: 12600, paid: 12600, balance: 0 })
      equal(pick(f.staff.salarySummary('2026-10')[0], ['employee_id', 'earned', 'paid', 'balance']),
        { employee_id: WORKER, earned: -6300 * (index + 1), paid: 0, balance: -6300 * (index + 1) })
      equal(f.staff.tireServiceReport(date).salary_operations.map(row => pick(row,
        ['employee_id', 'created_by', 'source', 'amount', 'work_date', 'created_at'])),
      [{ employee_id: WORKER, created_by: nextCashier, source: 'commission_reversal', amount: -6300,
        work_date: date, created_at: date + 'T09:00:00.000Z' }])
      assertReplays()
      close(nextCashier, shift, expected, date + 'T17:00:00.000Z')
    }
    equal(closed.map(previous => previous.evidence.shift.closing_cash), [56000, 43400, 25400, 7400])
    equal(f.db.prepare('SELECT COUNT(*) n FROM shifts WHERE cashier_id=?').get(WORKER).n, 0,
      'The original worker owns commission without opening any cashier shift')
    equal(f.db.prepare("SELECT COUNT(*) n FROM shifts WHERE status='open'").get().n, 0)
    equal(f.db.prepare('SELECT COUNT(*) n FROM shift_backups').get().n, 4)
    equal(f.db.prepare('SELECT type,amount,user_id,employee_id,shift_id FROM cash_operations ORDER BY created_at,id').all()
      .map(row => pick(row, ['type', 'amount', 'user_id', 'employee_id', 'shift_id'])), [
      { type: 'sale_cash', amount: 36000, user_id: CASHIER, employee_id: null, shift_id: f.shift },
      { type: 'salary_payout', amount: 12600, user_id: nextCashier, employee_id: WORKER, shift_id: wageShift },
      ...returned.map(previous => ({ type: 'return_cash', amount: 18000, user_id: nextCashier,
        employee_id: null, shift_id: previous.request.shift_id })),
    ])
    equal(f.pos.getSaleForReturn(sale.sale_id).sale.status, 'returned')
    equal(f.pos.getSaleForReturn(sale.sale_id).items[0].available_qty, 0)
    equal(f.catalog.findById(f.product.id).qty_on_hand, 0)
    equal(f.db.prepare('SELECT * FROM inventory_movements WHERE source_id IN (?,?,?)')
      .all(sale.sale_id, returned[0].result.id, returned[1].result.id), [])
    assertReplays()
  }, { openingCash: 20000, openingTime: '2026-09-29T08:00:00.000Z' })

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
