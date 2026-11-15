import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { CatalogCleanupRepository } from '../src/repositories/catalogCleanupRepository'
import { CatalogTidyRepository, TIDY_STEPS, type TidyStep } from '../src/repositories/catalogTidyRepository'
import {
  isGarbageName, learnCategoryRules, looksLikeLostThousands, nameKey, needsRounding, roundRetailUp, tidyName,
} from '../src/repositories/catalogTidyRules'

/** Рішення власника 15.11.2026 про наведення порядку в каталозі. */
describe('tidy rules agreed with the owner', () => {
  it('rounds prices with kopecks up to 5 UAH, and cheap items only to a whole hryvnia', () => {
    expect(roundRetailUp(61230)).toBe(61500)
    expect(roundRetailUp(60129)).toBe(60500)
    expect(roundRetailUp(61500)).toBe(61500)
    expect(roundRetailUp(150)).toBe(200)
    expect(roundRetailUp(999)).toBe(1000)
    expect(roundRetailUp(1001)).toBe(1500)
    expect(roundRetailUp(0)).toBe(0)
    // Лише вгору: округлена ціна ніколи не менша за початкову.
    for (const price of [1, 99, 101, 1234, 23979, 999999]) expect(roundRetailUp(price)).toBeGreaterThanOrEqual(price)
  })

  it('leaves whole prices and “lost thousands” alone', () => {
    expect(needsRounding(61230, 47100)).toBe(true)
    expect(needsRounding(61300, 47100)).toBe(false)
    expect(needsRounding(0, 47100)).toBe(false)
    // 1,09 грн при закупівлі 905 грн: власник перевіряє такі ціни сам.
    expect(looksLikeLostThousands(109, 90500)).toBe(true)
    expect(needsRounding(109, 90500)).toBe(false)
    expect(looksLikeLostThousands(109, 5000)).toBe(false)
    expect(needsRounding(150, 100)).toBe(true)
  })

  it('removes only stray whitespace from names and recognises garbage names', () => {
    expect(tidyName('  Пильник ШРКШ гумовий  змазка \t MITSUBISHI\n')).toBe('Пильник ШРКШ гумовий змазка MITSUBISHI')
    expect(tidyName('Олива Mannol 5W30')).toBe('Олива Mannol 5W30')
    for (const name of ['1', ' 1 ', '---', 'L201BA', 'HSC/KBC', 'ab']) expect(isGarbageName(name)).toBe(true)
    for (const name of ['шприц', 'Наклейка', 'Фільтр WIX WA6684', 'Брелок']) expect(isGarbageName(name)).toBe(false)
  })

  it('learns categories from cards the owner already sorted and refuses weak evidence', () => {
    const sorted = [
      ...Array.from({ length: 9 }, (_, i) => ({ name: `Фильтр масляный WIX WL70${i}`, category_id: 'filters' })),
      { name: 'Фільтр масляний ключ знімач', category_id: 'tools' },
      ...Array.from({ length: 5 }, (_, i) => ({ name: `Лампа H${i} Osram`, category_id: 'lamps' })),
      ...Array.from({ length: 6 }, (_, i) => ({ name: `Ремень ГРМ Gates ${i}`, category_id: 'belts' })),
      ...Array.from({ length: 6 }, (_, i) => ({ name: `Ремень генератора ${i}`, category_id: 'generator' })),
    ]
    const suggest = learnCategoryRules(sorted)
    expect(nameKey('Фильтр масляный WIX', 2)).toBe('фільтр масляний')
    expect(suggest('Фільтр масляний MAHLE OC264')).toMatchObject({ category_id: 'filters', samples: 10 })
    // П'ять прикладів — мало; «ремінь» розкидано по двох категоріях — неоднозначно.
    expect(suggest('Лампа H7 Philips')).toBeNull()
    expect(suggest('Ремень поликлиновой')).toBeNull()
    expect(suggest('Невідомий товар')).toBeNull()
  })
})

