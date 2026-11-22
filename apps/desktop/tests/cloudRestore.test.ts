import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertCloudBackupUrl, cloudBackupFileName, fetchCloudBackup, type CloudBackupRequest } from '../src/backup/cloudRestore'

const TENANT = '00000000-0000-0000-0000-000000000001'
const DEVICE = '65835ce5-9b59-4cc9-91d9-f0afe8d76840'
const ID = '60e1bae7-d41e-4349-8bd8-2decd72a590c'
const ORIGIN = 'https://project.supabase.co'
const db = Buffer.from('SQLite format 3\0 pretend database bytes '.repeat(50))
const archive = gzipSync(db)
const sha = createHash('sha256').update(archive).digest('hex')
const request = (over: Partial<CloudBackupRequest> = {}): CloudBackupRequest => ({
  tenant_id: TENANT, device_id: DEVICE, id: ID, sha256: sha, size_bytes: archive.length,
  url: `${ORIGIN}/storage/v1/object/sign/forsage-private-backups/${TENANT}/${DEVICE}/${ID}-${sha}.db.gz?token=abc`, ...over,
})
const okFetch = (body: Buffer = archive) => vi.fn(async () => new Response(new Uint8Array(body), { status: 200 })) as unknown as typeof fetch

describe('emergency restore from the cloud copy', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'forsage-cloud-restore-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const opts = (over: Record<string, unknown> = {}) => ({ backupsDir: dir, trustedOrigin: ORIGIN, fetchImpl: okFetch(), assertUsable: () => undefined, now: new Date('2026-11-17T10:00:00Z'), ...over })

  it('accepts only the exact signed file of our private bucket', () => {
    expect(() => assertCloudBackupUrl(request(), ORIGIN)).not.toThrow()
    expect(() => assertCloudBackupUrl(request({ url: request().url.replace('https://project.supabase.co', 'https://evil.example') }), ORIGIN)).toThrow('Неприпустима')
    expect(() => assertCloudBackupUrl(request({ url: request().url.replace('https:', 'http:') }), ORIGIN)).toThrow('Неприпустима')
    expect(() => assertCloudBackupUrl(request({ url: request().url.replace(ID, '11111111-1111-4111-8111-111111111111') }), ORIGIN)).toThrow('Неприпустима')
    expect(() => assertCloudBackupUrl(request({ url: request().url.replace('/sign/forsage-private-backups/', '/sign/other-bucket/') }), ORIGIN)).toThrow('Неприпустима')
    expect(() => assertCloudBackupUrl(request({ sha256: 'zz' }), ORIGIN)).toThrow('Некоректні')
    expect(() => assertCloudBackupUrl(request({ size_bytes: 0 }), ORIGIN)).toThrow('Некоректні')
  })

  it('names the file so that the normal restore list recognises it', () => {
    expect(cloudBackupFileName({ id: ID }, new Date('2026-11-17T10:00:00Z'))).toMatch(/^Forsage-\d{4}-\d{2}-\d{2}_.+\.db$/)
  })

  it('downloads, checks the SHA-256 and unpacks the database, leaving no temporary files', async () => {
    const result = await fetchCloudBackup(request(), opts())
    expect(result.fileName).toBe('Forsage-2026-11-17_cloud-60e1bae7.db')
    expect(readFileSync(result.filePath).equals(db)).toBe(true)
    expect(readdirSync(dir)).toEqual([result.fileName])
  })

  it('refuses a download whose checksum does not match, and leaves nothing behind', async () => {
    const tampered = Buffer.from(archive); tampered[tampered.length - 12] ^= 0xff
    await expect(fetchCloudBackup(request(), opts({ fetchImpl: okFetch(tampered) }))).rejects.toThrow('Контрольна сума')
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses an incomplete download', async () => {
    await expect(fetchCloudBackup(request(), opts({ fetchImpl: okFetch(archive.subarray(0, 20)) }))).rejects.toThrow('не повністю')
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses a file that is not a usable database and does not keep it', async () => {
    const assertUsable = vi.fn(() => { throw new Error('Копія пошкоджена') })
    await expect(fetchCloudBackup(request(), opts({ assertUsable }))).rejects.toThrow('Копія пошкоджена')
    expect(readdirSync(dir)).toEqual([])
  })

  it('reports a server refusal and never follows redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 403 })) as unknown as typeof fetch
    await expect(fetchCloudBackup(request(), opts({ fetchImpl }))).rejects.toThrow('HTTP 403')
    expect((fetchImpl as any).mock.calls[0][1]).toMatchObject({ redirect: 'error' })
  })

  it('reuses an already downloaded identical copy instead of downloading again', async () => {
    await fetchCloudBackup(request(), opts())
    const again = vi.fn() as unknown as typeof fetch
    const result = await fetchCloudBackup(request(), opts({ fetchImpl: again }))
    expect(again).not.toHaveBeenCalled()
    expect(existsSync(result.filePath)).toBe(true)
  })

  // 22.11.2026: нові копії стиснені Zstandard (менші на третину); старі gzip-копії відновлюються як і раніше.
  it('unpacks a zstd copy, and a request for one format never accepts the file of the other', async () => {
    const zst = zstdCompressSync(db), zsha = createHash('sha256').update(zst).digest('hex')
    const zrequest = request({ format: 'zst', sha256: zsha, size_bytes: zst.length,
      url: `${ORIGIN}/storage/v1/object/sign/forsage-private-backups/${TENANT}/${DEVICE}/${ID}-${zsha}.db.zst?token=abc` })
    const result = await fetchCloudBackup(zrequest, opts({ fetchImpl: okFetch(zst) }))
    expect(readFileSync(result.filePath).equals(db)).toBe(true)
    expect(readdirSync(dir)).toEqual([result.fileName])
    expect(() => assertCloudBackupUrl(request({ format: 'zst' }), ORIGIN)).toThrow('Неприпустима')
    expect(() => assertCloudBackupUrl({ ...zrequest, format: 'gz' }, ORIGIN)).toThrow('Неприпустима')
    expect(() => assertCloudBackupUrl({ ...request(), format: 'zip' as never }, ORIGIN)).toThrow('Некоректні')
  })

  it('a gzip file sent under the zstd name is refused and nothing is kept', async () => {
    const wrong = request({ format: 'zst', url: request().url.replace('.db.gz', '.db.zst') })
    await expect(fetchCloudBackup(wrong, opts())).rejects.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })
})
