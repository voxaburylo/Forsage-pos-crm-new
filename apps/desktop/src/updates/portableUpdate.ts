import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, lstatSync, mkdirSync, openSync, closeSync, readSync, readFileSync, realpathSync, type BigIntStats } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { PORTABLE_UPDATE_POWERSHELL } from './portableUpdateHelper'

export const MAX_UPDATE_BYTES = 512 * 1024 * 1024
export const UPDATE_CHUNK_BYTES = 512 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const RELEASE_ID = /^\d{8}T\d{6}-[a-f0-9]{12}$/
const SHA256 = /^[a-f0-9]{64}$/
export interface UpdateMetadata { protocol: 1; releaseId: string; sha256: string; size: number }
export interface UpdateChunkRequest { releaseId: string; sha256: string; offset: number; length: number }
export interface UpdateChunk { offset: number; data: Uint8Array }
export interface StagedUpdate extends UpdateMetadata { filePath: string }
export interface UpdateTransport {
  describe(): Promise<unknown>
  chunk(input: UpdateChunkRequest): Promise<UpdateChunk>
}

function normalized(file: string) { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved }
function optionalStat(file: string): BigIntStats | null {
  try { return lstatSync(file, { bigint: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
function localAbsolute(file: string) {
  if (!path.isAbsolute(file) || file.startsWith('\\\\') || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(file) || file.slice(2).includes(':') || file.length > 240))) throw Error('Update path must be a local absolute path')
  return path.resolve(file)
}
function assertPlainDirectory(directory: string) {
  localAbsolute(directory)
  let current = directory
  for (;;) {
    const stat = lstatSync(current, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(realpathSync(current)) !== normalized(current)) throw Error('Redirected update directory is not allowed')
    const parent = path.dirname(current); if (parent === current) break; current = parent
  }
}
function prepareDirectory(directory: string) {
  let ancestor = directory
  while (!optionalStat(ancestor)) { const next = path.dirname(ancestor); if (next === ancestor) throw Error('Missing update root'); ancestor = next }
  assertPlainDirectory(ancestor)
  mkdirSync(directory, { recursive: true })
  assertPlainDirectory(directory)
}
function assertPlainFile(file: string): BigIntStats {
  localAbsolute(file); assertPlainDirectory(path.dirname(file))
  const stat = lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || normalized(realpathSync(file)) !== normalized(file)) throw Error('Update file is linked, redirected or not a plain file')
  return stat
}
function sameIdentity(a: BigIntStats, b: BigIntStats) {
  return a.isFile() && !a.isSymbolicLink() && a.nlink === 1n && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs
}
function unchanged(a: BigIntStats, b: BigIntStats) {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
function assertExecutable(file: string, expected?: BigIntStats) {
  const stat = assertPlainFile(file)
  if (expected && !unchanged(stat, expected)) throw Error('Portable executable changed after startup')
  if (stat.size < 2n || stat.size > BigInt(MAX_UPDATE_BYTES)) throw Error('Executable size is outside update limits')
  const fd = openSync(file, 'r')
  try { const magic = Buffer.alloc(2); if (readSync(fd, magic, 0, 2, 0) !== 2 || magic.toString('ascii') !== 'MZ') throw Error('Not a Windows executable') } finally { closeSync(fd) }
  return stat
}
async function fileHash(file: string) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file, { highWaterMark: UPDATE_CHUNK_BYTES })) digest.update(chunk)
  return digest.digest('hex')
}
function metadata(value: unknown): UpdateMetadata {
  const item = value as Partial<UpdateMetadata> | null
  if (!item || item.protocol !== 1 || typeof item.releaseId !== 'string' || !RELEASE_ID.test(item.releaseId) || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size! < 2 || item.size! > MAX_UPDATE_BYTES) throw Error('Invalid update metadata')
  return { protocol: 1, releaseId: item.releaseId, sha256: item.sha256, size: item.size! }
}
export function createPortableReleaseSource(input: { packaged: boolean; portableExecutable?: string; releaseId?: string }): UpdateTransport | null {
  if (!input.packaged || !input.portableExecutable || !input.releaseId || !RELEASE_ID.test(input.releaseId)) return null
  const executable = localAbsolute(input.portableExecutable), initial = assertExecutable(executable)
  const releaseId = input.releaseId
  let cached: Promise<UpdateMetadata> | null = null
  const describe = async () => {
    assertExecutable(executable, initial)
    cached ??= (async () => {
      const sha256 = await fileHash(executable)
      assertExecutable(executable, initial)
      return { protocol: 1 as const, releaseId, sha256, size: Number(initial.size) }
    })()
    const result = await cached; assertExecutable(executable, initial)
    return { ...result }
  }
  return { describe, chunk: async request => {
    const current = await describe()
    if (request.releaseId !== current.releaseId || request.sha256 !== current.sha256) throw Error('Requested update release is not this host release')
    if (!Number.isSafeInteger(request.offset) || !Number.isSafeInteger(request.length) || request.offset < 0 || request.length < 1 || request.length > UPDATE_CHUNK_BYTES || request.offset + request.length > current.size) throw Error('Invalid update chunk range')
    const file = await open(executable, 'r')
    try {
      if (!unchanged(await file.stat({ bigint: true }), initial)) throw Error('Portable executable changed')
      const data = Buffer.alloc(request.length)
      const result = await file.read(data, 0, data.length, request.offset)
      if (result.bytesRead !== data.length || !unchanged(await file.stat({ bigint: true }), initial)) throw Error('Portable executable changed while reading')
      assertExecutable(executable, initial)
      return { offset: request.offset, data }
    } finally { await file.close() }
  } }
}

