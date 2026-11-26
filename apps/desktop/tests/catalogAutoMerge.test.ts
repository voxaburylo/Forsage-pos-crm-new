import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import {
  AUTO_MERGE_EVERY_HOURS, AUTO_MERGE_MAX_CARDS, AUTO_MERGE_PER_RUN, AUTO_MERGE_REASON, autoMergePlan, autoMergeTarget, autoMergeVerdict,
  catalogAutoMergeTick, factoryBarcode, literalName, readAutoMergeState, type AutoMergeCard, type AutoMergeHost,
} from '../src/repositories/catalogAutoMerge'

/**
 * 26.11.2026, слово власника: «дублі зі стовідсотковою схожістю обʼєднувати автоматично… без блоку кнопок, хай працює
 * в автоматі, у фоні; відлагодь, щоб чітко працювало». Назви й картки в прикладах — справжні з копії бази.
 */
const card = (id: string, name: string, over: Partial<AutoMergeCard> = {}): AutoMergeCard =>
  ({ id, name, sku: id, barcode: null, additional_barcodes: [], unit: 'шт', brand_id: null, qty_on_hand: 0, purchase_price: 1000, retail_price: 3000, created_at: '2026-06-01T00:00:00Z', ...over })

describe('the strict rule: what the till may merge by itself', () => {
  it('a factory barcode is 8–14 digits and not the shop range starting with 2', () => {
    expect([factoryBarcode('4008321100955'), factoryBarcode('8711500482730'), factoryBarcode('0199442260')]).toEqual([true, true, true])
    expect([factoryBarcode('2000998832391'), factoryBarcode('20976378'), factoryBarcode(''), factoryBarcode(null), factoryBarcode('WA6684')]).toEqual([false, false, false, false, false])
  })

  it('the name must match letter for letter; only letter case and extra spaces are forgiven', () => {
    expect(literalName('Фільтр  масляний  CHAMPION class S ')).toBe(literalName('фільтр масляний champion CLASS s'))
    expect(literalName('Фільтр class S')).not.toBe(literalName('Фільтр cla'))
    // Пошук дублів вважає ці пари «точними» (номер моделі, синоніми), але це, найімовірніше, різні товари.
    expect(autoMergeVerdict([card('a', 'Ліхтар BL-511 Police', { retail_price: 13500 }), card('b', 'Ліхтарик BL-511', { retail_price: 29000 })])).toEqual({ ok: false, reason: 'Назви не збігаються буква в букву' })
    expect(autoMergeVerdict([card('a', 'Клеми акумулятора'), card('b', 'Клеми АКБ')])).toEqual({ ok: false, reason: 'Назви не збігаються буква в букву' })
  })

  it('same name, shop barcodes only: the higher prices win, the stock is summed, the better card stays', () => {
    const name = 'Запобіжники (плоскі євро 10А) MTA GE-10'
    const a = card('81076', name, { barcode: '2000998787967', qty_on_hand: 5, retail_price: 350, purchase_price: 130, created_at: '2026-05-22T10:00:00Z' })
    const b = card('88903', name, { barcode: '2000998700002', qty_on_hand: 2, retail_price: 400, purchase_price: 150, created_at: '2026-09-01T10:00:00Z' })
    expect(autoMergeVerdict([a, b])).toEqual({ ok: true, target_id: '81076', source_ids: ['88903'], retail_price: 400, purchase_price: 150, raise: true, quantity: 7 })
    expect(autoMergeVerdict([a, { ...b, retail_price: 350, purchase_price: 130 }])).toMatchObject({ ok: true, raise: false })
    // Головна картка: заводський штрихкод → справжній артикул → більший залишок → старша.
    expect(autoMergeTarget([card('shop', name, { barcode: '2000998830274', qty_on_hand: 9 }), card('factory', name, { barcode: '5906083972201' })]).id).toBe('factory')
    expect(autoMergeTarget([card('x', name, { sku: 'AUTO-7FA67C8B44544093BA1187D442F7105D', qty_on_hand: 9 }), card('y', name, { sku: 'bn-04412' })]).id).toBe('y')
    expect(autoMergeTarget([card('p', name, { qty_on_hand: 1 }), card('q', name, { qty_on_hand: 4 })]).id).toBe('q')
    expect(autoMergeTarget([card('new', name, { created_at: '2026-11-01T00:00:00Z' }), card('old', name, { created_at: '2026-05-01T00:00:00Z' })]).id).toBe('old')
  })

  it('refuses everything that is not 100%', () => {
    const a = card('a', 'Ремінь поліклиновий BOSCH 1987946251'), b = card('b', 'Ремінь поліклиновий BOSCH 1987946251')
    const cable = (id: string, barcode: string) => card(id, 'Кабель Baseus Type-C Glimmer Series Fast Charging Data Cable', { barcode })
    expect(autoMergeVerdict([cable('c1', '0199442260'), cable('c2', '6932172617967')])).toEqual({ ok: false, reason: 'Різні заводські штрихкоди' })
    expect(autoMergeVerdict([cable('c1', '6932172617967'), { ...cable('c2', '2000998700009'), additional_barcodes: ['6932172617967'] }])).toMatchObject({ ok: true })
    // Два заводські коди на ОДНІЙ картці (виробник змінив код) — не суперечність.
    expect(autoMergeVerdict([{ ...cable('c1', '6932172617967'), additional_barcodes: ['4820000000017'] }, cable('c2', '2000998700009')])).toMatchObject({ ok: true })
    expect(autoMergeVerdict([{ ...cable('c1', '6932172617967'), additional_barcodes: ['4820000000017'] }, cable('c2', '4820000000017'), cable('c3', '5901234123457')])).toEqual({ ok: false, reason: 'Різні заводські штрихкоди' })
    expect(autoMergeVerdict([{ ...a, retail_price: 13500 }, { ...b, retail_price: 29000 }])).toEqual({ ok: false, reason: 'Ціни карток відрізняються більш ніж на 30%' })
    expect(autoMergeVerdict([{ ...a, purchase_price: 1000 }, { ...b, purchase_price: 1301 }])).toMatchObject({ ok: false })
    expect(autoMergeVerdict([{ ...a, retail_price: 0 }, b])).toMatchObject({ ok: true, retail_price: 3000, raise: true })
    expect(autoMergeVerdict(Array.from({ length: AUTO_MERGE_MAX_CARDS + 1 }, (_, index) => card('m' + index, 'Однакова назва')))).toMatchObject({ ok: false })
    expect(autoMergeVerdict([a, { ...b, qty_on_hand: -1 }])).toEqual({ ok: false, reason: 'Відʼємний залишок' })
    expect(autoMergeVerdict([{ ...a, retail_price: 390, purchase_price: 300000 }, { ...b, retail_price: 390, purchase_price: 300000 }])).toEqual({ ok: false, reason: 'Ціна продажу вийшла б нижчою за закупку' })
    expect(autoMergeVerdict([a, { ...b, unit: 'компл' }])).toEqual({ ok: false, reason: 'Різні одиниці обліку' })
    expect(autoMergeVerdict([{ ...a, brand_id: 'bosch' }, { ...b, brand_id: 'gates' }])).toEqual({ ok: false, reason: 'Різні бренди в картках' })
    expect(autoMergeVerdict([a])).toMatchObject({ ok: false })
  })
})

