import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storage: { isEncryptionAvailable: vi.fn(), encryptString: vi.fn(), decryptString: vi.fn() },
  paths: { cashalotSearchDirs: vi.fn(), detectCashalotDir: vi.fn(), resolveCashalotDir: vi.fn(), hasCashalotDll: vi.fn() },
  processes: { spawn: vi.fn(), spawnSync: vi.fn(), exec: vi.fn(), execSync: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn(), fork: vi.fn() },
}))

vi.mock('electron', () => ({ safeStorage: mocks.storage }))
vi.mock('node:child_process', () => ({ default: mocks.processes, ...mocks.processes }))
vi.mock('../src/fiscal/cashalotPaths', () => mocks.paths)

import { CashalotService, type CashalotConfig, type CashalotConfigUpdate } from '../src/fiscal/cashalotService'

const OLD_UNC = '\\\\unit-only-offline-host\\cashalot'
const INSTALLED = 'Z:\\__cashalot_atomic_unit_only__\\installed'
const MANUAL = 'Z:\\__cashalot_atomic_unit_only__\\manual'
const INITIAL: CashalotConfig = {
  enabled: false, cashalotDir: OLD_UNC, fiscalNumberRRO: '4000000000',
  certificateDir: 'Z:\\__cashalot_atomic_unit_only__\\cert-old',
  encryptedKeyPassword: Buffer.from('mock-old-encrypted').toString('base64'),
}
const NEXT: CashalotConfigUpdate = {
  enabled: true, fiscalNumberRRO: '5000000000',
  certificateDir: 'Z:\\__cashalot_atomic_unit_only__\\cert-new', keyPassword: 'mock-new-password',
}
const NEXT_ENCRYPTED = Buffer.from('mock-next-encrypted').toString('base64')
const OK = { id: 'mock-response', ok: true, result: { Return: true } }

