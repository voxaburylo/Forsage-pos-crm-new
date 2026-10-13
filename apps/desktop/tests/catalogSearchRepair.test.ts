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

  it('upgrades the old search index with normalized retained aliases and keeps them after later card edits', () => {
    const catalog = new LocalCatalogRepository(db), at = '2026-10-13'
    catalog.upsertProduct({ id: 'main', sku: 'MAIN-1', name: 'Поточна назва' })
    for (const [id, alias, deleted] of [['alias-name', 'СТАРИЙ ФІЛЬТР ЖОВТИЙ', null], ['alias-sku', 'WA-9428', null], ['removed', 'ВИДАЛЕНИЙ ПСЕВДОНІМ', at]]) {
      db.prepare('INSERT INTO product_aliases(id,tenant_id,product_id,alias,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?)').run(id, DEFAULT_TENANT_ID, 'main', alias, at, at, deleted)
    }
    db.prepare("UPDATE app_meta SET value_json='2' WHERE key='product_search_index_repair_version'").run()
    const updated = new LocalCatalogRepository(db)
    const verify = () => {
      expect(updated.listProducts({ query: 'старий фільтр жовтий' }).data.map(p => p.id)).toEqual(['main'])
      expect(updated.listProducts({ query: 'WA9428' }).data.map(p => p.id)).toEqual(['main'])
      expect(updated.listProducts({ query: 'видалений псевдонім' }).data).toEqual([])
      expect(updated.findBySku('wa 9428')?.id).toBe('main')
    }
    verify()
    updated.saveProduct({ id: 'main', sku: 'MAIN-1', name: 'Редагована назва' })
    verify()
  })

  it('only resolves a unique active tenant alias and gives an existing exact article precedence', () => {
    const catalog = new LocalCatalogRepository(db), at = '2026-10-13'
    catalog.upsertProduct({ id: 'one', sku: 'ONE-1', name: 'One' })
    catalog.upsertProduct({ id: 'two', sku: 'TWO-2', name: 'Two' })
    const insert = db.prepare('INSERT INTO product_aliases(id,tenant_id,product_id,alias,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    insert.run('a1', DEFAULT_TENANT_ID, 'one', 'WA-9428', at, at)
    insert.run('a2', DEFAULT_TENANT_ID, 'one', 'WA9428', at, at)
    expect(catalog.findBySku('wa 9428')?.id).toBe('one')
    insert.run('a3', DEFAULT_TENANT_ID, 'two', 'Wa.9428', at, at)
    expect(catalog.findBySku('wa 9428')).toBeNull()
    expect(catalog.withSkuLookupIndex(DEFAULT_TENANT_ID, () => catalog.findBySku('wa 9428'))).toBeNull()
    expect(catalog.findBySku('WA942')).toBeNull()
    expect(catalog.findBySku('wa 9428', 'other-tenant')).toBeNull()
    db.prepare('UPDATE product_aliases SET deleted_at=? WHERE id=?').run(at, 'a3')
    db.prepare('UPDATE products SET is_active=0 WHERE id=?').run('one')
    expect(catalog.findBySku('wa 9428')).toBeNull()
    catalog.saveProduct({ id: 'two', sku: 'WA9428', name: 'Direct article' })
    expect(catalog.findBySku('wa9428')?.id).toBe('two')
  })
})
