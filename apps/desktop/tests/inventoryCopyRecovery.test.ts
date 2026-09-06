import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { recoverInventoryDocumentCopies } from '../src/repositories/inventoryCopyRecovery'

describe('legacy inventory document recovery', () => {
  let root: string
  let db: LocalDatabase
  const marker = 'Знято з черги: сервер не прийме її ніколи. Остання відповідь: конфлікт'
  const payload = { id: 'revision', items: [{ product_id: 'product', expected_stock: 8, counted_stock: 3 }] }
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-history-copy-'))
    db = new LocalDatabase(root)
    db.prepare(`INSERT INTO products(id, tenant_id, sku, name, qty_on_hand, created_at, updated_at)
      VALUES ('product', ?, 'SKU', 'Fixture', 2, '2026-09-01', '2026-09-06')`).run(tenant)
    db.prepare(`INSERT INTO inventory_sessions(id, tenant_id, session_name, status, created_at, updated_at)
      VALUES ('revision', ?, 'Fixture', 'completed', '2026-09-01', '2026-09-01')`).run(tenant)
    db.prepare(`INSERT INTO inventory_items(id, tenant_id, session_id, product_id, expected_stock, counted_stock,
      was_counted, created_at, updated_at) VALUES ('row', ?, 'revision', 'product', 8, 3, 1, '2026-09-01', '2026-09-01')`).run(tenant)
    db.prepare(`INSERT INTO sync_outbox(operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
      operation_type, payload_json, status, attempts, created_at, synced_at, last_error)
      VALUES ('op', ?, 'device', 'inventory_session', 'revision', 'inventory.completed', ?, 'synced', 30, '2026-09-01', '2026-09-02', ?)`)
      .run(tenant, JSON.stringify(payload), marker)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const row = () => db.prepare('SELECT * FROM sync_outbox').get() as any

  it('requeues only the document, preserving the local stock, revision and original payload', () => {
    const product = db.prepare('SELECT * FROM products').get()
    const revision = db.prepare('SELECT * FROM inventory_sessions').get()
    const item = db.prepare('SELECT * FROM inventory_items').get()
    expect(recoverInventoryDocumentCopies(db)).toEqual({ queued: 1, skipped: 0 })
    expect(row()).toMatchObject({ operation_id: 'op', operation_type: 'inventory.document_copied', status: 'pending', synced_at: null, attempts: 0, payload_json: JSON.stringify(payload) })
    expect(db.prepare('SELECT * FROM products').get()).toEqual(product)
    expect(db.prepare('SELECT * FROM inventory_sessions').get()).toEqual(revision)
    expect(db.prepare('SELECT * FROM inventory_items').get()).toEqual(item)
    expect(recoverInventoryDocumentCopies(db)).toEqual({ queued: 0, skipped: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()).toEqual({ n: 1 })
  })

  it.each([null, 'SYNC_RESET_REQUIRED', 'Доставлено'])('does not resend an ordinary acknowledgement: %s', (error) => {
    db.prepare('UPDATE sync_outbox SET last_error = ?').run(error)
    expect(recoverInventoryDocumentCopies(db)).toEqual({ queued: 0, skipped: 0 })
    expect(row().status).toBe('synced')
  })

  it('restores a missing base only from the matching local revision, never from current stock', () => {
    db.prepare('UPDATE sync_outbox SET payload_json = ?').run(JSON.stringify({ id: 'revision', items: [{ product_id: 'product', counted_stock: 3 }] }))
    expect(recoverInventoryDocumentCopies(db)).toEqual({ queued: 1, skipped: 0 })
    expect(JSON.parse(row().payload_json)).toMatchObject({
      items: [{ product_id: 'product', counted_stock: 3, expected_stock: 8 }],
      document_copy_recovery: { expected_stock_from_local: ['product'] },
    })
    expect(db.prepare('SELECT qty_on_hand FROM products').get()).toEqual({ qty_on_hand: 2 })
  })

  it.each(['deleted', 'changed', 'foreign', 'invalid-base', 'corrupt'])('leaves ambiguous history untouched and visible: %s', (scenario) => {
    if (scenario === 'deleted') db.prepare("UPDATE inventory_sessions SET deleted_at = '2026-09-05'").run()
    if (scenario === 'changed') db.prepare('UPDATE inventory_items SET counted_stock = 4').run()
    if (scenario === 'foreign') db.prepare("UPDATE sync_outbox SET tenant_id = 'other'").run()
    if (scenario === 'invalid-base') db.prepare('UPDATE sync_outbox SET payload_json = ?').run(JSON.stringify({ items: [{ product_id: 'product', counted_stock: 3, expected_stock: false }] }))
    if (scenario === 'corrupt') db.prepare("UPDATE sync_outbox SET payload_json = '{'").run()
    const before = row()
    expect(recoverInventoryDocumentCopies(db)).toEqual({ queued: 0, skipped: 1 })
    expect(row()).toEqual(before)
    expect(db.prepare("SELECT COUNT(*) n FROM problem_log WHERE code = 'sync.inventory_copy_needs_review'").get()).toEqual({ n: 1 })
  })
})
