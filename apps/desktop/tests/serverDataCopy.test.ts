import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SERVER_DATA_EVERY_MS, SERVER_DATA_KEY, SERVER_DATA_MAX_BYTES, serverDataDue, storeServerData } from '../src/backup/serverDataCopy'

// 22.11.2026: дані, що живуть лише в хмарі, головний ПК раз на добу кладе у власну базу — так вони є в кожній її копії.
function database() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)')
  return db
}
const payload = (over: Record<string, unknown> = {}) => ({ version: 1, exported_at: '2026-11-22T17:00:00.000Z', tenant_id: 't',
  tables: { product_waitlist: [{ id: 1, phone: '0671234567' }] }, ai_rules: [], errors: {}, ...over })

describe('cloud-only data is kept inside the till database', () => {
  it('is due at first, then once a day', () => {
    const db = database(), now = new Date('2026-11-22T18:00:00Z')
    expect(serverDataDue(db, now)).toBe(true)
    expect(storeServerData(db, payload(), now)).toMatchObject({ stored: true })
    expect(serverDataDue(db, new Date(now.getTime() + SERVER_DATA_EVERY_MS - 1))).toBe(false)
    expect(serverDataDue(db, new Date(now.getTime() + SERVER_DATA_EVERY_MS))).toBe(true)
  })

  it('stores the copy as is and replaces the previous one', () => {
    const db = database()
    storeServerData(db, payload(), new Date('2026-11-22T18:00:00Z'))
    storeServerData(db, payload({ tables: { product_waitlist: [] } }), new Date('2026-11-23T18:00:00Z'))
    const rows = db.prepare('SELECT key, value_json, updated_at FROM app_meta').all() as Array<{ key: string; value_json: string; updated_at: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe(SERVER_DATA_KEY)
    expect(JSON.parse(rows[0].value_json).tables).toEqual({ product_waitlist: [] })
    expect(rows[0].updated_at).toBe('2026-11-23T18:00:00.000Z')
  })

  it('never overwrites a good copy with an empty, foreign or oversized answer', () => {
    const db = database(), now = new Date('2026-11-22T18:00:00Z')
    storeServerData(db, payload(), now)
    const before = db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(SERVER_DATA_KEY)
    for (const bad of [null, 'text', [], {}, { version: 2, tables: {}, exported_at: 'x' }, payload({ tables: [] }), payload({ exported_at: 5 }), { error: 'x' }])
      expect(storeServerData(db, bad, now)).toMatchObject({ stored: false, reason: 'unexpected-shape' })
    const huge = payload({ tables: { telegram_messages: [{ text: 'я'.repeat(SERVER_DATA_MAX_BYTES) }] } })
    expect(storeServerData(db, huge, now)).toMatchObject({ stored: false, reason: 'too-large' })
    expect(db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(SERVER_DATA_KEY)).toEqual(before)
  })

  it('runs only on the main PC, through the link key, away from the working data', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const block = main.slice(main.indexOf('const copyServerData = async'), main.indexOf('setInterval(() => { void copyServerData()'))
    expect(block).toContain('!isMainTill()')
    expect(block).toContain('databaseMaintenance')
    expect(block).toContain('getTillDeviceLink().serverData()')
    const source = readFileSync(new URL('../src/backup/serverDataCopy.ts', import.meta.url), 'utf8')
    expect(source.match(/INSERT INTO (\w+)/g)).toEqual(['INSERT INTO app_meta'])
  })
})
