import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase, LocalDatabaseOpenError } from '../src/db/localDatabase'

describe('LocalDatabase.open never rolls back local truth', () => {
  let root = ''
  beforeEach(() => {
    root = path.join(tmpdir(), `forsage-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-recovery-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })
  const databaseFile = () => path.join(root, 'data', 'forsage.db')
  const quarantine = () => path.join(root, 'corrupt')

  it('opens healthy local data without recovery', () => {
    const first = LocalDatabase.open(root)
    const id = first.database.deviceId
    first.database.close()
    const opened = LocalDatabase.open(root)
    expect(opened.recovery).toBeNull()
    expect(opened.database.deviceId).toBe(id)
    opened.database.close()
    expect(existsSync(quarantine())).toBe(false)
  })

  it.each(['database is locked', 'disk I/O error', 'database or disk is full', 'permission denied', 'migration bug'])(
    'does not restore an older backup after %s', async (message) => {
      const db = new LocalDatabase(root)
      db.exec('CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES(1)')
      await db.backupNow()
      db.exec('UPDATE probe SET value = 2')
      db.close()
      vi.spyOn(LocalDatabase.prototype as any, 'migrate').mockImplementationOnce(() => { throw new Error(message) })
      expect(() => LocalDatabase.open(root)).toThrow(LocalDatabaseOpenError)
      expect(existsSync(quarantine())).toBe(false)
      const opened = LocalDatabase.open(root)
      expect(opened.database.prepare('SELECT value FROM probe').get()).toEqual({ value: 2 })
      opened.database.close()
    },
  )

  it.each([true, false])('does not replace a corrupt database, backup present = %s', async (withBackup) => {
    const db = new LocalDatabase(root)
    if (withBackup) await db.backupNow()
    db.close()
    writeFileSync(databaseFile(), 'пошкоджена база — останні документи ще можуть бути тут', 'utf8')
    const before = readFileSync(databaseFile())
    expect(() => LocalDatabase.open(root)).toThrow(LocalDatabaseOpenError)
    expect(readFileSync(databaseFile())).toEqual(before)
    expect(existsSync(quarantine())).toBe(false)
  })

  it('never creates an empty replacement when the working file disappears', () => {
    LocalDatabase.open(root).database.close()
    unlinkSync(databaseFile())
    expect(() => LocalDatabase.open(root)).toThrow(LocalDatabaseOpenError)
    expect(existsSync(databaseFile())).toBe(false)
  })

  it('detects a missing old-install database by its backups, even before the identity marker exists', async () => {
    const db = new LocalDatabase(root)
    await db.backupNow()
    db.close()
    unlinkSync(databaseFile())
    expect(() => LocalDatabase.open(root)).toThrow(LocalDatabaseOpenError)
    expect(existsSync(databaseFile())).toBe(false)
  })

  it('refuses a zero-byte working file instead of showing zero stock', () => {
    LocalDatabase.open(root).database.close()
    writeFileSync(databaseFile(), '')
    expect(() => LocalDatabase.open(root)).toThrow(LocalDatabaseOpenError)
    expect(readFileSync(databaseFile()).length).toBe(0)
  })
})

describe('LocalDatabase.stageBackupForRestart', () => {
  let root = ''

  beforeEach(() => {
    root = path.join(tmpdir(), `forsage-restore-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects an unknown backup name', () => {
    new LocalDatabase(root).close()
    expect(() => LocalDatabase.stageBackupForRestart(root, 'Forsage-2020-01-01_00-00-00.db'))
      .toThrow('LOCAL_BACKUP_NOT_FOUND')
  })

  it('refuses a corrupt backup and leaves the working database in place', async () => {
    const database = new LocalDatabase(root)
    const deviceId = database.deviceId
    await database.backupNow()
    database.close()

    const backups = LocalDatabase.listBackups(root)
    writeFileSync(backups[0].filePath, 'пошкоджена копія', 'utf8')

    expect(() => LocalDatabase.stageBackupForRestart(root, backups[0].fileName)).toThrow()

    // Найважливіше: невдалий відкат не має залишити касу без даних.
    const reopened = LocalDatabase.open(root)
    expect(reopened.recovery).toBeNull()
    expect(reopened.database.deviceId).toBe(deviceId)
    reopened.database.close()
  })

  it('puts the chosen backup in place and keeps the previous database', async () => {
    const database = new LocalDatabase(root)
    const deviceId = database.deviceId
    await database.backupNow()
    database.close()

    const backups = LocalDatabase.listBackups(root)
    const staged = LocalDatabase.stageBackupForRestart(root, backups[0].fileName)

    expect(staged.fileName).toBe(backups[0].fileName)
    const reopened = LocalDatabase.open(root)
    expect(reopened.recovery).toBeNull()
    expect(reopened.database.deviceId).toBe(deviceId)
    reopened.database.close()
    expect(readdirSync(path.join(root, 'corrupt')).length).toBeGreaterThan(0)
  })
})
