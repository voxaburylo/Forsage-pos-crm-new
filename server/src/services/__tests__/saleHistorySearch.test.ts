import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { saleHistoryQuery } from '../saleHistorySearch.js'
import { saleListSchema } from '../../validators/saleSchema.js'

const db = new PGlite()
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const tenant = id(1), product = id(2), other = id(3), cashier = id(4), manager = id(5)
const at = '2026-10-04T10:00:00Z', from = '2026-10-03T21:00:00Z', to = '2026-10-04T20:59:59.999Z'
beforeAll(async () => {
  await db.exec(`CREATE TABLE sales(id uuid PRIMARY KEY,tenant_id uuid,sale_number text,customer_id uuid,cashier_id uuid,manager_id uuid,shift_id uuid,status text,total integer,completed_at timestamptz,created_at timestamptz,deleted_at timestamptz);
    CREATE TABLE customers(id uuid PRIMARY KEY,tenant_id uuid,phone text,full_name text,card_barcode text);
    CREATE TABLE customer_vehicles(id uuid,tenant_id uuid,customer_id uuid,vin text,deleted_at timestamptz);
    CREATE TABLE customer_cars(LIKE customer_vehicles);
    CREATE TABLE products(id uuid PRIMARY KEY,tenant_id uuid,name text,sku text,barcode text,retail_price integer,deleted_at timestamptz,specs jsonb);
    CREATE TABLE sale_items(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,product_id uuid,description text,sku text,unit_price integer,qty numeric,total integer,deleted_at timestamptz);
    CREATE TABLE product_barcodes(id uuid,tenant_id uuid,product_id uuid,barcode text,deleted_at timestamptz);
    CREATE TABLE customer_orders(id uuid,tenant_id uuid,sale_id uuid,manager_id uuid,deleted_at timestamptz);
    CREATE TABLE returns(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,status text,created_at timestamptz,deleted_at timestamptz);
    CREATE TABLE return_items(id uuid,tenant_id uuid,return_id uuid,sale_item_id uuid,deleted_at timestamptz);`)
}, 30000)
beforeEach(async () => {
  await db.exec('TRUNCATE sales,customers,customer_vehicles,customer_cars,products,sale_items,product_barcodes,customer_orders,returns,return_items')
  await db.query('INSERT INTO products(id,tenant_id,name,sku,barcode,retail_price) VALUES ($1,$2,$3,$4,$5,999999),($6,$2,$7,$8,$9,999999)', [product, tenant, 'Помпа Hort', 'HB-625', '5449000351081', other, 'Радіатор', 'R-1', 'other-code'])
})
afterAll(() => db.close())
async function sale(n: number, time = at, employee: string | null = null, price = 62500) {
  await db.query("INSERT INTO sales(id,tenant_id,sale_number,cashier_id,manager_id,status,total,completed_at,created_at) VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,$7)", [id(n), tenant, 'R-' + n, cashier, employee, price, time])
  await db.query("INSERT INTO sale_items(id,tenant_id,sale_id,product_id,description,sku,unit_price,qty,total) VALUES ($1,$2,$1,$3,'Історична назва','OLD-p',$4,1,$4)", [id(n), tenant, product, price])
}
async function run(input: Record<string, unknown> = {}) {
  const built = saleHistoryQuery(saleListSchema.parse(input), tenant)
  return (await db.query<{ total: number; data: Array<{ id: string }> }>(built.text, built.values)).rows[0]
}
it('finds archived/snapshot/alias names and historical price with safely bound literals', async () => {
  await sale(10); await sale(11, at, null, 70000)
  await db.query('UPDATE products SET deleted_at=$1 WHERE id=$2', [at, product])
  await db.query('INSERT INTO product_barcodes VALUES ($1,$2,$3,$4,NULL)', [id(6), tenant, product, '2000000000001'])
  for (const query of ['помпа hort', 'HB-625', 'ІСТОРИЧНА', 'OLD-p', '5449000351081', '2000000000001']) {
    expect((await run({ product_search: query, unit_price: 62500 })).data).toEqual([expect.objectContaining({ id: id(10) })])
    expect((await run({ search: query })).total).toBe(2)
  }
  expect((await run({ search: "' OR 1=1 --" })).total).toBe(0)
})
it('preserves receipt/client/VIN general search, including legacy cars', async () => {
  await sale(10)
  await db.query("INSERT INTO customers VALUES ($1,$2,'+380671234567','Іван Петренко','CARD-1')", [id(7), tenant])
  await db.query('UPDATE sales SET customer_id=$1', [id(7)])
  await db.query('INSERT INTO customer_cars VALUES ($1,$2,$3,$4,NULL)', [id(8), tenant, id(7), 'VIN-LEGACY'])
  for (const search of ['R-10', '671234567', 'петренко', 'CARD-1', 'VIN-LEGACY']) expect((await run({ search })).total).toBe(1)
})
it('keeps source-only historical barcodes searchable after their live index moves to the merged target', async () => {
  await sale(10); await sale(11, at, null, 70000); await sale(12)
  await db.query('UPDATE sale_items SET product_id=$1 WHERE id=$2', [other, id(12)])
  await db.query('INSERT INTO product_barcodes VALUES ($1,$2,$3,$4,NULL)', [id(6), tenant, other, 'OLD-EXTRA-01'])
  await db.query('UPDATE products SET deleted_at=$1,specs=$2 WHERE id=$3', [at, { merged_into_product_id: other, cleanup_barcodes: ['OLD-EXTRA-01', 'SOURCE-ONLY-02'] }, product])
  for (const query of ['OLD-EXTRA-01', 'SOURCE-ONLY-02']) {
    expect((await run({ product_barcode: query, product_id: product, unit_price: 62500 })).data.map(row => row.id)).toEqual([id(10)])
    expect((await run({ product_search: query, product_id: product, unit_price: 62500 })).data.map(row => row.id)).toEqual([id(10)])
    expect((await run({ search: query })).data.map(row => row.id)).toContain(id(10))
  }
  expect((await run({ product_barcode: 'SOURCE-ONLY-02', product_id: other })).total).toBe(0)
  await db.query('UPDATE products SET tenant_id=$1 WHERE id=$2', [id(999), product])
  expect((await run({ product_barcode: 'SOURCE-ONLY-02' })).total).toBe(0)
  expect((await run({ search: 'SOURCE-ONLY-02' })).total).toBe(0)
})
it('uses a merged source barcode only on the actual returned line', async () => {
  await sale(10, '2026-10-01T10:00:00Z'); await sale(11, '2026-10-01T10:00:00Z')
  await db.query('INSERT INTO sale_items(id,tenant_id,sale_id,product_id,unit_price) VALUES ($1,$2,$3,$4,62500)', [id(12), tenant, id(11), other])
  for (const [r, source, line] of [[20, 10, 10], [21, 11, 12]]) {
    await db.query("INSERT INTO returns VALUES ($1,$2,$3,'completed',$4,NULL)", [id(r), tenant, id(source), at])
    await db.query('INSERT INTO return_items VALUES ($1,$2,$1,$3,NULL)', [id(r), tenant, id(line)])
  }
  await db.query('UPDATE products SET deleted_at=$1,specs=$2 WHERE id=$3', [at, { merged_into_product_id: other, cleanup_barcodes: ['SOURCE-RETURN-CODE'] }, product])
  expect((await run({ product_barcode: 'SOURCE-RETURN-CODE', unit_price: 62500, date_from: from, date_to: to, include_returns: '1' })).data.map(row => row.id)).toEqual([id(10)])
})
it.each([null, {}, { cleanup_barcodes: ['INVALID-CODE'] }, { merged_into_product_id: other, cleanup_barcodes: 'INVALID-CODE' }, { merged_into_product_id: other, cleanup_barcodes: [123, { code: 'INVALID-CODE' }] }])('ignores invalid historical barcode metadata: %j', async value => {
  await sale(10)
  await db.query('UPDATE products SET specs=$1 WHERE id=$2', [value, product])
  expect((await run({ product_barcode: 'INVALID-CODE' })).total).toBe(0)
  expect((await run({ search: '123' })).total).toBe(0)
  expect((await run({ product_search: 'Помпа' })).total).toBe(1)
})
it('keeps legacy server schemas without a specs column searchable', async () => {
  await sale(10)
  await db.exec('BEGIN; ALTER TABLE products DROP COLUMN specs')
  try {
    expect((await run({ product_barcode: '5449000351081' })).total).toBe(1)
    expect((await run({ product_search: 'Помпа' })).total).toBe(1)
    expect((await run({ search: 'Помпа' })).total).toBe(1)
  } finally { await db.exec('ROLLBACK') }
})
it('includes only source receipts for the actual returned product on its return date', async () => {
  await sale(10, '2026-10-01T10:00:00Z', manager); await sale(11, '2026-10-01T10:00:00Z', manager)
  await db.query('INSERT INTO sale_items(id,tenant_id,sale_id,product_id,unit_price) VALUES ($1,$2,$3,$4,62500)', [id(12), tenant, id(11), other])
  for (const [r, source, line] of [[20, 10, 10], [21, 11, 12]]) {
    await db.query("INSERT INTO returns VALUES ($1,$2,$3,'completed',$4,NULL)", [id(r), tenant, id(source), at])
    await db.query('INSERT INTO return_items VALUES ($1,$2,$1,$3,NULL)', [id(r), tenant, id(line)])
  }
  const filter = { product_id: product, seller_id: manager, date_from: from, date_to: to }
  expect((await run(filter)).total).toBe(0)
  expect((await run({ ...filter, include_returns: '1' })).data).toEqual([expect.objectContaining({ id: id(10) })])
})
it('uses real instants and attribution, with tenant-isolated related records', async () => {
  await sale(10, '2026-10-04T00:00:00+03:00', manager); await sale(11, to); await sale(12, '2026-10-04T21:00:00Z')
  await db.query('INSERT INTO customer_orders VALUES ($1,$2,$3,$4,NULL)', [id(20), tenant, id(11), manager])
  expect((await run({ date_from: from, date_to: to, seller_id: manager })).data.map(row => row.id)).toEqual([id(11), id(10)])
  await db.query('UPDATE products SET tenant_id=$1', [id(999)])
  expect((await run({ product_search: 'Помпа' })).total).toBe(0)
})
it('includes the whole PostgreSQL final millisecond for sales and returns but excludes next midnight', async () => {
  await sale(10, '2026-10-04T20:59:59.999500Z'); await sale(11, '2026-10-04T21:00:00Z')
  await sale(12, '2026-10-01T10:00:00Z'); await sale(13, '2026-10-01T10:00:00Z')
  for (const [r, source, time] of [[20, 12, '2026-10-04T20:59:59.999900Z'], [21, 13, '2026-10-04T21:00:00Z']] as const) {
    await db.query("INSERT INTO returns VALUES ($1,$2,$3,'completed',$4,NULL)", [id(r), tenant, id(source), time])
    await db.query('INSERT INTO return_items VALUES ($1,$2,$1,$3,NULL)', [id(r), tenant, id(source)])
  }
  expect((await run({ product_id: product, date_from: from, date_to_exclusive: '2026-10-04T21:00:00Z', include_returns: '1' })).data.map(row => row.id)).toEqual([id(10), id(12)])
  expect((await run({ date_from: from, date_to: to })).total).toBe(0)
  expect((await run({ date_from: from, date_to: '2026-10-04T21:00:00Z' })).data.map(row => row.id)).toEqual([id(11), id(10)])
})
it('paginates more than 1000 matched lines deterministically in a read-only transaction', async () => {
  await db.query(`INSERT INTO sales(id,tenant_id,sale_number,status,completed_at,created_at)
    SELECT ('10000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,$1,'Receipt-'||i,'completed',$2,$2 FROM generate_series(1,1001) i`, [tenant, at])
  await db.query("INSERT INTO sale_items(id,tenant_id,sale_id,product_id,unit_price) SELECT id,tenant_id,id,$1,62500 FROM sales", [product])
  await db.exec('BEGIN READ ONLY')
  try {
    const seen = new Set()
    for (let page = 1; page <= 11; page++) {
      const result = await run({ product_search: 'Hort', per_page: 100, page })
      expect(result.total).toBe(1001)
      for (const row of result.data) { expect(seen.has(row.id)).toBe(false); seen.add(row.id) }
    }
    expect(seen.size).toBe(1001); expect((await run({ product_search: 'Hort', per_page: 100, page: 12 })).data).toEqual([])
  } finally { await db.exec('ROLLBACK') }
})
it.each([{ unit_price: -1 }, { unit_price: 1.1 }, { date_from: 'invalid' }, { date_from: to, date_to: from }, { product_id: 'not-uuid' },
  { date_to_exclusive: 'invalid' }, { date_from: to, date_to_exclusive: from }, { date_from: to, date_to_exclusive: to }, { date_to: to, date_to_exclusive: to },
])('rejects invalid filters %j', input => {
  expect(saleListSchema.safeParse(input).success).toBe(false)
})
