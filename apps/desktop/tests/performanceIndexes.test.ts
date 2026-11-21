import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LOCAL_SCHEMA_VERSION } from '../src/db/schema'

it('adds lookup indexes on open without raising the schema version (old builds can still open the base)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-indexes-'))
  try {
    const db = new LocalDatabase(root)
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(row => row.name)
    expect(names).toEqual(expect.arrayContaining(['idx_inventory_movements_source_id', 'idx_sync_outbox_aggregate']))
    expect(LOCAL_SCHEMA_VERSION).toBe(28)
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM inventory_movements WHERE source_id = ? ORDER BY id').all('x') as Array<{ detail: string }>
    expect(plan.map(row => row.detail).join(' ')).toContain('idx_inventory_movements_source_id')
    db.close()
  } finally { if (path.basename(root).startsWith('forsage-indexes-')) rmSync(root, { recursive: true, force: true }) }
})
