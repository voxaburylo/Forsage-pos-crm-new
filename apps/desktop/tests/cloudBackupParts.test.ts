import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Маленькі межі для тесту: «один файл» до 100 байтів, частини по 64 байти. Логіка та сама, що в cloudParts.ts.
vi.mock('../src/backup/cloudParts', async () => {
  const real = await vi.importActual<typeof import('../src/backup/cloudParts')>('../src/backup/cloudParts')
  // Ті самі функції, лише з малими межами.
  return { ...real, SINGLE_FILE_MAX_BYTES: 100, BACKUP_PART_BYTES: 64, MAX_CHUNKED_BACKUP_BYTES: 10_000,
    backupPartsOf: (size: number) => real.backupPartsOf(size, 64, 100),
    backupPartRange: (size: number, index: number) => real.backupPartRange(size, index, 64, 100),
    backupPartHashes: (file: string, size: number) => real.backupPartHashes(file, size, 64, 100),
  }
})
import { backupPartHashes, backupPartRange, backupPartsOf, backupPartSuffix } from '../src/backup/cloudParts'
import { assertCloudBackupUrl, fetchCloudBackup, type CloudBackupRequest } from '../src/backup/cloudRestore'

const TENANT = '00000000-0000-0000-0000-000000000001'
const DEVICE = '65835ce5-9b59-4cc9-91d9-f0afe8d76840'
const ID = '60e1bae7-d41e-4349-8bd8-2decd72a590c'
const ORIGIN = 'https://project.supabase.co'

// 24.11.2026 (план C10): велика копія — частинами; збирається назад і звіряється загальною сумою.
describe('cloud backup in parts', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'forsage-parts-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const db = Buffer.from(Array.from({ length: 400 }, (_, index) => String.fromCharCode(33 + (index * 7919) % 90)).join(''))
  const archive = gzipSync(db, { level: 0 })
  const sha = createHash('sha256').update(archive).digest('hex')
  const parts = Math.ceil(archive.length / 64)
  const partUrl = (index: number) => `${ORIGIN}/storage/v1/object/sign/forsage-private-backups/${TENANT}/${DEVICE}/${ID}-${sha}.db.gz${backupPartSuffix(index)}?token=t${index}`
  const request = (over: Partial<CloudBackupRequest> = {}): CloudBackupRequest => ({
    tenant_id: TENANT, device_id: DEVICE, id: ID, sha256: sha, size_bytes: archive.length, url: '',
    urls: Array.from({ length: parts }, (_, index) => partUrl(index + 1)), ...over,
  })

  it('splits by size: small stays one file, big goes in parts with a short last one, each with its own checksum', async () => {
    expect(archive.length).toBeGreaterThan(100)
    expect(backupPartsOf(100)).toBe(1)
    expect(backupPartsOf(archive.length)).toBe(parts)
    expect(backupPartRange(archive.length, parts).end).toBe(archive.length)
    const file = path.join(dir, 'a.db.gz'); writeFileSync(file, archive)
    const hashes = await backupPartHashes(file, archive.length)
    expect(hashes).toHaveLength(parts)
    expect(hashes[0]).toBe(createHash('sha256').update(archive.subarray(0, 64)).digest('hex'))
    expect(await backupPartHashes(file, 50)).toEqual([])
  })

  it('accepts only the exact signed part addresses and refuses a part of a small copy', () => {
    expect(() => assertCloudBackupUrl(request(), ORIGIN, 1)).not.toThrow()
    expect(() => assertCloudBackupUrl(request({ urls: [partUrl(2)] }), ORIGIN, 1)).toThrow('Неприпустима')
    expect(() => assertCloudBackupUrl(request(), ORIGIN, parts + 1)).toThrow('Некоректні')
    expect(() => assertCloudBackupUrl(request({ size_bytes: 90 }), ORIGIN, 1)).toThrow('Некоректні')
  })

  it('downloads parts in order into one archive, checks the whole checksum and unpacks it', async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      const index = Number(/part(\d+)/.exec(String(url))![1])
      return new Response(new Uint8Array(archive.subarray((index - 1) * 64, Math.min(archive.length, index * 64))), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCloudBackup(request(), { backupsDir: dir, trustedOrigin: ORIGIN, fetchImpl, assertUsable: () => undefined, now: new Date('2026-11-24T10:00:00Z') })
    expect(readFileSync(result.filePath)).toEqual(db)
    expect(fetchImpl).toHaveBeenCalledTimes(parts)
  })

  it('a missing or swapped part fails the restore and leaves no file', async () => {
    const swapped = vi.fn(async (url: URL) => {
      const index = Number(/part(\d+)/.exec(String(url))![1])
      const take = index === 1 ? 2 : index === 2 ? 1 : index
      return new Response(new Uint8Array(archive.subarray((take - 1) * 64, Math.min(archive.length, take * 64))), { status: 200 })
    }) as unknown as typeof fetch
    await expect(fetchCloudBackup(request(), { backupsDir: dir, trustedOrigin: ORIGIN, fetchImpl: swapped, assertUsable: () => undefined })).rejects.toThrow('Контрольна сума')
    await expect(fetchCloudBackup(request({ urls: request().urls!.slice(1) }), { backupsDir: dir, trustedOrigin: ORIGIN, fetchImpl: swapped, assertUsable: () => undefined })).rejects.toThrow('Некоректні')
    expect(require('node:fs').readdirSync(dir)).toEqual([])
  })
})

describe('the till and the server split the copy the same way', () => {
  it('uses the same part size, single-file limit and maximum as the server', async () => {
    const real = await vi.importActual<typeof import('../src/backup/cloudParts')>('../src/backup/cloudParts')
    const server = readFileSync(new URL('../../../server/src/services/backupPolicy.ts', import.meta.url), 'utf8')
    expect(real.SINGLE_FILE_MAX_BYTES).toBe(45 * 1024 * 1024)
    expect(server).toContain('export const MAX_BACKUP_BYTES = 45 * 1024 * 1024')
    expect(real.BACKUP_PART_BYTES).toBe(40 * 1024 * 1024)
    expect(server).toContain('export const BACKUP_PART_BYTES = 40 * 1024 * 1024')
    expect(real.MAX_CHUNKED_BACKUP_BYTES).toBe(400 * 1024 * 1024)
    expect(server).toContain('export const MAX_CHUNKED_BACKUP_BYTES = 400 * 1024 * 1024')
    expect(server).toContain("return path + '.part' + String(part).padStart(2, '0')")
    expect(real.backupPartSuffix(3)).toBe('.part03')
  })
})
