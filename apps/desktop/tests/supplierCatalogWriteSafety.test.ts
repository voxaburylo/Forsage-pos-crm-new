import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalSupplierCatalogRepository } from '../src/repositories/supplierCatalogRepository'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'

let root: string, db: LocalDatabase, repo: LocalSupplierCatalogRepository, item: any
const at = '2026-10-08T13:00:00.000Z'
const input = (fields: Record<string, unknown> = {}): any => ({
  source_row: 5, supplier_id: 'supplier', sku: 'NEW', name: 'New fixture',
  qty: '0.125', price_kopecks: 1234, ...fields,
})
const tables = ['supplier_price_items', 'supplier_price_imports', 'sync_outbox', 'products', 'suppliers', 'app_meta']
const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
const actions = ['create', 'update', 'delete', 'add', 'replace'] as const
type Action = typeof actions[number]
function act(action: Action) {
  if (action === 'create') return repo.create(input())
  if (action === 'update') return repo.update(item.id, input({ sku: 'OLD' }))
  if (action === 'delete') return repo.delete(item.id)
  return repo.importRows('fixture.xlsx', [input({ sku: action === 'add' ? 'OLD' : 'NEW' })],
    { mode: action, supplier_id: 'supplier' })
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-catalog-write-'))
  db = new LocalDatabase(root); repo = new LocalSupplierCatalogRepository(db)
  for (const id of ['supplier', 'other'])
    db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, tenant, id, at, at)
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,purchase_price,created_at,updated_at) VALUES(?,?,?,?,7,120,?,?)')
    .run('product', tenant, 'P', 'Stock fixture', at, at)
  repo.importRows('old.csv', [input({ sku: 'OLD', name: 'Old fixture', qty: '2' })], { supplier_id: 'supplier', mode: 'add' })
  item = repo.list({ supplier_id: 'supplier' }).data[0]
  repo.create(input({ supplier_id: 'other', sku: 'OTHER', name: 'Other scope' }))
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-catalog-write-'))
    rmSync(root, { recursive: true, force: true })
})

it.each([
  ['create', 'supplier_price_items', 6, 'Changed name'],
  ['create', 'supplier_price_items', 7, 1],
  ['create', 'supplier_price_items', 8, 99],
  ['create', 'supplier_price_items', 15, 'old-date'],
  ['add', 'supplier_price_imports', 6, 99],
  ['add', 'supplier_price_imports', 8, '[{"error":"changed"}]'],
  ['create', 'sync_outbox', 0, 'changed-operation'],
  ['create', 'sync_outbox', 6, '{}'],
] as const)('verifies stored values independently of row counts: %s %s parameter %s', (action, table, index, value) => {
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    if (!sql.includes('INSERT INTO ' + table)) return statement
    return new Proxy(statement, { get(target, key) {
      if (key === 'run') return (...args: any[]) => {
        const changed = [...args]; changed[index] = value
        return target.run(...changed)
      }
      const member = Reflect.get(target, key)
      return typeof member === 'function' ? member.bind(target) : member
    } })
  }) as typeof db.prepare
  rejected(action)
})
it('does not reread the product catalog or trust mutated storage when summing repeated rows', () => {
  const prepare = db.prepare.bind(db)
  let productReads = 0
  db.prepare = ((sql: string) => {
    if (/FROM products\s+WHERE tenant_id/.test(sql)) productReads++
    return prepare(sql)
  }) as typeof db.prepare
  repo.importRows('repeated.csv', Array.from({ length: 401 }, (_, i) => input({ source_row: i + 1, qty: '0.001' })),
    { mode: 'add', supplier_id: 'supplier' })
  expect(productReads).toBe(1)
  expect((prepare("SELECT qty FROM supplier_price_items WHERE sku='NEW'").get() as any).qty).toBe(0.401)
})
it('keeps identity indexes correct when consecutive repeated rows rename the same item', () => {
  repo.importRows('renamed.csv', [
    input({ sku: 'X', barcode: '999', name: 'First', qty: 1 }),
    input({ sku: 'Y', barcode: '999', name: 'Second', qty: 2 }),
    input({ sku: 'X', barcode: '888', name: 'First', qty: 3 }),
  ], { mode: 'replace', supplier_id: 'supplier' })
  const items = repo.list({ supplier_id: 'supplier' }).data
  expect(items).toHaveLength(2)
  expect(items.map(row => [row.sku, row.barcode, row.qty]).sort()).toEqual([['X', '888', '3'], ['Y', '999', '3']])
})

