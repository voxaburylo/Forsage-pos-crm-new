import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { compactOutbox, previewOutboxCompaction } from '../src/repositories/outboxCompaction'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { isLanProxyChannel } from '../src/lan/localNetwork'
import { webRpcChannelAllowed } from '../src/lan/webRpcChannels'

// 24.11.2026 (план C9): стиснення старого журналу відправлених операцій.
describe('outbox journal compaction', () => {
  let root: string, db: LocalDatabase
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-outbox-')); db = new LocalDatabase(root) })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const now = new Date('2026-11-24T10:00:00Z')
  let n = 0
  const add = (type: string, status: string, created: string, payload = '{"name":"' + 'x'.repeat(500) + '"}') =>
    db.prepare(`INSERT INTO sync_outbox(operation_id, tenant_id, device_id, aggregate_type, aggregate_id, operation_type, payload_json, status, attempts, created_at)
      VALUES (?, ?, 'dev', 'x', ?, ?, ?, ?, 0, ?)`).run('op-' + ++n, DEFAULT_TENANT_ID, 'a-' + n, type, payload, status, created)
  const payloadOf = (id: string) => (db.prepare('SELECT payload_json FROM sync_outbox WHERE operation_id = ?').get(id) as { payload_json: string }).payload_json

  it('compacts only old, sent records of kinds nobody reads afterwards, and keeps every row', () => {
    add('product.upsert', 'synced', '2026-03-01T00:00:00Z')        // op-1: стиснеться
    add('supplier_invoice.posted', 'synced', '2026-04-01T00:00:00Z') // op-2: стиснеться
    add('product.upsert', 'synced', '2026-10-01T00:00:00Z')        // op-3: молодше 180 днів
    add('product.upsert', 'failed', '2026-03-01T00:00:00Z')        // op-4: не відправлено
    add('sale.completed', 'synced', '2026-03-01T00:00:00Z')        // op-5: продаж — ніколи
    add('return.created', 'synced', '2026-03-01T00:00:00Z')        // op-6: повернення — ніколи
    add('inventory.completed', 'synced', '2026-03-01T00:00:00Z')   // op-7: ревізія — ніколи
    const before = (db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number }).n
    const preview = previewOutboxCompaction(db, now)
    expect(preview).toMatchObject({ rows: 2, journal_rows: before })
    expect(preview.bytes).toBeGreaterThan(1000)
    const result = compactOutbox(db, now)
    expect(result.rows).toBe(2)
    expect(result.bytes).toBeGreaterThan(900)
    expect([payloadOf('op-1'), payloadOf('op-2')]).toEqual(['{"compacted":true}', '{"compacted":true}'])
    for (const id of ['op-3', 'op-4', 'op-5', 'op-6', 'op-7']) expect(payloadOf(id)).not.toBe('{"compacted":true}')
    expect((db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number }).n).toBe(before)
    // Повтор нічого не змінює.
    expect(compactOutbox(db, now)).toEqual({ rows: 0, bytes: 0 })
    expect(previewOutboxCompaction(db, now).rows).toBe(0)
  })

  it('only the owner runs it, only on this PC: never from the manager PC or the web', () => {
    for (const channel of ['desktop:maintenance:outbox-preview', 'desktop:maintenance:outbox-compact']) {
      for (const role of ['owner', 'admin']) expect(isDesktopChannelAllowed(channel, role)).toBe(true)
      for (const role of ['manager', 'cashier', 'storekeeper']) expect(isDesktopChannelAllowed(channel, role)).toBe(false)
      expect(isLanProxyChannel(channel)).toBe(false)
      expect(webRpcChannelAllowed(channel)).toBe(false)
    }
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain("if (!isMainTill()) throw new Error('Журнал обслуговується лише на головному ПК')")
  })
})
