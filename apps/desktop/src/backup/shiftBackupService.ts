import { archiveFormatOf, archiveMime } from './archiveFormat'
import { backupPartHashes, backupPartRange, backupPartsOf, backupPartSuffix } from './cloudParts'
import { assertBackupSpace } from './backupSpace'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { mkdir, rename, stat } from 'node:fs/promises'
import { existsSync, createReadStream, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { createVerifiedBackup } from '../db/verifiedBackup'
import type { exportShiftSnapshot } from './shiftExportWorker'

type ExportResult = Awaited<ReturnType<typeof exportShiftSnapshot>>
export interface ShiftBackupJob {
  id: string; tenant_id: string; device_id: string; closed_at: string; captured_at: string | null;
  local_path: string | null; compressed_path: string | null; sha256: string | null;
  size_bytes: number | null; export_directory: string | null; attempts: number;
  cloud_completed_at: string | null; local_error: string | null; cloud_error: string | null;
}
export class ShiftBackupService {
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private uploads = new Set<string>()
  private stopped = false
  constructor(private db: LocalDatabase, private programDirectory: string, private onError: (error: unknown) => void,
    private exporter?: typeof exportShiftSnapshot, private options: { dailyCopy?: boolean } = {}) {}
  /**
   * 20.11.2026: зміни не закривались із 14.11, і хмарна копія не робилась тиждень.
   * Якщо за добу не було жодної копії (ні після зміни, ні щоденної), ставимо щоденну копію в ту саму чергу:
   * знімок, вивантаження й відправка в хмару — тим самим перевіреним шляхом, що й після закриття зміни.
   */
  ensureDailyCopy(now = new Date()): string | null {
    const since = new Date(now.getTime() - 24 * 3600_000).toISOString()
    const recent = this.db.prepare('SELECT 1 FROM shift_backups WHERE closed_at > ? LIMIT 1').get(since)
    if (recent) return null
    const deviceId = this.db.deviceId
    if (!deviceId) return null
    const last = this.db.prepare('SELECT tenant_id FROM shift_backups ORDER BY closed_at DESC LIMIT 1').get() as { tenant_id?: string } | undefined
    const id = randomUUID(), at = now.toISOString()
    this.db.prepare(`INSERT OR IGNORE INTO shift_backups (id, tenant_id, device_id, closed_at, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, last?.tenant_id ?? DEFAULT_TENANT_ID, deviceId, at, at)
    return id
  }
  start() {
    this.stopped = false
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, 30_000)
    void this.tick()
  }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.running }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running) return this.running
    if (this.options.dailyCopy) { try { this.ensureDailyCopy() } catch (error) { this.onError(error) } }
    this.running = this.runNext().catch(this.onError).finally(() => { this.running = null })
    return this.running
  }
  private async runNext() {
    const job = this.db.prepare(`SELECT * FROM shift_backups WHERE compressed_path IS NULL
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY closed_at, id LIMIT 1`).get(new Date().toISOString()) as unknown as ShiftBackupJob | undefined
    if (!job) return
    try {
      // A restored DB must not cause writes outside its own backup folder.
      const stamp = job.closed_at.replace(/[^0-9TZ-]/g, '-') + '_' + job.id.replace(/[^a-zA-Z0-9-]/g, '')
      const root = path.join(this.db.dataRoot, 'shift-backups')
      await mkdir(root, { recursive: true })
      const snapshot = path.join(root, stamp + '.db')
      let capturedAt = job.captured_at
      await assertBackupSpace(root, this.db.databasePath)
      if (!existsSync(snapshot)) {
        capturedAt = new Date().toISOString()
        await createVerifiedBackup(this.db.databasePath, snapshot + '.partial')
        await rename(snapshot + '.partial', snapshot)
      }
      capturedAt ??= (await stat(snapshot)).mtime.toISOString()
      this.db.prepare('UPDATE shift_backups SET local_path=?, captured_at=? WHERE id=?').run(snapshot, capturedAt, job.id)
      const output = path.join(this.programDirectory, 'Вивантаження', stamp)
      const result = await this.exportInWorker({ snapshot, dataRoot: this.db.dataRoot, output, tenantId: job.tenant_id, stamp, closedAt: job.closed_at, capturedAt })
      this.db.prepare(`UPDATE shift_backups SET compressed_path=?, sha256=?, size_bytes=?,
        export_directory=?, local_error=NULL, next_attempt_at=NULL WHERE id=?`)
        .run(result.compressed, result.sha256, result.size, output, job.id)
    } catch (error) {
      this.db.prepare(`UPDATE shift_backups SET local_error=?, attempts=attempts+1, next_attempt_at=? WHERE id=?`)
        .run(error instanceof Error ? error.message : String(error), new Date(Date.now()+60_000).toISOString(), job.id)
      throw error
    }
  }
  private exportInWorker(input: Parameters<typeof exportShiftSnapshot>[0]): Promise<ExportResult> {
    if (this.exporter) return this.exporter(input)
    return new Promise((resolve,reject) => {
      const worker = new Worker(path.join(__dirname, 'shiftExportWorker.js'), { workerData: input })
      let result: ExportResult | undefined, failure: Error | undefined
      // Сильніше стиснення копії (zstd) довше за gzip; на великій базі чи слабшому ПК двох хвилин могло б не вистачити.
      const timer = setTimeout(() => { failure = new Error('Перевищено час вивантаження'); void worker.terminate() }, 300_000)
      worker.on('message', message => { if (message.error) failure = new Error(message.error); else result=message.result })
      worker.on('error', error => { failure=error })
      worker.on('exit', code => { clearTimeout(timer); if (failure || code !== 0 || !result) reject(failure ?? new Error('Вивантаження перервано')); else resolve(result) })
    })
  }
  async pending(tenant: string) {
    const rows = this.db.prepare(`SELECT id, tenant_id, device_id, closed_at, captured_at, sha256, size_bytes, compressed_path
      FROM shift_backups WHERE tenant_id=? AND compressed_path IS NOT NULL AND cloud_completed_at IS NULL
      ORDER BY closed_at,id LIMIT 1`).all(tenant) as Array<Record<string, unknown> & { compressed_path: string; size_bytes: number }>
    // Формат архіву (gz у старих копій, zst у нових) сервер бере з цього поля: від нього залежить ім'я файлу в хмарі.
    // 24.11.2026 (план C10): велика копія — частинами; для кожної частини — своя контрольна сума.
    return Promise.all(rows.map(async ({ compressed_path, ...row }) => {
      const parts = backupPartsOf(Number(row.size_bytes))
      const part_sha256s = parts > 1 ? await backupPartHashes(compressed_path, Number(row.size_bytes)) : []
      return { ...row, format: archiveFormatOf(compressed_path) ?? 'gz', parts, part_sha256s }
    }))
  }
  status(tenant: string) {
    const rows = this.db.prepare(`SELECT id,closed_at,captured_at,export_directory,local_error,cloud_error,cloud_completed_at,local_path,compressed_path,sha256
      FROM shift_backups WHERE tenant_id=? AND (id IN
        (SELECT id FROM shift_backups WHERE tenant_id=? ORDER BY closed_at DESC,id DESC LIMIT 20)
        OR id = (SELECT id FROM shift_backups WHERE tenant_id=? AND cloud_completed_at IS NOT NULL ORDER BY captured_at DESC,id DESC LIMIT 1))
      ORDER BY closed_at DESC,id DESC`).all(tenant, tenant, tenant) as Array<Pick<ShiftBackupJob, 'id'|'closed_at'|'captured_at'|'export_directory'|'local_error'|'cloud_error'|'cloud_completed_at'|'local_path'|'compressed_path'|'sha256'>>
    const root = path.resolve(this.db.dataRoot, 'shift-backups')
    return rows.map(({ local_path, compressed_path, sha256, ...row }) => {
      let exportsReady = false
      if (row.export_directory && path.dirname(path.resolve(row.export_directory)) === path.resolve(this.programDirectory, 'Вивантаження')) {
        try {
          const files = readdirSync(row.export_directory)
          exportsReady = files.some(name => /^Товари_.+\.xlsx$/.test(name)) && files.some(name => /^Клієнти_.+\.xlsx$/.test(name))
        } catch { /* Missing or inaccessible files are not a ready export. */ }
      }
      return { ...row, exports_ready: exportsReady,
      local_ready: Boolean(local_path && compressed_path && sha256
        && path.dirname(path.resolve(local_path)) === root && path.dirname(path.resolve(compressed_path)) === root
        && existsSync(local_path) && existsSync(compressed_path)),
    } })
  }
  async upload(tenant: string, id: string, signedUrl: string, trustedOrigin: string, part?: number) {
    const job = this.db.prepare('SELECT * FROM shift_backups WHERE id=? AND tenant_id=?').get(id,tenant) as unknown as ShiftBackupJob | undefined
    if (!job?.compressed_path || !job.sha256) throw new Error('Резервну копію ще не підготовлено')
    const url = new URL(signedUrl)
    const format = archiveFormatOf(job.compressed_path) ?? 'gz'
    const expectedPath = '/storage/v1/object/upload/sign/forsage-private-backups/' +
      [job.tenant_id, job.device_id, job.id+'-'+job.sha256+'.db.'+format+(part ? backupPartSuffix(part) : '')].map(encodeURIComponent).join('/')
    // 24.11.2026 (план C10): частина — лише для великої копії й лише з допустимим номером.
    const parts = backupPartsOf(Number(job.size_bytes))
    if ((parts > 1) !== Boolean(part)) throw new Error(parts > 1 ? 'Велику копію надсилають частинами' : 'Ця копія надсилається одним файлом')
    const range = part ? backupPartRange(Number(job.size_bytes), part) : null
    if (url.origin !== new URL(trustedOrigin).origin || url.protocol !== 'https:' || decodeURI(url.pathname) !== decodeURI(expectedPath))
      throw new Error('Неприпустима адреса резервування')
    const uploadKey = id + (part ? backupPartSuffix(part) : '')
    if (this.uploads.has(uploadKey)) throw new Error('Копія вже надсилається')
    const resolved = path.resolve(job.compressed_path)
    if (path.dirname(resolved) !== path.resolve(this.db.dataRoot, 'shift-backups')) throw new Error('Неприпустимий файл копії')
    this.uploads.add(uploadKey)
    try {
      const body = range ? createReadStream(resolved, { start: range.start, end: range.end - 1 }) : createReadStream(resolved)
      const response = await fetch(url, {
        method: 'PUT', body: body as any, duplex: 'half',
        headers: { 'Content-Type': archiveMime(format), ...(range ? { 'Content-Length': String(range.end - range.start) } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(180_000),
      } as RequestInit)
      if (!response.ok) throw new Error('Сервер не прийняв копію: HTTP '+response.status)
      return { ok: true }
    } finally { this.uploads.delete(uploadKey) }
  }
  confirmed(tenant: string, id: string, sha256: string) {
    this.db.prepare('UPDATE shift_backups SET cloud_completed_at=?,cloud_error=NULL WHERE id=? AND tenant_id=? AND sha256=?')
      .run(new Date().toISOString(), id,tenant,sha256)
  }
  cloudFailed(tenant: string,id: string,message: string) {
    this.db.prepare('UPDATE shift_backups SET cloud_error=? WHERE id=? AND tenant_id=?').run(message.slice(0,500),id,tenant)
  }
}
