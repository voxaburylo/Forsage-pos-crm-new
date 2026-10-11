import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fs: {
    readFileSync: vi.fn(), writeFileSync: vi.fn(), statSync: vi.fn(), existsSync: vi.fn(),
    openSync: vi.fn(), fsyncSync: vi.fn(), closeSync: vi.fn(), renameSync: vi.fn(), unlinkSync: vi.fn(),
  },
  storage: { isEncryptionAvailable: vi.fn(), encryptString: vi.fn(), decryptString: vi.fn() },
  processes: {
    spawn: vi.fn(), spawnSync: vi.fn(), exec: vi.fn(), execSync: vi.fn(),
    execFile: vi.fn(), execFileSync: vi.fn(), fork: vi.fn(),
  },
  paths: { cashalotSearchDirs: vi.fn(), detectCashalotDir: vi.fn(), hasCashalotDll: vi.fn(), resolveCashalotDir: vi.fn() },
}))

vi.mock('node:fs', () => ({ default: mocks.fs, ...mocks.fs }))
vi.mock('electron', () => ({ safeStorage: mocks.storage }))
vi.mock('node:child_process', () => ({ default: mocks.processes, ...mocks.processes }))
vi.mock('../src/fiscal/cashalotPaths', () => mocks.paths)

import { CashalotService, type CashalotRetVal } from '../src/fiscal/cashalotService'

const ROOT = path.join('Z:\\__cashalot_worker_lifecycle_unit_only__', 'data')
const CONFIG_PATH = path.join(ROOT, 'fiscal.json')
const WORKER_PATH = path.join(ROOT, 'cashalot-worker.ps1')
const INSTALLATION = path.join(ROOT, 'synthetic-cashalot')
const CONFIG = {
  enabled: true, cashalotDir: INSTALLATION, fiscalNumberRRO: '4000000000',
  certificateDir: null, encryptedKeyPassword: null,
}
const CALL_TIMEOUT_MS = 180_000

type Request = { id: string; method: string; comMethod: string; args: string[]; config: typeof CONFIG }

class FakeWorker extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  readonly stderr = new EventEmitter()
  readonly requests: Request[] = []
  exitCode: number | null = null
  writeError: Error | null = null
  readonly stdin = {
    write: vi.fn((line: string) => {
      // Capture before throwing: delivery is deliberately uncertain in this
      // fault, so a caller timeout/write error must not declare the worker idle.
      this.requests.push(JSON.parse(Buffer.from(line.trim(), 'base64').toString('utf8')) as Request)
      if (this.writeError) throw this.writeError
      return true
    }),
    end: vi.fn(),
  }
  // Killing does not emit exit automatically. Real old processes can deliver
  // exit/stdout asynchronously after a replacement worker has already started.
  readonly kill = vi.fn(() => true)

  exit(): void {
    this.exitCode = 0
    this.emit('exit', 0)
  }

  respond(request: Request, result: CashalotRetVal): void {
    this.stdout.emit('data', responseLine(request.id, result))
  }
}

function responseLine(id: string, result: CashalotRetVal): string {
  return Buffer.from(JSON.stringify({ id, ok: true, result }), 'utf8').toString('base64') + '\n'
}

function observe(promise: Promise<CashalotRetVal>) {
  const settled = vi.fn()
  const done = promise.then(
    value => { settled({ value }) },
    error => { settled({ error: error instanceof Error ? error.message : String(error) }) },
  )
  return { settled, done }
}

