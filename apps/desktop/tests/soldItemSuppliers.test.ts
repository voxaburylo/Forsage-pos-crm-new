import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { soldItemSuppliers } from '../src/repositories/pos/soldItemSuppliers'

describe('local sold-item supplier history', () => {
  it('deduplicates posted receipts and excludes drafts, cancellation, deleted and other-tenant links', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`
        CREATE TABLE suppliers (id TEXT, tenant_id TEXT, name TEXT, deleted_at TEXT);
        CREATE TABLE supply_invoices (id TEXT, tenant_id TEXT, supplier_id TEXT, status TEXT, deleted_at TEXT);
        CREATE TABLE supply_invoice_items (product_id TEXT, tenant_id TEXT, invoice_id TEXT, qty REAL, deleted_at TEXT);
        INSERT INTO suppliers VALUES ('a','ours','Автокомфорт',NULL),('b','ours','Інший',NULL),('gone','ours','Removed','deleted'),('alien','other','Other tenant',NULL);
        INSERT INTO supply_invoices VALUES ('a1','ours','a','posted',NULL),('a2','ours','a','posted',NULL),('b1','ours','b','posted',NULL),
          ('draft','ours','b','draft',NULL),('cancel','ours','b','cancelled',NULL),('deleted','ours','b','posted','gone'),
          ('gs','ours','gone','posted',NULL),('ts','ours','alien','posted',NULL),('ti','other','a','posted',NULL);
        INSERT INTO supply_invoice_items VALUES ('p1','ours','a1',5,NULL),('p1','ours','a2',2,NULL),('p1','ours','b1',3,NULL),
          ('bad','ours','draft',1,NULL),('bad','ours','cancel',1,NULL),('bad','ours','deleted',1,NULL),
          ('bad','ours','gs',1,NULL),('bad','ours','ts',1,NULL),('bad','ours','ti',1,NULL),('bad','other','a1',1,NULL),
          ('bad','ours','a1',1,'gone'),('bad','ours','a1',0,NULL);
      `)
      const before = db.prepare('SELECT * FROM supply_invoice_items').all()
      const result = soldItemSuppliers(db, 'ours', ['p1', 'bad', ...Array.from({ length: 320 }, (_, i) => 'missing' + i), 'p1'])
      expect(result.get('p1')).toEqual([{ id: 'a', name: 'Автокомфорт' }, { id: 'b', name: 'Інший' }])
      expect(result.has('bad')).toBe(false)
      expect(result.size).toBe(1)
      expect(soldItemSuppliers(db, 'ours', []).size).toBe(0)
      expect(db.prepare('SELECT * FROM supply_invoice_items').all()).toEqual(before)
    } finally { db.close() }
  })
})
