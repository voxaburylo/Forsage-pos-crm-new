import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { createArchiveDecompressor, isArchiveFormat, type ArchiveFormat } from './archiveFormat'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { backupPartsOf, backupPartSuffix, MAX_CHUNKED_BACKUP_BYTES } from './cloudParts'

/**
 * Аварійне відновлення: найсвіжіша перевірена копія з хмарного сховища → файл у папці резервних копій цього ПК.
 * Сама заміна робочої бази лишається штатним відновленням («Резервні копії для відновлення»):
 * тут лише безпечно скачати, звірити контрольну суму, розпакувати й переконатись, що копія відкривається.
 */
export const CLOUD_BACKUP_BUCKET = 'forsage-private-backups'
export const MAX_CLOUD_ARCHIVE_BYTES = 45 * 1024 * 1024
/** Захист від «бомби» в архіві: розпакована база не може бути більшою за це. */
export const MAX_RESTORED_DB_BYTES = 4 * 1024 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export interface CloudBackupRequest {
  url: string
  tenant_id: string
  device_id: string
  id: string
  sha256: string
  size_bytes: number
  /** Формат архіву; у копій, зроблених до 22.11.2026, його немає — це gz. */
  format?: ArchiveFormat
  /** 24.11.2026 (план C10): велика копія — адреси частин по порядку замість однієї url. */
  urls?: string[]
}

function formatOf(request: Pick<CloudBackupRequest, 'format'>): ArchiveFormat {
  if (request.format === undefined) return 'gz'
  if (!isArchiveFormat(request.format)) throw new Error('Некоректні параметри копії')
  return request.format
}

/** Підписана адреса має вести рівно на цей файл (чи цю частину) у приватному сховищі нашого сервера. */
export function assertCloudBackupUrl(request: CloudBackupRequest, trustedOrigin: string, part?: number): URL {
  const parts = backupPartsOf(Number(request.size_bytes))
  if (![request.tenant_id, request.device_id, request.id].every(value => UUID.test(String(value)))
    || !/^[a-f0-9]{64}$/.test(String(request.sha256))
    || !Number.isSafeInteger(request.size_bytes) || request.size_bytes < 1
    || request.size_bytes > (part ? MAX_CHUNKED_BACKUP_BYTES : MAX_CLOUD_ARCHIVE_BYTES)
    || (part !== undefined && (parts < 2 || !Number.isInteger(part) || part < 1 || part > parts)))
    throw new Error('Некоректні параметри копії')
  let url: URL
  try { url = new URL(part ? String(request.urls?.[part - 1] ?? '') : request.url) } catch { throw new Error('Неприпустима адреса копії') }
  const expectedPath = '/storage/v1/object/sign/' + CLOUD_BACKUP_BUCKET + '/'
    + [request.tenant_id, request.device_id, request.id + '-' + request.sha256 + '.db.' + formatOf(request) + (part ? backupPartSuffix(part) : '')].map(encodeURIComponent).join('/')
  if (url.protocol !== 'https:' || url.origin !== new URL(trustedOrigin).origin || decodeURI(url.pathname) !== decodeURI(expectedPath))
    throw new Error('Неприпустима адреса копії')
  return url
}

/** Ім'я файлу в папці копій, яке впізнає «Резервні копії для відновлення» (Forsage-РРРР-ММ-ДД_…db). */
export function cloudBackupFileName(request: Pick<CloudBackupRequest, 'id'>, now = new Date()): string {
  return `Forsage-${now.toISOString().slice(0, 10)}_cloud-${request.id.slice(0, 8)}.db`
}

class SizeLimit extends Transform {
  private total = 0
  constructor(private readonly max: number, private readonly message: string) { super() }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.total += chunk.length
    if (this.total > this.max) callback(new Error(this.message)); else callback(null, chunk)
  }
}

function removeIfExists(file: string) {
  try { if (existsSync(file)) unlinkSync(file) } catch { /* найгірше — залишиться тимчасовий файл */ }
}

export interface FetchCloudBackupOptions {
  backupsDir: string
  trustedOrigin: string
  fetchImpl?: typeof fetch
  /** Перевірка, що розпакований файл — справжня база цієї версії програми. */
  assertUsable: (file: string) => void
  now?: Date
}

/** Скачує, звіряє SHA-256 архіву, розпаковує у файл копії й перевіряє його. Повертає ім'я файлу. */
export async function fetchCloudBackup(request: CloudBackupRequest, options: FetchCloudBackupOptions): Promise<{ fileName: string; filePath: string; sizeBytes: number }> {
  // 24.11.2026 (план C10): велика копія приходить частинами — усі адреси перевіряються наперед, до першого байта.
  const parts = Array.isArray(request.urls) && request.urls.length ? request.urls.length : 1
  if (parts > 1 && parts !== backupPartsOf(Number(request.size_bytes))) throw new Error('Некоректні параметри копії')
  const urls = parts > 1 ? Array.from({ length: parts }, (_, index) => assertCloudBackupUrl(request, options.trustedOrigin, index + 1)) : [assertCloudBackupUrl(request, options.trustedOrigin)]
  const fileName = cloudBackupFileName(request, options.now)
  mkdirSync(options.backupsDir, { recursive: true })
  const finalPath = path.join(options.backupsDir, fileName)
  if (existsSync(finalPath)) return { fileName, filePath: finalPath, sizeBytes: statSync(finalPath).size }

  const format = formatOf(request)
  const archivePath = finalPath + '.' + format + '.partial'
  const dbPath = finalPath + '.partial'
  try {
    const hash = createHash('sha256')
    let received = 0
    for (const [index, url] of urls.entries()) {
      const response = await (options.fetchImpl ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(300_000) } as RequestInit)
      if (!response.ok || !response.body) throw new Error('Сервер не віддав копію: HTTP ' + response.status)
      const limit = new SizeLimit(parts > 1 ? MAX_CHUNKED_BACKUP_BYTES - received : MAX_CLOUD_ARCHIVE_BYTES, 'Архів копії завеликий')
      limit.on('data', (chunk: Buffer) => { hash.update(chunk); received += chunk.length })
      // Частини дописуються в один архів по черзі; сума рахується від усього архіву.
      await pipeline(Readable.fromWeb(response.body as any), limit, createWriteStream(archivePath, { flags: index === 0 ? 'wx' : 'a' }))
    }
    if (received !== request.size_bytes) throw new Error('Копію завантажено не повністю')
    if (hash.digest('hex') !== request.sha256) throw new Error('Контрольна сума копії не збігається. Файл не використано.')

    await pipeline(
      createReadStream(archivePath),
      createArchiveDecompressor(format),
      new SizeLimit(MAX_RESTORED_DB_BYTES, 'Розпакована база неприпустимо велика'),
      createWriteStream(dbPath, { flags: 'wx' }),
    )
    options.assertUsable(dbPath)
    renameSync(dbPath, finalPath)
    return { fileName, filePath: finalPath, sizeBytes: statSync(finalPath).size }
  } finally {
    removeIfExists(archivePath)
    removeIfExists(dbPath)
  }
}
