import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { backup, DatabaseSync, type StatementSync } from 'node:sqlite'
import { LOCAL_MIGRATIONS } from './schema'

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

/**
 * Що саме сталося, коли базу не вдалося відкрити. Показуємо власнику: він має
 * розуміти, за який період дані могли не долетіти на сервер.
 */
export type LocalDatabaseRecovery = {
  /** Куди відклали пошкоджений файл — його ще можна віддати розробнику. */
  quarantinedPath: string
  /** Початкова помилка відкриття. */
  reason: string
} & (
  | { kind: 'backup'; restoredFrom: string; backupCreatedAt: string }
  | { kind: 'empty' }
)

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
  /** `null` — база відкрилася звичайно, нічого відновлювати не довелося. */
  recovery: LocalDatabaseRecovery | null
}

const DATABASE_FILE = 'forsage.db'
/** WAL і SHM — частина стану бази. Їх не можна лишати від старого файлу. */
const SIDECAR_SUFFIXES = ['-wal', '-shm']
const BACKUP_FILE_PATTERN = /^Forsage-\d{4}-\d{2}-\d{2}_.+\.db$/

export class LocalDatabase {
  private readonly database: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
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

  /**
   * Єдина точка відкриття локальної бази при старті каси.
   *
   * Раніше пошкоджений файл означав мертву касу: конструктор кидав виняток,
   * Electron показував «Forsage не запустився» — і це при тому, що поруч
   * лежало до 14 добових бекапів, якими ніхто не міг скористатися.
   *
   * Тепер: відкладаємо биту базу вбік (не видаляємо — там можуть бути
   * невідправлені чеки, які ще дістане розробник) і піднімаємо найсвіжіший
   * бекап, що реально відкривається. Якщо не відкривається жоден — стартуємо
   * з порожньою базою, щоб касир зміг увійти онлайн і завантажити дані заново.
   * Порожня каса — погано, але мертва каса гірша.
   */
  static open(dataRoot: string): LocalDatabaseOpenResult {
    try {
      return { database: new LocalDatabase(dataRoot), recovery: null }
    } catch (error) {
      // Стару збірку бекапом не лікують: база ціла, помилилися з ярликом.
      if (error instanceof OutdatedBuildError) throw error
      return LocalDatabase.recover(dataRoot, error)
    }
  }

  private static recover(dataRoot: string, error: unknown): LocalDatabaseOpenResult {
    const reason = error instanceof Error ? error.message : String(error)
    const quarantinedPath = LocalDatabase.quarantineBroken(dataRoot)

    for (const candidate of LocalDatabase.listBackups(dataRoot)) {
      try {
        LocalDatabase.stageDatabaseFile(dataRoot, candidate.filePath)
        const database = new LocalDatabase(dataRoot)
        return {
          database,
          recovery: {
            kind: 'backup',
            quarantinedPath,
            reason,
            restoredFrom: candidate.fileName,
            backupCreatedAt: candidate.createdAt,
          },
        }
      } catch {
        // Цей бекап теж не відкривається — прибираємо його спробу й беремо
        // наступний за свіжістю.
        LocalDatabase.removeDatabaseFiles(dataRoot)
      }
    }

    return {
      database: new LocalDatabase(dataRoot),
      recovery: { kind: 'empty', quarantinedPath, reason },
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
   * Ставить обраний бекап на місце робочої бази. Викликається при старті
   * (автовідновлення) і з налаштувань перед перезапуском програми.
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

  private static assertBackupIsUsable(sourcePath: string): void {
    const probe = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 })
    try {
      const row = probe.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined
      if (row?.quick_check !== 'ok') throw new Error('LOCAL_BACKUP_CORRUPT')
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
    const destination = path.join(quarantinePath, `forsage-${stamp}.db`)

    if (existsSync(databasePath)) renameSync(databasePath, destination)
    for (const suffix of SIDECAR_SUFFIXES) {
      const sidecar = `${databasePath}${suffix}`
      if (existsSync(sidecar)) renameSync(sidecar, `${destination}${suffix}`)
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

  async backupIfDue(maxAgeMs = 24 * 60 * 60_000, retain = 14): Promise<string | null> {
    const backupFiles = () => this.listBackups()
      .map((entry) => ({ filePath: entry.filePath, modifiedAt: Date.parse(entry.createdAt) }))

    const existing = backupFiles()
    if (existing[0] && Date.now() - existing[0].modifiedAt < Math.max(60_000, maxAgeMs)) {
      return null
    }

    const destination = await this.backupNow()
    const keepCount = Math.max(1, Math.floor(retain))
    for (const stale of backupFiles().slice(keepCount)) {
      unlinkSync(stale.filePath)
    }
    return destination
  }

  async backupNow(): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
    const destination = path.join(this.backupsPath, `Forsage-${stamp}.db`)
    await backup(this.database, destination)
    return destination
  }

  close(): void {
    if (!this.database.isOpen) return
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.statements.clear()
    this.database.close()
  }
}
