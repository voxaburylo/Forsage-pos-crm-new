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
  pid: number | undefined = 42000
  exitCode: number | null = null
  writeError: Error | null = null
  readonly stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((line: string) => {
      // Capture before throwing: delivery is deliberately uncertain in this
      // fault, so a caller timeout/write error must not declare the worker idle.
      this.requests.push(JSON.parse(Buffer.from(line.trim(), 'base64').toString('utf8')) as Request)
      if (this.writeError) throw this.writeError
      return true
    }),
    end: vi.fn(),
  })
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
      worker.pid = 42000 + workers.length
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

  function expectCancelled(operation: ReturnType<typeof observe>): void {
    expect(operation.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.stringMatching(/^FISCAL_(CALL_FAILED|WORKER_EXITED|WORKER_STOPPED)$/) })
  }

  async function expectFreshCallAfterRecovery(): Promise<void> {
    const previousWorkers = workers.length
    const fresh = observe(service.getStatus())
    await flush()
    expect(workers).toHaveLength(previousWorkers + 1)
    const replacement = workers[previousWorkers]
    expect(replacement.requests).toHaveLength(1)
    replacement.respond(replacement.requests[0], { Return: true, Description: 'fresh explicit request succeeded' })
    await fresh.done
    expect(fresh.settled).toHaveBeenCalledExactlyOnceWith({ value: { Return: true, Description: 'fresh explicit request succeeded' } })
    expect(vi.getTimerCount()).toBe(0)
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

  it('cancels a queued call when stopped before its first microtask, even without a worker', async () => {
    const queued = observe(service.getStatus())
    expect(workers).toHaveLength(0)
    service.stopWorker()
    await flush()
    expectCancelled(queued)
    expect(workers).toHaveLength(0)
    expect(mocks.processes.spawn).not.toHaveBeenCalled()
    expect(files.has(WORKER_PATH)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await expectFreshCallAfterRecovery()
    expectEditable()
  })

  it('cancels both in-flight A and queued B on stop without starting B or retrying either call', async () => {
    const first = observe(service.getStatus())
    await flush()
    const worker = workers[0]
    const queued = observe(service.getStatus())
    service.stopWorker()
    await flush()
    expectCancelled(first)
    expectCancelled(queued)
    expect(workers).toHaveLength(1)
    expect(worker.requests).toHaveLength(1)
    expect(worker.stdin.end).toHaveBeenCalledOnce()
    expect(worker.kill).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    // Old cancellation work must not leak into a newly requested generation.
    await expectFreshCallAfterRecovery()
    expect(first.settled).toHaveBeenCalledTimes(1)
    expect(queued.settled).toHaveBeenCalledTimes(1)
    expectEditable()
  })

  it('handles asynchronous child spawn failure without a pid or exit event and cancels unsent work', async () => {
    const first = observe(service.getStatus())
    const queued = observe(service.getStatus())
    await flush()
    const worker = workers[0]
    worker.pid = undefined
    expect(worker.requests).toHaveLength(1)
    expect(() => worker.emit('error', Object.assign(new Error('Synthetic spawn ENOENT'), { code: 'ENOENT' }))).not.toThrow()
    await flush()
    expect(first.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
    expectCancelled(queued)
    expect(vi.getTimerCount()).toBe(0)
    expect((service as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    expect(workers).toHaveLength(1)
    expect(worker.requests).toHaveLength(1)
    expect(worker.stdin.end).not.toHaveBeenCalled()
    expect(worker.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS)
    expect(mocks.processes.spawn).toHaveBeenCalledTimes(1)
    expect(first.settled).toHaveBeenCalledTimes(1)
    expect(queued.settled).toHaveBeenCalledTimes(1)
    // No exit is emitted: confirmed failure to start is enough to release the
    // configuration lock, but must never trigger an automatic retry.
    expectEditable()
    await expectFreshCallAfterRecovery()
  })

  it('normalizes a synchronous spawn throw and cancels already queued B without retrying', async () => {
    mocks.processes.spawn.mockImplementationOnce(() => { throw new Error('Synthetic private spawn failure') })
    const first = observe(service.getStatus())
    const queued = observe(service.getStatus())
    await flush()
    expect(first.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
    expectCancelled(queued)
    expect(workers).toHaveLength(0)
    expect(mocks.processes.spawn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS)
    expect(mocks.processes.spawn).toHaveBeenCalledOnce()
    expect(first.settled).toHaveBeenCalledTimes(1)
    expect(queued.settled).toHaveBeenCalledTimes(1)
    // No worker existed to stop or await: a new explicit request must work
    // without a settings save concealing a permanently broken transport flag.
    await expectFreshCallAfterRecovery()
    expectEditable()
  })

  it('handles a failed spawn with absent pipes and no pid through the child error without requiring exit', async () => {
    // Node may return a ChildProcess with unavailable stdio when creation
    // fails. Install this shape before ensureWorker attaches any listeners.
    const failedChild = Object.assign(new EventEmitter(), {
      pid: undefined, exitCode: null, stdin: null, stdout: undefined, stderr: null, kill: vi.fn(),
    })
    mocks.processes.spawn.mockReturnValueOnce(failedChild)
    const first = observe(service.getStatus())
    const queued = observe(service.getStatus())
    await flush()
    expect(() => failedChild.emit('error', Object.assign(new Error('Synthetic missing-pipes ENOENT'), { code: 'ENOENT' }))).not.toThrow()
    await flush()
    expect(first.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
    expectCancelled(queued)
    expect(mocks.processes.spawn).toHaveBeenCalledOnce()
    expect(workers).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect((service as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    // No exit event is supplied and no replacement is started implicitly.
    expectEditable()
    await expectFreshCallAfterRecovery()
  })

  it('clears uncertain stdin failure when a later child error confirms no process started, without exit', async () => {
    const current = observe(service.getStatus())
    await flush()
    const worker = workers[0]
    worker.pid = undefined
    expect(() => worker.stdin.emit('error', Object.assign(new Error('Synthetic pipe error'), { code: 'EPIPE' }))).not.toThrow()
    await flush()
    expect(current.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
    expect(vi.getTimerCount()).toBe(0)
    expectBusy()
    expect(() => worker.emit('error', Object.assign(new Error('Synthetic spawn error'), { code: 'ENOENT' }))).not.toThrow()
    await flush()
    expect(current.settled).toHaveBeenCalledTimes(1)
    expect(worker.requests).toHaveLength(1)
    expect(worker.stdin.end).not.toHaveBeenCalled()
    expect(worker.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expectEditable()
    expect(worker.kill).not.toHaveBeenCalled()
    await expectFreshCallAfterRecovery()
  })

  it('handles repeated errors from an already broken live worker idempotently', async () => {
    const current = observe(service.getStatus())
    await flush()
    const worker = workers[0]
    expect(() => worker.stderr.emit('error', new Error('First synthetic transport error'))).not.toThrow()
    await flush()
    expect(current.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
    for (const emitter of [worker, worker.stdin, worker.stdout, worker.stderr, worker.stdin, worker]) {
      expect(() => emitter.emit('error', new Error('Repeated synthetic transport error'))).not.toThrow()
    }
    await flush()
    expect(current.settled).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect((service as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    expect(worker.requests).toHaveLength(1)
    expect(worker.stdin.end).not.toHaveBeenCalled()
    expect(worker.kill).not.toHaveBeenCalled()
    expect(mocks.processes.spawn).toHaveBeenCalledOnce()
    expectBusy()
    worker.respond(worker.requests[0], { Return: true, Description: 'final matching confirmation' })
    await flush()
    expect(current.settled).toHaveBeenCalledTimes(1)
    expectEditable()
    await expectFreshCallAfterRecovery()
  })

  it('cancels unsent B on an unexpected current-worker exit without starting a replacement automatically', async () => {
    const first = observe(service.getStatus())
    const queued = observe(service.getStatus())
    await flush()
    const worker = workers[0]
    worker.exit()
    await flush()
    expect(first.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_WORKER_EXITED' })
    expectCancelled(queued)
    expect(worker.requests).toHaveLength(1)
    expect(worker.stdin.end).not.toHaveBeenCalled()
    expect(worker.kill).not.toHaveBeenCalled()
    expect(workers).toHaveLength(1)
    expect(mocks.processes.spawn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await expectFreshCallAfterRecovery()
    expect(first.settled).toHaveBeenCalledTimes(1)
    expect(queued.settled).toHaveBeenCalledTimes(1)
    expectEditable()
  })

  const transportFaultCases = (['child', 'stdin', 'stdout', 'stderr'] as const)
    .flatMap(source => (['late response', 'exit'] as const).map(completion => ({ source, completion })))

  it.each(transportFaultCases)('keeps live $source transport failure unresolved until $completion without retrying queued work', async ({ source, completion }) => {
    const first = observe(service.getStatus())
    const queued = observe(service.getStatus())
    await flush()
    const worker = workers[0]
    expect(worker.pid).toBeGreaterThan(0)
    const emitter = source === 'child' ? worker : worker[source]
    expect(() => emitter.emit('error', new Error(`Synthetic ${source} failure with private details`))).not.toThrow()
    await flush()
    expect(first.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
    expectCancelled(queued)
    expect(vi.getTimerCount()).toBe(0)
    expect((service as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    expectBusy()
    expect(workers).toHaveLength(1)
    expect(worker.requests).toHaveLength(1)
    expect(worker.stdin.end).not.toHaveBeenCalled()
    expect(worker.kill).not.toHaveBeenCalled()

    const blocked = observe(service.getStatus())
    await flush()
    expect(blocked.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
    expect(worker.requests).toHaveLength(1)
    expect(mocks.processes.spawn).toHaveBeenCalledTimes(1)
    expectBusy()
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS)
    expect(vi.getTimerCount()).toBe(0)
    expect(worker.requests).toHaveLength(1)
    expect(worker.kill).not.toHaveBeenCalled()

    worker.stdout.emit('data', responseLine('not-the-live-request', { Return: true }))
    expectBusy()
    if (completion === 'late response') {
      worker.respond(worker.requests[0], { Return: true, Description: 'late confirmation of uncertain delivery' })
      await flush()
      // A matching response releases uncertainty, not the broken transport:
      // a new operation still requires explicit worker reset or settings save.
      const stillBroken = observe(service.getStatus())
      await flush()
      expect(stillBroken.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
      expect(worker.requests).toHaveLength(1)
    } else {
      worker.exit()
      await flush()
    }
    expect(first.settled).toHaveBeenCalledTimes(1)
    expect(queued.settled).toHaveBeenCalledTimes(1)
    expectEditable()
    await expectFreshCallAfterRecovery()
  })

  it('ignores late errors from every old worker stream without crashing or disturbing replacement B', async () => {
    const { a, b, second } = await replaceIdleAWithPendingB()
    for (const emitter of [a, a.stdin, a.stdout, a.stderr]) {
      expect(() => emitter.emit('error', new Error('Late old worker error'))).not.toThrow()
    }
    await flush()
    expect(second.settled).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    expect(b.requests).toHaveLength(1)
    expect(b.stdin.end).not.toHaveBeenCalled()
    expect(b.kill).not.toHaveBeenCalled()
    expectBusy()
    b.respond(b.requests[0], { Return: true, Description: 'B survived old transport errors' })
    await second.done
    expect(second.settled).toHaveBeenCalledExactlyOnceWith({ value: { Return: true, Description: 'B survived old transport errors' } })
    expect(vi.getTimerCount()).toBe(0)
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

  it('cancels queued B on A timeout, blocks C until late confirmation, and allows fresh D on the same healthy worker', async () => {
    const first = observe(service.getStatus())
    const queued = observe(service.getStatus())
    await flush()
    const worker = workers[0]
    expect(worker.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS)
    expect(first.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_TIMEOUT' })
    expectCancelled(queued)
    expect(worker.requests).toHaveLength(1)
    expect(mocks.processes.spawn).toHaveBeenCalledOnce()
    expect(worker.stdin.end).not.toHaveBeenCalled()
    expect(worker.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expectBusy()

    const blocked = observe(service.getStatus())
    await flush()
    expect(blocked.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
    expect(worker.requests).toHaveLength(1)
    expect(mocks.processes.spawn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expectBusy()

    worker.respond(worker.requests[0], { Return: true, Description: 'A finished after caller timeout' })
    await flush()
    expect(first.settled).toHaveBeenCalledTimes(1)
    expect(queued.settled).toHaveBeenCalledTimes(1)
    expect(blocked.settled).toHaveBeenCalledTimes(1)
    expect(worker.requests).toHaveLength(1)
    const fresh = observe(service.getStatus())
    await flush()
    expect(workers).toHaveLength(1)
    expect(workers[0]).toBe(worker)
    expect(mocks.processes.spawn).toHaveBeenCalledOnce()
    expect(worker.requests).toHaveLength(2)
    expect(worker.requests[1].id).not.toBe(worker.requests[0].id)
    worker.respond(worker.requests[1], { Return: true, Description: 'D reused the healthy worker' })
    await fresh.done
    expect(fresh.settled).toHaveBeenCalledExactlyOnceWith({ value: { Return: true, Description: 'D reused the healthy worker' } })
    expect(queued.settled).toHaveBeenCalledTimes(1)
    expect(worker.requests).toHaveLength(2)
    expect(worker.stdin.end).not.toHaveBeenCalled()
    expect(worker.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expectEditable()
  })

  it.each(['stop', 'exit'] as const)('cleans a synchronous stdin.write failure timer but keeps delivery unresolved until %s', async completion => {
    nextWriteError = new Error('Synthetic stdin.write failure')
    const current = observe(service.getStatus())
    const queued = observe(service.getStatus())
    await flush()
    const worker = workers[0]
    expect(worker.requests).toHaveLength(1)
    expect(current.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
    expectCancelled(queued)
    expect(vi.getTimerCount()).toBe(0)
    expect((service as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    expectBusy()
    const blocked = observe(service.getStatus())
    await flush()
    expect(blocked.settled).toHaveBeenCalledExactlyOnceWith({ error: 'FISCAL_CALL_FAILED' })
    expect(worker.requests).toHaveLength(1)
    expect(worker.kill).not.toHaveBeenCalled()
    expect(mocks.processes.spawn).toHaveBeenCalledTimes(1)
    if (completion === 'stop') service.stopWorker()
    else worker.exit()
    await flush()
    expect(current.settled).toHaveBeenCalledTimes(1)
    expect(queued.settled).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expectEditable()
    await expectFreshCallAfterRecovery()
  })
})
