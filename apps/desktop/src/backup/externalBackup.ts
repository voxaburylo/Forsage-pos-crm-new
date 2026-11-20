import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  statSync, statfsSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'
import path from 'node:path'

/**
 * Друга копія бази поза диском C: (флешка або зовнішній диск). Рішення власника 17.11.2026.
 * Береться остання перевірена погодинна копія, стискається, поряд кладеться SHA-256,
 * записане читається назад і звіряється. Немає носія — не помилка, а нагадування.
 */
export const EXTERNAL_FOLDER_NAME = 'Forsage-копії'
export const EXTERNAL_CONFIG_FILE = 'external-backup.json'
export const EXTERNAL_INTERVAL_MS = 24 * 60 * 60_000
export const EXTERNAL_STALE_MS = 2 * 24 * 60 * 60_000
export const EXTERNAL_KEEP = 30
const MIN_KEEP_WHEN_FULL = 3
const MAX_RESTORED_DB_BYTES = 4 * 1024 * 1024 * 1024
const ARCHIVE = /^Forsage-(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-[a-f0-9]{8}\.db\.gz$/

export interface ExternalBackupConfig { folder: string | null; last_copy_at: string | null; last_error: string | null }
export interface ExternalCopy { fileName: string; sizeBytes: number; createdAt: string; sha256: string | null }
export interface ExternalStatus {
  folder: string | null
  available: boolean
  same_drive: boolean
  last_copy_at: string | null
  last_error: string | null
  stale: boolean
  copies: ExternalCopy[]
}

const configPath = (dataRoot: string) => path.join(dataRoot, EXTERNAL_CONFIG_FILE)
const driveOf = (value: string) => path.parse(path.resolve(value)).root.toLowerCase()

export function readExternalConfig(dataRoot: string): ExternalBackupConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(dataRoot), 'utf8'))
    return {
      folder: typeof raw.folder === 'string' && path.isAbsolute(raw.folder) ? raw.folder : null,
      last_copy_at: typeof raw.last_copy_at === 'string' ? raw.last_copy_at : null,
      last_error: typeof raw.last_error === 'string' ? raw.last_error : null,
    }
  } catch { return { folder: null, last_copy_at: null, last_error: null } }
}

export function writeExternalConfig(dataRoot: string, config: ExternalBackupConfig) {
  const target = configPath(dataRoot), partial = target + '.' + randomUUID().slice(0, 8) + '.partial'
  writeFileSync(partial, JSON.stringify(config, null, 2), 'utf8')
  renameSync(partial, target)
}

/** Нова папка: лише абсолютний шлях і не всередині даних програми. */
export function setExternalFolder(dataRoot: string, folder: string | null): ExternalBackupConfig {
  const current = readExternalConfig(dataRoot)
  if (folder !== null) {
    if (!path.isAbsolute(folder)) throw new Error('Вкажіть повний шлях до папки')
    const resolved = path.resolve(folder), root = path.resolve(dataRoot)
    if ((resolved + path.sep).toLowerCase().startsWith((root + path.sep).toLowerCase()))
      throw new Error('Оберіть флешку або зовнішній диск, а не папку з даними програми')
  }
  const next = { folder: folder === null ? null : path.resolve(folder), last_copy_at: folder === current.folder ? current.last_copy_at : null, last_error: null }
  writeExternalConfig(dataRoot, next)
  return next
}

function copyDirectory(folder: string) { return path.join(folder, EXTERNAL_FOLDER_NAME) }

function isAvailable(folder: string | null): boolean {
  if (!folder) return false
  try { return statSync(folder).isDirectory() } catch { return false }
}

export function listExternalCopies(folder: string): ExternalCopy[] {
  const dir = copyDirectory(folder)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && ARCHIVE.test(entry.name))
    .map(entry => {
      const filePath = path.join(dir, entry.name)
      const [, day, hh, mm] = ARCHIVE.exec(entry.name)!
      let sha256: string | null = null
      try { sha256 = /^([a-f0-9]{64})\b/.exec(readFileSync(filePath + '.sha256', 'utf8'))?.[1] ?? null } catch { /* без контрольної суми */ }
      return { fileName: entry.name, sizeBytes: statSync(filePath).size, createdAt: `${day}T${hh}:${mm}`, sha256 }
    })
    .sort((a, b) => b.fileName.localeCompare(a.fileName))
}

