import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase, OutdatedBuildError } from '../src/db/localDatabase'
import { LOCAL_MIGRATIONS } from '../src/db/schema'

/**
 * 05.09.2026 касу запустили резервною копією exe від 19.08. База вже була
 * мігрована свіжою збіркою, стара програма відкрила її без жодного слова — і
 * її черга перестала повторювати застряглі операції. Каса «працювала», а
 * продажі на сервер не доїжджали.
 */
describe('стара збірка проти новішої бази', () => {
  let root = ''

  beforeEach(() => {
    root = path.join(tmpdir(), `forsage-outdated-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const databaseFile = () => path.join(root, 'data', 'forsage.db')
  const corruptDir = () => path.join(root, 'corrupt')

  function seedWorkingDatabase(): void {
    const database = new LocalDatabase(root)
    database.close()
  }

  function markSchemaVersion(version: number): void {
    const database = new DatabaseSync(databaseFile())
    database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(version, new Date().toISOString())
    database.close()
  }

  const latestKnownVersion = Math.max(...LOCAL_MIGRATIONS.map((migration) => migration.version))

  it('відкриває базу своєї версії як звичайно', () => {
    seedWorkingDatabase()

    const opened = LocalDatabase.open(root)

    expect(opened.recovery).toBeNull()
    expect(opened.database.info().schemaVersion).toBe(latestKnownVersion)
    opened.database.close()
  })

  it('відмовляється стартувати, якщо база новіша за програму', () => {
    seedWorkingDatabase()
    markSchemaVersion(latestKnownVersion + 1)

    let thrown: unknown = null
    try {
      LocalDatabase.open(root)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(OutdatedBuildError)
    const error = thrown as OutdatedBuildError
    expect(error.databaseVersion).toBe(latestKnownVersion + 1)
    expect(error.buildVersion).toBe(latestKnownVersion)
    expect(error.message).toContain('старіша за локальну базу')
  })

  it('не чіпає цілу базу: жодного карантину і жодного відкату на бекап', () => {
    seedWorkingDatabase()
    markSchemaVersion(latestKnownVersion + 5)

    expect(() => LocalDatabase.open(root)).toThrow(OutdatedBuildError)

    // Найгірше, що могла зробити стара збірка — «полікувати» цілу базу бекапом.
    expect(existsSync(corruptDir())).toBe(false)
    expect(existsSync(databaseFile())).toBe(true)

    const database = new DatabaseSync(databaseFile())
    const row = database.prepare('SELECT max(version) AS version FROM schema_migrations').get() as { version: number }
    database.close()
    expect(row.version).toBe(latestKnownVersion + 5)
  })
})
