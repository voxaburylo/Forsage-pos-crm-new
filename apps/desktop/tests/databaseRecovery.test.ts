import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'

describe('LocalDatabase.open recovery', () => {
  let root = ''

  beforeEach(() => {
    root = path.join(tmpdir(), `forsage-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const databaseFile = () => path.join(root, 'data', 'forsage.db')
  const corruptDir = () => path.join(root, 'corrupt')

  function seedWorkingDatabase(): string {
    const database = new LocalDatabase(root)
    const deviceId = database.deviceId
    database.close()
    return deviceId
  }

  function corruptDatabaseFile(): void {
    writeFileSync(databaseFile(), 'це не база даних, а сміття', 'utf8')
  }

  it('opens normally and reports no recovery when the database is healthy', () => {
    const deviceId = seedWorkingDatabase()

    const opened = LocalDatabase.open(root)

    expect(opened.recovery).toBeNull()
    expect(opened.database.deviceId).toBe(deviceId)
    opened.database.close()
    expect(existsSync(corruptDir())).toBe(false)
  })

  it('restores the newest backup instead of refusing to start', async () => {
    const deviceId = seedWorkingDatabase()
    const database = new LocalDatabase(root)
    await database.backupNow()
    database.close()

    corruptDatabaseFile()
    const opened = LocalDatabase.open(root)

    expect(opened.recovery?.kind).toBe('backup')
    // Той самий device_id доводить, що піднялася саме наша база, а не порожня.
    expect(opened.database.deviceId).toBe(deviceId)
    opened.database.close()
  })

  it('keeps the broken file instead of deleting it', async () => {
    seedWorkingDatabase()
    const database = new LocalDatabase(root)
    await database.backupNow()
    database.close()

    corruptDatabaseFile()
    const opened = LocalDatabase.open(root)
    opened.database.close()

    const quarantined = opened.recovery?.quarantinedPath ?? ''
    expect(existsSync(quarantined)).toBe(true)
    // У битій базі можуть лишатись невідправлені чеки — її не можна видаляти.
    expect(readFileSync(quarantined, 'utf8')).toContain('сміття')
  })

  it('never leaves a stale WAL next to the restored database', async () => {
    seedWorkingDatabase()
    const database = new LocalDatabase(root)
    await database.backupNow()
    database.close()

    corruptDatabaseFile()
    writeFileSync(`${databaseFile()}-wal`, 'залишковий wal', 'utf8')
    writeFileSync(`${databaseFile()}-shm`, 'залишковий shm', 'utf8')

    const opened = LocalDatabase.open(root)
    opened.database.close()

    // Старий WAL містить закомічені транзакції побитої бази. Якщо лишити його
    // поруч із відновленою — SQLite накотить його зверху й зіпсує її вдруге.
    // Куди саме він подівся (карантин чи прибирання самою SQLite при закритті)
    // не важливо — важливо, що біля відновленої бази його вмісту немає.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${databaseFile()}${suffix}`
      const content = existsSync(sidecar) ? readFileSync(sidecar, 'utf8') : ''
      expect(content).not.toContain('залишковий')
    }
    // А сама бита база при цьому збережена.
    expect(readdirSync(corruptDir()).length).toBeGreaterThan(0)
  })

  it('falls back to an empty database when no backup can be opened', () => {
    seedWorkingDatabase()
    const backupsPath = path.join(root, 'backups')
    mkdirSync(backupsPath, { recursive: true })
    writeFileSync(path.join(backupsPath, 'Forsage-2026-01-01_00-00-00.db'), 'теж сміття', 'utf8')

    corruptDatabaseFile()
    const opened = LocalDatabase.open(root)

    // Порожня каса погана, але мертва каса гірша: касир зможе увійти онлайн
    // і завантажити дані заново.
    expect(opened.recovery?.kind).toBe('empty')
    expect(opened.database.info().schemaVersion).toBeGreaterThan(0)
    opened.database.close()
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