export function externalStatus(dataRoot: string, now = Date.now()): ExternalStatus {
  const config = readExternalConfig(dataRoot)
  const available = isAvailable(config.folder)
  const last = config.last_copy_at ? Date.parse(config.last_copy_at) : NaN
  return {
    folder: config.folder,
    available,
    same_drive: Boolean(config.folder) && driveOf(config.folder!) === driveOf(dataRoot),
    last_copy_at: config.last_copy_at,
    last_error: config.last_error,
    stale: Boolean(config.folder) && (!Number.isFinite(last) || now - last > EXTERNAL_STALE_MS),
    copies: available ? listExternalCopies(config.folder!) : [],
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function removeQuietly(file: string) { try { if (existsSync(file)) unlinkSync(file) } catch { /* залишиться тимчасовий файл */ } }

/** Стисла копія + SHA-256 на носій; записане читається назад і звіряється. */
export async function writeExternalCopy(sourceDb: string, folder: string, now = new Date()): Promise<ExternalCopy> {
  const dir = copyDirectory(folder)
  mkdirSync(dir, { recursive: true })
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString()
  const fileName = `Forsage-${local.slice(0, 10)}_${local.slice(11, 13)}-${local.slice(14, 16)}-${randomUUID().slice(0, 8)}.db.gz`
  const finalPath = path.join(dir, fileName), partial = finalPath + '.partial'
  try {
    const hash = createHash('sha256')
    const tap = new Transform({ transform(chunk, _enc, done) { hash.update(chunk); done(null, chunk) } })
    await pipeline(createReadStream(sourceDb), createGzip({ level: 6 }), tap, createWriteStream(partial, { flags: 'wx' }))
    const written = hash.digest('hex')
    // Флешка може «прийняти» запис і втратити його: звіряємо те, що реально лежить на носії.
    if (await sha256File(partial) !== written) throw new Error('Копія на носії не збігається із записаною. Перевірте флешку.')
    writeFileSync(finalPath + '.sha256', `${written}  ${fileName}\n`, 'utf8')
    renameSync(partial, finalPath)
    return { fileName, sizeBytes: statSync(finalPath).size, createdAt: local.slice(0, 16), sha256: written }
  } catch (error) {
    removeQuietly(partial)
    removeQuietly(finalPath + '.sha256')
    throw error
  }
}

/** Лишаємо `keep` найсвіжіших; якщо місця мало — прибираємо старі, але не менше трьох копій. */
export function pruneExternalCopies(folder: string, keep = EXTERNAL_KEEP, freeBytes?: () => number): string[] {
  const copies = listExternalCopies(folder)
  const removed: string[] = []
  const remove = (copy: ExternalCopy) => {
    const file = path.join(copyDirectory(folder), copy.fileName)
    unlinkSync(file); removeQuietly(file + '.sha256'); removed.push(copy.fileName)
  }
  for (const copy of copies.slice(Math.max(1, keep))) remove(copy)
  const left = copies.slice(0, Math.max(1, keep))
  const newest = left[0]
  const free = freeBytes ?? (() => { const s = statfsSync(folder); return Number(s.bavail) * Number(s.bsize) })
  while (newest && left.length > MIN_KEEP_WHEN_FULL && free() < newest.sizeBytes * 2) remove(left.pop()!)
  return removed
}

/**
 * Копія з носія → файл у папці копій цього ПК; далі штатне «Відновити» (як для хмарної копії).
 * Без збігу контрольної суми файл не використовується.
 */
export async function importExternalCopy(folder: string, fileName: string, backupsDir: string,
  assertUsable: (file: string) => void, now = new Date()): Promise<{ fileName: string; sizeBytes: number }> {
  if (!ARCHIVE.test(fileName)) throw new Error('Некоректна назва копії')
  const source = path.join(copyDirectory(folder), fileName)
  const copy = listExternalCopies(folder).find(item => item.fileName === fileName)
  if (!copy) throw new Error('Копію на носії не знайдено')
  if (!copy.sha256) throw new Error('Поруч із копією немає контрольної суми (.sha256). Файл не використано.')
  if (await sha256File(source) !== copy.sha256) throw new Error('Контрольна сума копії не збігається. Файл не використано.')
  mkdirSync(backupsDir, { recursive: true })
  const target = `Forsage-${now.toISOString().slice(0, 10)}_usb-${fileName.slice(-14, -6)}.db`
  const finalPath = path.join(backupsDir, target), partial = finalPath + '.partial'
  if (existsSync(finalPath)) return { fileName: target, sizeBytes: statSync(finalPath).size }
  try {
    let total = 0
    const limit = new Transform({ transform(chunk, _enc, done) {
      total += chunk.length
      done(total > MAX_RESTORED_DB_BYTES ? new Error('Розпакована база неприпустимо велика') : null, chunk)
    } })
    await pipeline(createReadStream(source), createGunzip(), limit, createWriteStream(partial, { flags: 'wx' }))
    assertUsable(partial)
    renameSync(partial, finalPath)
    return { fileName: target, sizeBytes: statSync(finalPath).size }
  } finally { removeQuietly(partial) }
}

type BackupSource = { listBackups(): Array<{ filePath: string; createdAt: string }>; backupNow(): Promise<string> }

/** Раз на добу, коли носій підключено; перевірка кожні 10 хв, тож вставлена пізніше флешка дописується сама. */
export class ExternalBackupService {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<ExternalCopy> | null = null
  constructor(private readonly dataRoot: string, private readonly database: BackupSource,
    private readonly onError: (error: unknown) => void) {}

  start() {
    void this.runIfDue()
    this.timer = setInterval(() => { void this.runIfDue() }, 10 * 60_000)
    this.timer.unref?.()
  }

  async stop() { if (this.timer) clearInterval(this.timer); this.timer = null; await this.running?.catch(() => null) }

  status(now = Date.now()): ExternalStatus & { running: boolean } {
    return { ...externalStatus(this.dataRoot, now), running: this.running !== null }
  }

  runIfDue(now = Date.now()): Promise<ExternalCopy | null> {
    const config = readExternalConfig(this.dataRoot)
    if (!config.folder || !isAvailable(config.folder)) return Promise.resolve(null)
    const last = config.last_copy_at ? Date.parse(config.last_copy_at) : NaN
    if (Number.isFinite(last) && now - last < EXTERNAL_INTERVAL_MS) return Promise.resolve(null)
    return this.runNow().catch(error => { this.onError(error); return null })
  }

  runNow(): Promise<ExternalCopy> {
    if (this.running) return this.running
    const task = (async () => {
      const config = readExternalConfig(this.dataRoot)
      if (!config.folder) throw new Error('Папку для копій не вибрано')
      if (!isAvailable(config.folder)) throw new Error('Флешку або диск не підключено')
      try {
        // Береться свіжа перевірена копія, а не робоча база: каса може писати під час запису на флешку.
        const fresh = this.database.listBackups()[0]
        const source = fresh && Date.now() - Date.parse(fresh.createdAt) < 2 * 60 * 60_000 ? fresh.filePath : await this.database.backupNow()
        const copy = await writeExternalCopy(source, config.folder)
        pruneExternalCopies(config.folder)
        writeExternalConfig(this.dataRoot, { ...readExternalConfig(this.dataRoot), last_copy_at: new Date().toISOString(), last_error: null })
        return copy
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeExternalConfig(this.dataRoot, { ...readExternalConfig(this.dataRoot), last_error: message.slice(0, 300) })
        throw error
      }
    })()
    this.running = task
    void task.finally(() => { if (this.running === task) this.running = null }).catch(() => {})
    return task
  }
}