function rejected(action: Action) {
  const before = snapshot()
  expect(() => act(action)).toThrow()
  expect(snapshot()).toEqual(before)
}
it.each(actions)('rolls back %s when its queue insert is silently skipped', action => {
  db.exec("CREATE TRIGGER fault BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(IGNORE); END;")
  rejected(action)
})
it.each(actions)('rolls back %s when its item write is silently skipped', action => {
  const operation = action === 'create' || action === 'replace' ? 'INSERT' : 'UPDATE'
  db.exec('CREATE TRIGGER fault BEFORE ' + operation + ' ON supplier_price_items BEGIN SELECT RAISE(IGNORE); END;')
  rejected(action)
})
it.each(['add', 'replace'] as const)('rolls back %s when import history is silently skipped', action => {
  db.exec('CREATE TRIGGER fault BEFORE INSERT ON supplier_price_imports BEGIN SELECT RAISE(IGNORE); END;')
  rejected(action)
})
it('rolls back replacement if one old row is not retired', () => {
  db.exec('CREATE TRIGGER fault BEFORE UPDATE ON supplier_price_items WHEN NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(IGNORE); END;')
  rejected('replace')
})
it.each(['qty=900', 'price_kopecks=1', "name='Tampered'", "tenant_id='foreign'",
  "barcode='unexpected'", "search_text='hidden'", "created_at='old'", "matched_product_id='product'"])
('rejects changed stored item field %s after writing the queue', assignment => {
  db.exec('CREATE TRIGGER fault AFTER INSERT ON sync_outbox BEGIN UPDATE supplier_price_items SET ' + assignment + " WHERE sku='NEW'; END;")
  rejected('create')
})
it.each(["payload_json='{}'", "status='synced'", 'attempts=5', "device_id='other'", "created_at='old'", "operation_type='wrong'"])
('rejects changed queue field %s', assignment => {
  db.exec('CREATE TRIGGER fault AFTER INSERT ON sync_outbox BEGIN UPDATE sync_outbox SET ' + assignment + ' WHERE sequence=NEW.sequence; END;')
  rejected('update')
})
it.each(['total_rows=0', 'processed_rows=0', "status='failed'", "filename='other.csv'", "mode='replace'", "errors_json='[]'", "warehouse_name='wrong'"])
('rejects changed import history field %s', assignment => {
  // Even an extra same-value write is unexpected in this strictly local path.
  db.exec('CREATE TRIGGER fault AFTER INSERT ON sync_outbox BEGIN UPDATE supplier_price_imports SET ' + assignment + ' WHERE id=NEW.aggregate_id; END;')
  rejected('add')
})
it.each(actions)('keeps stock and other scopes intact on a hidden side effect during %s', action => {
  db.exec("CREATE TRIGGER fault AFTER INSERT ON sync_outbox BEGIN UPDATE products SET qty_on_hand=0 WHERE id='product'; UPDATE supplier_price_items SET qty=0 WHERE supplier_id='other'; END;")
  rejected(action)
})
it.each(actions)('keeps previous import/queue history intact during %s', action => {
  db.exec("CREATE TRIGGER fault AFTER INSERT ON sync_outbox BEGIN UPDATE supplier_price_imports SET filename='rewritten' WHERE id<>NEW.aggregate_id; UPDATE sync_outbox SET attempts=99 WHERE sequence<>NEW.sequence; END;")
  rejected(action)
})
it.each(['add', 'replace'] as const)('does not silently skip a conflicting %s row and save an incomplete list', mode => {
  const before = snapshot()
  expect(() => repo.importRows('conflict.csv', [
    input({ sku: 'A', name: 'A', barcode: '111' }),
    input({ sku: 'B', name: 'B', barcode: '222' }),
    input({ sku: 'A', name: 'C', barcode: '222', source_row: 9 }),
  ], { mode, supplier_id: 'supplier' })).toThrow(/9|різні|Дублікат/)
  expect(snapshot()).toEqual(before)
})
it.each(actions)('permits %s after a failed attempt and persists the complete result across restart', action => {
  const before = snapshot()
  db.exec('CREATE TRIGGER fault BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, \'Injected\'); END;')
  rejected(action)
  db.exec('DROP TRIGGER fault')
  act(action)
  const after = snapshot()
  expect(after.products).toEqual(before.products)
  expect(after.suppliers).toEqual(before.suppliers)
  expect(after.sync_outbox).toHaveLength((before.sync_outbox as any[]).length + 1)
  db.close(); db = new LocalDatabase(root); repo = new LocalSupplierCatalogRepository(db)
  expect(snapshot()).toEqual(after)
})
