import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { rememberedManagerClient } from '../src/lan/lanClientMemory'

// 26.11.2026 (план T7): версія ПК менеджера на «Стан системи» не зникає після перезапуску каси.
describe('manager PC version survives a restart of the main PC', () => {
  let root: string, db: LocalDatabase
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-lan-seen-')); db = new LocalDatabase(root) })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

  it('remembers what it saw and gives it back when the memory is empty after a restart', () => {
    expect(rememberedManagerClient(db, null)).toBeNull()
    const seen = { release_id: '20261126T130913-44b10d124f13', seen_at: '2026-11-26T14:00:00.000Z' }
    expect(rememberedManagerClient(db, seen)).toEqual(seen)
    expect(rememberedManagerClient(db, null)).toEqual(seen)
    const newer = { release_id: '20261127T090000-aaaaaaaaaaaa', seen_at: '2026-11-27T09:00:00.000Z' }
    expect(rememberedManagerClient(db, newer)).toEqual(newer)
    expect(rememberedManagerClient(db, null)).toEqual(newer)
  })

  it('an old manager program without a version is remembered as «unknown»; junk is never stored (letter «s» check)', () => {
    expect(rememberedManagerClient(db, { release_id: null, seen_at: '2026-11-26T14:00:00Z' })).toEqual({ release_id: null, seen_at: '2026-11-26T14:00:00.000Z' })
    expect(rememberedManagerClient(db, { release_id: "s'; DROP TABLE x", seen_at: '2026-11-26T15:00:00Z' })?.release_id).toBeNull()
    expect(rememberedManagerClient(db, { release_id: 'x', seen_at: 'not a date' })?.seen_at).toBe('2026-11-26T15:00:00.000Z')
  })
})
