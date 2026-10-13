import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPortableReleaseSource, downloadPortableUpdate, MAX_UPDATE_BYTES, UPDATE_CHUNK_BYTES, type UpdateMetadata, type UpdateTransport } from '../src/updates/portableUpdate'

const roots: string[] = []
const oldRelease = '20261012T010000-aaaaaaaaaaaa'
const releaseId = '20261013T010000-bbbbbbbbbbbb'
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
function fixture(bytes = Buffer.from('MZ-safe-synthetic-executable')) {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-lan-update-')); roots.push(root)
  const executable = path.join(root, 'Forsage.exe'); writeFileSync(executable, bytes)
  const metadata: UpdateMetadata = { protocol: 1, releaseId, sha256: hash(bytes), size: bytes.length }
  const transport: UpdateTransport = { describe: async () => metadata, chunk: async input => ({ offset: input.offset, data: bytes.subarray(input.offset, input.offset + input.length) }) }
  return { root, executable, metadata, transport, bytes }
}
afterEach(() => {
  for (const root of roots.splice(0)) if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-lan-update-')) rmSync(root, { force: true, recursive: true })
})

describe('portable LAN release source', () => {
  it('never serves a development/unpacked executable', () => {
    const f = fixture()
    expect(createPortableReleaseSource({ packaged: false, portableExecutable: f.executable, releaseId })).toBeNull()
    expect(createPortableReleaseSource({ packaged: true, releaseId })).toBeNull()
  })
  it('serves only its own immutable release with no filesystem paths in metadata', async () => {
    const f = fixture(), source = createPortableReleaseSource({ packaged: true, portableExecutable: f.executable, releaseId })!
    expect(await source.describe()).toEqual(f.metadata)
    expect(await source.chunk({ ...f.metadata, offset: 2, length: 4 })).toEqual({ offset: 2, data: f.bytes.subarray(2, 6) })
    await expect(source.chunk({ ...f.metadata, releaseId: oldRelease, offset: 0, length: 2 })).rejects.toThrow(/release/i)
    await expect(source.chunk({ ...f.metadata, offset: -1, length: 2 })).rejects.toThrow(/range/i)
    await expect(source.chunk({ ...f.metadata, offset: 0, length: UPDATE_CHUNK_BYTES + 1 })).rejects.toThrow(/range/i)
    writeFileSync(f.executable, 'MZ-new-content-after-start')
    await expect(source.describe()).rejects.toThrow(/changed/i)
  })
  it('rejects aliases and redirected source directories', () => {
    const f = fixture(); linkSync(f.executable, path.join(f.root, 'alias.exe'))
    expect(() => createPortableReleaseSource({ packaged: true, portableExecutable: f.executable, releaseId })).toThrow(/link/i)
    const other = fixture(), redirect = path.join(other.root, 'redirect'); symlinkSync(other.root, redirect, 'junction')
    expect(() => createPortableReleaseSource({ packaged: true, portableExecutable: path.join(redirect, 'Forsage.exe'), releaseId })).toThrow(/redirect/i)
  })
})

