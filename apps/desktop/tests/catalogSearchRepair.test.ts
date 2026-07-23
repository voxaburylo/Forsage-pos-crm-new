import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'

describe('local product search repair', () => {
  let root = ''
  let db: LocalDatabase

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-search-repair-'))
    db = new LocalDatabase(root)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-search-repair-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('repairs legacy rows once and keeps new writes indexed', () => {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO products (id, tenant_id, sku, name, barcode, search_text, created_at, updated_at)
      VALUES ('legacy-product', ?, 'BOOST-1', 'Пускові дроти BOOSTER', '2003093555486', '', ?, ?)
    `).run(DEFAULT_TENANT_ID, now, now)

    const first = new LocalCatalogRepository(db)
    const repaired = db.prepare("SELECT search_text FROM products WHERE id = 'legacy-product'")
      .get() as { search_text: string }
    expect(repaired.search_text).toContain('пускови дроти booster')
    expect(db.prepare("SELECT value_json FROM app_meta WHERE key = 'product_search_index_repair_version'").get()).toBeTruthy()

    db.prepare("UPDATE products SET search_text = '' WHERE id = 'legacy-product'").run()
    new LocalCatalogRepository(db)
    const unchanged = db.prepare("SELECT search_text FROM products WHERE id = 'legacy-product'")
      .get() as { search_text: string }
    expect(unchanged.search_text).toBe('')

    first.upsertProduct({
      id: 'new-product', tenant_id: DEFAULT_TENANT_ID, sku: 'NEW-1',
      name: 'Новий індексований товар', barcode: '2000000000001',
    })
    const fresh = db.prepare("SELECT search_text FROM products WHERE id = 'new-product'")
      .get() as { search_text: string }
    expect(fresh.search_text).toContain('новий индексований товар')
  })
})
