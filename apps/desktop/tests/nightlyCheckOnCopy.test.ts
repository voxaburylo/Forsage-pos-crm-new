import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { runNightlyCheck } from '../src/diagnostics/nightlyCheck'

/**
 * 23.11.2026 (план T6): нічна перевірка на КОПІЇ справжньої бази (робоча не відкривається).
 *   FORSAGE_REHEARSAL_DB=<тека з data/forsage.db> pnpm --filter desktop exec vitest run tests/nightlyCheckOnCopy.test.ts
 * Без змінної — пропускається (у CI справжньої бази немає).
 */
const source = process.env.FORSAGE_REHEARSAL_DB
const sourceDb = source ? path.join(source, 'data', 'forsage.db') : ''
const run = source && existsSync(sourceDb) ? describe : describe.skip

run('nightly check on a copy of the real database', () => {
  it('reads the whole database quickly, changes nothing and reports in plain words', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'forsage-nightly-copy-'))
    mkdirSync(path.join(root, 'data'), { recursive: true })
    copyFileSync(sourceDb, path.join(root, 'data', 'forsage.db'))
    for (const suffix of ['-wal', '-shm']) if (existsSync(sourceDb + suffix)) copyFileSync(sourceDb + suffix, path.join(root, 'data', 'forsage.db' + suffix))
    const db = new LocalDatabase(root)
    try {
      const result = runNightlyCheck(db)
      console.log(JSON.stringify({ duration_ms: result.duration_ms, findings: result.findings.map(item => ({ code: item.code, count: item.count, detail: item.detail.slice(0, 400) })) }, null, 1))
      expect(result.duration_ms).toBeLessThan(60_000)
      expect(result.findings.some(item => item.code === 'nightly-db-file')).toBe(false)
    } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
