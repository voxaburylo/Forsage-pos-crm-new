import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalProduct } from '../src/db/localTypes'
import { LocalCatalogRepository, type LocalProductSortField } from '../src/repositories/catalogRepository'

describe('catalog availability before pagination', () => {
  let root: string
  let db: LocalDatabase
  let catalog: LocalCatalogRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-stock-order-'))
    db = new LocalDatabase(root)
    db.transaction(() => {
      const insert = db.prepare(`INSERT INTO products
        (id, tenant_id, sku, name, barcode, qty_on_hand, retail_price, is_favorite, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01', '2026-01-01')`)
      for (let i = 0; i < 780; i++) {
        const id = String(i).padStart(4, '0')
        insert.run(id, DEFAULT_TENANT_ID, `FILTER-${id}`, `Фільтр ${id}`, `200000000${id}`,
          i % 3 === 0 ? 0 : (i % 17) + 1, 780 - i, i % 2)
      }
    })
    catalog = new LocalCatalogRepository(db)
  })

  afterEach(() => {
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-stock-order-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function reserve(id: string, qty: number, options: { expires?: string; released?: string; deleted?: string } = {}) {
    db.prepare(`INSERT INTO stock_reserves
      (id, tenant_id, product_id, qty, expires_at, released_at, deleted_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01', '2026-01-01')`)
      .run(`reserve-${id}`, DEFAULT_TENANT_ID, id, qty, options.expires ?? null,
        options.released ?? null, options.deleted ?? null)
  }

  const available = (p: LocalProduct) => p.is_service === 1 || Number(p.qty_available) > 0
  function expectStockFirst(rows: LocalProduct[]) {
    const firstAbsent = rows.findIndex(p => !available(p))
    if (firstAbsent >= 0) expect(rows.slice(firstAbsent).some(available)).toBe(false)
  }

  it.each([undefined, 'name', 'sku', 'qty_on_hand', 'retail_price', 'brand'] as Array<LocalProductSortField | undefined>)(
    'keeps ALL available matches ahead across eight pages sorted by %s', (sortField) => {
      // These would previously be positive in SQL and absent only after LIMIT.
      reserve('0001', 2)
      reserve('0002', 10)
      const rows: LocalProduct[] = []
      for (let offset = 0; offset < 780; offset += 100) {
        const page = catalog.listProducts({ query: 'фільтр', limit: 100, offset, sortField, sortDir: 'asc' })
        expect(page.total).toBe(780)
        rows.push(...page.data)
      }
      expect(rows).toHaveLength(780)
      expect(new Set(rows.map(p => p.id)).size).toBe(780)
      expect(rows.filter(available)).toHaveLength(518)
      expectStockFirst(rows)
      if (sortField === 'qty_on_hand') {
        const quantities = rows.filter(available).map(p => Number(p.qty_available))
        expect(quantities).toEqual([...quantities].sort((a, b) => a - b))
      }
    },
  )

  it('ignores expired, released and deleted reserves, but accounts for partial reserves', () => {
    reserve('0001', 100, { expires: '2000-01-01T00:00:00Z' })
    reserve('0002', 100, { released: '2026-01-01' })
    reserve('0004', 100, { deleted: '2026-01-01' })
    reserve('0005', 2)
    for (const id of ['0001', '0002', '0004', '0005']) {
      const p = catalog.listProducts({ query: `FILTER-${id}` }).data[0]
      expect(p.qty_reserved).toBe(id === '0005' ? 2 : 0)
      expect(p.qty_available).toBe(Number(p.qty_on_hand) - Number(p.qty_reserved))
    }
  })

  it('suggestions and popular products choose from all available products before limiting', () => {
    const ids = Array.from({ length: 400 }, (_, i) => String(i).padStart(4, '0'))
    db.exec(`UPDATE products SET qty_on_hand = 0, is_favorite = 1 WHERE id IN (${ids.map(id => `'${id}'`).join(',')})`)
    expect(catalog.searchProducts('фільтр', DEFAULT_TENANT_ID, 30).every(available)).toBe(true)
    expect(catalog.listPopular(DEFAULT_TENANT_ID, 30).every(available)).toBe(true)
  })

  it('keeps an exact scanner lookup exact even when that product is absent', () => {
    const rows = catalog.searchProducts('2000000000000')
    expect(rows.map(p => p.id)).toEqual(['0000'])
    expect(rows[0].qty_available).toBe(0)
  })

  it('handles services, negative stock, stable ties, and excludes deleted/inactive products', () => {
    db.exec(`UPDATE products SET qty_on_hand = 0, is_favorite = 0, name = 'Фільтр';
      UPDATE products SET qty_on_hand = -1 WHERE id = '0001';
      UPDATE products SET is_service = 1 WHERE id = '0779';
      UPDATE products SET deleted_at = '2026-01-01', qty_on_hand = 50 WHERE id = '0002';
      UPDATE products SET is_active = 0, qty_on_hand = 50 WHERE id = '0003';`)
    const rows = catalog.listProducts({ limit: 4 }).data
    expect(rows.map(p => p.id)).toEqual(['0779', '0000', '0001', '0004'])
    expectStockFirst(rows)
    expect(catalog.listProducts({ limit: 4 }).data).toEqual(rows)
  })
})
