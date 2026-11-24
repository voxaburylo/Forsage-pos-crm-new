import { describe, it, expect } from 'vitest'
import { BACKUP_KEEP, BACKUP_PART_BYTES, VERIFIED_BACKUP_NAME, backupDescriptor, backupFormatOfName, backupPartPath, backupPartsOf, backupPartSize, backupsToKeep, hasArchiveMagic, MAX_BACKUP_BYTES, MAX_CHUNKED_BACKUP_BYTES } from './backupPolicy.js'
const tenant='11111111-1111-4111-8111-111111111111'
const input={tenant_id:tenant,device_id:'22222222-2222-4222-8222-222222222222',id:'33333333-3333-4333-8333-333333333333',sha256:'a'.repeat(64),size_bytes:100}
describe('private backup paths',()=>{
  it('uses immutable tenant/device/shift and checksum names',()=>expect(backupDescriptor(input,tenant).path).toBe(tenant+'/'+input.device_id+'/'+input.id+'-'+input.sha256+'.db.gz'))
  it.each([{tenant_id:'other'},{id:'../../secret'},{device_id:'../other'},{sha256:'x'},{size_bytes:MAX_CHUNKED_BACKUP_BYTES+1},{size_bytes:-1}])('rejects %j',change=>expect(()=>backupDescriptor({...input,...change},tenant)).toThrow())
})

// 22.11.2026: копія в gzip уже 27,6 МБ при ліміті хмари 45 МБ; Zstandard дає 17,8 МБ на тій самій базі.
describe('the copy may be gzip (old) or zstd (new)', () => {
  it('names the cloud file by its format; an old till without the field keeps gzip', () => {
    expect(backupDescriptor({ ...input, format: 'zst' }, tenant)).toMatchObject({ format: 'zst', path: tenant+'/'+input.device_id+'/'+input.id+'-'+input.sha256+'.db.zst' })
    expect(backupDescriptor({ ...input, format: 'gz' }, tenant)).toMatchObject({ format: 'gz' })
    expect(backupDescriptor(input, tenant).format).toBe('gz')
    expect(backupDescriptor({ ...input, format: null }, tenant).format).toBe('gz')
    for (const format of ['zip', '../x', '', 7, 'GZ']) expect(() => backupDescriptor({ ...input, format }, tenant)).toThrow()
  })
  it('recognises the archive by its first bytes and never takes one format for the other', () => {
    const gz = Uint8Array.from([0x1f, 0x8b, 8, 0]), zst = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0])
    expect(hasArchiveMagic(gz, 'gz')).toBe(true)
    expect(hasArchiveMagic(zst, 'zst')).toBe(true)
    expect(hasArchiveMagic(gz, 'zst')).toBe(false)
    expect(hasArchiveMagic(zst, 'gz')).toBe(false)
    expect(hasArchiveMagic(new Uint8Array(0), 'zst')).toBe(false)
  })
  it('lists and keeps verified copies of both formats', () => {
    const base = input.id + '-' + input.sha256
    expect(VERIFIED_BACKUP_NAME.test(base + '.db.gz.json')).toBe(true)
    expect(VERIFIED_BACKUP_NAME.test(base + '.db.zst.json')).toBe(true)
    expect(VERIFIED_BACKUP_NAME.test(base + '.db.zip.json')).toBe(false)
    expect(VERIFIED_BACKUP_NAME.test(base + '.db.zst')).toBe(false)
    expect(backupFormatOfName(base + '.db.zst')).toBe('zst')
    expect(backupFormatOfName(base + '.db.zst.json')).toBe('zst')
    expect(backupFormatOfName(base + '.db.gz')).toBe('gz')
  })
})