function aborted(signal?: AbortSignal) { if (signal?.aborted) throw Error('Update download cancelled') }
async function bounded<T>(work: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  aborted(signal)
  const delay = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())
  if (delay <= 0) throw Error('Update download timed out')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('Update download timed out')), delay)
      abort = () => reject(Error('Update download cancelled'))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })])
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
}
function updateRoot(localAppData: string) { return path.join(localAbsolute(localAppData), 'Forsage', 'updates') }
async function removeOwned(file: string, identity: BigIntStats) {
  const current = optionalStat(file)
  if (!current) return
  if (!sameIdentity(current, identity)) throw Error('Update cleanup refused: file ownership changed')
  assertPlainDirectory(path.dirname(file))
  await unlink(file)
}
export async function downloadPortableUpdate(input: { transport: UpdateTransport; localAppData: string; currentReleaseId: string; signal?: AbortSignal }): Promise<{ state: 'current' } | { state: 'ready'; update: StagedUpdate }> {
  if (!RELEASE_ID.test(input.currentReleaseId)) throw Error('Current release identity is unavailable')
  aborted(input.signal)
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS
  const offered = metadata(await bounded(input.transport.describe(), deadline, input.signal))
  aborted(input.signal)
  // A same timestamp with different content has no proven ordering: never downgrade/reinstall it automatically.
  if (offered.releaseId.slice(0, 15) <= input.currentReleaseId.slice(0, 15)) return { state: 'current' }
  const directory = updateRoot(input.localAppData); prepareDirectory(directory)
  if (optionalStat(path.join(directory, 'install.lock'))) throw Error('Previous update installation needs inspection')
  const lockPath = path.join(directory, 'download.lock'), lock = await open(lockPath, 'wx')
  const lockStat = await lock.stat({ bigint: true })
  const partialPath = path.join(directory, `${randomUUID()}.partial`)
  let partialStat: BigIntStats | null = null
  try {
    await lock.writeFile(JSON.stringify({ protocol: 1, pid: process.pid, startedAt: new Date().toISOString() })); await lock.sync()
    const filePath = path.join(directory, `${offered.sha256}.exe`)
    if (optionalStat(filePath)) {
      const existing = assertExecutable(filePath)
      if (Number(existing.size) !== offered.size || await fileHash(filePath) !== offered.sha256 || !unchanged(assertPlainFile(filePath), existing)) throw Error('Existing staged update failed verification')
      aborted(input.signal)
      return { state: 'ready', update: { ...offered, filePath } }
    }
    const partial = await open(partialPath, 'wx')
    partialStat = await partial.stat({ bigint: true })
    try {
      const digest = createHash('sha256')
      for (let offset = 0; offset < offered.size;) {
        aborted(input.signal)
        const length = Math.min(UPDATE_CHUNK_BYTES, offered.size - offset)
        const response = await bounded(input.transport.chunk({ releaseId: offered.releaseId, sha256: offered.sha256, offset, length }), deadline, input.signal)
        aborted(input.signal)
        if (response.offset !== offset || !(response.data instanceof Uint8Array) || response.data.byteLength !== length) throw Error('Invalid update chunk response')
        if (offset === 0 && (response.data[0] !== 77 || response.data[1] !== 90)) throw Error('Not a Windows executable')
        digest.update(response.data)
        let written = 0
        while (written < length) { const result = await partial.write(response.data, written, length - written, offset + written); if (!result.bytesWritten) throw Error('Update write incomplete'); written += result.bytesWritten }
        offset += length
      }
      if (digest.digest('hex') !== offered.sha256) throw Error('Downloaded update checksum mismatch')
      await partial.sync()
    } finally { await partial.close() }
    aborted(input.signal)
    assertPlainDirectory(directory)
    const completed = assertExecutable(partialPath)
    if (!sameIdentity(completed, partialStat) || Number(completed.size) !== offered.size || await fileHash(partialPath) !== offered.sha256 || !unchanged(assertPlainFile(partialPath), completed)) throw Error('Staged update changed during verification')
    aborted(input.signal)
    if (optionalStat(filePath)) throw Error('Concurrent staged update appeared')
    await rename(partialPath, filePath)
    partialStat = null
    if (await fileHash(filePath) !== offered.sha256 || !sameIdentity(assertExecutable(filePath), completed)) throw Error('Published staged update failed verification')
    return { state: 'ready', update: { ...offered, filePath } }
  } finally {
    await lock.close()
    // Unknown/replaced paths are retained for inspection instead of deleting someone else's file.
    if (partialStat) await removeOwned(partialPath, partialStat)
    await removeOwned(lockPath, lockStat)
  }
}