type Response = { id: string; ok: boolean; error?: string; result?: { Return?: boolean; Description?: string } }
type Request = { id: string; config: { cashalotDir: string; fiscalNumberRRO: string; certificateDir: string | null; keyPassword: string | null } }
type IdleWorker = { exitCode: null; stdin: { end: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> }
type Adapter = {
  config: CashalotConfig
  cashalotDirResolved: boolean
  worker: IdleWorker | null
  sendRequest(request: Request): Promise<Response>
  isComRegistered(): boolean
}

function inspect(service: CashalotService): Adapter { return service as unknown as Adapter }

// Keep unwrapped methods for fixture setup, fault injection and assertions.
// The service only sees fs spies, and every permitted real path is inside the
// newly created private temp directory. Cashalot/certificate paths are mocked.
const real = {
  readFileSync: fs.readFileSync.bind(fs), writeFileSync: fs.writeFileSync.bind(fs),
  openSync: fs.openSync.bind(fs), closeSync: fs.closeSync.bind(fs), fsyncSync: fs.fsyncSync.bind(fs),
  renameSync: fs.renameSync.bind(fs), unlinkSync: fs.unlinkSync.bind(fs), readdirSync: fs.readdirSync.bind(fs),
}

describe('Cashalot configuration publishes atomically and only while idle', () => {
  let root = ''
  let configPath = ''
  let opened: Set<number>
  let operations: Promise<unknown>[]
  let releaseGates: Array<() => void>

  beforeEach(() => {
    vi.resetAllMocks()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-cashalot-config-atomic-'))
    configPath = path.join(root, 'fiscal.json')
    opened = new Set()
    operations = []
    releaseGates = []
    real.writeFileSync(configPath, JSON.stringify(INITIAL, null, 2), 'utf8')
    mocks.paths.cashalotSearchDirs.mockReturnValue([INSTALLED])
    mocks.paths.detectCashalotDir.mockReturnValue(INSTALLED)
    mocks.paths.resolveCashalotDir.mockImplementation((saved: unknown) => saved === MANUAL ? MANUAL : INSTALLED)
    mocks.paths.hasCashalotDll.mockReturnValue(true)
    mocks.storage.isEncryptionAvailable.mockReturnValue(true)
    mocks.storage.encryptString.mockReturnValue(Buffer.from('mock-next-encrypted'))
    mocks.storage.decryptString.mockReturnValue('mock-old-password')
    for (const [name, mock] of Object.entries(mocks.processes)) {
      mock.mockImplementation(() => { throw new Error(`Forbidden real subprocess: ${name}`) })
    }
    // Also intercept require('node:child_process'), which vi.mock alone cannot
    // reliably replace. No registry, PowerShell or COM process may be started.
    const native = createRequire(import.meta.url)('node:child_process') as
      Record<keyof typeof mocks.processes, (...args: any[]) => any>
    for (const name of Object.keys(mocks.processes) as Array<keyof typeof mocks.processes>) {
      vi.spyOn(native, name).mockImplementation(mocks.processes[name])
    }
  })

  afterEach(async () => {
    // Release synthetic calls before restoring mocks, even after an assertion
    // failure. Otherwise a queued microtask could outlive its process guard.
    for (const release of releaseGates) release()
    await Promise.allSettled(operations)
    for (const fd of opened) { try { real.closeSync(fd) } catch {} }
    vi.restoreAllMocks()
    const resolved = path.resolve(root)
    const temp = path.resolve(os.tmpdir())
    if (root && path.dirname(resolved) === temp && path.basename(resolved).startsWith('forsage-cashalot-config-atomic-')) {
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  })

  function service(config: CashalotConfig = INITIAL): CashalotService {
    real.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
    const result = new CashalotService(root)
    vi.spyOn(inspect(result), 'isComRegistered').mockReturnValue(true)
    return result
  }

  function worker(subject: CashalotService, events: string[] = []): IdleWorker {
    const idle = {
      exitCode: null,
      stdin: { end: vi.fn(() => { events.push('worker.end') }) },
      kill: vi.fn(() => { events.push('worker.kill') }),
    }
    inspect(subject).worker = idle
    return idle
  }

  function snapshot(subject: CashalotService) {
    const state = inspect(subject)
    return {
      reference: state.config, config: { ...state.config }, resolved: state.cashalotDirResolved,
      worker: state.worker, file: real.readFileSync(configPath, 'utf8'), files: real.readdirSync(root).sort(),
    }
  }

  function expectUnchanged(subject: CashalotService, before: ReturnType<typeof snapshot>, checkDirectory = true): void {
    const state = inspect(subject)
    expect(state.config).toBe(before.reference)
    expect(state.config).toEqual(before.config)
    expect(state.cashalotDirResolved).toBe(before.resolved)
    expect(state.worker).toBe(before.worker)
    expect(before.worker?.stdin.end).not.toHaveBeenCalled()
    expect(before.worker?.kill).not.toHaveBeenCalled()
    expect(real.readFileSync(configPath, 'utf8')).toBe(before.file)
    if (checkDirectory) expect(real.readdirSync(root).sort()).toEqual(before.files)
  }

  function assertPrivatePath(target: fs.PathLike): void {
    expect(path.dirname(path.resolve(String(target)))).toBe(path.resolve(root))
  }

  function watchIo(events: string[] = []) {
    const open = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
      assertPrivatePath(target)
      events.push('open')
      const fd = real.openSync(target, flags, mode)
      opened.add(fd)
      return fd
    })
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
      if (typeof target === 'number') expect(opened.has(target)).toBe(true)
      else assertPrivatePath(target)
      events.push('write')
      real.writeFileSync(target, data, options)
    })
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      expect(opened.has(fd)).toBe(true)
      events.push('fsync')
      real.fsyncSync(fd)
    })
    const close = vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
      expect(opened.has(fd)).toBe(true)
      events.push('close')
      real.closeSync(fd)
      opened.delete(fd)
    })
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      assertPrivatePath(from)
      assertPrivatePath(to)
      events.push('rename')
      real.renameSync(from, to)
    })
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(target => {
      assertPrivatePath(target)
      expect(String(target)).not.toBe(configPath)
      events.push('unlink')
      real.unlinkSync(target)
    })
    return { open, write, sync, close, rename, unlink, events }
  }

  function responseGate() {
    let resolve!: (response: Response) => void
    let reject!: (error: Error) => void
    const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no })
    releaseGates.push(() => resolve(OK))
    return { promise, resolve, reject }
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    operations.push(promise.catch(() => undefined))
    return promise
  }

  function expectBusy(subject: CashalotService): void {
    const before = snapshot(subject)
    const resolutions = mocks.paths.resolveCashalotDir.mock.calls.length
    const encryptions = mocks.storage.encryptString.mock.calls.length
    expect(() => subject.updateConfig(NEXT)).toThrow('FISCAL_CONFIG_BUSY')
    expectUnchanged(subject, before)
    expect(mocks.paths.resolveCashalotDir).toHaveBeenCalledTimes(resolutions)
    expect(mocks.storage.encryptString).toHaveBeenCalledTimes(encryptions)
  }

  it('writes a private flushed temp file, renames it, then publishes memory and stops the idle worker; restart reads the saved result', () => {
    const subject = service()
    const events: string[] = []
    const idle = worker(subject, events)
    const before = snapshot(subject)
    const io = watchIo(events)
    io.rename.mockImplementation((from, to) => {
      assertPrivatePath(from)
      expect(String(from)).not.toBe(configPath)
      expect(String(to)).toBe(configPath)
      // The file, in-memory config and worker remain old until publication.
      expectUnchanged(subject, before, false)
      events.push('rename')
      real.renameSync(from, to)
    })

    const result = subject.updateConfig(NEXT)

    expect(events).toEqual(['open', 'write', 'fsync', 'close', 'rename', 'worker.end', 'worker.kill'])
    expect(io.open).toHaveBeenCalledTimes(1)
    const [temp, flags, mode] = io.open.mock.calls[0]
    expect([flags, mode]).toEqual(['wx', 0o600])
    expect(String(temp)).not.toBe(configPath)
    expect(path.dirname(String(temp))).toBe(root)
    expect(io.write).toHaveBeenCalledTimes(1)
    expect(typeof io.write.mock.calls[0][0]).toBe('number')
    expect(io.sync.mock.calls[0][0]).toBe(io.write.mock.calls[0][0])
    expect(io.close.mock.calls[0][0]).toBe(io.write.mock.calls[0][0])
    expect(idle.stdin.end).toHaveBeenCalledTimes(1)
    expect(idle.kill).toHaveBeenCalledTimes(1)
    expect(inspect(subject).worker).toBeNull()
    const expected = {
      ...INITIAL, enabled: true, cashalotDir: INSTALLED, fiscalNumberRRO: NEXT.fiscalNumberRRO,
      certificateDir: NEXT.certificateDir, encryptedKeyPassword: NEXT_ENCRYPTED,
    }
    expect(inspect(subject).config).toEqual(expected)
    expect(inspect(subject).cashalotDirResolved).toBe(true)
    expect(JSON.parse(real.readFileSync(configPath, 'utf8'))).toEqual(expected)
    expect(real.readFileSync(configPath, 'utf8')).not.toContain('mock-new-password')
    expect(real.readdirSync(root)).toEqual(['fiscal.json'])
    expect(result).toMatchObject({ enabled: true, cashalotDir: INSTALLED, hasPassword: true })
    const restarted = new CashalotService(root)
    expect(inspect(restarted).config).toEqual(expected)
    expect(restarted.isEnabled()).toBe(true)
    for (const process of Object.values(mocks.processes)) expect(process).not.toHaveBeenCalled()
  })

  it('preserves omitted fields and encrypted password while normalizing only an explicitly updated RRO', () => {
    const subject = service()
    subject.updateConfig({ fiscalNumberRRO: ' 5000000001 ' })
    const expected = { ...INITIAL, cashalotDir: INSTALLED, fiscalNumberRRO: '5000000001' }
    expect(inspect(subject).config).toEqual(expected)
    expect(JSON.parse(real.readFileSync(configPath, 'utf8'))).toEqual(expected)
    expect(mocks.storage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(mocks.storage.encryptString).not.toHaveBeenCalled()
    expect(mocks.storage.decryptString).not.toHaveBeenCalled()
  })

  it.each(['', null])('clears the password explicitly with %s without encryption', keyPassword => {
    const subject = service()
    const result = subject.updateConfig({ keyPassword })
    expect(result.hasPassword).toBe(false)
    expect(inspect(subject).config.encryptedKeyPassword).toBeNull()
    expect(JSON.parse(real.readFileSync(configPath, 'utf8')).encryptedKeyPassword).toBeNull()
    expect(mocks.storage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(mocks.storage.encryptString).not.toHaveBeenCalled()
  })

  it('honours an explicit manual directory without resolving the old UNC location', () => {
    const subject = service()
    subject.updateConfig({ enabled: true, cashalotDir: MANUAL })
    expect(inspect(subject).config).toEqual({ ...INITIAL, enabled: true, cashalotDir: MANUAL })
    expect(mocks.paths.resolveCashalotDir.mock.calls.some(([saved]) => saved === OLD_UNC)).toBe(false)
    expect(mocks.paths.detectCashalotDir).not.toHaveBeenCalled()
    expect(JSON.parse(real.readFileSync(configPath, 'utf8')).cashalotDir).toBe(MANUAL)
  })

  it.each(['unavailable', 'throws'] as const)('does not publish any candidate state when encryption %s', failure => {
    const subject = service()
    worker(subject)
    const before = snapshot(subject)
    const io = watchIo()
    if (failure === 'unavailable') mocks.storage.isEncryptionAvailable.mockReturnValue(false)
    else mocks.storage.encryptString.mockImplementation(() => { throw new Error('injected encryption failure') })

    expect(() => subject.updateConfig(NEXT)).toThrow(failure === 'unavailable' ? 'FISCAL_ENCRYPTION_UNAVAILABLE' : 'injected encryption failure')

    expectUnchanged(subject, before)
    expect(io.open).not.toHaveBeenCalled()
    expect(io.write).not.toHaveBeenCalled()
    expect(io.rename).not.toHaveBeenCalled()
  })

  it('does not publish a candidate whose public configuration diagnostics fail', () => {
    const subject = service()
    worker(subject)
    const before = snapshot(subject)
    const io = watchIo()
    mocks.paths.hasCashalotDll.mockImplementation(() => { throw new Error('injected diagnostic failure') })

    expect(() => subject.updateConfig(NEXT)).toThrow('injected diagnostic failure')

    expectUnchanged(subject, before)
    expect(io.open).not.toHaveBeenCalled()
    expect(io.write).not.toHaveBeenCalled()
    expect(io.rename).not.toHaveBeenCalled()
  })

  it.each(['open', 'write', 'fsync', 'close', 'rename'] as const)('preserves the old file, memory, lazy-resolution state and worker on %s failure', stage => {
    const subject = service()
    worker(subject)
    const before = snapshot(subject)
    const io = watchIo()
    const failure = new Error(`injected ${stage} failure`)
    if (stage === 'open') io.open.mockImplementation(() => { throw failure })
    if (stage === 'write') io.write.mockImplementation(target => {
      if (typeof target !== 'number') assertPrivatePath(target)
      real.writeFileSync(target, '{"partial":', 'utf8')
      throw failure
    })
    if (stage === 'fsync') io.sync.mockImplementation(() => { throw failure })
    if (stage === 'close') io.close.mockImplementationOnce(fd => {
      // A close error need not prove that the descriptor stayed open. Cleanup
      // must tolerate either state without deleting anything but its own temp.
      real.closeSync(fd)
      opened.delete(fd)
      throw failure
    })
    if (stage === 'rename') io.rename.mockImplementation(() => { throw failure })

    expect(() => subject.updateConfig(NEXT)).toThrow(failure.message)

    expectUnchanged(subject, before)
    expect(opened.size).toBe(0)
    if (stage === 'open') expect(io.unlink).not.toHaveBeenCalled()
    else {
      expect(io.unlink).toHaveBeenCalledTimes(1)
      expect(String(io.unlink.mock.calls[0][0])).not.toBe(configPath)
    }
  })

  it('never removes a pre-existing temp collision when exclusive creation fails', () => {
    const subject = service()
    worker(subject)
    const before = snapshot(subject)
    const io = watchIo()
    let collision = ''
    io.open.mockImplementation((target, flags, mode) => {
      assertPrivatePath(target)
      expect([flags, mode]).toEqual(['wx', 0o600])
      collision = String(target)
      expect(collision).not.toBe(configPath)
      const foreignFd = real.openSync(collision, 'wx', 0o600)
      try { real.writeFileSync(foreignFd, 'foreign-owned-file', 'utf8') } finally { real.closeSync(foreignFd) }
      throw Object.assign(new Error('injected EEXIST collision'), { code: 'EEXIST' })
    })

    expect(() => subject.updateConfig(NEXT)).toThrow('injected EEXIST collision')

    expectUnchanged(subject, before, false)
    expect(real.readFileSync(collision, 'utf8')).toBe('foreign-owned-file')
    expect(io.unlink).not.toHaveBeenCalled()
    expect(io.close).not.toHaveBeenCalled()
  })

  it('blocks updates synchronously when a call is queued but its first microtask has not run', async () => {
    const subject = service()
    worker(subject)
    const gate = responseGate()
    const send = vi.spyOn(inspect(subject), 'sendRequest').mockReturnValue(gate.promise)
    const call = track(subject.getStatus())
    expect(send).not.toHaveBeenCalled()

    expectBusy(subject)

    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].config.fiscalNumberRRO).toBe(INITIAL.fiscalNumberRRO)
    gate.resolve(OK)
    await call
    expect(() => subject.updateConfig({ fiscalNumberRRO: '5000000002' })).not.toThrow()
  })

  it('blocks updates while a request is in flight, then permits them after it settles', async () => {
    const subject = service()
    worker(subject)
    const gate = responseGate()
    const send = vi.spyOn(inspect(subject), 'sendRequest').mockReturnValue(gate.promise)
    const call = track(subject.getStatus())
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)

    expectBusy(subject)

    gate.resolve(OK)
    await call
    expect(() => subject.updateConfig({ enabled: true })).not.toThrow()
  })

  it('keeps the guard across two queued calls and releases it after protocol and transport failures', async () => {
    const subject = service()
    worker(subject)
    const firstGate = responseGate()
    const secondGate = responseGate()
    const send = vi.spyOn(inspect(subject), 'sendRequest')
      .mockReturnValueOnce(firstGate.promise).mockReturnValueOnce(secondGate.promise)
    const first = track(subject.openShift())
    const second = track(subject.getStatus())
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    expectBusy(subject)

    firstGate.resolve({ id: 'mock-first', ok: false, error: 'mock protocol failure' })
    await expect(first).rejects.toThrow('mock protocol failure')
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(2)
    expectBusy(subject)
    secondGate.reject(new Error('mock transport failure'))
    await expect(second).rejects.toThrow('mock transport failure')

    expect(() => subject.updateConfig({ enabled: true, cashalotDir: MANUAL })).not.toThrow()
  })

  it.each(['missing RRO', 'decrypt failure'] as const)('releases the queued-call guard after %s before a worker request', async failure => {
    const subject = service(failure === 'missing RRO' ? { ...INITIAL, fiscalNumberRRO: '' } : INITIAL)
    worker(subject)
    const send = vi.spyOn(inspect(subject), 'sendRequest').mockResolvedValue(OK)
    if (failure === 'decrypt failure') mocks.storage.decryptString.mockImplementation(() => { throw new Error('mock decrypt failure') })
    const call = track(subject.getStatus())
    await expect(call).rejects.toThrow(failure === 'missing RRO' ? 'FISCAL_RRO_NOT_CONFIGURED' : 'mock decrypt failure')
    expect(send).not.toHaveBeenCalled()
    expect(() => subject.updateConfig({ fiscalNumberRRO: '5000000003' })).not.toThrow()
  })
})