describe('tidy steps on an isolated database', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository, tidy: CatalogTidyRepository
  const owner = '00000000-0000-4000-8000-000000000201', cashier = '00000000-0000-4000-8000-000000000202'
  const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
  const row = (productId: string) => db.prepare('SELECT * FROM products WHERE id=?').get(productId) as any
  const stock = () => (db.prepare('SELECT SUM(qty_on_hand) q FROM products WHERE deleted_at IS NULL').get() as any).q
  const outbox = (type: string) => (db.prepare("SELECT COUNT(*) n FROM sync_outbox WHERE operation_type=? AND status='pending'").get(type) as any).n
  const run = (step: TidyStep) => {
    const plan = tidy.plan(tenant).steps.find(item => item.step === step)!
    return tidy.apply({ tenant_id: tenant, step, operation_id: randomUUID(), fingerprint: plan.fingerprint }, owner)
  }
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-tidy-'))
    db = new LocalDatabase(root)
    const staff = db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,phone,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
    staff.run(owner, tenant, 'Owner', 'owner', '+380670000001', '2026-11-15', '2026-11-15')
    staff.run(cashier, tenant, 'Cashier', 'cashier', '+380670000002', '2026-11-15', '2026-11-15')
    catalog = new LocalCatalogRepository(db)
    tidy = new CatalogTidyRepository(db, new CatalogCleanupRepository(db, { canMirrorMerge: () => true, externalBlockers: () => [] }))
  })
  afterEach(() => { db.close(); if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-tidy-')) rmSync(root, { recursive: true, force: true }) })

  it('merges a duplicate whose second card has no stock (regression: -0 failed the write check)', () => {
    // Саме так виглядає більшість справжніх дублів: на одній картці залишок, на іншій — нуль.
    catalog.upsertProduct({ id: id(1), sku: 'KG0900132', name: 'Датчик давления масла Ланос KAP KG0900132', barcode: '2000000000101', qty_on_hand: 2, purchase_price: 10000, retail_price: 14000 })
    catalog.upsertProduct({ id: id(2), sku: 'AUTO-0002', name: 'Датчик давления масла Ланос KAP KG0900132', barcode: '2000000000102', qty_on_hand: 0, purchase_price: 12000, retail_price: 17000 })
    const cleanup = new CatalogCleanupRepository(db, { canMirrorMerge: () => true, externalBlockers: () => [] })
    const selection = { tenant_id: tenant, target_id: id(1), source_ids: [id(2)], stock_review: 'pending' as const }
    const preview = cleanup.preview(selection)
    expect(preview.can_apply).toBe(true)
    expect(() => cleanup.apply({ ...selection, operation_id: randomUUID(), preview_fingerprint: preview.fingerprint, reason: 'Той самий товар' }, owner)).not.toThrow()
    expect(row(id(1)).qty_on_hand).toBe(2)
    expect(row(id(2))).toMatchObject({ qty_on_hand: 0, is_active: 0 })
    const moves = db.prepare("SELECT qty_delta FROM inventory_movements WHERE source_type='product_merge' ORDER BY rowid").all() as any[]
    expect(moves.map(move => move.qty_delta)).toEqual([0, 0])
  })

  it('merges same-name duplicates only, keeps the higher prices and the summed stock', () => {
    catalog.upsertProduct({ id: id(1), sku: 'KG0900132', name: 'Датчик давления масла Ланос KAP KG0900132', barcode: '2000000000101', qty_on_hand: 2, purchase_price: 10000, retail_price: 14000 })
    catalog.upsertProduct({ id: id(2), sku: 'AUTO-0002', name: 'Датчик давления масла Ланос KAP KG0900132', barcode: '2000000000102', qty_on_hand: 3, purchase_price: 12000, retail_price: 17030 })
    // Спільний номер виробника, але назви різні — це лише для ручного перегляду.
    catalog.upsertProduct({ id: id(3), sku: 'WA6684', name: 'Фільтр повітряний OPEL VIVARO A', qty_on_hand: 1, purchase_price: 14200, retail_price: 27000 })
    catalog.upsertProduct({ id: id(4), sku: 'AUTO-0004', name: 'Воздушный фильтр WIX WA6684 Renault', qty_on_hand: 0, purchase_price: 14500, retail_price: 24000 })
    const plan = tidy.plan(tenant)
    expect(plan.steps.find(step => step.step === 'duplicates')?.count).toBe(1)
    expect(plan.info.manual_duplicate_groups).toBe(1)
    const before = stock()
    expect(run('duplicates')).toMatchObject({ changed: 1, skipped: [] })
    const kept = [row(id(1)), row(id(2))].find(card => !card.deleted_at && card.is_active === 1)
    // Більша ціна продажу з копійками одразу округлюється за тим самим правилом.
    expect(kept).toMatchObject({ qty_on_hand: 5, retail_price: 17500, purchase_price: 12000 })
    expect(stock()).toBe(before)
    expect(row(id(3)).is_active).toBe(1)
    expect(row(id(4)).is_active).toBe(1)
    expect(outbox('product.catalog_cleanup')).toBe(1)
    expect(tidy.plan(tenant).steps.find(step => step.step === 'duplicates')?.count).toBe(0)
  })

  it('reports a blocked merge instead of failing the whole step', () => {
    catalog.upsertProduct({ id: id(1), sku: 'A-1001', name: 'Термостат Fitshi 6833', qty_on_hand: 1, purchase_price: 100, retail_price: 20000 })
    catalog.upsertProduct({ id: id(2), sku: 'AUTO-2', name: 'Термостат Fitshi 6833', qty_on_hand: 1, purchase_price: 100, retail_price: 20000 })
    const guarded = new CatalogTidyRepository(db, new CatalogCleanupRepository(db, { canMirrorMerge: () => true, externalBlockers: () => ['Товар є у відкритому чеку'] }))
    const plan = guarded.plan(tenant).steps.find(step => step.step === 'duplicates')!
    const result = guarded.apply({ tenant_id: tenant, step: 'duplicates', operation_id: randomUUID(), fingerprint: plan.fingerprint }, owner)
    expect(result.changed).toBe(0)
    expect(result.skipped[0].reason).toContain('відкритому чеку')
    expect(row(id(1)).is_active).toBe(1)
    expect(row(id(2)).is_active).toBe(1)
  })

  it('copies an article from the name only into an empty article field', () => {
    catalog.upsertProduct({ id: id(1), sku: 'AUTO-0001', name: 'Термостат 2110 HT182 задняя часть', qty_on_hand: 1, purchase_price: 100, retail_price: 20000 })
    catalog.upsertProduct({ id: id(2), sku: 'MY-CODE', name: 'Подушка ДВЗ Лачетті KG0700541PH', qty_on_hand: 1, purchase_price: 100, retail_price: 20000 })
    expect(tidy.plan(tenant).steps.find(step => step.step === 'sku')?.count).toBe(1)
    expect(run('sku')).toMatchObject({ changed: 1, skipped: [] })
    expect(row(id(1)).sku).toBe('HT182')
    expect(row(id(2)).sku).toBe('MY-CODE')
  })

  it('rounds prices up without touching purchase prices, stock or “lost thousands”', () => {
    catalog.upsertProduct({ id: id(1), sku: 'P-1', name: 'Ремінь поліклиновий CONTITECH', qty_on_hand: 1, purchase_price: 47100, retail_price: 61230 })
    catalog.upsertProduct({ id: id(2), sku: 'P-2', name: 'Хомут пластиковий', qty_on_hand: 9, purchase_price: 100, retail_price: 150 })
    catalog.upsertProduct({ id: id(3), sku: 'P-3', name: 'Радиатор охлаждения 21082', qty_on_hand: 0, purchase_price: 90500, retail_price: 109 })
    catalog.upsertProduct({ id: id(4), sku: 'P-4', name: 'Свічка NGK', qty_on_hand: 4, purchase_price: 10000, retail_price: 14000 })
    const plan = tidy.plan(tenant)
    expect(plan.steps.find(step => step.step === 'prices')?.count).toBe(2)
    expect(plan.info.lost_thousands).toBe(1)
    const before = stock()
    expect(run('prices')).toMatchObject({ changed: 2, skipped: [] })
    expect(row(id(1))).toMatchObject({ retail_price: 61500, purchase_price: 47100, qty_on_hand: 1 })
    expect(row(id(2)).retail_price).toBe(200)
    expect(row(id(3)).retail_price).toBe(109)
    expect(row(id(4)).retail_price).toBe(14000)
    expect(stock()).toBe(before)
    // Зміна йде звичайним збереженням картки — отже, потрапить і на сервер.
    expect(outbox('product.upsert')).toBe(2)
    expect(tidy.plan(tenant).steps.find(step => step.step === 'prices')?.count).toBe(0)
  })

  it('trims names and deletes garbage cards only when nothing refers to them', () => {
    catalog.upsertProduct({ id: id(1), sku: 'N-1', name: '  Пильник ШРКШ  гумовий ', qty_on_hand: 1, purchase_price: 100, retail_price: 20000 })
    catalog.upsertProduct({ id: id(2), sku: 'N-2', name: '1', qty_on_hand: 0, purchase_price: 0, retail_price: 0 })
    catalog.upsertProduct({ id: id(3), sku: 'N-3', name: '1', qty_on_hand: 2, purchase_price: 0, retail_price: 0 })
    catalog.upsertProduct({ id: id(4), sku: 'N-4', name: 'L201BA', qty_on_hand: 0, purchase_price: 0, retail_price: 0 })
    db.prepare(`INSERT INTO inventory_movements(id,tenant_id,product_id,source_type,source_id,qty_delta,qty_after,unit_cost,notes,dirty_at,created_at,updated_at)
      VALUES(?,?,?,'adjustment',?,0,0,0,'history','2026-11-15','2026-11-15','2026-11-15')`).run(randomUUID(), tenant, id(4), id(4))
    const plan = tidy.plan(tenant)
    expect(plan.steps.find(step => step.step === 'names')?.count).toBe(1)
    expect(plan.steps.find(step => step.step === 'garbage')?.count).toBe(1)
    expect(plan.info.garbage_kept).toBe(2)
    run('names'); run('garbage')
    expect(row(id(1)).name).toBe('Пильник ШРКШ гумовий')
    expect(row(id(2)).deleted_at).not.toBeNull()
    // Залишок або запис у документах — картка лишається.
    expect(row(id(3)).deleted_at).toBeNull()
    expect(row(id(4)).deleted_at).toBeNull()
  })

  it('sorts uncategorized cards, merges a duplicate category and removes an empty one', () => {
    const filters = catalog.createCategory('Фильтра'), compressor = catalog.createCategory('Авто-компрессор')
    const empty = catalog.createCategory('Шины')
    // Програма не дає створити категорію з такою самою назвою, але в старих даних такі пари є.
    const twin = { id: id(900) }
    db.prepare('INSERT INTO categories(id,tenant_id,name,sort_order,created_at,updated_at) VALUES(?,?,?,0,?,?)').run(twin.id, tenant, 'Авто-Компрессор', '2026-11-15', '2026-11-15')
    for (let n = 1; n <= 9; n++) catalog.upsertProduct({ id: id(n), sku: 'F-' + n, name: `Фильтр масляный WIX WL70${n}`, category_id: filters.id, qty_on_hand: 1, purchase_price: 100, retail_price: 20000 })
    catalog.upsertProduct({ id: id(20), sku: 'C-1', name: 'Компрессор Vitol', category_id: compressor.id, qty_on_hand: 1, purchase_price: 100, retail_price: 20000 })
    catalog.upsertProduct({ id: id(21), sku: 'C-2', name: 'Компрессор Uragan', category_id: compressor.id, qty_on_hand: 1, purchase_price: 100, retail_price: 20000 })
    catalog.upsertProduct({ id: id(22), sku: 'C-3', name: 'Компрессор Elegant', category_id: twin.id, qty_on_hand: 1, purchase_price: 100, retail_price: 20000 })
    catalog.upsertProduct({ id: id(30), sku: 'U-1', name: 'Фільтр масляний MAHLE OC264', qty_on_hand: 1, purchase_price: 100, retail_price: 20000 })
    catalog.upsertProduct({ id: id(31), sku: 'U-2', name: 'Щось зовсім інше', qty_on_hand: 1, purchase_price: 100, retail_price: 20000 })
    const plan = tidy.plan(tenant)
    // 1 товар без категорії + 1 товар із дубля категорії + 2 категорії до прибирання.
    expect(plan.steps.find(step => step.step === 'categories')?.count).toBe(4)
    expect(plan.info.uncategorized_left).toBe(1)
    expect(run('categories')).toMatchObject({ changed: 4, skipped: [] })
    expect(row(id(30)).category_id).toBe(filters.id)
    expect(row(id(31)).category_id).toBeNull()
    expect(row(id(22)).category_id).toBe(compressor.id)
    const deleted = (categoryId: string) => (db.prepare('SELECT deleted_at FROM categories WHERE id=?').get(categoryId) as any).deleted_at
    expect(deleted(twin.id)).not.toBeNull()
    expect(deleted(empty.id)).not.toBeNull()
    expect(deleted(compressor.id)).toBeNull()
    expect(deleted(filters.id)).toBeNull()
  })

  it('refuses a stale list, a non-owner and malformed requests, and records each step in the audit log', () => {
    catalog.upsertProduct({ id: id(1), sku: 'P-1', name: 'Ремінь поліклиновий CONTITECH', qty_on_hand: 1, purchase_price: 47100, retail_price: 61230 })
    const plan = tidy.plan(tenant).steps.find(step => step.step === 'prices')!
    const input = { tenant_id: tenant, step: 'prices' as const, operation_id: randomUUID(), fingerprint: plan.fingerprint }
    expect(() => tidy.apply(input, cashier)).toThrow('лише власнику')
    expect(() => tidy.apply({ ...input, operation_id: 'x' }, owner)).toThrow('номер операції')
    expect(() => tidy.apply({ ...input, step: 'everything' as TidyStep }, owner)).toThrow('Невідомий крок')
    catalog.saveProduct({ id: id(1), sku: 'P-1', name: 'Ремінь поліклиновий CONTITECH', retail_price: 70010 })
    expect(() => tidy.apply(input, owner)).toThrow('Каталог змінився')
    expect(row(id(1)).retail_price).toBe(70010)
    expect(run('prices').changed).toBe(1)
    const audit = db.prepare("SELECT entity_id, user_id, after_json FROM audit_log WHERE action='catalog.tidy'").all() as any[]
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ entity_id: 'prices', user_id: owner })
    expect(JSON.parse(audit[0].after_json)).toMatchObject({ changed: 1, skipped: 0, total: 1 })
  })

  it('offers every step in a fixed order and does nothing on a clean catalog', () => {
    catalog.upsertProduct({ id: id(1), sku: 'OK-1', name: 'Свічка NGK BKR5ES-11', category_id: catalog.createCategory('Свічки').id, qty_on_hand: 1, purchase_price: 10000, retail_price: 14000 })
    const plan = tidy.plan(tenant)
    expect(plan.steps.map(step => step.step)).toEqual([...TIDY_STEPS])
    expect(plan.steps.every(step => step.count === 0 && /^[a-f0-9]{64}$/.test(step.fingerprint))).toBe(true)
    for (const step of TIDY_STEPS) expect(run(step)).toMatchObject({ changed: 0, skipped: [] })
    expect(outbox('product.upsert')).toBe(0)
  })
})