describe('background merge on a real till database', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository
  const tenant = DEFAULT_TENANT_ID
  const owner = '00000000-0000-4000-8000-000000000101'
  let clock: Date
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-automerge-'))
    db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db)
    clock = new Date('2026-11-26T10:00:00Z')
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,phone,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(owner, tenant, 'Owner', 'owner', '+380670000000', '2026-10-13', '2026-10-13')
    serverAcceptedMergeBefore()
  })
  afterEach(() => { db.close(); if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-automerge-')) rmSync(root, { recursive: true, force: true }) })

  /** Доказ, що сервер уміє приймати обʼєднання: колись передане ручне обʼєднання з цієї каси. */
  function serverAcceptedMergeBefore() {
    db.prepare(`INSERT INTO sync_outbox(operation_id,tenant_id,device_id,aggregate_type,aggregate_id,operation_type,payload_json,status,created_at,synced_at)
      VALUES(?,?,?,'product',?,'product.catalog_cleanup','{}','synced',?,?)`).run(randomUUID(), tenant, db.deviceId, randomUUID(), '2026-10-13T10:00:00Z', '2026-10-13T10:00:05Z')
  }
  const product = (sku: string, name: string, over: Record<string, unknown> = {}) =>
    catalog.upsertProduct({ id: randomUUID(), sku, name, qty_on_hand: 0, purchase_price: 1000, retail_price: 3000, ...over } as never)
  const row = (id: string) => db.prepare('SELECT * FROM products WHERE id=?').get(id) as Record<string, any>
  const host = (over: Partial<AutoMergeHost> = {}): AutoMergeHost => ({ db, tenantId: tenant, readOpenReceipts: async () => [], backup: vi.fn(async () => 'backup'), busy: () => false, lock: vi.fn(), now: () => clock, pause: async () => undefined, ...over })
  const receiptWith = (productId: string) => [['forsage_pos_open_receipts_v2:user1', JSON.stringify({ tabs: [{ items: [{ productId }] }] })]]

  it('merges an exact pair: stock summed, higher prices kept, both barcodes and the old article still find the card, history untouched', async () => {
    const name = 'Запобіжники (плоскі євро 10А) MTA GE-10'
    const a = product('81076', name, { barcode: '2000998787967', qty_on_hand: 5, retail_price: 350, purchase_price: 130, notes: 'Полиця 3', specs: { amp: '10' } })
    const b = product('88903', name, { barcode: '5906083972201', qty_on_hand: 2, retail_price: 400, purchase_price: 150 })
    const lonely = product('L-1', 'Одна така картка', { qty_on_hand: 9 })
    const sales = db.prepare('SELECT COUNT(*) AS n FROM sale_items').get()
    const backup = vi.fn(async () => 'C:/backup.db'), lock = vi.fn()
    const outcome = await catalogAutoMergeTick(host({ backup, lock }))
    expect(outcome).toEqual({ status: 'ran', merged: 1, cards: 1, refused: {}, left: 0, finished: true })
    expect(backup).toHaveBeenCalledTimes(1)
    expect(lock.mock.calls.map(call => call[0])).toEqual([true, false])
    // Головна — із заводським штрихкодом (b); a — в архіві з посиланням на головну.
    expect(row(b.id)).toMatchObject({ qty_on_hand: 7, retail_price: 400, purchase_price: 150, deleted_at: null, is_active: 1 })
    expect(row(a.id).deleted_at).toBeTruthy()
    expect(JSON.parse(row(a.id).specs_json).merged_into_product_id).toBe(b.id)
    expect(catalog.findByBarcode('2000998787967', tenant)?.id).toBe(b.id)
    expect(catalog.findByBarcode('5906083972201', tenant)?.id).toBe(b.id)
    expect((db.prepare("SELECT alias FROM product_aliases WHERE product_id=? AND deleted_at IS NULL ORDER BY alias").all(b.id) as Array<{ alias: string }>).map(item => item.alias)).toContain('81076')
    expect(row(lonely.id)).toMatchObject({ qty_on_hand: 9, deleted_at: null })
    expect(db.prepare('SELECT COUNT(*) AS n FROM sale_items').get()).toEqual(sales)
    // Журнал і черга на сервер: хто (власник), що (автоматичне правило), і обʼєднання піде на сервер.
    const audit = db.prepare("SELECT user_id,after_json FROM audit_log WHERE action='product.catalog_cleanup' ORDER BY sequence DESC LIMIT 1").get() as { user_id: string; after_json: string }
    expect(audit.user_id).toBe(owner)
    expect(JSON.parse(audit.after_json).reason).toBe(AUTO_MERGE_REASON)
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE operation_type='product.catalog_cleanup' AND status='pending'").get()).toEqual({ n: 1 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(readAutoMergeState(db)).toMatchObject({ finished_at: clock.toISOString(), attempted: [], last: { merged: 1, cards: 1 } })
    // Друге коло — не раніше ніж через добу.
    expect(await catalogAutoMergeTick(host())).toEqual({ status: 'not-due' })
    clock = new Date(clock.getTime() + AUTO_MERGE_EVERY_HOURS * 3_600_000)
    expect(await catalogAutoMergeTick(host())).toMatchObject({ status: 'ran', merged: 0, finished: true })
  })

  it('raising the price of the main card does not lose its other data', async () => {
    const name = 'Щуп веерный 17 лепестков 0,02-1,0мм YATO'
    const main = product('88848', name, { barcode: '5906083972201', additional_barcodes: ['4820000000017'], retail_price: 14000, purchase_price: 10000, notes: 'Вітрина', photo_url: 'file:///photos/x.jpg', storage_bin: 'A-3', specs: { leaves: '17' } })
    product('88429', name, { barcode: '2000998830274', retail_price: 17000, purchase_price: 12000 })
    expect(await catalogAutoMergeTick(host())).toMatchObject({ status: 'ran', merged: 1 })
    const saved = row(main.id)
    expect(saved).toMatchObject({ retail_price: 17000, purchase_price: 12000, notes: 'Вітрина', photo_url: 'file:///photos/x.jpg', storage_bin: 'A-3', sku: '88848', barcode: '5906083972201' })
    expect(JSON.parse(saved.specs_json).leaves).toBe('17')
    for (const code of ['5906083972201', '4820000000017', '2000998830274']) expect(catalog.findByBarcode(code, tenant)?.id, code).toBe(main.id)
  })

  it('a card that sits in an open receipt is not merged and not repriced; the others are', async () => {
    const busy = product('B-1', 'Жиклер омывателя веерный', { qty_on_hand: 1, retail_price: 3000 })
    const busyTwin = product('B-2', 'Жиклер омывателя веерный', { retail_price: 3300 })
    const free = product('F-1', 'Аптечка Мицар'), freeTwin = product('F-2', 'Аптечка Мицар')
    const outcome = await catalogAutoMergeTick(host({ readOpenReceipts: async () => receiptWith(busyTwin.id) }))
    expect(outcome).toMatchObject({ status: 'ran', merged: 1, cards: 1, finished: true })
    expect((outcome as { refused: Record<string, number> }).refused).toEqual({ 'Товар є у відкритому чеку. Завершіть або очистіть цей чек перед злиттям.': 1 })
    expect(row(busy.id)).toMatchObject({ deleted_at: null, retail_price: 3000, qty_on_hand: 1 })
    expect(row(busyTwin.id)).toMatchObject({ deleted_at: null, retail_price: 3300 })
    expect([row(free.id).deleted_at, row(freeTwin.id).deleted_at].filter(Boolean)).toHaveLength(1)
  })

  it('without a window (open receipts cannot be checked) nothing is merged and the attempt is repeated later', async () => {
    const a = product('N-1', 'Гофра глушителя 50 x 200 мм'), b = product('N-2', 'Гофра глушителя 50 x 200 мм')
    const backup = vi.fn(async () => 'x')
    expect(await catalogAutoMergeTick(host({ readOpenReceipts: async () => null, backup }))).toEqual({ status: 'no-window' })
    expect(backup).not.toHaveBeenCalled()
    expect([row(a.id).deleted_at, row(b.id).deleted_at]).toEqual([null, null])
    expect(readAutoMergeState(db).finished_at).toBeNull()
    expect(await catalogAutoMergeTick(host())).toMatchObject({ status: 'ran', merged: 1 })
  })

  it('does nothing while maintenance or a manual merge runs, when the server never accepted a merge, or without an owner', async () => {
    const a = product('S-1', 'Хомут 10-16 Winso'), b = product('S-2', 'Хомут 10-16 Winso')
    expect(await catalogAutoMergeTick(host({ busy: () => true }))).toEqual({ status: 'busy' })
    db.prepare("DELETE FROM sync_outbox WHERE operation_type='product.catalog_cleanup'").run()
    expect(await catalogAutoMergeTick(host())).toEqual({ status: 'server-unproven' })
    expect(readAutoMergeState(db).last?.note).toContain('спершу обʼєднайте одну пару вручну')
    clock = new Date(clock.getTime() + AUTO_MERGE_EVERY_HOURS * 3_600_000)
    serverAcceptedMergeBefore()
    db.prepare("UPDATE staff_users SET is_active=0 WHERE role='owner'").run()
    expect(await catalogAutoMergeTick(host())).toEqual({ status: 'no-owner' })
    expect([row(a.id).deleted_at, row(b.id).deleted_at]).toEqual([null, null])
  })

  it('works in portions so the till never freezes: the rest continues on the next tick, then the circle is finished', async () => {
    const groups = AUTO_MERGE_PER_RUN + 2
    // Внутрішні числові артикули, як у справжніх дублів (81076 / 88903).
    for (let index = 0; index < groups; index++) { product(String(81000 + index), 'Точний дубль номер ' + index, { qty_on_hand: 1 }); product(String(88000 + index), 'Точний дубль номер ' + index) }
    const active = () => (db.prepare('SELECT COUNT(*) AS n FROM products WHERE deleted_at IS NULL').get() as { n: number }).n
    const pause = vi.fn(async () => undefined)
    expect(await catalogAutoMergeTick(host({ pause }))).toEqual({ status: 'ran', merged: AUTO_MERGE_PER_RUN, cards: AUTO_MERGE_PER_RUN, refused: {}, left: 2, finished: false })
    expect(pause).toHaveBeenCalledTimes(AUTO_MERGE_PER_RUN)
    expect(active()).toBe(groups * 2 - AUTO_MERGE_PER_RUN)
    expect(readAutoMergeState(db).finished_at).toBeNull()
    expect(await catalogAutoMergeTick(host())).toEqual({ status: 'ran', merged: 2, cards: 2, refused: {}, left: 0, finished: true })
    expect(active()).toBe(groups)
    expect((db.prepare('SELECT ROUND(SUM(qty_on_hand),3) AS q FROM products WHERE deleted_at IS NULL').get() as { q: number }).q).toBe(groups)
  })

  it('same name but different lettered maker articles: the till itself refuses — these are different goods', async () => {
    const a = product('CSW-2302M', 'Комплект проводів запалювання'), b = product('CSW-2601MT', 'Комплект проводів запалювання')
    const outcome = await catalogAutoMergeTick(host())
    expect(outcome).toMatchObject({ status: 'ran', merged: 0, finished: true })
    expect(Object.keys((outcome as { refused: Record<string, number> }).refused)).toEqual(['Немає достатніх ознак тотожності'])
    expect([row(a.id).deleted_at, row(b.id).deleted_at]).toEqual([null, null])
  })

  it('the plan reads identical names straight from the cards and says why the rest waits for a person', () => {
    product('1', 'Лампа W16W', { barcode: '4008321100955' }); product('2', 'Лампа W16W', { barcode: '8711500482730' })
    product('3', 'Огнетушитель 2л', { retail_price: 86000, purchase_price: 66000 }); product('4', 'Огнетушитель 2л', { retail_price: 60000, purchase_price: 46000 })
    product('5', 'Аптечка'); product('6', 'аптечка ')
    const plan = autoMergePlan(db, tenant)
    expect(plan.same_name_groups).toBe(3)
    expect(plan.rows.map(item => item.name.trim().toLowerCase())).toEqual(['аптечка'])
    expect(plan.skipped).toEqual({ 'Різні заводські штрихкоди': 1, 'Ціни карток відрізняються більш ніж на 30%': 1 })
  })
})

describe('wiring: the main PC runs it by itself, the screen has no extra buttons', () => {
  it('main process starts the background merge on the main till only and never during maintenance or a manual merge', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(main).toContain('if (!db || !isMainTill() || databaseMaintenance || cleanupMutationInProgress) return')
    expect(main).toContain('setInterval(autoMergeDuplicates, 30 * 60_000).unref()')
    expect(main).toContain('lock: on => { cleanupMutationInProgress = on }')
    expect(main).toContain('if (!window || window.isDestroyed() || window.webContents.isLoading()) return null')
  })
})