export interface PortableUpdateOutcome {
  protocol: 1
  jobId: string
  releaseId: string
  state: 'waiting' | 'installed' | 'failed' | 'rolled-back' | 'unknown'
  message?: string
  sha256?: string
  previousHash?: string
  finishedAt?: string
}
interface UpdateJob {
  protocol: 1; jobId: string; root: string; destination: string; parentPid: number;
  releaseId: string; sha256: string; size: number; previousHash: string; deadline: string;
}
function readSmallJson(file: string): Record<string, unknown> {
  const stat = assertPlainFile(file)
  if (stat.size > 16_384n) throw Error('Invalid update state size')
  const result: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!unchanged(assertPlainFile(file), stat) || !result || typeof result !== 'object' || Array.isArray(result)) throw Error('Invalid update state')
  return result as Record<string, unknown>
}
export function readPortableUpdateOutcome(localAppData: string): PortableUpdateOutcome | null {
  const directory = updateRoot(localAppData), lastFile = path.join(directory, 'last-job.json')
  if (!optionalStat(lastFile)) return null
  const last = readSmallJson(lastFile)
  if (last.protocol !== 1 || typeof last.jobId !== 'string' || !/^[a-f0-9-]{36}$/.test(last.jobId) || typeof last.releaseId !== 'string' || !RELEASE_ID.test(last.releaseId) || typeof last.deadline !== 'string' || !Number.isFinite(Date.parse(last.deadline))) throw Error('Invalid previous update job')
  const base = { protocol: 1 as const, jobId: last.jobId, releaseId: last.releaseId }
  const resultFile = path.join(directory, `${last.jobId}.result.json`)
  if (!optionalStat(resultFile)) return { ...base, state: Date.now() > Date.parse(last.deadline) ? 'unknown' : 'waiting' }
  const result = readSmallJson(resultFile)
  if (result.protocol !== 1 || result.jobId !== last.jobId || result.releaseId !== last.releaseId || !['installed', 'failed', 'rolled-back', 'unknown'].includes(String(result.state))) return { ...base, state: 'unknown' }
  // Even a written result is not a completed job until both locks have been released by the helper.
  if (optionalStat(path.join(directory, 'install.lock'))) return { ...base, state: 'unknown', message: 'Update recovery files need inspection' }
  return { ...base, state: result.state as PortableUpdateOutcome['state'],
    ...(typeof result.message === 'string' ? { message: result.message.slice(0, 500) } : {}),
    ...(typeof result.sha256 === 'string' && SHA256.test(result.sha256) ? { sha256: result.sha256 } : {}),
    ...(typeof result.previousHash === 'string' && SHA256.test(result.previousHash) ? { previousHash: result.previousHash } : {}),
    ...(typeof result.finishedAt === 'string' ? { finishedAt: result.finishedAt } : {}) }
}

/** Prepare only after the application's existing normal-quit checks have accepted closing.
 * The detached helper still independently waits for every Forsage process and the launcher.
 * Unknown previous outcomes are retained; this function never guesses that an interrupted job is safe.
 */
