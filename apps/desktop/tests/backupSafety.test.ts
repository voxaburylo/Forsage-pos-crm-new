import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase, type LocalDatabaseBackup } from '../src/db/localDatabase'
import { backupsToPrune } from '../src/db/backupPolicy'
import { startBackupScheduler } from '../src/db/backupScheduler'

describe('verified local backups', () => {
  let root = ''
  let db: LocalDatabase | undefined
  afterEach(async () => {
    await db?.waitForBackup().catch(() => {})
    db?.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-backup-test-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })
  function create() {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-backup-test-'))
    db = new LocalDatabase(root)
    return db
  }

  it('joins concurrent manual and scheduled requests and publishes only a verified file', async () => {
    const database = create()
    const first = database.backupNow()
    const second = database.backupNow()
    expect(first).toBe(second)
    expect(database.listBackups()).toHaveLength(0)
    const [a, b, c] = await Promise.all([first, second, database.backupIfDue()])
    expect(a).toBe(b)
    expect(a).toBe(c)
    expect(database.listBackups()).toHaveLength(1)
    LocalDatabase.assertBackupIsUsable(a)
    expect(readdirSync(database.backupsPath)).toEqual([path.basename(a)])
    expect(await database.backupIfDue()).toBeNull()
  })

  it('copies WAL transactions coherently while the main connection keeps writing', async () => {
    const database = create()
    database.exec('CREATE TABLE balances(a INTEGER, b INTEGER); INSERT INTO balances VALUES(0, 1000)')
    let writes = 0
    const timer = setInterval(() => {
      database.transaction(() => database.exec('UPDATE balances SET a = a + 1, b = b - 1'))
      writes++
    }, 1)
    let destination: string
    try { destination = await database.backupNow() }
    finally { clearInterval(timer) }
    expect(writes).toBeGreaterThan(0)
    const copy = new DatabaseSync(destination!, { readOnly: true })
    try {
      expect(copy.prepare('SELECT a + b AS total FROM balances').get()).toEqual({ total: 1000 })
      expect(copy.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    } finally { copy.close() }
  })

  it('a failed backup does not replace a good one or change working rows', async () => {
    const database = create()
    const good = await database.backupNow()
    database.exec('DROP TABLE sync_outbox') // Isolated fixture: force verification to fail.
    await expect(database.backupNow()).rejects.toThrow('LOCAL_BACKUP_MISSING_TABLE')
    expect(database.listBackups().map(b => b.filePath)).toEqual([good])
    expect(readdirSync(database.backupsPath).some(name => name.endsWith('.partial'))).toBe(false)
    expect(database.deviceId).toBeTruthy()
    LocalDatabase.assertBackupIsUsable(good)
  })
})

describe('backup schedule and retention', () => {
  afterEach(() => vi.useRealTimers())
  it('runs during a long session, retries failures, and stops without overlapping jobs', async () => {
    vi.useFakeTimers()
    const errors = vi.fn()
    let release!: () => void
    const backupIfDue = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
      .mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(null)
    const stop = startBackupScheduler({ backupIfDue, waitForBackup: async () => {} }, errors)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(backupIfDue).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(errors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(backupIfDue).toHaveBeenCalledTimes(3)
    stop()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(backupIfDue).toHaveBeenCalledTimes(3)
  })

  it('keeps hourly points without erasing the daily history in the same day', () => {
    const files: LocalDatabaseBackup[] = Array.from({ length: 20 * 24 }, (_, hour) => ({
      fileName: `backup-${hour}`, filePath: `backup-${hour}`, sizeBytes: 10,
      createdAt: new Date(Date.UTC(2026, 8, 6, 23) - hour * 60 * 60_000).toISOString(),
    }))
    const stale = new Set(backupsToPrune(files).map(b => b.filePath))
    const kept = files.filter(b => !stale.has(b.filePath))
    expect(files.slice(0, 24).every(b => !stale.has(b.filePath))).toBe(true)
    expect(new Set(kept.map(b => b.createdAt.slice(0, 10))).size).toBe(14)
    expect(kept).toHaveLength(37)
  })
})
