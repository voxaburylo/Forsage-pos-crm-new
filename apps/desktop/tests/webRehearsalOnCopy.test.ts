import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { decodeRpcValue, encodeRpcValue } from '../src/link/rpcCodec'
import { WEB_MONEY_CHANNELS, webRpcChannelAllowed } from '../src/lan/webRpcChannels'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'

/**
 * 23.11.2026, прохання власника перед роботою з товаром через веб: «щоб не було задвоєння, розбіжностей і працювало
 * безпечно — інвентаризація, поступлення товару». Репетиція на КОПІЇ справжньої бази (робоча не відкривається на
 * запис): кожна дія йде тим самим шляхом, що запит вебу — перевірка каналу й прав, кодування аргументів як у сервері
 * (JSON), розкодування на касі, той самий виклик бази, що в обробнику main.ts.
 *
 *   FORSAGE_REHEARSAL_DB=<тека з data/forsage.db, напр. %LOCALAPPDATA%\Forsage> pnpm --filter desktop exec vitest run tests/webRehearsalOnCopy.test.ts
 *
 * Без змінної — пропускається (у CI справжньої бази немає).
 */
const source = process.env.FORSAGE_REHEARSAL_DB
const sourceDb = source ? path.join(source, 'data', 'forsage.db') : ''
const run = source && existsSync(sourceDb) ? describe : describe.skip

/** Запит вебу: канал дозволений вебу й ролі, аргументи пройшли сервер (JSON) і касу (розкодування). */
function webCall<T>(channel: string, role: string, args: unknown[], handler: (...decoded: any[]) => T): T {
  if (!webRpcChannelAllowed(channel)) throw new Error('Ця дія доступна лише на самій касі')
  if (!isDesktopChannelAllowed(channel, role)) throw new Error('Недостатньо прав для цієї дії')
  const overServer = JSON.parse(JSON.stringify(encodeRpcValue(args)))
  const decoded = decodeRpcValue(overServer) as unknown[]
  const answer = handler(...decoded)
  return decodeRpcValue(JSON.parse(JSON.stringify(encodeRpcValue(answer ?? null)))) as T
}

