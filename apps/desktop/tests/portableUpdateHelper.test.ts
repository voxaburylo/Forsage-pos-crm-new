import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchPortableUpdateAfterQuit, readPortableUpdateOutcome, type StagedUpdate } from '../src/updates/portableUpdate'
import { PORTABLE_UPDATE_POWERSHELL } from '../src/updates/portableUpdateHelper'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>()
  return { ...actual, spawn: vi.fn(() => { throw Error('Unexpected helper dispatch in fixture') }) }
})

const roots: string[] = [], releaseId = '20261013T010000-bbbbbbbbbbbb'
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const platformSupported = process.platform === 'win32'
const shopOpen = platformSupported && execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^Forsage(?:-.*)?\\.exe$' }).Count"], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim() !== '0'
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-helper-test-')); roots.push(root)
  const directory = path.join(root, 'Forsage', 'updates'); mkdirSync(directory, { recursive: true })
  const destination = path.join(root, 'synthetic.exe'), bytes = Buffer.from('MZ-next-synthetic-executable'), sha256 = hash(bytes)
  writeFileSync(destination, 'MZ-previous-synthetic-executable')
  writeFileSync(path.join(root, 'forsage.db'), 'DO NOT TOUCH')
  const filePath = path.join(directory, `${sha256}.exe`); writeFileSync(filePath, bytes)
  const update: StagedUpdate = { protocol: 1, releaseId, sha256, size: bytes.length, filePath }
  const job = { protocol: 1, jobId: randomUUID(), root: directory, destination, parentPid: 2147483646,
    releaseId, sha256, size: bytes.length, previousHash: hash(readFileSync(destination)), deadline: new Date(Date.now() + 60_000).toISOString() }
  return { root, directory, destination, bytes, update, job }
}
function seedJob(f: ReturnType<typeof fixture>) {
  writeFileSync(path.join(f.directory, 'install.lock'), JSON.stringify(f.job))
  writeFileSync(f.destination + '.update-lock', JSON.stringify(f.job))
  writeFileSync(path.join(f.directory, 'last-job.json'), JSON.stringify(f.job))
}
function runHelper(f: ReturnType<typeof fixture>) {
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PORTABLE_UPDATE_POWERSHELL, 'utf16le').toString('base64')], {
    env: { ...process.env, FORSAGE_UPDATE_JOB: Buffer.from(JSON.stringify(f.job)).toString('base64') }, windowsHide: true, timeout: 20_000,
  })
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  vi.mocked(childProcess.spawn).mockReset()
  for (const root of roots.splice(0)) if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-helper-test-')) rmSync(root, { recursive: true, force: true })
})
it('uses a fixed bounded hidden helper without policy bypass, downloaded script or forced termination', () => {
  expect(Buffer.from(PORTABLE_UPDATE_POWERSHELL, 'utf16le').toString('base64').length).toBeLessThan(30_000)
  expect(PORTABLE_UPDATE_POWERSHELL).not.toMatch(/Stop-Process|taskkill|ExecutionPolicy|Invoke-WebRequest|Invoke-Expression/i)
  expect(PORTABLE_UPDATE_POWERSHELL).toContain('[IO.File]::Replace($pending, $target, $backup, $false)')
  expect(PORTABLE_UPDATE_POWERSHELL).toContain('[IO.File]::Replace($backup, $target, $null, $false)')
})
describe.skipIf(!platformSupported)('real Windows helper on isolated synthetic files, production gates unchanged', () => {
  it('rejects a modified staged executable before touching the target or any database file', () => {
    const f = fixture(); seedJob(f); writeFileSync(f.update.filePath, 'MZ-corrupt')
    runHelper(f)
    expect(hash(readFileSync(f.destination))).toBe(f.job.previousHash)
    expect(readPortableUpdateOutcome(f.root)?.state).toBe('failed')
    expect(existsSync(f.destination + '.update-lock')).toBe(false)
    expect(readFileSync(path.join(f.root, 'forsage.db'), 'utf8')).toBe('DO NOT TOUCH')
  })
  it('never installs after the allowed waiting period expires', () => {
    const f = fixture(); f.job.deadline = new Date(Date.now() - 1000).toISOString(); seedJob(f)
    runHelper(f)
    expect(hash(readFileSync(f.destination))).toBe(f.job.previousHash)
    const result = readPortableUpdateOutcome(f.root)
    expect(result?.state).toBe('failed')
    expect(result?.message).toMatch(/open|expired/i)
  })
  it.skipIf(shopOpen)('atomically installs and saves a verified rollback without touching other files', () => {
    const f = fixture(); seedJob(f); runHelper(f)
    expect(hash(readFileSync(f.destination))).toBe(f.update.sha256)
    expect(hash(readFileSync(path.join(f.directory, `rollback-${f.job.previousHash}.exe`)))).toBe(f.job.previousHash)
    expect(readPortableUpdateOutcome(f.root)?.state).toBe('installed')
    expect(readdirSync(f.root).filter(name => name.includes('pending') || name.includes('backup') || name.includes('lock'))).toEqual([])
    expect(readFileSync(path.join(f.root, 'forsage.db'), 'utf8')).toBe('DO NOT TOUCH')
  })
  it.skipIf(shopOpen)('rolls back atomically if the existing recovery destination is untrusted', () => {
    const f = fixture(); seedJob(f)
    writeFileSync(path.join(f.directory, `rollback-${f.job.previousHash}.exe`), 'MZ-corrupt-rollback')
    runHelper(f)
    expect(hash(readFileSync(f.destination))).toBe(f.job.previousHash)
    expect(readPortableUpdateOutcome(f.root)?.state).toBe('rolled-back')
  })
})
describe('installation preparation fails closed before spawning', () => {
  it('does not install from an unpacked build or without accepted normal quit', async () => {
    const f = fixture()
    await expect(launchPortableUpdateAfterQuit({ packaged: false, portableExecutable: f.destination, localAppData: f.root, update: f.update, quitConfirmed: true })).rejects.toThrow(/unavailable/i)
    await expect(launchPortableUpdateAfterQuit({ packaged: true, portableExecutable: f.destination, localAppData: f.root, update: f.update, quitConfirmed: false as true })).rejects.toThrow(/unavailable/i)
  })
  it('rejects a staging path supplied outside the private update directory', async () => {
    const f = fixture()
    await expect(launchPortableUpdateAfterQuit({ packaged: true, portableExecutable: f.destination, localAppData: f.root, update: { ...f.update, filePath: f.destination }, quitConfirmed: true })).rejects.toThrow(/escaped/i)
    expect(existsSync(f.destination + '.update-lock')).toBe(false)
  })
  it('does not retry an interrupted installation with an unknown result', async () => {
    const f = fixture(); f.job.deadline = new Date(Date.now() - 1000).toISOString(); seedJob(f)
    expect(readPortableUpdateOutcome(f.root)?.state).toBe('unknown')
    await expect(launchPortableUpdateAfterQuit({ packaged: true, portableExecutable: f.destination, localAppData: f.root, update: f.update, quitConfirmed: true })).rejects.toThrow(/inspection/i)
    expect(JSON.parse(readFileSync(path.join(f.directory, 'install.lock'), 'utf8')).jobId).toBe(f.job.jobId)
  })
  it('rejects a hard-linked target and retains an existing installer lock', async () => {
    const f = fixture(); linkSync(f.destination, path.join(f.root, 'alias.exe'))
    await expect(launchPortableUpdateAfterQuit({ packaged: true, portableExecutable: f.destination, localAppData: f.root, update: f.update, quitConfirmed: true })).rejects.toThrow(/link/i)
    const second = fixture(); writeFileSync(second.destination + '.update-lock', 'owned by operator installer')
    await expect(launchPortableUpdateAfterQuit({ packaged: true, portableExecutable: second.destination, localAppData: second.root, update: second.update, quitConfirmed: true })).rejects.toThrow(/EEXIST/i)
    expect(readFileSync(second.destination + '.update-lock', 'utf8')).toBe('owned by operator installer')
    expect(existsSync(path.join(second.directory, 'install.lock'))).toBe(false)
  })
  it('dispatches a hidden detached fixed helper with no broad inherited credentials or policy override', async () => {
    const f = fixture(), child = new EventEmitter() as childProcess.ChildProcess
    child.unref = vi.fn()
    vi.stubEnv('FORSAGE_SYNTHETIC_PRIVATE_TEST', 'not-to-be-forwarded')
    const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => { setImmediate(() => child.emit('spawn')); return child })
    const result = await launchPortableUpdateAfterQuit({ packaged: true, portableExecutable: f.destination, localAppData: f.root, update: f.update, quitConfirmed: true })
    expect(spawn).toHaveBeenCalledOnce()
    const [program, args, options] = spawn.mock.calls[0] as [string, string[], childProcess.SpawnOptions]
    expect(program).toBe(powershell)
    expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PORTABLE_UPDATE_POWERSHELL, 'utf16le').toString('base64')])
    expect(options).toMatchObject({ windowsHide: true, detached: true, stdio: 'ignore' })
    expect(options.env?.FORSAGE_SYNTHETIC_PRIVATE_TEST).toBeUndefined()
    expect(child.unref).toHaveBeenCalledOnce()
    expect(readPortableUpdateOutcome(f.root)).toMatchObject({ state: 'waiting', jobId: result.jobId })
    expect(hash(readFileSync(f.destination))).toBe(f.job.previousHash)
    expect(existsSync(f.destination + '.update-lock')).toBe(true)
  })
  it('records a failed helper spawn as a known non-install and releases only its own locks', async () => {
    const f = fixture(), child = new EventEmitter() as childProcess.ChildProcess
    child.unref = vi.fn()
    vi.mocked(childProcess.spawn).mockImplementation(() => { setImmediate(() => child.emit('error', Error('synthetic spawn failure'))); return child })
    await expect(launchPortableUpdateAfterQuit({ packaged: true, portableExecutable: f.destination, localAppData: f.root, update: f.update, quitConfirmed: true })).rejects.toThrow(/synthetic spawn failure/)
    expect(readPortableUpdateOutcome(f.root)?.state).toBe('failed')
    expect(existsSync(f.destination + '.update-lock')).toBe(false)
    expect(existsSync(path.join(f.directory, 'install.lock'))).toBe(false)
    expect(hash(readFileSync(f.destination))).toBe(f.job.previousHash)
  })
})