describe('Cashalot worker ownership and uncertain request completion', () => {
  let service: CashalotService
  let workers: FakeWorker[]
  let nextWriteError: Error | null
  let files: Map<string, string>

  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    workers = []
    nextWriteError = null
    files = new Map([[CONFIG_PATH, JSON.stringify(CONFIG)]])
    const descriptors = new Map<number, string>()
    let nextDescriptor = 800
    mocks.paths.cashalotSearchDirs.mockReturnValue([INSTALLATION])
    mocks.paths.detectCashalotDir.mockReturnValue(INSTALLATION)
    mocks.paths.resolveCashalotDir.mockImplementation((stored: string | null) => stored || INSTALLATION)
    mocks.paths.hasCashalotDll.mockReturnValue(true)
    mocks.fs.readFileSync.mockImplementation((target: string) => {
      if (!files.has(target)) throw Object.assign(new Error('Synthetic file missing'), { code: 'ENOENT' })
      return files.get(target)
    })
    mocks.fs.writeFileSync.mockImplementation((target: string | number, value: string) => {
      const filename = typeof target === 'number' ? descriptors.get(target) : target
      if (!filename || (filename !== WORKER_PATH && filename !== CONFIG_PATH && path.dirname(filename) !== ROOT)) {
        throw new Error('Unexpected synthetic file write')
      }
      files.set(filename, String(value))
    })
    mocks.fs.openSync.mockImplementation((target: string, flags: string, mode: number) => {
      expect(path.dirname(target)).toBe(ROOT)
      expect([flags, mode]).toEqual(['wx', 0o600])
      if (files.has(target)) throw Object.assign(new Error('Synthetic file exists'), { code: 'EEXIST' })
      files.set(target, '')
      const descriptor = nextDescriptor++
      descriptors.set(descriptor, target)
      return descriptor
    })
    mocks.fs.fsyncSync.mockImplementation((descriptor: number) => { expect(descriptors.has(descriptor)).toBe(true) })
    mocks.fs.closeSync.mockImplementation((descriptor: number) => { descriptors.delete(descriptor) })
    mocks.fs.renameSync.mockImplementation((source: string, destination: string) => {
      expect(destination).toBe(CONFIG_PATH)
      expect(files.has(source)).toBe(true)
      files.set(destination, files.get(source)!)
      files.delete(source)
    })
    mocks.fs.unlinkSync.mockImplementation((target: string) => {
      expect(target).not.toBe(CONFIG_PATH)
      files.delete(target)
    })
    mocks.fs.existsSync.mockImplementation((target: string) => files.has(target))
    mocks.fs.statSync.mockImplementation(() => { throw new Error('Unexpected filesystem probe: paths are synthetic') })
    for (const mock of Object.values(mocks.storage)) mock.mockImplementation(() => { throw new Error('Unexpected encryption request') })
    for (const [method, mock] of Object.entries(mocks.processes)) {
      mock.mockImplementation(() => { throw new Error(`Unexpected process request: ${method}`) })
    }
    mocks.processes.execSync.mockReturnValue(Buffer.from('Synthetic registered COM'))
    mocks.processes.spawn.mockImplementation(() => {
      const worker = new FakeWorker()
      worker.writeError = nextWriteError
      nextWriteError = null
      workers.push(worker)
      return worker
    })
    // CommonJS registry access can bypass vi.mock; intercept it as well. These
    // methods never reach real subprocesses, COM, the registry, or PowerShell.
    const nativeProcesses = createRequire(import.meta.url)('node:child_process') as
      Record<keyof typeof mocks.processes, (...args: any[]) => any>
    for (const method of Object.keys(mocks.processes) as Array<keyof typeof mocks.processes>) {
      vi.spyOn(nativeProcesses, method).mockImplementation(mocks.processes[method])
    }
    service = new CashalotService(ROOT)
  })

  afterEach(() => {
    service?.stopWorker()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
  }

  function expectBusy(): void {
    const previousFile = files.get(CONFIG_PATH)
    const writes = mocks.fs.writeFileSync.mock.calls.length
    const opens = mocks.fs.openSync.mock.calls.length
    expect(() => service.updateConfig({ fiscalNumberRRO: '4999999999' })).toThrow('FISCAL_CONFIG_BUSY')
    expect(files.get(CONFIG_PATH)).toBe(previousFile)
    expect(mocks.fs.writeFileSync).toHaveBeenCalledTimes(writes)
    expect(mocks.fs.openSync).toHaveBeenCalledTimes(opens)
  }

  function expectEditable(): void {
    expect(service.updateConfig({ fiscalNumberRRO: '4111111111' })).toMatchObject({ fiscalNumberRRO: '4111111111' })
    expect(JSON.parse(files.get(CONFIG_PATH)!)).toMatchObject({ fiscalNumberRRO: '4111111111' })
  }

  async function replaceIdleAWithPendingB() {
    const first = observe(service.getStatus())
    await flush()
    const a = workers[0]
    a.respond(a.requests[0], { Return: true, Description: 'worker A finished' })
    await first.done
    service.stopWorker()
    expect(a.stdin.end).toHaveBeenCalledOnce()
    expect(a.kill).toHaveBeenCalledOnce()
    const second = observe(service.getStatus())
    await flush()
    expect(workers).toHaveLength(2)
    return { a, b: workers[1], second }
  }

  it('ignores an old stopped worker exit without settling or clearing the new worker request', async () => {
    const { a, b, second } = await replaceIdleAWithPendingB()
    a.exit()
    await flush()
    expect(second.settled).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    expectBusy()
    b.respond(b.requests[0], { Return: true, Description: 'worker B response' })
    await second.done
    expect(second.settled).toHaveBeenCalledExactlyOnceWith({ value: { Return: true, Description: 'worker B response' } })
    expect(vi.getTimerCount()).toBe(0)
    expectEditable()
  })

  it('ignores old stdout, including a forged current id and fragments interleaved with the new buffer', async () => {
    const { a, b, second } = await replaceIdleAWithPendingB()
    a.respond(b.requests[0], { Return: true, Description: 'stale worker must not answer B' })
    await flush()
    expect(second.settled).not.toHaveBeenCalled()
    const response = responseLine(b.requests[0].id, { Return: true, Description: 'complete B response' })
    const split = Math.floor(response.length / 2)
    b.stdout.emit('data', response.slice(0, split))
    a.stdout.emit('data', 'old incomplete buffer')
    a.stdout.emit('data', responseLine('unrelated-old-request', { Return: true }))
    b.stdout.emit('data', response.slice(split))
    await flush()
    expect(second.settled).toHaveBeenCalledExactlyOnceWith({ value: { Return: true, Description: 'complete B response' } })
    expect(vi.getTimerCount()).toBe(0)
    expectEditable()
  })

  it('settles the current worker request on exit, clears its timer, and allows a replacement', async () => {
    const current = observe(service.getStatus())
    await flush()
    workers[0].exit()
    await flush()
    expect(current.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_WORKER_EXITED' })
    expect(vi.getTimerCount()).toBe(0)
    expectEditable()
    const replacement = observe(service.getStatus())
    await flush()
    expect(workers).toHaveLength(2)
    workers[1].respond(workers[1].requests[0], { Return: false, Description: 'replacement is healthy' })
    await replacement.done
    expect(replacement.settled).toHaveBeenCalledExactlyOnceWith({ value: { Return: false, Description: 'replacement is healthy' } })
  })

  it('explicit stop settles pending work immediately without waiting for process exit or timeout', async () => {
    const current = observe(service.getStatus())
    await flush()
    service.stopWorker()
    await flush()
    expect(current.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.stringMatching(/^FISCAL_WORKER_(STOPPED|EXITED)$/) })
    expect(vi.getTimerCount()).toBe(0)
    service.stopWorker()
    expect(workers[0].stdin.end).toHaveBeenCalledOnce()
    expect(workers[0].kill).toHaveBeenCalledOnce()
    expectEditable()
  })

  it.each(['late response', 'exit'] as const)('keeps settings busy after a caller timeout until the worker confirms completion by %s', async completion => {
    const current = observe(service.getStatus())
    await flush()
    const worker = workers[0]
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS)
    expect(current.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_TIMEOUT' })
    expect(vi.getTimerCount()).toBe(0)
    expectBusy()
    worker.stdout.emit('data', 'not-valid-base64-json\n')
    for (const malformed of [null, [], { id: worker.requests[0].id }, { id: worker.requests[0].id, ok: 'true' }]) {
      worker.stdout.emit('data', Buffer.from(JSON.stringify(malformed)).toString('base64') + '\n')
    }
    worker.stdout.emit('data', responseLine('not-the-request-id', { Return: true }))
    expectBusy()
    if (completion === 'late response') worker.respond(worker.requests[0], { Return: true, Description: 'completed after timeout' })
    else worker.exit()
    await flush()
    expect(current.settled).toHaveBeenCalledTimes(1)
    expectEditable()
  })

  it.each(['stop', 'exit'] as const)('cleans a synchronous stdin.write failure timer but keeps delivery unresolved until %s', async completion => {
    nextWriteError = new Error('Synthetic stdin.write failure')
    const current = observe(service.getStatus())
    await flush()
    const worker = workers[0]
    expect(worker.requests).toHaveLength(1)
    expect(current.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
    expect(vi.getTimerCount()).toBe(0)
    expect((service as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    expectBusy()
    if (completion === 'stop') service.stopWorker()
    else worker.exit()
    await flush()
    expect(current.settled).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expectEditable()
  })
})