describe('bounded, authenticated-transport download', () => {
  it('stages verified bytes under the local root and preserves unrelated database files', async () => {
    const f = fixture(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(UPDATE_CHUNK_BYTES + 9, 9)]))
    writeFileSync(path.join(f.root, 'forsage.db'), 'unchanged')
    const result = await downloadPortableUpdate({ transport: f.transport, localAppData: f.root, currentReleaseId: oldRelease })
    expect(result.state).toBe('ready')
    if (result.state !== 'ready') throw Error('missing update')
    expect(result.update.filePath.startsWith(path.join(f.root, 'Forsage', 'updates') + path.sep)).toBe(true)
    expect(hash(readFileSync(result.update.filePath))).toBe(f.metadata.sha256)
    expect(readFileSync(path.join(f.root, 'forsage.db'), 'utf8')).toBe('unchanged')
    expect(await downloadPortableUpdate({ transport: f.transport, localAppData: f.root, currentReleaseId: oldRelease })).toEqual(result)
  })
  it('skips the installed release and refuses automatic downgrades before downloading', async () => {
    const f = fixture(); let chunks = 0
    f.transport.chunk = async () => { chunks++; throw Error('must not download') }
    expect(await downloadPortableUpdate({ transport: f.transport, localAppData: f.root, currentReleaseId: releaseId })).toEqual({ state: 'current' })
    expect(await downloadPortableUpdate({ transport: f.transport, localAppData: f.root, currentReleaseId: '20261014T010000-cccccccccccc' })).toEqual({ state: 'current' })
    expect(chunks).toBe(0)
  })
  it.each([
    { protocol: 2 }, { releaseId: '../../outside.exe' }, { sha256: 'not-a-hash' },
    { size: MAX_UPDATE_BYTES + 1 }, { size: 1 }, { size: 2.5 },
  ])('rejects untrusted metadata %j', async patch => {
    const f = fixture()
    await expect(downloadPortableUpdate({ transport: { ...f.transport, describe: async () => ({ ...f.metadata, ...patch }) }, localAppData: f.root, currentReleaseId: oldRelease })).rejects.toThrow(/metadata/i)
    expect(existsSync(path.join(f.root, 'Forsage'))).toBe(false)
  })
  it.each(['offset', 'short', 'corrupt', 'not-exe'] as const)('rejects %s payload without committing a staged executable', async kind => {
    const f = fixture(kind === 'not-exe' ? Buffer.from('NO-invalid-executable') : undefined)
    const chunk = f.transport.chunk
    f.transport.chunk = async input => {
      const result = await chunk(input)
      if (kind === 'offset') return { ...result, offset: result.offset + 1 }
      if (kind === 'short') return { ...result, data: result.data.subarray(1) }
      if (kind === 'corrupt') return { ...result, data: Buffer.alloc(result.data.length, 65) }
      return result
    }
    await expect(downloadPortableUpdate({ transport: f.transport, localAppData: f.root, currentReleaseId: oldRelease })).rejects.toThrow()
    const directory = path.join(f.root, 'Forsage', 'updates')
    expect(readdirSync(directory).filter(name => name.endsWith('.exe'))).toEqual([])
    expect(existsSync(path.join(directory, 'download.lock'))).toBe(false)
  })
  it('never writes through an AppData junction', async () => {
    const f = fixture(), outside = fixture()
    symlinkSync(outside.root, path.join(f.root, 'Forsage'), 'junction')
    await expect(downloadPortableUpdate({ transport: f.transport, localAppData: f.root, currentReleaseId: oldRelease })).rejects.toThrow(/redirect/i)
    expect(existsSync(path.join(outside.root, 'updates'))).toBe(false)
  })
  it('preserves an interrupted download lock instead of guessing ownership', async () => {
    const f = fixture(), directory = path.join(f.root, 'Forsage', 'updates'); mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'download.lock'), 'unknown previous download')
    await expect(downloadPortableUpdate({ transport: f.transport, localAppData: f.root, currentReleaseId: oldRelease })).rejects.toThrow(/lock|EEXIST/i)
    expect(readFileSync(path.join(directory, 'download.lock'), 'utf8')).toBe('unknown previous download')
  })
  it('aborts a pending chunk immediately and ignores a late response without leaving a lock', async () => {
    const f = fixture(), controller = new AbortController()
    let finish: (chunk: { offset: number; data: Uint8Array }) => void = () => {}
    f.transport.chunk = async () => {
      setImmediate(() => controller.abort())
      return new Promise(resolve => { finish = resolve })
    }
    await expect(downloadPortableUpdate({ transport: f.transport, localAppData: f.root, currentReleaseId: oldRelease, signal: controller.signal })).rejects.toThrow(/cancelled/i)
    finish({ offset: 0, data: f.bytes })
    await new Promise(resolve => setImmediate(resolve))
    expect(readdirSync(path.join(f.root, 'Forsage', 'updates'))).toEqual([])
  })
  it('does not contact the host for an already cancelled check', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort()
    f.transport.describe = async () => { throw Error('must not contact host') }
    await expect(downloadPortableUpdate({ transport: f.transport, localAppData: f.root, currentReleaseId: oldRelease, signal: controller.signal })).rejects.toThrow(/cancelled/i)
    expect(existsSync(path.join(f.root, 'Forsage'))).toBe(false)
  })
})
