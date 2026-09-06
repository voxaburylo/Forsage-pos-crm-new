import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { LOCAL_MIGRATIONS } from './schema'
import { createVerifiedBackup } from './verifiedBackup'
import { backupsToPrune } from './backupPolicy'

export interface LocalDatabaseInfo {
  databasePath: string
  deviceId: string
  schemaVersion: number
  pendingOperations: number
}

export interface LocalDatabaseBackup {
  fileName: string
  filePath: string
  sizeBytes: number
  createdAt: string
}

export class LocalDatabaseOpenError extends Error {
  constructor(readonly databasePath: string, cause: unknown) {
    super('Не вдалося відкрити робочу локальну базу. Автоматичний відкат або створення порожньої бази заборонено. '
      + 'Дані залишено на місці. Потрібно перевірити причину; не відновлюйте стару копію без звірки останніх документів.', { cause })
    this.name = 'LocalDatabaseOpenError'
  }
}

/**
 * База новіша за програму: на цьому компʼютері запустили стару збірку каси.
 *
 * Так уже було 05.09.2026 — касу відкрили резервною копією exe від 19.08, і
 * черга тієї збірки мовчки перестала повторювати 137 застряглих операцій, з
 * них 113 продажів. Ззовні каса виглядала цілком справною.
 *
 * Стара збірка не знає ні нових таблиць, ні нових правил черги, тому далі не
 * йдемо. Це НЕ пошкодження бази: відновлювати з бекапу тут не можна, інакше
 * старий exe відкотить магазин на добу назад.
 */
export class OutdatedBuildError extends Error {
  constructor(readonly databaseVersion: number, readonly buildVersion: number) {
    super(
      `Ця копія Форсажу старіша за локальну базу: база має версію ${databaseVersion}, `
      + `а програма знає лише ${buildVersion}. Запустіть актуальну версію каси.`,
    )
    this.name = 'OutdatedBuildError'
  }
}

export interface LocalDatabaseOpenResult {
  database: LocalDatabase
  /** Відкриття НІКОЛИ не підміняє робочу базу резервною копією. */
  recovery: null
}

const DATABASE_FILE = 'forsage.db'
/** WAL і SHM — частина стану бази. Їх не можна лишати від старого файлу. */
const SIDECAR_SUFFIXES = ['-wal', '-shm']
const BACKUP_FILE_PATTERN = /^Forsage-\d{4}-\d{2}-\d{2}_.+\.db$/
const DATABASE_IDENTITY_FILE = 'database-identity.json'

export class LocalDatabase {
  private readonly database: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private backupInProgress: Promise<string> | null = null
  readonly dataRoot: string
  readonly databasePath: string
  readonly backupsPath: string
  readonly deviceId: string

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot
    const dataPath = path.join(dataRoot, 'data')
    this.backupsPath = path.join(dataRoot, 'backups')
    mkdirSync(dataPath, { recursive: true })
    mkdirSync(this.backupsPath, { recursive: true })

    this.databasePath = path.join(dataPath, DATABASE_FILE)
    this.database = new DatabaseSync(this.databasePath, { timeout: 5_000 })

