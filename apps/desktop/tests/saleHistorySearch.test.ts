import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'

let directory: string, db: LocalDatabase, pos: LocalPosRepository, shift: string
const at = '2026-10-04T10:00:00.000Z', from = '2026-10-03T21:00:00.000Z', to = '2026-10-04T20:59:59.999Z'
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'forsage-receipt-history-')); db = new LocalDatabase(directory)
  db.prepare("INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES ('cashier',?,'Касир','cashier',?,?)").run(tenant, at, at)
  pos = new LocalPosRepository(db); shift = pos.openShift({ cashier_id: 'cashier' })
  for (const [id, name, sku, barcode] of [['p', 'Помпа Hort', 'HB-625', '5449000351081'], ['other', 'Радіатор з кондиціонером', 'R-1', 'barcode-other']])
    db.prepare('INSERT INTO products(id,tenant_id,name,sku,barcode,retail_price,created_at,updated_at) VALUES (?,?,?,?,?,999999,?,?)').run(id, tenant, name, sku, barcode, at, at)
})
afterEach(() => {
  db.close()
  if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('forsage-receipt-history-')) rmSync(directory, { recursive: true, force: true })
})
function sale(id: string, time = at, manager: string | null = null, product = 'p', price = 62500) {
  db.prepare("INSERT INTO sales(id,tenant_id,sale_number,cashier_id,manager_id,shift_id,status,total,payment_method,completed_at,created_at,updated_at) VALUES (?,?,?,'cashier',?,?,'completed',?,'cash',?,?,?)").run(id, tenant, id, manager, shift, price, time, time, time)
  db.prepare('INSERT INTO sale_items(id,tenant_id,sale_id,product_id,description,sku,qty,unit_price,total,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?)').run(id, tenant, id, product, 'Історична назва ' + product, 'OLD-' + product, price, price, time, time)
}
function refund(id: string, source: string, line = source, product = 'p') {
  db.prepare("INSERT INTO customer_returns(id,tenant_id,sale_id,reason,refund_method,refund_kopecks,stock_action,status,created_at,updated_at) VALUES (?,?,?,'test','cash',62500,'return_to_stock','completed',?,?)").run(id, tenant, source, at, at)
  db.prepare("INSERT INTO customer_return_items(id,tenant_id,return_id,sale_item_id,product_id,quantity,unit_price_kopecks,total_kopecks,condition,created_at,updated_at) VALUES (?,?,?,?,?,1,62500,62500,'new',?,?)").run(id, tenant, id, line, product, at, at)
}
it('searches current names, snapshot names/SKU and aliases even after archive; price is historical', () => {
  sale('match'); sale('wrong-price', at, null, 'p', 70000)
  db.prepare("UPDATE products SET deleted_at=? WHERE id='p'").run(at)
  db.prepare("INSERT INTO product_barcodes(id,tenant_id,product_id,barcode,created_at,updated_at) VALUES ('alias',?,'p','2000000000001',?,?)").run(tenant, at, at)
  for (const query of ['помпа hort', 'HB-625', 'ІСТОРИЧНА', 'OLD-p', '5449000351081', '2000000000001']) {
    expect(pos.listSales({ product_search: query, unit_price: 62500 }).data.map(row => row.id)).toEqual(['match'])
    expect(pos.listSales({ search: query }).pagination.total).toBe(2)
  }
  expect(pos.listSales({ product_search: "' OR 1=1 --" }).pagination.total).toBe(0)
})
it('uses actual instants across legacy offset dates and excludes adjacent days', () => {
  sale('start', '2026-10-04T00:00:00+03:00'); sale('end', to); sale('before', '2026-10-03T20:59:59.999Z'); sale('after', '2026-10-04T21:00:00Z')
  expect(pos.listSales({ date_from: from, date_to: to }).data.map(row => row.id)).toEqual(['end', 'start'])
})
it('keeps source-only historical barcodes searchable after their live index moves to the merged target', () => {
  sale('source-receipt'); sale('wrong-price', at, null, 'p', 70000); sale('target-receipt', at, null, 'other')
  db.prepare("INSERT INTO product_barcodes(id,tenant_id,product_id,barcode,created_at,updated_at) VALUES ('moved',?,'other','OLD-EXTRA-01',?,?)").run(tenant, at, at)
  db.prepare("UPDATE products SET deleted_at=?,specs_json=? WHERE id='p'").run(at, JSON.stringify({ merged_into_product_id: 'other', cleanup_barcodes: ['OLD-EXTRA-01', 'SOURCE-ONLY-02'] }))
  for (const query of ['OLD-EXTRA-01', 'SOURCE-ONLY-02']) {
    expect(pos.listSales({ product_barcode: query, product_id: 'p', unit_price: 62500 }).data.map(row => row.id)).toEqual(['source-receipt'])
    expect(pos.listSales({ product_search: query, product_id: 'p', unit_price: 62500 }).data.map(row => row.id)).toEqual(['source-receipt'])
    expect(pos.listSales({ search: query }).data.map(row => row.id)).toContain('source-receipt')
  }
  expect(pos.listSales({ product_barcode: 'SOURCE-ONLY-02', product_id: 'other' }).pagination.total).toBe(0)
  db.prepare("UPDATE products SET tenant_id='foreign' WHERE id='p'").run()
  expect(pos.listSales({ product_barcode: 'SOURCE-ONLY-02' }).pagination.total).toBe(0)
  expect(pos.listSales({ search: 'SOURCE-ONLY-02' }).pagination.total).toBe(0)
})
it('uses a merged source barcode only on the actual returned line', () => {
  sale('source-return', '2026-10-01T10:00:00Z'); refund('source-refund', 'source-return')
  sale('wrong-return', '2026-10-01T10:00:00Z')
  db.prepare("INSERT INTO sale_items(id,tenant_id,sale_id,product_id,qty,unit_price,total,created_at,updated_at) VALUES ('other-line',?,'wrong-return','other',1,62500,62500,?,?)").run(tenant, at, at)
  refund('wrong-refund', 'wrong-return', 'other-line', 'other')
  db.prepare("UPDATE products SET deleted_at=?,specs_json=? WHERE id='p'").run(at, JSON.stringify({ merged_into_product_id: 'other', cleanup_barcodes: ['SOURCE-RETURN-CODE'] }))
  expect(pos.listSales({ product_barcode: 'SOURCE-RETURN-CODE', unit_price: 62500, date_from: from, date_to: to, include_returns: '1' }).data.map(row => row.id)).toEqual(['source-return'])
})
it.each(['not-json', 'null', '{}', '{"cleanup_barcodes":["INVALID-CODE"]}', '{"merged_into_product_id":"other","cleanup_barcodes":"INVALID-CODE"}', '{"merged_into_product_id":"other","cleanup_barcodes":[123,{"code":"INVALID-CODE"}]}'])('ignores invalid historical barcode metadata without breaking receipt search: %s', value => {
  sale('receipt')
  db.prepare("UPDATE products SET specs_json=? WHERE id='p'").run(value)
  expect(pos.listSales({ product_barcode: 'INVALID-CODE' }).pagination.total).toBe(0)
  expect(pos.listSales({ search: '123' }).pagination.total).toBe(0)
  expect(pos.listSales({ product_search: 'Помпа' }).pagination.total).toBe(1)
})
it('uses an exclusive next-day boundary without changing the inclusive legacy bound', () => {
  sale('end', to); sale('next-day', '2026-10-04T21:00:00Z')
  expect(pos.listSales({ date_from: from, date_to_exclusive: '2026-10-04T21:00:00Z' }).data.map(row => row.id)).toEqual(['end'])
  expect(pos.listSales({ date_from: from, date_to: '2026-10-04T21:00:00Z' }).data.map(row => row.id)).toEqual(['next-day', 'end'])
})
it('applies exact barcode and historical price to the same line, including aliases and snapshots', () => {
  sale('correct'); sale('wrong-price', at, null, 'p', 70000)
  db.prepare("INSERT INTO sale_items(id,tenant_id,sale_id,product_id,qty,unit_price,total,created_at,updated_at) VALUES ('other-line',?,'wrong-price','other',1,62500,62500,?,?)").run(tenant, at, at)
  db.prepare("INSERT INTO product_barcodes(id,tenant_id,product_id,barcode,created_at,updated_at) VALUES ('alias',?,'p','2000000000001',?,?)").run(tenant, at, at)
  for (const code of ['5449000351081', 'HB-625', '2000000000001', 'OLD-p']) {
    expect(pos.listSales({ product_barcode: code, unit_price: 62500 }).data.map(row => row.id)).toEqual(['correct'])
  }
  db.prepare("UPDATE products SET tenant_id='foreign' WHERE id='p'").run()
  db.prepare("UPDATE product_barcodes SET tenant_id='foreign' WHERE id='alias'").run()
  expect(pos.listSales({ product_barcode: '2000000000001' }).pagination.total).toBe(0)
  expect(pos.listSales({ product_barcode: '5449000351081' }).pagination.total).toBe(0)
})
it('applies exact barcode to the actual returned line, not another line of the source receipt', () => {
  sale('matching-return', '2026-10-01T10:00:00Z'); refund('correct', 'matching-return')
  sale('wrong-return', '2026-10-01T10:00:00Z')
  db.prepare("INSERT INTO sale_items(id,tenant_id,sale_id,product_id,qty,unit_price,total,created_at,updated_at) VALUES ('other-line',?,'wrong-return','other',1,62500,62500,?,?)").run(tenant, at, at)
  refund('other-refund', 'wrong-return', 'other-line', 'other')
  expect(pos.listSales({ product_barcode: '5449000351081', unit_price: 62500, date_from: from, date_to: to, include_returns: '1' }).data.map(row => row.id)).toEqual(['matching-return'])
})
it('matches source receipts for a returned product on its return date, not another returned line', () => {
  sale('old', '2026-10-01T10:00:00Z', 'manager'); refund('r', 'old')
  sale('unrelated', '2026-10-01T10:00:00Z', 'manager')
  db.prepare("INSERT INTO sale_items(id,tenant_id,sale_id,product_id,qty,unit_price,total,created_at,updated_at) VALUES ('other-line',?,'unrelated','other',1,100,100,?,?)").run(tenant, at, at)
  refund('other-refund', 'unrelated', 'other-line', 'other')
  const filter = { product_id: 'p', date_from: from, date_to: to, seller_id: 'manager' }
  expect(pos.listSales(filter).pagination.total).toBe(0)
  expect(pos.listSales({ ...filter, include_returns: '1' }).data.map(row => row.id)).toEqual(['old'])
})
it('uses saved manager, then order manager, then cashier; scopes joins to the shop', () => {
  sale('saved', at, 'original'); sale('legacy'); sale('cashier-sale')
  for (const [id, saleId, manager] of [['one', 'saved', 'edited'], ['two', 'legacy', 'order-manager']])
    db.prepare("INSERT INTO customer_orders(id,tenant_id,manager_id,status,sale_id,created_at,updated_at) VALUES (?,?,?,'completed',?,?,?)").run(id, tenant, manager, saleId, at, at)
  expect(pos.listSales({ seller_id: 'original' }).data.map(row => row.id)).toEqual(['saved'])
  expect(pos.listSales({ seller_id: 'order-manager' }).data.map(row => row.id)).toEqual(['legacy'])
  expect(pos.listSales({ seller_id: 'cashier' }).data.map(row => row.id)).toEqual(['cashier-sale'])
  db.prepare("UPDATE products SET tenant_id='foreign' WHERE id='p'").run()
  expect(pos.listSales({ product_search: 'Помпа' }).pagination.total).toBe(0)
})
it('paginates 1001 matches deterministically without duplicates or a 1000-item cap and never writes', () => {
  for (let i = 0; i < 1001; i++) sale('receipt-' + String(i).padStart(4, '0'))
  const before = db.prepare('SELECT count(*) n FROM sync_outbox').get(); db.prepare('PRAGMA query_only=ON').run()
  const seen = new Set<string>()
  for (let page = 1; page <= 11; page++) {
    const rows = pos.listSales({ product_search: 'Hort', page, per_page: 100 })
    expect(rows.pagination.total).toBe(1001); expect(rows.filter_version).toBe(1)
    for (const row of rows.data) { expect(seen.has(row.id)).toBe(false); seen.add(row.id) }
  }
  expect(seen.size).toBe(1001); expect(pos.listSales({ product_search: 'Hort', page: 12, per_page: 100 }).data).toEqual([])
  expect(db.prepare('SELECT count(*) n FROM sync_outbox').get()).toEqual(before)
  db.prepare('PRAGMA query_only=OFF').run()
})
it('rejects unsafe price, malformed and reversed dates', () => {
  expect(() => pos.listSales({ unit_price: -1 })).toThrow()
  expect(() => pos.listSales({ date_from: 'bad' })).toThrow()
  expect(() => pos.listSales({ date_from: to, date_to: from })).toThrow()
  expect(() => pos.listSales({ date_to_exclusive: 'bad' })).toThrow()
  expect(() => pos.listSales({ date_from: to, date_to_exclusive: from })).toThrow()
  expect(() => pos.listSales({ date_from: to, date_to_exclusive: to })).toThrow()
  expect(() => pos.listSales({ date_to: to, date_to_exclusive: to })).toThrow()
})
it('preserves custom and snapshot line text in receipt detail without a product card', () => {
  sale('custom')
  db.prepare("UPDATE sale_items SET product_id=NULL,description='Додаткова робота',sku='WORK-123' WHERE id='custom'").run()
  expect(pos.getSale('custom').sale_items[0]).toMatchObject({ product_id: null, description: 'Додаткова робота', sku: 'WORK-123' })
})
it('drilled receipt operations reconcile quantity and money with the sold-item report, including an old returned receipt', () => {
  sale('current'); sale('old', '2026-10-01T10:00:00Z'); refund('r-old', 'old')
  db.prepare("UPDATE sales SET total=125000 WHERE id='current'").run()
  db.prepare("UPDATE sale_items SET qty=2,total=125000 WHERE id='current'").run()
  const matching = pos.listSales({ product_id: 'p', seller_id: 'cashier', date_from: from, date_to: to, include_returns: '1' })
  expect(new Set(matching.data.map(row => row.id))).toEqual(new Set(['current', 'old']))
  const report = pos.soldItemsReport({ date_from: from, date_to: to })[0]
  const inPeriod = matching.data.filter(row => Date.parse(row.completed_at) >= Date.parse(from) && Date.parse(row.completed_at) <= Date.parse(to))
  const soldQuantity = inPeriod.flatMap(row => row.sale_items).reduce((sum, line) => sum + line.qty, 0)
  const revenue = inPeriod.reduce((sum, row) => sum + row.total, 0)
  const refundRows = db.prepare('SELECT quantity,total_kopecks FROM customer_return_items WHERE return_id=?').all('r-old') as Array<{ quantity: number; total_kopecks: number }>
  expect(report.qty_sold).toBe(soldQuantity)
  expect(report.qty_net).toBe(soldQuantity - refundRows[0].quantity)
  expect(report.net_revenue).toBe(revenue - refundRows[0].total_kopecks)
  expect(report.sellers[0]).toMatchObject({ id: 'cashier', qty_net: 1, net_revenue: 62500 })
})
