import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { quickCheckInWorker } from '../src/db/verifiedBackup'
import { startBackupScheduler } from '../src/db/backupScheduler'

const roots: string[] = []
const root = () => { const dir = mkdtempSync(path.join(tmpdir(), 'forsage-cold-start-')); roots.push(dir); return dir }
afterEach(() => { vi.useRealTimers(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('cold start of the till (25.11.2026, owner: «cold start is long»)', () => {
  it('checks every page only after an unclean close: first open, crash or power cut', () => {
    const dataRoot = root()
    const first = LocalDatabase.open(dataRoot).database
    expect(first.integrityChecked).toBe(true)
    first.close()

    const afterCleanClose = LocalDatabase.open(dataRoot).database
    expect(afterCleanClose.integrityChecked).toBe(false)
    // Імітація збою: процес зник, close() не викликано — позначки штатного закриття немає.
    const databasePath = afterCleanClose.databasePath
    afterCleanClose.close()
    const raw = new DatabaseSync(databasePath)
    raw.prepare("DELETE FROM app_meta WHERE key = 'clean_close'").run()
    raw.close()

    const afterCrash = LocalDatabase.open(dataRoot).database
    expect(afterCrash.integrityChecked).toBe(true)
    afterCrash.close()
  })

  it('the open database never carries the clean mark, so a copy taken while it runs is checked when restored', () => {
    const dataRoot = root()
    LocalDatabase.open(dataRoot).database.close()
    const running = LocalDatabase.open(dataRoot).database
    const raw = new DatabaseSync(running.databasePath, { readOnly: true })
    expect(raw.prepare("SELECT 1 FROM app_meta WHERE key = 'clean_close'").get()).toBeUndefined()
    raw.close()
    running.close()
  })

  it('a worker checks the working database without blocking the till', async () => {
    const dataRoot = root()
    const db = LocalDatabase.open(dataRoot).database
    await expect(quickCheckInWorker(db.databasePath)).resolves.toBe('ok')
    db.close()
  })

  it('the hourly copy does not start in the first seconds after launch when a delay is given', async () => {
    vi.useFakeTimers()
    const backupIfDue = vi.fn(async () => null)
    const stop = startBackupScheduler({ backupIfDue } as never, () => {}, 3 * 60_000)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(backupIfDue).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(backupIfDue).toHaveBeenCalledOnce()
    stop()
  })

  it('the main PC delays copies, records startup phases and checks a skipped database later', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain('shiftBackups.start(2 * 60_000)')
    expect(main).toContain('externalBackups.start(4 * 60_000)')
    expect(main).toContain('}, 3 * 60_000)\n  startupPhase(\'services\')'.replace(/\n/g, main.includes('\r\n') ? '\r\n' : '\n'))
    expect(main).toContain("startupPhase('ready')")
    expect(main).toContain('quickCheckInWorker(checkedDb.databasePath)')
  })
})