    // Якщо база бита, впаде щось із наступного — і тоді дескриптор ОБОВʼЯЗКОВО
    // треба закрити. Інакше Windows тримає файл заблокованим, і відновлення не
    // може навіть перейменувати його: `EBUSY: resource busy or locked`.
    let deviceId: string
    try {
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = FULL;
      `)
      this.migrate()
      this.assertIntegrity()
      deviceId = this.getOrCreateDeviceId()
    } catch (error) {
      try { this.database.close() } catch { /* уже закрита або не відкривалась */ }
      throw error
    }
    this.deviceId = deviceId
  }

  /** Помилка відкриття не є дозволом відкотити продажі, приходи й ревізії. */
  static open(dataRoot: string): LocalDatabaseOpenResult {
    const databasePath = path.join(dataRoot, 'data', DATABASE_FILE)
    const identityPath = path.join(dataRoot, DATABASE_IDENTITY_FILE)
    try {
      const missing = !existsSync(databasePath) || statSync(databasePath).size === 0
      if (missing && (existsSync(identityPath) || LocalDatabase.listBackups(dataRoot).length > 0
        || existsSync(path.join(dataRoot, 'corrupt'))
        || SIDECAR_SUFFIXES.some((suffix) => existsSync(`${databasePath}${suffix}`)))) {
        throw new Error('Робочий файл бази відсутній або порожній, але на ПК уже були дані магазину')
      }
      const database = new LocalDatabase(dataRoot)
      try {
        if (!existsSync(identityPath)) {
          writeFileSync(identityPath, JSON.stringify({ deviceId: database.deviceId }), { flag: 'wx' })
        }
      } catch (error) {
        database.close()
        throw error
      }
      return { database, recovery: null }
    } catch (error) {
      if (error instanceof OutdatedBuildError) throw error
      throw new LocalDatabaseOpenError(databasePath, error)
    }
  }

  /** Бекапи від найсвіжішого до найстарішого. */
  static listBackups(dataRoot: string): LocalDatabaseBackup[] {
    const backupsPath = path.join(dataRoot, 'backups')
    if (!existsSync(backupsPath)) return []
    return readdirSync(backupsPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && BACKUP_FILE_PATTERN.test(entry.name))
      .map((entry) => {
        const filePath = path.join(backupsPath, entry.name)
        const stats = statSync(filePath)
        return {
          fileName: entry.name,
          filePath,
          sizeBytes: stats.size,
          createdAt: new Date(stats.mtimeMs).toISOString(),
        }
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /**
   * Ставить ЯВНО обраний власником бекап на місце робочої бази.
   *
   * База МАЄ бути закрита. Далі програма перезапускається — тримати відкриті
   * репозиторії на підмінений файл не можна.
   */
  static stageBackupForRestart(dataRoot: string, fileName: string): LocalDatabaseBackup {
    const candidate = LocalDatabase.listBackups(dataRoot)
      .find((entry) => entry.fileName === fileName)
    if (!candidate) throw new Error('LOCAL_BACKUP_NOT_FOUND')

    // Спершу переконуємось, що копія взагалі відкривається, і лише потім
    // чіпаємо робочу базу. Інакше невдалий відкат залишив би касу без даних.
    LocalDatabase.assertBackupIsUsable(candidate.filePath)

    const quarantinedPath = LocalDatabase.quarantineBroken(dataRoot)
    try {
      LocalDatabase.stageDatabaseFile(dataRoot, candidate.filePath)
      return candidate
    } catch (error) {
      // Копіювання зірвалось (немає місця, файл зайнято) — повертаємо робочу
      // базу на місце, щоб каса лишилась працездатною.
      LocalDatabase.restoreQuarantined(dataRoot, quarantinedPath)
      throw error
    }
  }

  static assertBackupIsUsable(sourcePath: string): void {
    const probe = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 })
    try {
      const row = probe.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined
      if (row?.quick_check !== 'ok') throw new Error('LOCAL_BACKUP_CORRUPT')
      const version = probe.prepare('SELECT max(version) AS version FROM schema_migrations').get() as { version: number }
      const buildVersion = Math.max(...LOCAL_MIGRATIONS.map((migration) => migration.version))
      if (version.version > buildVersion) throw new OutdatedBuildError(version.version, buildVersion)
      if (!probe.prepare("SELECT value_json FROM app_meta WHERE key = 'device_id'").get()) {
        throw new Error('LOCAL_BACKUP_NOT_FORSAGE_DATABASE')
      }
    } finally {
      probe.close()
    }
  }

  private static restoreQuarantined(dataRoot: string, quarantinedPath: string): void {
    const databasePath = path.join(dataRoot, 'data', DATABASE_FILE)
    LocalDatabase.removeDatabaseFiles(dataRoot)
    if (existsSync(quarantinedPath)) renameSync(quarantinedPath, databasePath)
    for (const suffix of SIDECAR_SUFFIXES) {
      const sidecar = `${quarantinedPath}${suffix}`
      if (existsSync(sidecar)) renameSync(sidecar, `${databasePath}${suffix}`)
    }
  }

  /**
   * Відкладає поточні файли бази у `corrupt/`. Нічого не видаляє: у битій базі
   * можуть лишатись невідправлені продажі.
   */
  private static quarantineBroken(dataRoot: string): string {
    const databasePath = path.join(dataRoot, 'data', DATABASE_FILE)
    const quarantinePath = path.join(dataRoot, 'corrupt')
    mkdirSync(quarantinePath, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const destination = path.join(quarantinePath, `forsage-${stamp}-${randomUUID().slice(0, 8)}.db`)
    const moved: Array<{ from: string; to: string }> = []
    try {
      for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
        const from = `${databasePath}${suffix}`
        const to = `${destination}${suffix}`
        if (existsSync(from)) { renameSync(from, to); moved.push({ from, to }) }
      }
    } catch (error) {
      // Наприклад, антивірус утримує WAL: не лишаємо головний файл окремо
      // від його транзакцій через часткове переміщення.
      for (const entry of moved.reverse()) renameSync(entry.to, entry.from)
      throw error
    }
    return destination
  }

  private static stageDatabaseFile(dataRoot: string, sourcePath: string): void {
    const dataPath = path.join(dataRoot, 'data')
    mkdirSync(dataPath, { recursive: true })
    LocalDatabase.removeDatabaseFiles(dataRoot)
    copyFileSync(sourcePath, path.join(dataPath, DATABASE_FILE))
  }

  /**
   * Прибирає базу разом із WAL/SHM. Без цього SQLite накотить залишковий WAL
   * від попереднього файлу на щойно відновлений — і зіпсує його вдруге.
   */
  private static removeDatabaseFiles(dataRoot: string): void {
    const databasePath = path.join(dataRoot, 'data', DATABASE_FILE)
    for (const target of [databasePath, ...SIDECAR_SUFFIXES.map((suffix) => `${databasePath}${suffix}`)]) {
      if (existsSync(target)) unlinkSync(target)
    }
  }

  private migrate(): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.exec(LOCAL_MIGRATIONS[0].sql)
      const appliedRows = this.database.prepare(
        'SELECT version FROM schema_migrations',
      ).all() as Array<{ version: number }>
      const applied = new Set(appliedRows.map((row) => row.version))
      this.assertBuildIsNotOlderThanDatabase(applied)

      for (const migration of LOCAL_MIGRATIONS) {
        if (applied.has(migration.version)) continue
        this.database.exec(migration.sql)
        this.database.prepare(
          'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
        ).run(migration.version, new Date().toISOString())
      }

      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Міграції котяться лише вперед, тому версія бази, більша за найновішу
   * відому програмі, означає рівно одне: цей exe старіший за дані.
   */
  private assertBuildIsNotOlderThanDatabase(applied: ReadonlySet<number>): void {
    const databaseVersion = Math.max(0, ...applied)
    const buildVersion = Math.max(0, ...LOCAL_MIGRATIONS.map((migration) => migration.version))
    if (databaseVersion > buildVersion) throw new OutdatedBuildError(databaseVersion, buildVersion)
  }

  private assertIntegrity(): void {
    const row = this.database.prepare('PRAGMA quick_check').get() as
      | { quick_check: string }
      | undefined
    const result = row?.quick_check
    if (result !== 'ok') {
      throw new Error(`Локальна база пошкоджена: ${result ?? 'невідома помилка'}`)
    }
  }

  private getOrCreateDeviceId(): string {
    const row = this.database.prepare(
      "SELECT value_json FROM app_meta WHERE key = 'device_id'",
    ).get() as { value_json: string } | undefined
    if (row) return JSON.parse(row.value_json) as string

    const deviceId = randomUUID()
    this.database.prepare(`
      INSERT INTO app_meta(key, value_json, updated_at)
      VALUES ('device_id', ?, ?)
    `).run(JSON.stringify(deviceId), new Date().toISOString())
    return deviceId
  }

  exec(sql: string): void {
    this.database.exec(sql)
  }

  prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.database.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  transaction<T>(work: () => T): T {
    if (this.database.isTransaction) return work()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  info(): LocalDatabaseInfo {
    const pending = this.database.prepare(`
      SELECT count(*) AS count
      FROM sync_outbox
      WHERE status IN ('pending', 'failed')
    `).get() as { count: number }
    const schema = this.database.prepare(
      'SELECT max(version) AS version FROM schema_migrations',
    ).get() as { version: number | null }

    return {
      databasePath: this.databasePath,
      deviceId: this.deviceId,
      schemaVersion: schema.version ?? 0,
      pendingOperations: pending.count,
    }
  }


  /** Бекапи цієї бази — від найсвіжішого. */
  listBackups(): LocalDatabaseBackup[] {
    return LocalDatabase.listBackups(this.dataRoot)
  }

  async backupIfDue(maxAgeMs = 60 * 60_000, retain = 24): Promise<string | null> {
    if (this.backupInProgress) return this.backupInProgress
    const existing = this.listBackups()
    if (existing[0] && Date.now() - Date.parse(existing[0].createdAt) < Math.max(60_000, maxAgeMs)) {
      return null
    }

    const destination = await this.backupNow()
    for (const stale of backupsToPrune(this.listBackups(), retain)) {
      unlinkSync(stale.filePath)
    }
    return destination
  }

  backupNow(): Promise<string> {
    if (this.backupInProgress) return this.backupInProgress
    if (!this.database.isOpen) return Promise.reject(new Error('LOCAL_DATABASE_NOT_READY'))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
    const destination = path.join(this.backupsPath, `Forsage-${stamp}-${randomUUID().slice(0, 8)}.db`)
    const partial = `${destination}.partial`
    const operation = createVerifiedBackup(this.databasePath, partial).then(() => {
      // Неповний або неперевірений файл ніколи не потрапляє до списку копій.
      renameSync(partial, destination)
      return destination
    }).catch((error) => {
      if (existsSync(partial)) unlinkSync(partial)
      throw error
    })
    this.backupInProgress = operation
    const release = () => { if (this.backupInProgress === operation) this.backupInProgress = null }
    operation.then(release, release)
    return operation
  }

  async waitForBackup(): Promise<void> {
    await this.backupInProgress
  }

  close(): void {
    if (!this.database.isOpen) return
    try { this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)') }
    finally {
      this.statements.clear()
      this.database.close()
    }
  }
}