// 22.11.2026: у хмарі лишали сім найновіших копій — це 3–7 днів. Пізно помічену помилку вже нема з чого відкотити.
describe('cloud copies: seven days, four weeks, six months', () => {
  const copy = (day: string, hour = 17) => ({ name: `copy-${day}-${hour}`, created_at: `${day}T${String(hour).padStart(2, '0')}:00:00Z` })
  const days = (from: string, count: number) => Array.from({ length: count }, (_, i) => {
    const date = new Date(from + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() - i)
    return copy(date.toISOString().slice(0, 10))
  })

  it('half a year of daily copies shrinks to 7 days + 4 weeks + 6 months', () => {
    const kept = backupsToKeep(days('2026-11-22', 190))
    const names = [...kept].sort().reverse()
    // Сім останніх днів.
    for (const day of ['2026-11-22', '2026-11-21', '2026-11-20', '2026-11-19', '2026-11-18', '2026-11-17', '2026-11-16'])
      expect(kept.has(`copy-${day}-17`), day).toBe(true)
    // Найновіша копія кожного з чотирьох останніх тижнів (тиждень із понеділка): 22.11, 15.11, 08.11, 01.11.
    for (const day of ['2026-11-15', '2026-11-08', '2026-11-01']) expect(kept.has(`copy-${day}-17`), day).toBe(true)
    // Найновіша копія кожного з шести останніх місяців.
    for (const day of ['2026-10-31', '2026-09-30', '2026-08-31', '2026-07-31', '2026-06-30']) expect(kept.has(`copy-${day}-17`), day).toBe(true)
    expect(names.length).toBeLessThanOrEqual(BACKUP_KEEP.days + BACKUP_KEEP.weeks + BACKUP_KEEP.months)
    expect(names.length).toBe(15)
    // Усе старше за шість місяців прибирається.
    expect(kept.has('copy-2026-05-31-17')).toBe(false)
  })

  it('several copies in one day count as one day; the newest of the day stays', () => {
    const files = [copy('2026-11-21', 8), copy('2026-11-21', 9), copy('2026-11-21', 17), ...days('2026-11-20', 10)]
    const kept = backupsToKeep(files)
    expect(kept.has('copy-2026-11-21-17')).toBe(true)
    expect(kept.has('copy-2026-11-21-8')).toBe(false)
    expect(kept.has('copy-2026-11-21-9')).toBe(false)
    for (const day of ['2026-11-20', '2026-11-19', '2026-11-18', '2026-11-17', '2026-11-16', '2026-11-15']) expect(kept.has(`copy-${day}-17`), day).toBe(true)
  })

  it('never removes the newest copy, a single copy, or a copy whose date cannot be read', () => {
    expect([...backupsToKeep([copy('2026-11-22')])]).toEqual(['copy-2026-11-22-17'])
    expect(backupsToKeep([]).size).toBe(0)
    const odd = [{ name: 'no-date', created_at: null }, { name: 'bad-date', created_at: 'yesterday' }, copy('2026-11-22')]
    expect([...backupsToKeep(odd)].sort()).toEqual(['bad-date', 'copy-2026-11-22-17', 'no-date'])
    expect(backupsToKeep(days('2026-11-22', 3), { days: 0, weeks: 0, months: 0 }).has('copy-2026-11-22-17')).toBe(true)
  })

  it('a day is a Kyiv day: a copy made after midnight Kyiv time belongs to the new day', () => {
    // 21:30Z 21.11 — це вже 23:30 за Києвом 21.11; 22:30Z — 00:30 22.11 за Києвом.
    const kept = backupsToKeep([{ name: 'late', created_at: '2026-11-21T21:30:00Z' }, { name: 'after-midnight', created_at: '2026-11-21T22:30:00Z' }], { days: 2, weeks: 0, months: 0 })
    expect([...kept].sort()).toEqual(['after-midnight', 'late'])
  })
})

// 24.11.2026 (план C10): копія, більша за 45 МБ, іде частинами по 40 МБ.
describe('a big copy goes in parts', () => {
  it('a copy up to 45 MB stays one file; bigger is split into 40 MB parts with a short last one', () => {
    expect(backupPartsOf(MAX_BACKUP_BYTES)).toBe(1)
    expect(backupPartsOf(MAX_BACKUP_BYTES + 1)).toBe(2)
    expect(backupPartsOf(100 * 1024 * 1024)).toBe(3)
    expect(backupPartSize(100 * 1024 * 1024, 1)).toBe(BACKUP_PART_BYTES)
    expect(backupPartSize(100 * 1024 * 1024, 3)).toBe(20 * 1024 * 1024)
    expect(backupPartPath('t/d/x.db.zst', 2)).toBe('t/d/x.db.zst.part02')
  })
  it('a part names its index and its own checksum; a part of a small copy or a wrong index is refused', () => {
    const big = { ...input, size_bytes: 100 * 1024 * 1024, format: 'zst' }
    expect(backupDescriptor({ ...big, part: 3, part_sha256: 'b'.repeat(64) }, tenant)).toMatchObject({ parts: 3, part: { index: 3, sha256: 'b'.repeat(64), size_bytes: 20 * 1024 * 1024 } })
    expect(backupDescriptor(big, tenant)).toMatchObject({ parts: 3, part: null })
    for (const change of [{ part: 0 }, { part: 4 }, { part: 1.5 }, { part: 1, part_sha256: 'x' }]) {
      expect(() => backupDescriptor({ ...big, part_sha256: 'b'.repeat(64), ...change }, tenant)).toThrow()
    }
    expect(() => backupDescriptor({ ...input, part: 1, part_sha256: 'b'.repeat(64) }, tenant)).toThrow()
  })
})