export async function launchPortableUpdateAfterQuit(input: {
  packaged: boolean; portableExecutable?: string; localAppData: string; update: StagedUpdate;
  parentPid?: number; quitConfirmed: true;
}): Promise<{ jobId: string; resultFile: string }> {
  if (process.platform !== 'win32' || !input.packaged || !input.portableExecutable || input.quitConfirmed !== true) throw Error('Portable update installation is unavailable before normal quit')
  const offered = metadata(input.update), directory = updateRoot(input.localAppData)
  assertPlainDirectory(directory)
  const source = path.join(directory, `${offered.sha256}.exe`)
  if (normalized(input.update.filePath) !== normalized(source)) throw Error('Staged update escaped the local staging directory')
  const sourceStat = assertExecutable(source)
  if (Number(sourceStat.size) !== offered.size || await fileHash(source) !== offered.sha256 || !unchanged(assertPlainFile(source), sourceStat)) throw Error('Staged update checksum mismatch')
  const destination = localAbsolute(input.portableExecutable)
  if (path.extname(destination).toLowerCase() !== '.exe' || normalized(source) === normalized(destination)) throw Error('Invalid portable update destination')
  const targetStat = assertExecutable(destination), previousHash = await fileHash(destination)
  if (!unchanged(assertPlainFile(destination), targetStat)) throw Error('Installed executable changed during update preparation')
  if (previousHash === offered.sha256) throw Error('Update is already installed')
  const parentPid = input.parentPid ?? process.pid
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) throw Error('Invalid parent process identity')
  const previous = readPortableUpdateOutcome(input.localAppData)
  if (previous?.state === 'waiting' || previous?.state === 'unknown') throw Error('Previous update outcome requires inspection')
  const job: UpdateJob = { protocol: 1, jobId: randomUUID(), root: directory, destination, parentPid,
    releaseId: offered.releaseId, sha256: offered.sha256, size: offered.size, previousHash,
    deadline: new Date(Date.now() + 5 * 60_000).toISOString() }
  const command = Buffer.from(PORTABLE_UPDATE_POWERSHELL, 'utf16le').toString('base64')
  if (command.length > 30_000) throw Error('Update helper command exceeds Windows limit')
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw Error('Windows PowerShell location is unavailable')
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const lockFiles = [destination + '.update-lock', path.join(directory, 'install.lock')]
  const owned: Array<{ file: string; stat: BigIntStats }> = []
  const lastFile = path.join(directory, 'last-job.json'), lastTemp = path.join(directory, `${job.jobId}.last.partial`)
  let dispatched = false
  let published = false
  try {
    for (const file of lockFiles) {
      assertPlainDirectory(path.dirname(file))
      const lock = await open(file, 'wx')
      try { owned.push({ file, stat: await lock.stat({ bigint: true }) }); await lock.writeFile(JSON.stringify(job)); await lock.sync() } finally { await lock.close() }
    }
    if (!unchanged(assertPlainFile(destination), targetStat)) throw Error('Installed executable changed before dispatch')
    if (optionalStat(lastFile)) readSmallJson(lastFile)
    const last = await open(lastTemp, 'wx')
    try { owned.push({ file: lastTemp, stat: await last.stat({ bigint: true }) }); await last.writeFile(JSON.stringify(job)); await last.sync() } finally { await last.close() }
    assertPlainDirectory(directory)
    await rename(lastTemp, lastFile)
    published = true
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      windowsHide: true, detached: true, stdio: 'ignore',
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA,
        FORSAGE_UPDATE_JOB: Buffer.from(JSON.stringify(job), 'utf8').toString('base64') },
    })
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve) })
    dispatched = true; child.unref()
    return { jobId: job.jobId, resultFile: path.join(directory, `${job.jobId}.result.json`) }
  } catch (error) {
    if (published && !dispatched) {
      // spawn failure is a known non-install, unlike an interrupted running helper.
      const result = await open(path.join(directory, `${job.jobId}.result.json`), 'wx')
      try { await result.writeFile(JSON.stringify({ protocol: 1, jobId: job.jobId, releaseId: job.releaseId,
        state: 'failed', message: 'Windows update helper could not start', finishedAt: new Date().toISOString() })); await result.sync() } finally { await result.close() }
    }
    throw error
  } finally {
    // After dispatch, only the helper owns cleanup. Even an unconfirmed helper outcome keeps recovery locks.
    if (!dispatched) for (const entry of owned.reverse()) await removeOwned(entry.file, entry.stat)
  }
}
