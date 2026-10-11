import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storage: { isEncryptionAvailable: vi.fn(), encryptString: vi.fn(), decryptString: vi.fn() },
  paths: { cashalotSearchDirs: vi.fn(), detectCashalotDir: vi.fn(), resolveCashalotDir: vi.fn(), hasCashalotDll: vi.fn() },
  processes: { spawn: vi.fn(), spawnSync: vi.fn(), exec: vi.fn(), execSync: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn(), fork: vi.fn() },
}))

// Never import application main or native Electron. SQLite and the filesystem
// stay real, but only receive the unique temporary fixture root below.
vi.mock('electron', () => ({ safeStorage: mocks.storage }))
vi.mock('node:child_process', () => ({ default: mocks.processes, ...mocks.processes }))
vi.mock('../src/fiscal/cashalotPaths', () => mocks.paths)

import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalFiscalReturnRequest, type LocalFiscalSaleIntentResult, type LocalFiscalSaleRequest, type LocalProduct } from '../src/db/localTypes'
import { CashalotService, type CashalotRetVal } from '../src/fiscal/cashalotService'
import { fiscalizeSale, processFiscalReturn } from '../src/fiscal/fiscalOrchestration'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

const CASHIER = 'fiscal-orchestration-cashier'
const OPERATION = 'fiscal-orchestration-operation'
const PRICE = 1500
const CALL_TIMEOUT_MS = 180_000
type WorkerRequest = { id: string; method: string; comMethod: string; args: string[]; config: { cashalotDir: string } }
type Observation = { settlements: number; value?: LocalFiscalSaleIntentResult; error?: string; done: Promise<void> }

class FakeWorker extends EventEmitter {
  readonly pid = 81001
  exitCode: number | null = null
  readonly requests: WorkerRequest[] = []
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  readonly stderr = new EventEmitter()
  readonly stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((line: string) => {
      this.requests.push(JSON.parse(Buffer.from(line.trim(), 'base64').toString('utf8')) as WorkerRequest)
      return true
    }),
    end: vi.fn(),
  })
  // No automatic exit: late responses/errors from a detached worker remain
  // possible, just as in the worker lifecycle fixture.
  readonly kill = vi.fn(() => true)

  respond(request: WorkerRequest, result: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result })).toString('base64') + '\n')
  }
}

