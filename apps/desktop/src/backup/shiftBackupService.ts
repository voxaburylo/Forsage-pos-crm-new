import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { mkdir, rename, stat } from 'node:fs/promises'
import { existsSync, createReadStream } from 'node:fs'
import { LocalDatabase } from '../db/localDatabase'
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
    private exporter?: typeof exportShiftSnapshot) {}
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
      if (!existsSync(snapshot)) {
        capturedAt = new Date().toISOString()
        await createVerifiedBackup(this.db.databasePath, snapshot + '.partial')
        await rename(snapshot + '.partial', snapshot)
      }
      capturedAt ??= (await stat(snapshot)).mtime.toISOString()
      this.db.prepare('UPDATE shift_backups SET local_path=?, captured_at=? WHERE id=?').run(snapshot, capturedAt, job.id)
      const output = path.join(this.programDirectory, 'Вивантаження', stamp)
      const result = await this.exportInWorker({ snapshot, output, tenantId: job.tenant_id, stamp, closedAt: job.closed_at, capturedAt })
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
      const timer = setTimeout(() => { failure = new Error('Перевищено час вивантаження'); void worker.terminate() }, 120_000)
      worker.on('message', message => { if (message.error) failure = new Error(message.error); else result=message.result })
      worker.on('error', error => { failure=error })
      worker.on('exit', code => { clearTimeout(timer); if (failure || code !== 0 || !result) reject(failure ?? new Error('Вивантаження перервано')); else resolve(result) })
    })
  }
  pending(tenant: string) {
    return this.db.prepare(`SELECT id, tenant_id, device_id, closed_at, captured_at, sha256, size_bytes
      FROM shift_backups WHERE tenant_id=? AND compressed_path IS NOT NULL AND cloud_completed_at IS NULL
      ORDER BY closed_at,id LIMIT 1`).all(tenant)
  }
  status(tenant: string) {
    return this.db.prepare(`SELECT id,closed_at,captured_at,export_directory,local_error,cloud_error,cloud_completed_at
      FROM shift_backups WHERE tenant_id=? ORDER BY closed_at DESC,id DESC LIMIT 20`).all(tenant)
  }
  async upload(tenant: string, id: string, signedUrl: string, trustedOrigin: string) {
    const job = this.db.prepare('SELECT * FROM shift_backups WHERE id=? AND tenant_id=?').get(id,tenant) as unknown as ShiftBackupJob | undefined
    if (!job?.compressed_path || !job.sha256) throw new Error('Резервну копію ще не підготовлено')
    const url = new URL(signedUrl)
    const expectedPath = '/storage/v1/object/upload/sign/forsage-private-backups/' +
      [job.tenant_id, job.device_id, job.id+'-'+job.sha256+'.db.gz'].map(encodeURIComponent).join('/')
    if (url.origin !== new URL(trustedOrigin).origin || url.protocol !== 'https:' || decodeURI(url.pathname) !== decodeURI(expectedPath))
      throw new Error('Неприпустима адреса резервування')
    if (this.uploads.has(id)) throw new Error('Копія вже надсилається')
    const resolved = path.resolve(job.compressed_path)
    if (path.dirname(resolved) !== path.resolve(this.db.dataRoot, 'shift-backups')) throw new Error('Неприпустимий файл копії')
    this.uploads.add(id)
    try {
      const response = await fetch(url, {
        method: 'PUT', body: createReadStream(resolved) as any, duplex: 'half',
        headers: { 'Content-Type': 'application/gzip' }, redirect: 'error', signal: AbortSignal.timeout(90_000),
      } as RequestInit)
      if (!response.ok) throw new Error('Сервер не прийняв копію: HTTP '+response.status)
      return { ok: true }
    } finally { this.uploads.delete(id) }
  }
  confirmed(tenant: string, id: string, sha256: string) {
    this.db.prepare('UPDATE shift_backups SET cloud_completed_at=?,cloud_error=NULL WHERE id=? AND tenant_id=? AND sha256=?')
      .run(new Date().toISOString(), id,tenant,sha256)
  }
  cloudFailed(tenant: string,id: string,message: string) {
    this.db.prepare('UPDATE shift_backups SET cloud_error=? WHERE id=? AND tenant_id=?').run(message.slice(0,500),id,tenant)
  }
}
