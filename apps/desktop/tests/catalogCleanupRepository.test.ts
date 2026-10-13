import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { LocalWarehouseRepository } from '../src/repositories/warehouseRepository'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'
import { CatalogCleanupRepository } from '../src/repositories/catalogCleanupRepository'

describe('reviewed catalog cleanup (isolated SQLite only)', () => {
  let root: string, db: LocalDatabase, repo: CatalogCleanupRepository
  const owner = '00000000-0000-4000-8000-000000000101', target = '00000000-0000-4000-8000-000000000102', source = '00000000-0000-4000-8000-000000000103'
  const selection = () => ({ tenant_id: tenant, target_id: target, source_ids: [source], stock_review: 'pending' as const })
  const row = (id: string) => db.prepare('SELECT * FROM products WHERE id=?').get(id) as any
  const request = () => ({ ...selection(), operation_id: randomUUID(), preview_fingerprint: repo.preview(selection()).fingerprint, reason: 'Виріб, бренд і фасування перевірено' })
  const rows = (table: string) => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-cleanup-'))
    db = new LocalDatabase(root)
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,phone,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
      .run(owner, tenant, 'Owner', 'owner', '+380670000000', '2026-10-13', '2026-10-13')
    const catalog = new LocalCatalogRepository(db)
    catalog.upsertProduct({ id: target, sku: 'M-100', name: 'Олива Test 1л', barcode: '4820000000001', qty_on_hand: 2, purchase_price: 10000, retail_price: 15000 })
    catalog.upsertProduct({ id: source, sku: '(12)', name: 'Олива Test 1 л', barcode: '2000000000002', qty_on_hand: 3, purchase_price: 11000, retail_price: 16000, photo_url: 'file:///local/old-photo.jpg', notes: 'Source note' })
    repo = new CatalogCleanupRepository(db, { canMirrorMerge: () => true, externalBlockers: () => [] })
  })
  afterEach(() => { db.close(); if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-cleanup-')) rmSync(root, { recursive: true, force: true }) })

  it('keeps closed invoices and inventory history byte-for-byte; mirrors one tombstone-aware operation', () => {
    const supply = new LocalSupplyRepository(db)
    const supplier = supply.saveSupplier({ name: 'Supplier' })
    const invoice = supply.createInvoice({ supplier_id: supplier.id, items: [{ product_id: source, qty: 1, purchase_price: 11000 }], paid_amount: 0 })
    supply.postInvoice(invoice.id)
    const historical = ['supply_invoices', 'supply_invoice_items', 'supplier_payments', 'inventory_movements'].map(table => [table, rows(table)] as const)
    const input = request(), total = Number(row(target).qty_on_hand) + Number(row(source).qty_on_hand)
    expect(repo.preview(selection())).toMatchObject({ can_apply: true, quantity_after: total, stock_review: 'pending' })
    const result = repo.apply(input, owner)
    expect(result.quantity_after).toBe(total)
    for (const [table, old] of historical) {
      const after = rows(table)
      expect(after.filter((item: any) => table !== 'inventory_movements' || item.source_type !== 'product_merge')).toEqual(old)
    }
    expect(row(source)).toMatchObject({ qty_on_hand: 0, is_active: 0, photo_url: 'file:///local/old-photo.jpg' })
    expect(JSON.parse(row(source).specs_json).merged_into_product_id).toBe(target)
    expect(row(target)).toMatchObject({ qty_on_hand: total, purchase_price: 10000, retail_price: 15000 })
    expect(JSON.parse(row(target).specs_json).cleanup_sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: source, sku: '(12)', photo_url: 'file:///local/old-photo.jpg', notes: 'Source note' })]))
    expect(new LocalCatalogRepository(db).findByBarcode('2000000000002')?.id).toBe(target)
    const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type='product.catalog_cleanup'").all() as any[]
    expect(outbox).toHaveLength(1)
    const payload = JSON.parse(outbox[0].payload_json)
    expect(payload.products.find((p: any) => p.id === source)).toMatchObject({ is_active: false, qty_on_hand: 0, deleted_at: expect.any(String), specs: { merged_into_product_id: target, merge_operation_id: input.operation_id, cleanup_barcodes: ['2000000000002'] } })
    const after = rows('audit_log'), changes = db.prepare('SELECT total_changes() n').get()
    expect(repo.apply(input, owner)).toEqual(result)
    expect(rows('audit_log')).toEqual(after)
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(changes)
  })

  it('requires server capability, reviewed carts, owner and an unchanged preview', () => {
    expect(new CatalogCleanupRepository(db).preview(selection()).can_apply).toBe(false)
    const input = request()
    db.prepare('UPDATE products SET retail_price=17000 WHERE id=?').run(source)
    expect(() => repo.apply(input, owner)).toThrow(/змінил|перевірк/i)
    db.prepare("UPDATE staff_users SET role='cashier' WHERE id=?").run(owner)
    expect(() => repo.apply(request(), owner)).toThrow(/прав|власник|адмін/i)
    expect(row(source).deleted_at).toBeNull()
  })

  it('blocks open invoices, cart references and unknown future product references', () => {
    const input = request()
    db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)').run('pos-open-cart:other-user', JSON.stringify({ items: [{ productId: source }] }), '2026-10-13')
    expect(repo.preview(selection()).blockers.join(' ')).toMatch(/кошик|чек/i)
    expect(() => repo.apply(input, owner)).toThrow()
    db.prepare("DELETE FROM app_meta WHERE key='pos-open-cart:other-user'").run()
    db.exec('CREATE TABLE future_product_links(id TEXT,product_id TEXT)')
    db.prepare('INSERT INTO future_product_links VALUES(?,?)').run('new', source)
    expect(repo.preview(selection()).blockers.join(' ')).toMatch(/Невідоме посилання/)
    expect(row(source).deleted_at).toBeNull()
  })

  it('rejects third-party barcode conflicts without writes and binds retries to the same request', () => {
    new LocalCatalogRepository(db).upsertProduct({ id: 'third', sku: 'THIRD', name: 'Other' })
    db.prepare('UPDATE product_barcodes SET product_id=? WHERE barcode=?').run('third', '2000000000002')
    expect(repo.preview(selection()).blockers.join(' ')).toMatch(/штрихкод/i)
    const before = rows('products')
    expect(() => repo.apply(request(), owner)).toThrow()
    expect(rows('products')).toEqual(before)
    db.prepare('UPDATE product_barcodes SET product_id=? WHERE barcode=?').run(source, '2000000000002')
    const input = request(); repo.apply(input, owner)
    expect(() => repo.apply({ ...input, reason: 'changed' }, owner)).toThrow(/Повтор/)
  })

  it.each(['Олива Test 4л', 'Лампа H7 12V 55W'])('cannot bypass technical conflicts or absent identity evidence by calling IPC directly: %s', name => {
    db.prepare('UPDATE products SET name=? WHERE id=?').run(name, source)
    const preview = repo.preview(selection())
    expect(preview.can_apply).toBe(false)
    expect(() => repo.apply(request(), owner)).toThrow()
    expect(row(source).deleted_at).toBeNull()
  })

  it('shows fresh joined brand and alternate barcodes in the confirmation, and catches carts under unknown keys', () => {
    db.prepare('INSERT INTO brands(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('00000000-0000-4000-8000-000000000104', tenant, 'Test', '2026-10-13', '2026-10-13')
    db.prepare('UPDATE products SET brand_id=?').run('00000000-0000-4000-8000-000000000104')
    expect(repo.preview(selection()).products.find(p => p.id === source)).toMatchObject({ brand: 'Test', additional_barcodes: ['2000000000002'] })
    db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)').run('operator-session:other', JSON.stringify({ tabs: [{ items: [{ productId: source }] }] }), '2026-10-13')
    expect(repo.preview(selection()).can_apply).toBe(false)
  })

  it('applies a reviewed article once using actual nested SQLite transactions and never changes quantities', () => {
    const catalog = new LocalCatalogRepository(db)
    catalog.upsertProduct({ id: 'sku-card', sku: 'AUTO-1234', name: 'Фільтр WIX арт. WA9428', qty_on_hand: 7 })
    const proposal = repo.scan(tenant).sku_suggestions.find(p => p.product_id === 'sku-card')!
    const input = { tenant_id: tenant, operation_id: randomUUID(), product_id: 'sku-card', sku: 'WA9428', preview_fingerprint: proposal.preview_fingerprint, reason: 'Артикул явно в назві' }
    expect(repo.applySku(input, owner)).toEqual({ updated: 1 })
    expect(row('sku-card')).toMatchObject({ sku: 'WA9428', qty_on_hand: 7 })
    const after = rows('sync_outbox'), audit = rows('audit_log')
    expect(repo.applySku(input, owner)).toEqual({ updated: 1 })
    expect(rows('sync_outbox')).toEqual(after); expect(rows('audit_log')).toEqual(audit)
  })

  it.each(['draft-invoice', 'reserve', 'inventory', 'order'])('blocks active %s references even with explicit direct apply', kind => {
    if (kind === 'draft-invoice') new LocalSupplyRepository(db).createInvoice({ items: [{ product_id: source, qty: 1, purchase_price: 100 }] })
    if (kind === 'reserve') db.prepare('INSERT INTO stock_reserves(id,tenant_id,product_id,qty,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('reserve', tenant, source, 1, '2026-10-13', '2026-10-13')
    if (kind === 'inventory') {
      db.prepare('INSERT INTO inventory_sessions(id,tenant_id,session_name,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('inv', tenant, 'Inventory', 'in_progress', '2026-10-13', '2026-10-13')
      db.prepare('INSERT INTO inventory_items(id,tenant_id,session_id,product_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('inv-item', tenant, 'inv', source, '2026-10-13', '2026-10-13')
    }
    if (kind === 'order') {
      db.prepare('INSERT INTO customer_orders(id,tenant_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run('order', tenant, 'lead', '2026-10-13', '2026-10-13')
      db.prepare('INSERT INTO customer_order_items(id,tenant_id,order_id,product_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('order-item', tenant, 'order', source, 'Oil', '2026-10-13', '2026-10-13')
    }
    expect(repo.preview(selection()).can_apply).toBe(false)
    const before = rows('products')
    expect(() => repo.apply(request(), owner)).toThrow()
    expect(rows('products')).toEqual(before)
  })

  it('preserves merged tombstones when cancelling an old invoice or submitting stale stock inputs', () => {
    const supply = new LocalSupplyRepository(db), catalog = new LocalCatalogRepository(db)
    const invoice = supply.createInvoice({ items: [{ product_id: source, qty: 1, purchase_price: 11000 }] })
    supply.postInvoice(invoice.id)
    repo.apply(request(), owner)
    const before = rows('products'), invoices = rows('supply_invoices'), outbox = rows('sync_outbox')
    expect(() => supply.cancelInvoice(invoice.id, tenant, supply.getInvoice(invoice.id).edit_revision)).toThrow(/видалений|відсутній|об’єднано/)
    expect(() => supply.createInvoice({ items: [{ product_id: source, qty: 1, purchase_price: 100 }] })).toThrow(/не знайдено/)
    expect(() => new LocalWarehouseRepository(db).createWriteoff({ reason: 'other', items: [{ product_id: source, qty: 1 }] })).toThrow(/не знайдено/)
    expect(() => catalog.upsertProduct({ id: source, sku: '(12)', name: 'Oil restored', is_active: true })).toThrow()
    expect(rows('products')).toEqual(before); expect(rows('supply_invoices')).toEqual(invoices); expect(rows('sync_outbox')).toEqual(outbox)
    const inventory = new LocalInventoryRepository(db), session = inventory.createSession({ name: 'Count' })
    inventory.startSession(session.id)
    expect(() => inventory.countProduct(session.id, { product_id: source, qty: 5 })).toThrow(/не знайдено/)
    expect(row(source).qty_on_hand).toBe(0)
  })

  it.each(['quantity', 'outbox', 'receipt'])('rolls back all changes when a storage trigger corrupts %s during merge', kind => {
    if (kind === 'quantity') db.exec(`CREATE TRIGGER bad_cleanup_qty AFTER UPDATE ON products WHEN NEW.id='${target}' AND NEW.qty_on_hand=5 BEGIN UPDATE products SET qty_on_hand=99 WHERE id=NEW.id; END`)
    if (kind === 'outbox') db.exec("CREATE TRIGGER bad_cleanup_outbox AFTER INSERT ON sync_outbox WHEN NEW.operation_type='product.catalog_cleanup' BEGIN DELETE FROM sync_outbox WHERE operation_id=NEW.operation_id; END")
    if (kind === 'receipt') db.exec(`CREATE TRIGGER bad_cleanup_receipt AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:catalog-cleanup:%' BEGIN UPDATE products SET qty_on_hand=88 WHERE id='${target}'; END`)
    const before = rows('products'), codes = rows('product_barcodes'), outbox = rows('sync_outbox'), audit = rows('audit_log')
    expect(() => repo.apply(request(), owner)).toThrow()
    expect(rows('products')).toEqual(before); expect(rows('product_barcodes')).toEqual(codes)
    expect(rows('sync_outbox')).toEqual(outbox); expect(rows('audit_log')).toEqual(audit)
    expect(rows('inventory_movements').filter((r: any) => r.source_type === 'product_merge')).toHaveLength(0)
  })

  it('conserves fractional group stock, all photos and alias codes while preventing a subsequent hidden merge chain', () => {
    const second = '00000000-0000-4000-8000-000000000105'
    new LocalCatalogRepository(db).upsertProduct({ id: second, sku: 'AUTO-2', name: 'Олива Test 1л', qty_on_hand: 0.125, photo_url: 'file:///local/second.jpg' })
    const selected = { ...selection(), source_ids: [second, source], stock_review: 'checked' as const }
    const preview = repo.preview(selected)
    expect(preview.can_apply).toBe(true)
    repo.apply({ ...selected, operation_id: randomUUID(), preview_fingerprint: preview.fingerprint, reason: 'Групу перевірено' }, owner)
    expect(row(target).qty_on_hand).toBe(5.125)
    expect(row(source).qty_on_hand).toBe(0); expect(row(second).qty_on_hand).toBe(0)
    const movements = rows('inventory_movements').filter((r: any) => r.source_type === 'product_merge') as any[]
    expect(movements).toHaveLength(4); expect(movements.reduce((sum, r) => sum + r.qty_delta, 0)).toBe(0)
    expect(JSON.parse(row(target).specs_json).cleanup_sources.map((r: any) => r.photo_url).sort()).toEqual(['file:///local/old-photo.jpg', 'file:///local/second.jpg'])
    expect((rows('product_aliases') as any[]).filter(r => r.product_id === target).map(r => r.alias)).toEqual(expect.arrayContaining(['(12)', 'AUTO-2']))
    new LocalCatalogRepository(db).upsertProduct({ id: 'next-target', sku: 'AUTO-3', name: 'Олива Test 1л', qty_on_hand: 1 })
    expect(repo.preview({ ...selection(), target_id: 'next-target', source_ids: [target] }).blockers.join(' ')).toMatch(/попереднього злиття/)
  })

  it('rejects a changed historical line and a newly negative balance without changing any product', () => {
    const supply = new LocalSupplyRepository(db), invoice = supply.createInvoice({ items: [{ product_id: source, qty: 1, purchase_price: 11000 }] })
    supply.postInvoice(invoice.id)
    const input = request()
    db.prepare('UPDATE supply_invoice_items SET purchase_price=12000 WHERE invoice_id=?').run(invoice.id)
    expect(() => repo.apply(input, owner)).toThrow(/змінилися/)
    db.prepare('UPDATE products SET qty_on_hand=-1 WHERE id=?').run(source)
    expect(repo.preview(selection()).blockers.join(' ')).toMatch(/Від’ємний/)
    expect(row(source).deleted_at).toBeNull()
  })

  it.each(['manual', 'invented', 'archived-collision', 'stale'])('does not apply an unsafe article proposal: %s', kind => {
    const catalog = new LocalCatalogRepository(db)
    catalog.upsertProduct({ id: 'sku-card', sku: kind === 'manual' ? 'MANUAL-1' : 'AUTO-1234', name: 'Фільтр WIX арт. WA9428', qty_on_hand: 7 })
    const card = repo.scan(tenant).products.find(p => p.id === 'sku-card')!
    const input = { tenant_id: tenant, operation_id: randomUUID(), product_id: 'sku-card', sku: kind === 'invented' ? 'WA9999' : 'WA9428', preview_fingerprint: card.fingerprint, reason: 'Перевірка' }
    if (kind === 'archived-collision') {
      catalog.upsertProduct({ id: 'old-sku', sku: 'WA9428', name: 'Old archived filter' })
      db.prepare('UPDATE products SET deleted_at=?,is_active=0 WHERE id=?').run('2026-10-13', 'old-sku')
    }
    if (kind === 'stale') db.prepare('UPDATE products SET retail_price=3000 WHERE id=?').run('sku-card')
    const before = rows('products'), audit = rows('audit_log'), outbox = rows('sync_outbox')
    expect(() => repo.applySku(input, owner)).toThrow()
    expect(rows('products')).toEqual(before); expect(rows('audit_log')).toEqual(audit); expect(rows('sync_outbox')).toEqual(outbox)
  })

  it('finds both old names and formatted articles after merging and after editing the main card', () => {
    const catalog = new LocalCatalogRepository(db)
    db.prepare('UPDATE products SET name=?,sku=?,barcode=? WHERE id=?').run('Олива Test 1л ОРИГІНАЛ', 'WA-9428', row(target).barcode, source)
    repo.apply(request(), owner)
    const verify = () => {
      expect(catalog.listProducts({ query: 'оригінал' }).data.map(p => p.id)).toContain(target)
      expect(catalog.listProducts({ query: 'WA9428' }).data.map(p => p.id)).toContain(target)
      expect(catalog.findBySku('wa9428')?.id).toBe(target)
      expect(catalog.withSkuLookupIndex(tenant, () => catalog.findBySku('WA 9428'))?.id).toBe(target)
    }
    verify()
    catalog.saveProduct({ id: target, sku: 'M-100', name: 'Олива Test 1л нова назва' })
    verify()
    expect(row(source).qty_on_hand).toBe(0); expect(row(target).qty_on_hand).toBe(5)
  })

  it('blocks cross-number variants that would collide in the server normalized index', () => {
    db.prepare('INSERT INTO product_cross_numbers(id,tenant_id,product_id,cross_number,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('00000000-0000-4000-8000-000000000106', tenant, target, 'OE-123', 'Target', '2026-10-13', '2026-10-13')
    db.prepare('INSERT INTO product_cross_numbers(id,tenant_id,product_id,cross_number,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('00000000-0000-4000-8000-000000000107', tenant, source, 'OE123', 'Source', '2026-10-13', '2026-10-13')
    expect(repo.preview(selection()).blockers.join(' ')).toMatch(/крос|аналог/i)
    const before = rows('products'), cross = rows('product_cross_numbers')
    expect(() => repo.apply(request(), owner)).toThrow()
    expect(rows('products')).toEqual(before); expect(rows('product_cross_numbers')).toEqual(cross)
  })

  it.each(['empty-sku', 'long-alias', 'metadata-id', 'metadata-date', 'payload-size'])('preflights incompatible %s in preview before any mutation', kind => {
    if (kind === 'empty-sku') db.prepare('UPDATE products SET sku=? WHERE id=?').run('', source)
    if (kind === 'long-alias') db.prepare('UPDATE products SET name=? WHERE id=?').run(row(source).name + ' '.repeat(301), source)
    if (kind === 'metadata-id') db.prepare('UPDATE product_barcodes SET id=? WHERE product_id=?').run('legacy-id', source)
    if (kind === 'metadata-date') db.prepare('UPDATE product_barcodes SET created_at=? WHERE product_id=?').run('not-a-date', source)
    if (kind === 'payload-size') db.prepare('UPDATE products SET notes=? WHERE id=?').run('Ж'.repeat(400_000), source)
    const before = rows('products'), outbox = rows('sync_outbox'), aliases = rows('product_aliases')
    const preview = repo.preview(selection())
    expect(preview.can_apply).toBe(false)
    expect(preview.blockers.join(' ')).toMatch(/Артикул|300|ідентифікатор|дата|2 МБ/)
    expect(() => repo.apply(request(), owner)).toThrow()
    expect(rows('products')).toEqual(before); expect(rows('sync_outbox')).toEqual(outbox); expect(rows('product_aliases')).toEqual(aliases)
  })
})