describe.each(['sale', 'return'] as const)('fiscal %s orchestration with persistent SQLite', kind => {
  let root = ''
  let fiscalRoot = ''
  let db: LocalDatabase | undefined
  let pos: LocalPosRepository
  let catalog: LocalCatalogRepository
  let service: CashalotService
  let getCashalot: ReturnType<typeof vi.fn<() => CashalotService>>
  let services: CashalotService[]
  let workers: FakeWorker[]
  let operations: Observation[]
  let product: LocalProduct
  let shiftId: string
  let saleRequest: LocalFiscalSaleRequest
  let returnRequest: LocalFiscalReturnRequest
  let businessBefore: Record<string, unknown[]>
  let stockBefore: number
  let cashBefore: number
  let sendsBefore: number

  const receipt: CashalotRetVal = {
    Return: true, ReceiptFiscalNum: `${kind.toUpperCase()}-FISCAL-1`,
    FSKOReceiptLink: `https://example.invalid/${kind}-receipt`,
    Description: 'Synthetic confirmed receipt',
  }

  function database(): LocalDatabase {
    if (!db) throw new Error('Fixture database is not open')
    return db
  }

  function observe(promise: Promise<LocalFiscalSaleIntentResult>): Observation {
    const observation: Observation = { settlements: 0, done: Promise.resolve() }
    observation.done = promise.then(value => {
      observation.settlements++
      observation.value = value
    }, error => {
      observation.settlements++
      observation.error = error instanceof Error ? error.message : String(error)
    })
    operations.push(observation)
    return observation
  }

  async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(0) }

  function sends() {
    return workers.flatMap(worker => worker.requests.map(request => ({ worker, request })))
  }

  function snapshotBusiness(): Record<string, unknown[]> {
    // Include every business/metadata table, including stock, cash, audit and
    // outbox; only the intentional fiscal-intent state changes are excluded.
    return database().readSnapshot(() => {
      const tables = database().prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'fiscal_sale_intents'
        ORDER BY name`).all() as Array<{ name: string }>
      return Object.fromEntries(tables.map(({ name }) => {
        const rows = database().prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()
        return [name, rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]
      }))
    })
  }

  function createService(): CashalotService {
    const next = new CashalotService(fiscalRoot)
    services.push(next)
    return next
  }

  function makeSaleRequest(operationId: string): LocalFiscalSaleRequest {
    return {
      operation_id: operationId,
      checkout: {
        tenant_id: DEFAULT_TENANT_ID, client_operation_id: operationId,
        cashier_id: CASHIER, shift_id: shiftId,
        items: [{ product_id: product.id, qty: 1 }],
        payments: [{ method: 'cash', amount: PRICE, is_fiscal: true, fiscal_number: null }],
        is_fiscal: true, fiscal_number: null, fiscal_qr_url: null,
      },
      items: [{ name: product.name, vendor_code: product.sku, barcode: product.barcode,
        unit: product.unit, qty: 1, unit_price: PRICE, amount: PRICE, discount: 0 }],
      pay: { cash: PRICE, card: 0, bank: 0, check_total: PRICE },
    }
  }

  async function completeSale(request: LocalFiscalSaleRequest): Promise<LocalFiscalSaleIntentResult> {
    const intent = await fiscalizeSale(pos, getCashalot, request)
    if (intent.state === 'completed') return intent
    // Production deliberately has two commands for a sale: fiscalize-sale,
    // then pos:checkout with the confirmed receipt. Do not merge their logic.
    const result = intent.fiscal_result!
    const fiscalNumber = (typeof result.ReceiptFiscalNum === 'string' ? result.ReceiptFiscalNum.trim() : '')
      || (typeof result.ReceiptLocalNum === 'string' ? result.ReceiptLocalNum.trim() : '') || null
    const fiscalQrUrl = String(result.FSKOReceiptLink ?? result.CashalotReceiptLink ?? '').trim() || null
    pos.checkout({ ...request.checkout, fiscal_number: fiscalNumber, fiscal_qr_url: fiscalQrUrl,
      payments: request.checkout.payments.map(payment => ({ ...payment, fiscal_number: fiscalNumber })) })
    return pos.getFiscalSaleIntent(request.operation_id)
  }

  async function perform(fromStoredRequest = false): Promise<LocalFiscalSaleIntentResult> {
    if (kind === 'sale') return completeSale(saleRequest)
    const request = fromStoredRequest
      ? pos.getFiscalReturnRequest(OPERATION, { tenant_id: DEFAULT_TENANT_ID, cashier_id: CASHIER })
      : returnRequest
    return (await processFiscalReturn(pos, getCashalot, request)).intent
  }

  async function start() {
    const observation = observe(perform())
    await flush()
    expect(observation.settlements).toBe(0)
    expect(pos.getFiscalSaleIntent(OPERATION).state).toBe('fiscalizing')
    expect(sends()).toHaveLength(sendsBefore + 1)
    const sent = sends().at(-1)!
    expect(sent.request.method).toBe('call')
    expect(sent.request.comMethod).toBe(kind === 'sale' ? 'FiscalizeCheck' : 'FiscalizeReturnCheck')
    if (kind === 'return') expect(sent.request.args.at(-1)).toBe('SEED-FISCAL-1')
    expect(snapshotBusiness()).toEqual(businessBefore)
    return { observation, ...sent }
  }

  async function restart(): Promise<void> {
    service.stopWorker()
    await flush()
    const previous = database()
    const identity = previous.deviceId
    const databasePath = previous.databasePath
    previous.close()
    db = new LocalDatabase(root)
    // Do not pass a closed DatabaseSync wrapper to Vitest's object inspector.
    expect(db === previous).toBe(false)
    expect(db.databasePath).toBe(databasePath)
    expect(db.deviceId).toBe(identity)
    pos = new LocalPosRepository(db)
    catalog = new LocalCatalogRepository(db)
    service = createService()
  }

  async function expectBlockedWithoutResend(): Promise<void> {
    const before = sends().length
    getCashalot.mockImplementation(() => { throw new Error('Blocked/replayed intent must not look up Cashalot') })
    const retry = observe(perform(true))
    await flush()
    expect(retry.settlements).toBe(1)
    expect(retry.error).toMatch(new RegExp(`^FISCAL_INTENT_UNKNOWN\\|${OPERATION}\\|`))
    expect(sends()).toHaveLength(before)
    expect(snapshotBusiness()).toEqual(businessBefore)
  }

  function expectCompletedOnce(expectedReceipt: CashalotRetVal = receipt, expectedNumber = receipt.ReceiptFiscalNum): void {
    const table = kind === 'sale' ? 'sales' : 'customer_returns'
    const documents = database().prepare(`SELECT id, fiscal_number FROM ${table} WHERE client_operation_id = ?`)
      .all(OPERATION) as Array<{ id: string; fiscal_number: string }>
    expect(documents).toHaveLength(1)
    expect(documents[0].fiscal_number).toBe(expectedNumber)
    const id = documents[0].id
    const itemTable = kind === 'sale' ? 'sale_items' : 'customer_return_items'
    const itemColumn = kind === 'sale' ? 'sale_id' : 'return_id'
    expect(database().prepare(`SELECT COUNT(*) AS count FROM ${itemTable} WHERE ${itemColumn} = ?`).get(id))
      .toEqual({ count: 1 })
    expect(database().prepare(`SELECT qty_delta FROM inventory_movements WHERE source_type = ? AND source_id = ?`)
      .all(kind === 'sale' ? 'sale' : 'customer_return', id)).toEqual([{ qty_delta: kind === 'sale' ? -1 : 1 }])
    expect(database().prepare(`SELECT COUNT(*) AS count FROM sync_outbox WHERE aggregate_id = ? AND operation_type = ?`)
      .get(id, kind === 'sale' ? 'sale.completed' : 'return.created')).toEqual({ count: 1 })
    expect(catalog.findById(product.id)?.qty_on_hand).toBe(stockBefore + (kind === 'sale' ? -1 : 1))
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(cashBefore + (kind === 'sale' ? PRICE : -PRICE))
    expect(pos.getFiscalSaleIntent(OPERATION)).toMatchObject({ state: 'completed', fiscal_result: expectedReceipt })
    expect(sends()).toHaveLength(sendsBefore + 1)
  }

  beforeEach(async () => {
    vi.resetAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    services = []; workers = []; operations = []
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-fiscal-orchestration-'))
    fiscalRoot = path.join(root, 'synthetic-fiscal')
    fs.mkdirSync(fiscalRoot)
    const installation = path.join(fiscalRoot, 'synthetic-installation')
    fs.writeFileSync(path.join(fiscalRoot, 'fiscal.json'), JSON.stringify({
      enabled: true, cashalotDir: installation, fiscalNumberRRO: 'SYNTHETIC-RRO',
      certificateDir: null, encryptedKeyPassword: null,
    }), 'utf8')
    mocks.paths.cashalotSearchDirs.mockReturnValue([installation])
    mocks.paths.resolveCashalotDir.mockReturnValue(installation)
    mocks.paths.detectCashalotDir.mockReturnValue(installation)
    mocks.paths.hasCashalotDll.mockReturnValue(true)
    for (const mock of Object.values(mocks.storage)) {
      mock.mockImplementation(() => { throw new Error('Unexpected native Electron storage request') })
    }
    for (const [name, mock] of Object.entries(mocks.processes)) {
      mock.mockImplementation(() => { throw new Error(`Forbidden subprocess/COM/registry request: ${name}`) })
    }
    mocks.processes.spawn.mockImplementation((command: string, args: string[], options: unknown) => {
      expect(command).toBe('powershell.exe')
      expect(args[args.indexOf('-File') + 1]).toBe(path.join(fiscalRoot, 'cashalot-worker.ps1'))
      expect(options).toEqual({ windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    })
    // The service's CommonJS registry lookup must not bypass vi.mock.
    const native = createRequire(import.meta.url)('node:child_process') as
      Record<keyof typeof mocks.processes, (...args: any[]) => any>
    for (const name of Object.keys(mocks.processes) as Array<keyof typeof mocks.processes>) {
      vi.spyOn(native, name).mockImplementation(mocks.processes[name])
    }
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
    catalog = new LocalCatalogRepository(db)
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO staff_users (id, tenant_id, full_name, role, created_at, updated_at)
      VALUES (?, ?, ?, 'cashier', ?, ?)`).run(CASHIER, DEFAULT_TENANT_ID, 'Synthetic Cashier', now, now)
    product = catalog.upsertProduct({ id: 'fiscal-orchestration-product', sku: 'FISCAL-ONLY',
      name: 'Synthetic product', retail_price: PRICE, purchase_price: 900, qty_on_hand: 3 })
    shiftId = pos.openShift({ cashier_id: CASHIER, opening_cash: 10000 })
    service = createService()
    getCashalot = vi.fn(() => service)
    saleRequest = makeSaleRequest(kind === 'sale' ? OPERATION : 'fiscal-orchestration-seed-sale')
    if (kind === 'return') {
      // Seed the original receipt through the same real service/orchestrator,
      // not by manually marking its intent fiscalized.
      const seed = observe(completeSale(saleRequest))
      await flush()
      const sent = sends().at(-1)!
      sent.worker.respond(sent.request, { Return: true, ReceiptFiscalNum: 'SEED-FISCAL-1' })
      await flush()
      expect(seed.error).toBeUndefined()
      expect(seed.value?.state).toBe('completed')
      const sale = pos.getSaleForReturn(seed.value!.checkout_result!.sale_id)
      returnRequest = {
        operation_id: OPERATION, original_fiscal_number: 'SEED-FISCAL-1',
        return_input: { tenant_id: DEFAULT_TENANT_ID, sale_id: sale.sale.id, approved_by: CASHIER,
          shift_id: shiftId, reason: 'other', reason_note: 'Synthetic return', refund_method: 'cash',
          stock_action: 'return_to_stock', items: [{ sale_item_id: sale.items[0].id,
            product_id: product.id, quantity: 1, condition: 'good' }] },
        items: saleRequest.items, pay: saleRequest.pay,
      }
    }
    businessBefore = snapshotBusiness()
    stockBefore = Number(catalog.findById(product.id)!.qty_on_hand)
    cashBefore = pos.getExpectedCash(CASHIER)!.expected_amount
    sendsBefore = sends().length
  })

  afterEach(async () => {
    // RED assertions must not let queued work escape after process guards are
    // restored. Drain under the guards, then close SQLite before removing only
    // the exact disposable fixture root.
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        for (const subject of services ?? []) subject.stopWorker()
        await vi.runOnlyPendingTimersAsync()
      }
      await Promise.all((operations ?? []).map(operation => operation.done))
      for (const [name, mock] of Object.entries(mocks.processes)) {
        if (name !== 'spawn') expect(mock).not.toHaveBeenCalled()
      }
      for (const mock of Object.values(mocks.storage)) expect(mock).not.toHaveBeenCalled()
    } finally {
      db?.close()
      db = undefined
      vi.clearAllTimers()
      vi.useRealTimers()
      vi.restoreAllMocks()
      const resolved = path.resolve(root)
      if (root && path.dirname(resolved) === path.resolve(os.tmpdir())
        && path.basename(resolved).startsWith('forsage-fiscal-orchestration-')
        && fs.existsSync(resolved) && fs.realpathSync(resolved) === resolved) {
        fs.rmSync(resolved, { recursive: true, force: true })
      }
    }
  })

  it('commits once and replays the exact result before and after a genuine database reopen', async () => {
    const { observation, worker, request } = await start()
    getCashalot.mockImplementation(() => { throw new Error('In-flight/completed intent must not look up Cashalot') })
    const concurrent = observe(perform())
    await flush()
    expect(concurrent.settlements).toBe(1)
    expect(concurrent.error).toMatch(new RegExp(`^FISCAL_INTENT_UNKNOWN\\|${OPERATION}\\|`))
    expect(observation.settlements).toBe(0)
    expect(sends()).toHaveLength(sendsBefore + 1)
    expect(snapshotBusiness()).toEqual(businessBefore)
    worker.respond(request, receipt)
    await flush()
    expect(observation.error).toBeUndefined()
    expect(observation.value?.state).toBe('completed')
    expectCompletedOnce()
    const committed = snapshotBusiness()
    const completed = pos.getFiscalSaleIntent(OPERATION)
    getCashalot.mockImplementation(() => { throw new Error('Completed intent must not look up Cashalot') })
    for (const reopen of [false, true]) {
      if (reopen) await restart()
      const retry = observe(perform(true))
      await flush()
      expect(retry.error).toBeUndefined()
      expect(retry.value).toEqual(completed)
      expectCompletedOnce()
      expect(snapshotBusiness()).toEqual(committed)
    }
  })

  it('persists unknown after live transport failure and refuses retries across restart', async () => {
    const { observation, worker } = await start()
    expect(() => worker.stdin.emit('error', new Error('Synthetic transport failure'))).not.toThrow()
    await flush()
    expect(observation.error).toMatch(new RegExp(`^FISCAL_INTENT_UNKNOWN\\|${OPERATION}\\|`))
    expect(observation.error).toContain('FISCAL_CALL_FAILED')
    expect(pos.getFiscalSaleIntent(OPERATION)).toMatchObject({ state: 'unknown', fiscal_result: null })
    expect(() => service.updateConfig({ fiscalNumberRRO: 'MUST-NOT-SAVE' })).toThrow('FISCAL_CONFIG_BUSY')
    expect(worker.kill).not.toHaveBeenCalled()
    expect(worker.stdin.end).not.toHaveBeenCalled()
    await expectBlockedWithoutResend()
    await restart()
    expect(pos.getFiscalSaleIntent(OPERATION).state).toBe('unknown')
    await expectBlockedWithoutResend()
  })

  it.each([
    { label: 'empty object', result: {} },
    { label: 'null result', result: null },
    { label: 'omitted result', result: undefined },
    { label: 'array instead of a receipt', result: [] },
    { label: 'primitive instead of a receipt', result: 'not-a-receipt' },
    { label: 'success without a receipt identifier', result: { Return: true } },
    { label: 'blank receipt identifiers', result: { Return: true, ReceiptFiscalNum: '', ReceiptLocalNum: '   ' } },
    { label: 'receipt number without Return', result: { ReceiptFiscalNum: 'UNCONFIRMED-1' } },
    { label: 'receipt number with null Return', result: { Return: null, ReceiptFiscalNum: 'UNCONFIRMED-1' } },
    { label: 'receipt number with string Return', result: { Return: 'true', ReceiptFiscalNum: 'UNCONFIRMED-1' } },
    { label: 'receipt number with numeric Return', result: { Return: 1, ReceiptFiscalNum: 'UNCONFIRMED-1' } },
    { label: 'numeric fiscal number despite a valid local fallback',
      result: { Return: true, ReceiptFiscalNum: 12345, ReceiptLocalNum: 'LOCAL-1' } },
    { label: 'object local number despite a valid fiscal number',
      result: { Return: true, ReceiptFiscalNum: 'FISCAL-1', ReceiptLocalNum: { number: 'LOCAL-1' } } },
    { label: 'array fiscal number', result: { Return: true, ReceiptFiscalNum: ['FISCAL-1'] } },
    { label: 'boolean local number', result: { Return: true, ReceiptLocalNum: true } },
  ])('blocks $label without business effects or another send before/after restart', async ({ result }) => {
    const { observation, worker, request } = await start()
    worker.respond(request, result)
    await flush()
    expect(observation.settlements).toBe(1)
    expect(observation.error).toMatch(new RegExp(`^FISCAL_INTENT_UNKNOWN\\|${OPERATION}\\|`))
    expect(pos.getFiscalSaleIntent(OPERATION)).toMatchObject({
      state: 'unknown', fiscal_result: null, checkout_result: null,
    })
    expect(database().prepare('SELECT fiscal_number FROM fiscal_sale_intents WHERE operation_id = ?').get(OPERATION))
      .toEqual({ fiscal_number: null })
    expect(snapshotBusiness()).toEqual(businessBefore)
    expect(sends()).toHaveLength(sendsBefore + 1)
    await expectBlockedWithoutResend()
    await restart()
    expect(pos.getFiscalSaleIntent(OPERATION)).toMatchObject({ state: 'unknown', fiscal_result: null })
    await expectBlockedWithoutResend()
    expect(sends()).toHaveLength(sendsBefore + 1)
  })

  it('keeps an explicit Return=false rejection unknown even if receipt-like fields are present', async () => {
    const { observation, worker, request } = await start()
    worker.respond(request, { Return: false, Description: 'SYNTHETIC_FISCAL_REJECTED',
      ReceiptFiscalNum: 'MUST-NOT-BECOME-A-DOCUMENT', ReceiptLocalNum: 'MUST-NOT-BE-USED' })
    await flush()
    expect(observation.settlements).toBe(1)
    expect(observation.error).toMatch(new RegExp(`^FISCAL_INTENT_UNKNOWN\\|${OPERATION}\\|`))
    expect(observation.error).toContain('SYNTHETIC_FISCAL_REJECTED')
    expect(pos.getFiscalSaleIntent(OPERATION)).toMatchObject({
      state: 'unknown', fiscal_result: null, checkout_result: null,
    })
    expect(snapshotBusiness()).toEqual(businessBefore)
    await expectBlockedWithoutResend()
    await restart()
    await expectBlockedWithoutResend()
    expect(sends()).toHaveLength(sendsBefore + 1)
  })

  it.each([undefined, null, '', '  \t '])('accepts a confirmed local-only receipt when ReceiptFiscalNum is %s and replays it without resending', async fiscalNumber => {
    const localNumber = `${kind.toUpperCase()}-LOCAL-1`
    const localReceipt: CashalotRetVal = { Return: true, ReceiptLocalNum: `  ${localNumber}\t ` }
    const { observation, worker, request } = await start()
    worker.respond(request, { ...localReceipt, ReceiptFiscalNum: fiscalNumber })
    await flush()
    expect(observation.settlements).toBe(1)
    expect(observation.error).toBeUndefined()
    expectCompletedOnce({ Return: true }, localNumber)
    expect(String(pos.getFiscalSaleIntent(OPERATION).fiscal_result?.ReceiptLocalNum).trim()).toBe(localNumber)
    expect(database().prepare('SELECT fiscal_number FROM fiscal_sale_intents WHERE operation_id = ?').get(OPERATION))
      .toEqual({ fiscal_number: localNumber })
    const completed = pos.getFiscalSaleIntent(OPERATION)
    const committed = snapshotBusiness()
    getCashalot.mockImplementation(() => { throw new Error('Confirmed local receipt must not look up Cashalot') })
    for (const reopen of [false, true]) {
      if (reopen) await restart()
      const retry = observe(perform(true))
      await flush()
      expect(retry.settlements).toBe(1)
      expect(retry.error).toBeUndefined()
      expect(retry.value).toEqual(completed)
      expect(snapshotBusiness()).toEqual(committed)
      expectCompletedOnce({ Return: true }, localNumber)
    }
  })

  it('accepts a trimmed fiscal number with a null local number and persists the selected identity', async () => {
    const fiscalNumber = `${kind.toUpperCase()}-TRIMMED-FISCAL-1`
    const { observation, worker, request } = await start()
    worker.respond(request, { Return: true, ReceiptFiscalNum: `  ${fiscalNumber}\t `, ReceiptLocalNum: null })
    await flush()
    expect(observation.settlements).toBe(1)
    expect(observation.error).toBeUndefined()
    expectCompletedOnce({ Return: true }, fiscalNumber)
    expect(database().prepare('SELECT fiscal_number FROM fiscal_sale_intents WHERE operation_id = ?').get(OPERATION))
      .toEqual({ fiscal_number: fiscalNumber })
    const committed = snapshotBusiness()
    const completed = pos.getFiscalSaleIntent(OPERATION)
    await restart()
    getCashalot.mockImplementation(() => { throw new Error('Completed receipt must not look up Cashalot') })
    const retry = observe(perform(true))
    await flush()
    expect(retry.settlements).toBe(1)
    expect(retry.error).toBeUndefined()
    expect(retry.value).toEqual(completed)
    expect(snapshotBusiness()).toEqual(committed)
    expectCompletedOnce({ Return: true }, fiscalNumber)
  })

  it('keeps a timed-out intent unknown even when the worker later confirms fiscal success', async () => {
    const { observation, worker, request } = await start()
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS)
    expect(observation.settlements).toBe(1)
    expect(observation.error).toMatch(new RegExp(`^FISCAL_INTENT_UNKNOWN\\|${OPERATION}\\|`))
    expect(observation.error).toContain('FISCAL_CALL_TIMEOUT')
    expect(() => service.updateConfig({ fiscalNumberRRO: 'MUST-NOT-SAVE' })).toThrow('FISCAL_CONFIG_BUSY')
    const unknown = pos.getFiscalSaleIntent(OPERATION)
    expect(unknown.state).toBe('unknown')
    await expectBlockedWithoutResend()
    worker.respond(request, receipt)
    await flush()
    expect(observation.settlements).toBe(1)
    expect(pos.getFiscalSaleIntent(OPERATION)).toEqual(unknown)
    expect(worker.kill).not.toHaveBeenCalled()
    expect(worker.stdin.end).not.toHaveBeenCalled()
    await expectBlockedWithoutResend()
    await restart()
    expect(pos.getFiscalSaleIntent(OPERATION)).toEqual(unknown)
    await expectBlockedWithoutResend()
  })

  it.each([false, true])('blocks after fiscal success when saving its result fails (fallback update also fails: %s)', async doubleFailure => {
    database().exec(`CREATE TRIGGER fixture_result_failure BEFORE UPDATE OF state ON fiscal_sale_intents
      WHEN NEW.operation_id = '${OPERATION}' AND OLD.state = 'fiscalizing'
        AND NEW.state IN (${doubleFailure ? "'fiscalized', 'unknown'" : "'fiscalized'"})
      BEGIN SELECT RAISE(ABORT, 'synthetic fiscal result persistence failure'); END`)
    const { observation, worker, request } = await start()
    worker.respond(request, receipt)
    await flush()
    expect(observation.error).toMatch(new RegExp(`^FISCAL_INTENT_UNKNOWN\\|${OPERATION}\\|`))
    expect(observation.error).toContain('synthetic fiscal result persistence failure')
    expect(pos.getFiscalSaleIntent(OPERATION)).toMatchObject({
      state: doubleFailure ? 'fiscalizing' : 'unknown', fiscal_result: null, checkout_result: null,
    })
    expect(snapshotBusiness()).toEqual(businessBefore)
    await expectBlockedWithoutResend()
    // Remove the synthetic disk fault before the new process performs recovery.
    database().exec('DROP TRIGGER fixture_result_failure')
    await restart()
    expect(pos.getFiscalSaleIntent(OPERATION)).toMatchObject({ state: 'unknown', fiscal_result: null })
    await expectBlockedWithoutResend()
  })

  it('rolls back the final transaction but resumes the saved receipt locally after restart without another fiscal send', async () => {
    database().exec(`CREATE TRIGGER fixture_completion_failure BEFORE UPDATE OF state ON fiscal_sale_intents
      WHEN NEW.operation_id = '${OPERATION}' AND NEW.state = 'completed'
      BEGIN SELECT RAISE(ABORT, 'synthetic final transaction failure'); END`)
    const { observation, worker, request } = await start()
    worker.respond(request, receipt)
    await flush()
    expect(observation.error).toContain('synthetic final transaction failure')
    expect(observation.error).not.toContain('FISCAL_INTENT_UNKNOWN')
    expect(pos.getFiscalSaleIntent(OPERATION)).toMatchObject({ state: 'fiscalized', fiscal_result: receipt, checkout_result: null })
    expect(snapshotBusiness()).toEqual(businessBefore)
    database().exec('DROP TRIGGER fixture_completion_failure')
    await restart()
    expect(pos.getFiscalSaleIntent(OPERATION)).toMatchObject({ state: 'fiscalized', fiscal_result: receipt })
    getCashalot.mockImplementation(() => { throw new Error('Local recovery must not look up Cashalot') })
    const recovered = observe(perform(true))
    await flush()
    expect(recovered.error).toBeUndefined()
    expect(recovered.value?.state).toBe('completed')
    expectCompletedOnce()
    const committed = snapshotBusiness()
    const retry = observe(perform(true))
    await flush()
    expect(retry.value).toEqual(recovered.value)
    expect(snapshotBusiness()).toEqual(committed)
    expectCompletedOnce()
  })

  it('recovers an interrupted in-flight intent from disk as unknown without accepting an old worker response', async () => {
    const { observation, worker, request } = await start()
    const oldDatabase = database()
    const identity = oldDatabase.deviceId
    const databasePath = oldDatabase.databasePath
    // Closing before settling the synthetic worker models the durable crash
    // boundary: the old continuation cannot write its unknown fallback to disk.
    oldDatabase.close()
    service.stopWorker()
    await flush()
    expect(observation.error).toMatch(new RegExp(`^FISCAL_INTENT_UNKNOWN\\|${OPERATION}\\|`))
    db = new LocalDatabase(root)
    expect(db === oldDatabase).toBe(false)
    expect(db.databasePath).toBe(databasePath)
    expect(db.deviceId).toBe(identity)
    expect(db.prepare('SELECT state FROM fiscal_sale_intents WHERE operation_id = ?').get(OPERATION))
      .toEqual({ state: 'fiscalizing' })
    pos = new LocalPosRepository(db)
    catalog = new LocalCatalogRepository(db)
    service = createService()
    expect(pos.getFiscalSaleIntent(OPERATION)).toMatchObject({ state: 'unknown', fiscal_result: null })
    const recovered = pos.getFiscalSaleIntent(OPERATION)
    worker.respond(request, receipt)
    await flush()
    expect(pos.getFiscalSaleIntent(OPERATION)).toEqual(recovered)
    expect(observation.settlements).toBe(1)
    await expectBlockedWithoutResend()
  })
})
