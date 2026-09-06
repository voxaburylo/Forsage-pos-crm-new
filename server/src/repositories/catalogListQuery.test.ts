import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { catalogListQuery } from './catalogListQuery.js'
import { productListSchema } from '../validators/productValidator.js'

describe('PostgreSQL catalog pagination', () => {
  const db = new PGlite()
  beforeAll(async () => {
    await db.exec(`
      CREATE TABLE products (
        id text PRIMARY KEY, tenant_id text NOT NULL, name text, sku text, barcode text,
        qty_on_hand numeric, retail_price integer, reorder_point numeric DEFAULT 2,
        is_active boolean DEFAULT true, is_service boolean DEFAULT false, is_favorite boolean DEFAULT false,
        brand_id text, category_id text, deleted_at timestamptz, created_at timestamptz DEFAULT now(),
        normalized_oem text, normalized_supplier_article text, oem_number text, additional_barcodes jsonb
      );
      CREATE TABLE brands (id text, tenant_id text, name text, deleted_at timestamptz);
      CREATE TABLE categories (id text, tenant_id text, name text, deleted_at timestamptz);
      CREATE TABLE inventory_reserves (product_id text, tenant_id text, qty numeric, released_at timestamptz, expires_at timestamptz);
      CREATE TABLE product_aliases (product_id text, tenant_id text, alias text, deleted_at timestamptz);
      CREATE TABLE product_cross_numbers (product_id text, tenant_id text, normalized_number text, deleted_at timestamptz);
      CREATE TABLE product_supplier_codes (product_id text, tenant_id text, supplier_code text, normalized_supplier_article text);
      CREATE TABLE product_barcodes (product_id text, tenant_id text, barcode text, deleted_at timestamptz);
      INSERT INTO products (id, tenant_id, name, sku, barcode, qty_on_hand, retail_price, is_favorite)
      SELECT lpad(i::text,4,'0'), 'shop', 'Фільтр ' || lpad(i::text,4,'0'), 'SKU-' || i,
        '200000000' || lpad(i::text,4,'0'), CASE WHEN i % 3 = 0 THEN 0 ELSE i % 19 + 1 END,
        2105 - i, i % 2 = 0 FROM generate_series(0,2104) AS i;
      INSERT INTO inventory_reserves (product_id, tenant_id, qty)
        SELECT id, tenant_id, qty_on_hand FROM products WHERE id < '0300' AND qty_on_hand > 0;
      INSERT INTO inventory_reserves VALUES ('0301', 'other-shop', 999, NULL, NULL),
        ('0301', 'shop', 999, now(), NULL), ('0301', 'shop', 999, NULL, '2000-01-01');
      INSERT INTO products (id, tenant_id, name, sku, qty_on_hand, retail_price, deleted_at, is_active)
        VALUES ('foreign', 'other-shop', 'Фільтр', 'FOREIGN', 999, 1, NULL, true),
          ('deleted', 'shop', 'Фільтр', 'DELETED', 999, 1, now(), true),
          ('inactive', 'shop', 'Фільтр', 'INACTIVE', 999, 1, NULL, false);
      INSERT INTO product_aliases (product_id, tenant_id, alias)
        SELECT id, tenant_id, 'унікальний синонім' FROM products WHERE id < '0700';
      INSERT INTO product_aliases VALUES ('0701', 'other-shop', 'чужий синонім', NULL);
    `)
  }, 30000)
  afterAll(() => db.close())

  async function list(filters: Record<string, unknown> = {}) {
    const parsed = productListSchema.parse({ per_page: 100, ...filters })
    const query = catalogListQuery(parsed, 'shop', parsed.search ? [parsed.search] : [])
    const result = await db.query<{ total: number; data: Array<{ id: string; qty_available: number; qty_reserved: number; name: string; is_service: boolean }> }>(query.text, query.values)
    return result.rows[0]
  }

  it.each(['name', 'sku', 'qty_on_hand', 'retail_price', 'brand', 'created_at'])(
    'keeps stocked products first throughout the complete result sorted by %s', async (field) => {
      for (const dir of ['asc', 'desc']) {
        const rows = []
        for (let page = 1; page <= 5; page++) {
          const result = await list({ page, per_page: 500, search: 'Фільтр', sort_field: field, sort_dir: dir })
          expect(result.total).toBe(2105)
          rows.push(...result.data)
        }
        expect(rows).toHaveLength(2105)
        expect(new Set(rows.map(p => p.id)).size).toBe(2105)
        const firstAbsent = rows.findIndex(p => p.qty_available <= 0)
        expect(firstAbsent).toBe(1203)
        expect(rows.slice(firstAbsent).some(p => p.qty_available > 0)).toBe(false)
        if (field === 'qty_on_hand') {
          const qty = rows.slice(0, firstAbsent).map(p => p.qty_available)
          expect(qty).toEqual([...qty].sort((a, b) => dir === 'asc' ? a - b : b - a))
        }
      }
    }, 30000,
  )

  it('does not cap alias matches at 500 or low-stock matches at the REST row limit', async () => {
    expect((await list({ search: 'унікальний синонім' })).total).toBe(700)
    expect((await list({ low_stock: 'true', per_page: 2000 })).total).toBeGreaterThan(700)
    const allLowStock = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM products
      WHERE tenant_id='shop' AND deleted_at IS NULL AND is_active AND qty_on_hand<=reorder_point`)
    expect((await list({ low_stock: 'true' })).total).toBe(allLowStock.rows[0].count)
  })

  it('returns the requested empty page, not the first page again', async () => {
    const result = await list({ page: 99 })
    expect(result.total).toBe(2105)
    expect(result.data).toEqual([])
    expect(await list({ search: 'немає такого' })).toEqual({ total: 0, data: [] })
  })

  it('does not read another tenant or count expired/released reserves', async () => {
    expect((await list({ search: 'чужий синонім' })).total).toBe(0)
    const product = (await list({ search: 'SKU-301' })).data.find(p => p.id === '0301')!
    expect(product.qty_reserved).toBe(0)
    expect(product.qty_available).toBe(17)
  })

  it('treats SQL and LIKE metacharacters as literal search text', async () => {
    expect((await list({ search: "%' OR 1=1 --" })).data).toEqual([])
    expect((await list({ search: '%' })).data).toEqual([])
    expect((await list()).total).toBe(2105)
  })
})
