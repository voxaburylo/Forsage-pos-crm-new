import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { commitReceiving, type ReceivingLine } from '../src/repositories/receivingCommit'
import { NEVER_SOLD_DAYS, NIGHTLY_CODES, runNightlyCheck } from '../src/diagnostics/nightlyCheck'

/**
 * 26.11.2026, аудит (слово власника: «щоб більше не було помилок у базі; іноді все одно якась дрібниця вилазить»).
 * Три види помилок у картках, які власник знаходив сам: ціна нижче закупки, картки-дублі з однаковою назвою,
 * товар, що приходить у чужу картку (антифриз → «Масло Промывочное»). Тепер їх знаходить нічна перевірка.
 */
describe('nightly check finds card mistakes before the owner does', () => {
  let root: string, db: LocalDatabase
  const tenant = DEFAULT_TENANT_ID
  const now = new Date('2026-11-26T03:10:00')
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-audit-')); db = new LocalDatabase(root) })
  afterEach(() => { db.close(); if (path.basename(root).startsWith('forsage-audit-')) rmSync(root, { recursive: true, force: true }) })

  function product(id: string, name: string, over: { buy?: number; sell?: number; qty?: number; service?: number; active?: number } = {}) {
    db.prepare(`INSERT INTO products(id,tenant_id,sku,name,purchase_price,retail_price,qty_on_hand,is_service,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, tenant, 'SKU-' + id, name, over.buy ?? 100, over.sell ?? 200, over.qty ?? 1, over.service ?? 0, over.active ?? 1, ago(100), ago(100))
  }
  function supply(productId: string, daysAgo: number) {
    const invoice = randomUUID()
    db.prepare(`INSERT INTO supply_invoices(id,tenant_id,status,total,created_at,updated_at) VALUES(?,?,?,?,?,?)`).run(invoice, tenant, 'posted', 100, ago(daysAgo), ago(daysAgo))
    db.prepare(`INSERT INTO supply_invoice_items(id,tenant_id,invoice_id,product_id,qty,purchase_price,total,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), tenant, invoice, productId, 1, 100, 100, ago(daysAgo), ago(daysAgo))
  }
  function sale(productId: string) {
    const id = randomUUID()
    const shift = randomUUID()
    db.prepare(`INSERT INTO shifts(id,tenant_id,cashier_id,status,opened_at,closed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(shift, tenant, 'cashier-1', 'closed', ago(6), ago(5), ago(6), ago(5))
    db.prepare(`INSERT INTO sales(id,tenant_id,sale_number,cashier_id,shift_id,status,total,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(id, tenant, 'T-' + id.slice(0, 8), 'cashier-1', shift, 'completed', 200, ago(5), ago(5))
    db.prepare(`INSERT INTO sale_items(id,tenant_id,sale_id,product_id,qty,unit_price,total,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), tenant, id, productId, 1, 200, 200, ago(5), ago(5))
  }
  const find = (code: string) => runNightlyCheck(db, { now: () => now }).findings.find(item => item.code === code)

  it('knows the three new checks, so a problem that is fixed closes itself in the log', () => {
    expect(NIGHTLY_CODES).toEqual(expect.arrayContaining(['nightly-price-below-cost', 'nightly-same-name-cards', 'nightly-supply-never-sold']))
  })

  it('price below purchase: only goods on the shelf, real cards, with money in the examples', () => {
    product('pack', 'Хомут пластиковий 100шт', { buy: 12740, sell: 500, qty: 1 })
    product('empty', 'Нема на полиці', { buy: 500, sell: 300, qty: 0 })
    product('noprice', 'Без ціни', { buy: 500, sell: 0, qty: 3 })
    product('service', 'Послуга', { buy: 500, sell: 300, qty: 1, service: 1 })
    product('ok', 'Нормальний', { buy: 100, sell: 150, qty: 2 })
    const finding = find('nightly-price-below-cost')!
    expect(finding.count).toBe(1)
    expect(finding.detail).toContain('Хомут пластиковий 100шт: закупка 127.40, продаж 5.00')
    expect(finding.detail).toContain('цін сама не змінює')
  })

  it('cards with exactly the same name are counted as groups, whatever the letter case', () => {
    product('a', 'Запобіжники MTA GE-10 slim', { qty: 5 }); product('b', 'запобіжники  mta ge-10 slim ', { qty: 2 }) // «s» і подвійний пробіл: назва не має псуватись
    product('c', 'Тормозная Жидкость BOSCH DOT 4 1L'); product('d', 'Тормозная Жидкость BOSCH DOT 4 1L'); product('e', 'Тормозная Жидкость BOSCH DOT 4 1L', { active: 0 })
    product('single', 'Одна така')
    const finding = find('nightly-same-name-cards')!
    expect(finding.count).toBe(2)
    expect(finding.detail).toContain('(2 картки)')
    expect(finding.detail).toContain('Очищенні номенклатури')
  })

  it('a card that keeps receiving goods but never sold a piece is reported; a selling card and a fresh one are not', () => {
    product('ghost', 'Масло Промывочное GNL Flush 4L', { qty: 44 })
    for (const days of [90, 60, 30, 7, 1]) supply('ghost', days)
    product('selling', 'Антифриз G12+ Вамп 1л', { qty: 23 })
    for (const days of [90, 60, 30]) supply('selling', days)
    sale('selling')
    product('fresh', 'Новинка', { qty: 9 })
    for (const days of [3, 2, 1]) supply('fresh', days) // три приходи за три дні — ще рано судити
    product('gone', 'Розпродано без чеків', { qty: 0 })
    for (const days of [90, 60, 30]) supply('gone', days)
    const finding = find('nightly-supply-never-sold')!
    expect(NEVER_SOLD_DAYS).toBe(21)
    expect(finding.count).toBe(1)
    expect(finding.detail).toContain('Масло Промывочное GNL Flush 4L: приходів 5, залишок 44')
    expect(finding.detail).toContain('чужий артикул постачальника')
  })
})

describe('receiving names the twin cards instead of a bare «choose manually»', () => {
  let root: string, db: LocalDatabase
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-audit-recv-')); db = new LocalDatabase(root) })
  afterEach(() => { db.close(); if (path.basename(root).startsWith('forsage-audit-recv-')) rmSync(root, { recursive: true, force: true }) })

  it('says which cards share the name: article, stock, price — and nothing is written', () => {
    const catalog = new LocalCatalogRepository(db), supply = new LocalSupplyRepository(db)
    const supplier = supply.saveSupplier({ name: 'Тестовий постачальник' }).id
    catalog.saveProduct({ id: randomUUID(), sku: '81076', name: 'Запобіжники (плоскі євро 10А) MTA GE-10', retail_price: 300, qty_on_hand: 5 })
    catalog.saveProduct({ id: randomUUID(), sku: '88903', name: 'Запобіжники (плоскі євро 10А) MTA GE-10', retail_price: 400, qty_on_hand: 0 })
    const line: ReceivingLine = { client_key: randomUUID(), product_name: 'Запобіжники (плоскі євро 10А) MTA GE-10', sku: '', qty: 10, purchase_price: 200, retail_price: 300, category_id: null }
    const before = db.prepare('SELECT COUNT(*) AS n FROM supply_invoices').get()
    let message = ''
    try { commitReceiving(db, { invoice_id: randomUUID(), operation_id: randomUUID(), supplier_id: supplier, items: [line], payments: [] }) } catch (error) { message = (error as Error).message }
    expect(message).toContain('RECEIVING_LINE:0:name-several-cards:')
    expect(message).toContain('арт. 81076 (залишок 5, 3.00 грн)')
    expect(message).toContain('арт. 88903 (залишок 0, 4.00 грн)')
    expect(message).toContain('Очищенні номенклатури')
    expect(db.prepare('SELECT COUNT(*) AS n FROM supply_invoices').get()).toEqual(before)
  })
})
