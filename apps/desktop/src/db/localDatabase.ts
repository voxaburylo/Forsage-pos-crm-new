import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { backup, DatabaseSync, type StatementSync } from 'node:sqlite'
import { LOCAL_MIGRATIONS } from './schema'

export interface LocalDatabaseInfo {
  databasePath: string
  deviceId: string
  schemaVersion: number
  pendingOperations: number
}

export class LocalDatabase {
  private readonly database: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  readonly databasePath: string
  readonly backupsPath: string
  readonly deviceId: string

  constructor(dataRoot: string) {
    const dataPath = path.join(dataRoot, 'data')
    this.backupsPath = path.join(dataRoot, 'backups')
    mkdirSync(dataPath, { recursive: true })
    mkdirSync(this.backupsPath, { recursive: true })

    this.databasePath = path.join(dataPath, 'forsage.db')
    this.database = new DatabaseSync(this.databasePath, { timeout: 5_000 })
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
    `)

    this.migrate()
    this.assertIntegrity()
    this.deviceId = this.getOrCreateDeviceId()
  }

  private migrate(): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.exec(LOCAL_MIGRATIONS[0].sql)
      const appliedRows = this.database.prepare(
        'SELECT version FROM schema_migrations',
      ).all() as Array<{ version: number }>
      const applied = new Set(appliedRows.map((row) => row.version))

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


  async backupIfDue(maxAgeMs = 24 * 60 * 60_000, retain = 14): Promise<string | null> {
    const backupFiles = () => readdirSync(this.backupsPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^Forsage-\d{4}-\d{2}-\d{2}_.+\.db$/.test(entry.name))
      .map((entry) => {
        const filePath = path.join(this.backupsPath, entry.name)
        return { filePath, modifiedAt: statSync(filePath).mtimeMs }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt)

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