run('web through the main PC on a copy of the real database', () => {
  let root = '', db: LocalDatabase, supply: LocalSupplyRepository, inventory: LocalInventoryRepository, orders: LocalOrderRepository
  let manager = '', owner = ''
  let products: Array<{ id: string; sku: string; name: string; qty_on_hand: number }> = []
  let supplierId = ''
  let foreignKeyProblemsBefore = 0
  const foreignKeyProblems = () => db.prepare('PRAGMA foreign_key_check').all().length
  const qty = (id: string) => Number((db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(id) as { qty_on_hand: number }).qty_on_hand)
  const count = (sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as { n: number }).n)

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-web-rehearsal-'))
    mkdirSync(path.join(root, 'data'), { recursive: true })
    copyFileSync(sourceDb, path.join(root, 'data', 'forsage.db'))
    for (const suffix of ['-wal', '-shm']) if (existsSync(sourceDb + suffix)) copyFileSync(sourceDb + suffix, path.join(root, 'data', 'forsage.db' + suffix))
    db = new LocalDatabase(root)
    supply = new LocalSupplyRepository(db); inventory = new LocalInventoryRepository(db); orders = new LocalOrderRepository(db)
    const staff = (role: string) => (db.prepare(`SELECT id FROM staff_users WHERE tenant_id = ? AND role = ? AND is_active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1`).get(tenant, role) as { id: string } | undefined)?.id ?? ''
    manager = staff('manager') || staff('admin') || staff('owner'); owner = staff('owner') || manager
    products = db.prepare(`SELECT id, sku, name, qty_on_hand FROM products WHERE tenant_id = ? AND deleted_at IS NULL AND is_active = 1
      AND COALESCE(is_service, 0) = 0 AND sku NOT LIKE 'POS-%' AND qty_on_hand BETWEEN 0 AND 50 ORDER BY sku LIMIT 2`).all(tenant) as typeof products
    foreignKeyProblemsBefore = foreignKeyProblems()
    supplierId = (db.prepare('SELECT id FROM suppliers WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name LIMIT 1').get(tenant) as { id: string }).id
  })
  afterAll(() => { db?.close(); if (root && path.dirname(root) === path.resolve(tmpdir())) rmSync(root, { recursive: true, force: true }) })

  it('the copy is a real shop database', () => {
    expect(count("SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL")).toBeGreaterThan(1000)
    expect(products).toHaveLength(2)
    expect(manager).not.toBe('')
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
  })

  it('receiving: a repeated create gives the same draft, posting adds stock exactly once, a second post is refused', () => {
    const [a, b] = products, before = { a: qty(a.id), b: qty(b.id) }
    const movementsBefore = count('SELECT COUNT(*) n FROM inventory_movements')
    const input = { id: randomUUID(), operation_id: randomUUID(), supplier_id: supplierId, invoice_number: 'REHEARSAL-' + Date.now(),
      paid_amount: 0, items: [{ id: randomUUID(), product_id: a.id, qty: 3, purchase_price: 1000 }, { id: randomUUID(), product_id: b.id, qty: 2, purchase_price: 2500 },
        { id: randomUUID(), product_id: a.id, qty: 1, purchase_price: 1000 }] }
    const created = webCall('desktop:supply:create-invoice', 'manager', [input], (body) => supply.createInvoice({ ...body, user_id: manager }))
    // Втрачена відповідь і повторне натискання — та сама чернетка, залишки не змінено.
    const again = webCall('desktop:supply:create-invoice', 'manager', [input], (body) => supply.createInvoice({ ...body, user_id: manager }))
    expect(again.id).toBe(created.id)
    expect({ a: qty(a.id), b: qty(b.id) }).toEqual(before)
    const current = supply.getInvoice(created.id)
    webCall('desktop:supply:post-invoice', 'manager', [created.id, { expected_revision: current.edit_revision }],
      (id, body) => supply.postInvoice(id, { ...body, user_id: manager }))
    expect(qty(a.id)).toBe(before.a + 4)
    expect(qty(b.id)).toBe(before.b + 2)
    expect(count('SELECT COUNT(*) n FROM inventory_movements')).toBe(movementsBefore + 3)
    // Друге «Провести» (повтор із вебу чи з каси одночасно) — відмова, залишки не подвоюються.
    expect(() => webCall('desktop:supply:post-invoice', 'manager', [created.id, { expected_revision: current.edit_revision }],
      (id, body) => supply.postInvoice(id, { ...body, user_id: manager }))).toThrow()
    expect(qty(a.id)).toBe(before.a + 4)
    expect(qty(b.id)).toBe(before.b + 2)
    expect(count("SELECT COUNT(*) n FROM sync_outbox WHERE aggregate_id = ? AND operation_type = 'supplier_invoice.posted'", created.id)).toBe(1)
  })

  it('receiving: an edit from a stale screen is refused instead of overwriting someone else', () => {
    const [a] = products
    const input = { id: randomUUID(), operation_id: randomUUID(), supplier_id: supplierId, invoice_number: 'REHEARSAL-STALE', paid_amount: 0,
      items: [{ id: randomUUID(), product_id: a.id, qty: 1, purchase_price: 1000 }] }
    const created = supply.createInvoice({ ...input, user_id: manager })
    const opened = supply.getInvoice(created.id)
    supply.updateInvoice(created.id, { items: [{ product_id: a.id, qty: 5, purchase_price: 1000 }], expected_revision: opened.edit_revision })
    expect(() => webCall('desktop:supply:update-invoice', 'manager', [created.id, { items: [{ product_id: a.id, qty: 9, purchase_price: 1000 }], expected_revision: opened.edit_revision }],
      (id, body) => supply.updateInvoice(id, body))).toThrow(/DOCUMENT_CONFLICT|змін/)
    expect(supply.getInvoice(created.id).items[0].qty).toBe(5)
  })

  it('inventory: completing sets the counted stock once; a repeated complete does not move stock again', () => {
    const [, b] = products
    const counted = qty(b.id) + 7
    const session = webCall('desktop:inventory:create-session', 'manager', [{ name: 'Репетиція ' + Date.now() }],
      (body) => inventory.createSession({ ...body, created_by: manager }))
    webCall('desktop:inventory:start-session', 'manager', [session.id, {}], (id, body) => inventory.startSession(id, { ...body, user_id: manager }))
    webCall('desktop:inventory:count', 'manager', [session.id, { product_id: b.id, qty: counted }], (id, body) => inventory.countProduct(id, { ...body, user_id: manager }))
    const data = inventory.getSessionData(session.id)
    const movementsBefore = count('SELECT COUNT(*) n FROM inventory_movements WHERE product_id = ?', b.id)
    const first = webCall('desktop:inventory:complete', 'manager', [session.id, { expected_revision: data.edit_revision }],
      (id, body) => inventory.complete(id, { ...body, user_id: manager }))
    expect(qty(b.id)).toBe(counted)
    const afterFirst = count('SELECT COUNT(*) n FROM inventory_movements WHERE product_id = ?', b.id)
    expect(afterFirst).toBe(movementsBefore + 1)
    const second = webCall('desktop:inventory:complete', 'manager', [session.id, { expected_revision: data.edit_revision }],
      (id, body) => inventory.complete(id, { ...body, user_id: manager }))
    expect(second).toEqual(first)
    expect(qty(b.id)).toBe(counted)
    expect(count('SELECT COUNT(*) n FROM inventory_movements WHERE product_id = ?', b.id)).toBe(afterFirst)
  })

  it('orders: the same save sent twice creates one order and one reserve', () => {
    const [a] = products
    const before = count('SELECT COUNT(*) n FROM customer_orders')
    const input = { operation_id: randomUUID(), status: 'new', items: [{ product_id: a.id, name: a.name, sku: a.sku, qty: 1, sell_price: 10000, buy_price: 5000, source_type: 'supplier', item_type: 'product' }] }
    const first = webCall('desktop:orders:save', 'manager', [input], (body) => orders.saveOrder({ ...body, manager_id: manager }))
    const second = webCall('desktop:orders:save', 'manager', [input], (body) => orders.saveOrder({ ...body, manager_id: manager }))
    expect(second.id).toBe(first.id)
    expect(count('SELECT COUNT(*) n FROM customer_orders')).toBe(before + 1)
  })

  it('money at the till never runs from the web, whatever the role', () => {
    for (const channel of WEB_MONEY_CHANNELS) for (const role of ['owner', 'admin', 'manager'])
      expect(() => webCall(channel, role, [], () => { throw new Error('must not run') })).toThrow('Ця дія доступна лише на самій касі')
    // Касир з вебу не працює взагалі (перевіряє executeWebRequest), а owner — лише в межах своїх прав каси.
    expect(owner).not.toBe('')
  })

  it('the copy is still consistent after the rehearsal', () => {
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    // Старі записи бази тут не оцінюємо — лише те, що репетиція не додала нових порушень зв'язків.
    expect(foreignKeyProblems()).toBe(foreignKeyProblemsBefore)
  })
})
