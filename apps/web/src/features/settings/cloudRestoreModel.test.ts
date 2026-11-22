import { describe, expect, it } from 'vitest'
import { backupAgeDays, cloudBackupFormat, latestCloudBackup, usableCloudBackups, type CloudBackupItem } from './cloudRestoreModel'

const U = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const item = (n: number, created: string, over: Partial<CloudBackupItem> = {}): CloudBackupItem => ({
  device_id: U(1), name: `${U(n)}-${'a'.repeat(64)}.db.gz`, created_at: created, id: U(n), sha256: 'a'.repeat(64), size_bytes: 26_000_000, ...over,
})

describe('finding the freshest cloud copy', () => {
  it('puts the newest verified copy first, whichever PC made it', () => {
    const list = [item(2, '2026-11-13T16:00:00Z'), item(3, '2026-11-14T17:12:00Z', { device_id: U(9) }), item(4, '2026-11-12T17:00:00Z')]
    expect(latestCloudBackup(list)?.id).toBe(U(3))
    expect(usableCloudBackups(list).map(x => x.id)).toEqual([U(3), U(2), U(4)])
  })
  it('ignores entries that cannot be restored (no size, bad checksum or date)', () => {
    const list = [item(2, '2026-11-13T16:00:00Z', { size_bytes: 0 }), item(3, 'broken'), item(4, '2026-11-12T17:00:00Z', { sha256: 'x' }), item(5, '2026-11-11T17:00:00Z')]
    expect(usableCloudBackups(list).map(x => x.id)).toEqual([U(5)])
    expect(latestCloudBackup([])).toBeNull()
  })
  it('tells how many days of work the copy is missing', () => {
    expect(backupAgeDays('2026-11-14T17:12:00Z', Date.parse('2026-11-17T10:00:00Z'))).toBe(2)
    expect(backupAgeDays('2026-11-18T00:00:00Z', Date.parse('2026-11-17T10:00:00Z'))).toBe(0)
  })

  // 22.11.2026: нові копії стиснені Zstandard; формат береться з відповіді сервера, а якщо сервер старий — з імені файлу.
  it('knows the archive format of a copy: from the server field, else from the file name', () => {
    expect(cloudBackupFormat(item(1, '2026-11-22T10:00:00Z'))).toBe('gz')
    expect(cloudBackupFormat(item(1, '2026-11-22T10:00:00Z', { name: `${U(1)}-${'a'.repeat(64)}.db.zst` }))).toBe('zst')
    expect(cloudBackupFormat(item(1, '2026-11-22T10:00:00Z', { format: 'zst' }))).toBe('zst')
    expect(cloudBackupFormat(item(1, '2026-11-22T10:00:00Z', { name: 'x.db.zst', format: 'gz' }))).toBe('gz')
    expect(cloudBackupFormat({ name: 'unknown', format: 'zip' as never })).toBe('gz')
  })
})
