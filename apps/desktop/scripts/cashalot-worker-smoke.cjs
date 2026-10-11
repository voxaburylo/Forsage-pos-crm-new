// Native Electron + compiled service, with synthetic workers and configuration.
// Never starts application main, PowerShell, COM, registry, network or a shop DB.
const { app, safeStorage } = require('electron')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
// Emergency app.exit may run quit before the case's finally restores mocks.
// Cleanup may use only these captured functions and the owned disposable path.
const cleanupFs = { existsSync: fs.existsSync, realpathSync: fs.realpathSync, rmSync: fs.rmSync }
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')

if (!app?.whenReady) throw new Error('Run with normal Electron, without ELECTRON_RUN_AS_NODE')
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-cashalot-worker-'))
const environment = {
  USERPROFILE: path.join(profileRoot, 'profile'),
  LOCALAPPDATA: path.join(profileRoot, 'local'),
  APPDATA: path.join(profileRoot, 'appData'),
  ProgramFiles: path.join(profileRoot, 'program-files'),
  'ProgramFiles(x86)': path.join(profileRoot, 'program-files-x86'),
  PORTABLE_EXECUTABLE_DIR: profileRoot,
}
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
Object.assign(process.env, environment)
for (const name of ['appData', 'userData', 'sessionData', 'crashDumps']) {
  const directory = path.join(profileRoot, name)
  fs.mkdirSync(directory, { recursive: true })
  app.setPath(name, directory)
}
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
const compiledArg = process.argv.indexOf('--compiled-dir')
if (compiledArg >= 0 && (!process.argv[compiledArg + 1] || process.argv[compiledArg + 1].startsWith('--'))) {
  throw new Error('Missing --compiled-dir value')
}
const dist = compiledArg >= 0 ? path.resolve(process.argv[compiledArg + 1])
  : process.argv.includes('--staged')
    ? path.resolve(process.cwd(), 'apps/desktop/release/staged/win-unpacked/resources/app.asar/dist')
    : path.resolve(__dirname, '../dist')
const deadline = setTimeout(() => { console.error('Synthetic Cashalot worker probe timed out'); app.exit(1) }, 60_000)
let checks = 0
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++ }
const ok = (value, message) => { assert.ok(value, message); checks++ }
const noThrow = (run, message) => { assert.doesNotThrow(run, message); checks++ }
const throws = (run, expression, message) => { assert.throws(run, expression, message); checks++ }
const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve() }
const observe = promise => {
  const outcome = { settled: false, settlements: 0, value: undefined, error: undefined }
  promise.then(value => { outcome.settled = true; outcome.settlements++; outcome.value = value }, error => {
    outcome.settled = true
    outcome.settlements++
    outcome.error = error instanceof Error ? error.message : String(error)
  })
  return outcome
}
const responseLine = response => Buffer.from(JSON.stringify(response), 'utf8').toString('base64') + '\n'

app.whenReady().then(async () => {
  // Load the whole compiled module graph while real ASAR reads are still allowed.
  // All service activity below runs only after the mocks have been installed.
  const { CashalotService } = require(path.join(dist, 'fiscal/cashalotService.js'))
  const cashalotPaths = require(path.join(dist, 'fiscal/cashalotPaths.js'))
  const buildPath = path.join(dist, 'build-info.json')
  const build = fs.existsSync(buildPath) ? JSON.parse(fs.readFileSync(buildPath, 'utf8')).releaseId : null
  const reports = []

  async function runCase(name, run) {
    const nonce = Object.freeze({ fixture: name })
    const dataRoot = path.join(profileRoot, `fixture-${reports.length}`)
    const configPath = path.join(dataRoot, 'fiscal.json')
    const scriptPath = path.join(dataRoot, 'cashalot-worker.ps1')
    const installation = path.join(dataRoot, 'synthetic-installation')
    let configText = JSON.stringify({ enabled: false, cashalotDir: installation,
      fiscalNumberRRO: 'SYNTHETIC-RRO', certificateDir: null, encryptedKeyPassword: null })
    const services = []
    const workers = []
    const nextWorkers = []
    const temporaryFiles = new Map()
    const descriptors = new Map()
    let nextDescriptor = 1000
    let scriptWrites = 0
    let forbiddenProcessAttempts = 0
    const savedFs = Object.fromEntries(['readFileSync', 'writeFileSync', 'statSync', 'existsSync',
      'openSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync'].map(key => [key, fs[key]]))
    const savedStorage = Object.fromEntries(['isEncryptionAvailable', 'encryptString', 'decryptString']
      .map(key => [key, safeStorage[key]]))
    const savedProcesses = Object.fromEntries(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile',
      'execFileSync', 'fork'].map(key => [key, childProcess[key]]))
    const savedPaths = Object.fromEntries(['cashalotSearchDirs', 'resolveCashalotDir', 'detectCashalotDir',
      'hasCashalotDll'].map(key => [key, cashalotPaths[key]]))

    class FakeWorker extends EventEmitter {
      constructor(options = {}) {
        super()
        Object.defineProperty(this, 'syntheticNonce', { value: nonce, writable: false, configurable: false })
        this.pid = options.noPid ? undefined : 7000 + workers.length
        this.exitCode = null
        this.requests = []
        this.kills = 0
        this.ends = 0
        this.stdout = new EventEmitter()
        this.stdout.setEncoding = encoding => equal(encoding, 'utf8', 'Worker stdout uses UTF-8')
        this.stderr = new EventEmitter()
        this.stdin = new EventEmitter()
        this.stdin.write = text => {
          assert.equal(this.syntheticNonce, nonce)
          this.requests.push(JSON.parse(Buffer.from(String(text).trim(), 'base64').toString('utf8')))
          if (options.writeError) throw new Error('Synthetic uncertain write failure')
          return true
        }
        this.stdin.end = () => { this.ends++ }
        if (Object.prototype.hasOwnProperty.call(options, 'missingPipes')) {
          this.stdin = options.missingPipes
          this.stdout = options.missingPipes
          this.stderr = options.missingPipes
        }
      }
      kill() { this.kills++; return true }
      exit() { this.exitCode = 0; this.emit('exit', 0, null) }
      respond(id, result = { Return: true, marker: 'synthetic' }) {
        this.stdout.emit('data', responseLine({ id, ok: true, result }))
      }
    }

    const fsMocks = {
      readFileSync(filename) {
        assert.equal(String(filename), configPath, 'Only synthetic fiscal.json may be read')
        return configText
      },
      writeFileSync(target, text) {
        if (typeof target === 'string') {
          assert.equal(target, scriptPath, 'Only the synthetic worker script path is writable')
          assert.ok(String(text).includes('CashaLot') || String(text).includes('Cashalot'))
          scriptWrites++
          return
        }
        const record = descriptors.get(target)
        assert.ok(record && !record.closed, 'Write requires an owned open descriptor')
        record.text = String(text)
      },
      statSync() { throw new Error('Unexpected filesystem probing: path helpers must be synthetic') },
      existsSync() { throw new Error('Unexpected filesystem probing: path helpers must be synthetic') },
      openSync(filename, flags, mode) {
        assert.equal(path.dirname(filename), dataRoot)
        assert.ok(filename.startsWith(configPath + '.') && filename.endsWith('.tmp'))
        assert.equal(flags, 'wx')
        assert.equal(mode, 0o600)
        assert.ok(!temporaryFiles.has(filename), 'Exclusive temporary file')
        const record = { filename, text: '', flushed: false, closed: false }
        temporaryFiles.set(filename, record)
        const descriptor = nextDescriptor++
        descriptors.set(descriptor, record)
        return descriptor
      },
      fsyncSync(descriptor) {
        const record = descriptors.get(descriptor)
        assert.ok(record && !record.closed)
        record.flushed = true
      },
      closeSync(descriptor) {
        const record = descriptors.get(descriptor)
        assert.ok(record && !record.closed)
        record.closed = true
        descriptors.delete(descriptor)
      },
      renameSync(source, destination) {
        assert.equal(destination, configPath)
        const record = temporaryFiles.get(source)
        assert.ok(record && record.flushed && record.closed)
        configText = record.text
        temporaryFiles.delete(source)
      },
      unlinkSync(filename) {
        assert.notEqual(filename, configPath)
        const record = temporaryFiles.get(filename)
        assert.ok(record && record.closed, 'Cleanup is limited to an owned temporary file')
        temporaryFiles.delete(filename)
      },
    }
    const storageMocks = {
      isEncryptionAvailable: () => true,
      encryptString: text => Buffer.from('synthetic:' + text, 'utf8'),
      decryptString: buffer => buffer.toString('utf8').replace(/^synthetic:/, ''),
    }
    const pathMocks = {
      cashalotSearchDirs: () => [installation],
      resolveCashalotDir: stored => stored || installation,
      detectCashalotDir: () => installation,
      hasCashalotDll: directory => directory === installation,
    }
    const spawnMock = (command, args, options) => {
      assert.equal(command, 'powershell.exe')
      assert.equal(args[args.indexOf('-File') + 1], scriptPath)
      assert.equal(options.windowsHide, true)
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe'])
      const workerOptions = nextWorkers.shift() || {}
      const worker = new FakeWorker(workerOptions)
      workers.push(worker)
      equal(worker.syntheticNonce, nonce, 'Only fixture workers can be returned')
      equal(Object.getOwnPropertyDescriptor(worker, 'syntheticNonce').writable, false, 'Worker nonce is readonly')
      equal(Object.getOwnPropertyDescriptor(worker, 'syntheticNonce').configurable, false, 'Worker nonce cannot be replaced')
      if (Object.prototype.hasOwnProperty.call(workerOptions, 'missingPipes')) {
        equal(worker.pid, undefined, 'Absent pipes fixture represents a failed spawn')
        for (const stream of ['stdin', 'stdout', 'stderr']) equal(worker[stream], workerOptions.missingPipes)
      } else {
        ok(worker.stdin instanceof EventEmitter, 'Synthetic stdin implements stream error events')
      }
      return worker
    }
    const forbiddenProcess = () => {
      forbiddenProcessAttempts++
      throw new Error('Forbidden process/registry/COM access in synthetic worker harness')
    }

    try {
      Object.assign(fs, fsMocks)
      Object.assign(safeStorage, storageMocks)
      Object.assign(cashalotPaths, pathMocks)
      for (const key of Object.keys(savedProcesses)) childProcess[key] = key === 'spawn' ? spawnMock : forbiddenProcess
      for (const [key, value] of Object.entries(fsMocks)) equal(fs[key], value, `Synthetic fs.${key} installed`)
      for (const [key, value] of Object.entries(storageMocks)) equal(safeStorage[key], value, `Synthetic storage.${key} installed`)
      for (const [key, value] of Object.entries(pathMocks)) equal(cashalotPaths[key], value, `Synthetic paths.${key} installed`)
      for (const key of Object.keys(savedProcesses)) equal(childProcess[key], key === 'spawn' ? spawnMock : forbiddenProcess,
        `Synthetic child_process.${key} installed`)
      const create = () => {
        const service = new CashalotService(dataRoot)
        service.isComRegistered = () => true
        services.push(service)
        return service
      }
      const assertBusy = service => {
        const before = configText
        throws(() => service.updateConfig({ fiscalNumberRRO: 'MUST-NOT-SAVE' }), /FISCAL_CONFIG_BUSY/,
          'Uncertain operation keeps configuration locked')
        equal(configText, before, 'Busy check does not write config')
      }
      const assertConfigUnlocked = service => {
        noThrow(() => service.updateConfig({ fiscalNumberRRO: 'SYNTHETIC-RRO' }), 'Settled operation releases configuration')
        equal(JSON.parse(configText).fiscalNumberRRO, 'SYNTHETIC-RRO')
      }
      await run({ create, workers, nextWorkers, assertBusy, assertConfigUnlocked })
      equal(forbiddenProcessAttempts, 0, 'No forbidden process or registry attempt')
      equal(descriptors.size, 0, 'No leaked fake file descriptors')
      equal(temporaryFiles.size, 0, 'No leaked synthetic config temporaries')
      reports.push({ name, workers: workers.length, scriptWrites })
    } finally {
      // Keep all mocks in place while an older/broken implementation drains.
      // Repeated stop also settles a wrongly-started queued call on the RED run.
      for (let attempt = 0; attempt < 4; attempt++) {
        for (const service of services) service.stopWorker()
        await flush()
      }
      Object.assign(cashalotPaths, savedPaths)
      Object.assign(childProcess, savedProcesses)
      Object.assign(safeStorage, savedStorage)
      Object.assign(fs, savedFs)
    }
  }

  await runCase('stop before the first microtask cancels two queued calls; fresh call works', async ({ create, workers }) => {
    const service = create()
    const first = observe(service.getStatus())
    const second = observe(service.getStatus())
    service.stopWorker()
    await flush()
    equal(workers.length, 0, 'Stopped queued calls must not start any worker')
    for (const outcome of [first, second]) {
      equal(outcome.settled, true, 'Cancelled call settles')
      ok(/^FISCAL_WORKER_(?:STOPPED|EXITED)$/.test(outcome.error || ''), 'Cancellation has a stable worker error')
    }
    equal(service.queuedCalls, 0)
    const fresh = observe(service.getStatus())
    await flush()
    equal(workers.length, 1, 'A new call after stop can start a worker')
    equal(workers[0].requests.length, 1)
    workers[0].respond(workers[0].requests[0].id)
    await flush()
    equal(fresh.value?.Return, true)
  })

  await runCase('stop active call cancels the second queued call without replacement', async ({ create, workers }) => {
    const service = create()
    const first = observe(service.getStatus())
    const second = observe(service.getStatus())
    await flush()
    equal(workers.length, 1)
    equal(workers[0].requests.length, 1, 'Queue serializes calls')
    service.stopWorker()
    await flush()
    equal(workers.length, 1, 'Stop does not let the second call start a replacement')
    equal(first.settled, true)
    equal(second.settled, true)
    ok(/^FISCAL_WORKER_(?:STOPPED|EXITED)$/.test(first.error || ''))
    ok(/^FISCAL_WORKER_(?:STOPPED|EXITED)$/.test(second.error || ''))
    equal(service.pending.size, 0)
    equal(service.workerRequestsInFlight.size, 0)
    equal(service.queuedCalls, 0)
    equal(workers[0].ends, 1)
    equal(workers[0].kills, 1)
  })

  await runCase('async spawn failure without pid or exit settles and permits a fresh call', async ({ create, workers, nextWorkers, assertConfigUnlocked }) => {
    nextWorkers.push({ noPid: true })
    const service = create()
    const failed = observe(service.getStatus())
    await flush()
    equal(workers.length, 1)
    equal(workers[0].pid, undefined)
    noThrow(() => workers[0].emit('error', Object.assign(new Error('synthetic ENOENT'), { code: 'ENOENT' })),
      'Child spawn error must have a listener')
    await flush()
    equal(failed.error, 'FISCAL_CALL_FAILED')
    equal(service.pending.size, 0)
    equal(service.workerRequestsInFlight.size, 0, 'No spawned process means no uncertain COM operation')
    equal(service.worker, null)
    equal(workers[0].kills, 0, 'Spawn failure is not killed or retried')
    equal(workers.length, 1)
    assertConfigUnlocked(service)
    const fresh = observe(service.getStatus())
    await flush()
    equal(workers.length, 2)
    ok(workers[1].pid > 0)
    workers[1].respond(workers[1].requests[0].id)
    await flush()
    equal(fresh.value?.Return, true)
  })

  for (const missingPipes of [null, undefined]) {
    await runCase(`spawn failure with ${String(missingPipes)} pipes needs no exit to settle`, async ({ create, workers, nextWorkers, assertBusy, assertConfigUnlocked }) => {
      nextWorkers.push({ noPid: true, missingPipes })
      const service = create()
      const failed = observe(service.getStatus())
      const queued = observe(service.getStatus())
      await flush()
      const worker = workers[0]
      equal(worker.pid, undefined)
      for (const stream of ['stdin', 'stdout', 'stderr']) equal(worker[stream], missingPipes)
      equal(failed.error, 'FISCAL_CALL_FAILED', 'Missing stdin is normalized without exposing a TypeError')
      ok(/^FISCAL_WORKER_(?:STOPPED|EXITED)$/.test(queued.error || ''), 'Unsent second call is cancelled')
      equal(worker.requests.length, 0)
      equal(workers.length, 1, 'Missing pipes do not trigger a retry')
      assertBusy(service)
      noThrow(() => worker.emit('error', Object.assign(new Error('synthetic absent-pipes ENOENT'), { code: 'ENOENT' })))
      await flush()
      equal(failed.settlements, 1)
      equal(queued.settlements, 1)
      equal(service.pending.size, 0)
      equal(service.workerRequestsInFlight.size, 0, 'Confirmed no-process error releases uncertainty')
      equal(service.worker, null)
      equal(worker.kills, 0)
      noThrow(() => worker.emit('error', new Error('synthetic repeated absent-pipes error')))
      assertConfigUnlocked(service)
      const fresh = observe(service.getStatus())
      await flush()
      equal(workers.length, 2)
      workers[1].respond(workers[1].requests[0].id)
      await flush()
      equal(fresh.value?.Return, true)
    })
  }

  for (const source of ['stdin', 'child', 'stdout', 'stderr']) {
    for (const release of ['response', 'exit']) {
      await runCase(`live ${source} error stays uncertain until ${release}`, async ({ create, workers, assertBusy, assertConfigUnlocked }) => {
        const service = create()
        const failed = observe(service.getStatus())
        const queued = observe(service.getStatus())
        await flush()
        const worker = workers[0]
        const id = worker.requests[0].id
        const emitter = source === 'child' ? worker : worker[source]
        noThrow(() => emitter.emit('error', new Error('synthetic live transport error')),
          `${source} errors must not escape EventEmitter`)
        await flush()
        equal(failed.error, 'FISCAL_CALL_FAILED', 'Caller receives a normalized failure')
        equal(failed.settlements, 1)
        equal(queued.settlements, 1, 'Queued B settles without being sent')
        ok(/^FISCAL_WORKER_(?:STOPPED|EXITED)$/.test(queued.error || ''), 'Failure cancels unsent queued B')
        equal(service.pending.size, 0, 'Caller timer/pending entry is released')
        equal(service.workerRequestsInFlight.size, 1, 'A live process may still complete the operation')
        equal(service.queuedCalls, 0)
        equal(workers.length, 1, 'Transport failure is not retried')
        equal(worker.requests.length, 1)
        equal(worker.kills, 0, 'Uncertain process is not killed automatically')
        equal(worker.ends, 0)
        assertBusy(service)
        const blocked = observe(service.getStatus())
        await flush()
        equal(blocked.error, 'FISCAL_CALL_FAILED', 'Fresh C cannot reuse uncertain transport')
        equal(blocked.settlements, 1)
        equal(worker.requests.length, 1, 'Fresh C was not sent')
        equal(workers.length, 1, 'Fresh C does not spawn a replacement')
        const failedEpoch = service.queueEpoch
        for (const repeated of [emitter, worker, worker.stdin, worker.stdout, worker.stderr]) {
          noThrow(() => repeated.emit('error', new Error('synthetic repeated transport error')))
        }
        await flush()
        equal(service.queueEpoch, failedEpoch, 'Repeated errors do not repeatedly invalidate the queue')
        equal(failed.settlements, 1)
        equal(queued.settlements, 1)
        equal(blocked.settlements, 1)
        equal(service.pending.size, 0)
        equal(service.workerRequestsInFlight.size, 1)
        equal(service.worker, worker)
        equal(worker.kills, 0)
        equal(worker.ends, 0)
        assertBusy(service)
        worker.stdout.emit('data', responseLine({ id, ok: 'invalid' }) + responseLine({ id: 'unknown-id', ok: true }))
        assertBusy(service)
        if (release === 'response') worker.respond(id)
        else worker.exit()
        await flush()
        equal(service.workerRequestsInFlight.size, 0)
        equal(failed.error, 'FISCAL_CALL_FAILED', 'Late response cannot rewrite the settled result')
        equal(workers.length, 1)
        if (release === 'response') {
          const stillBroken = observe(service.getStatus())
          await flush()
          equal(stillBroken.error, 'FISCAL_CALL_FAILED', 'Late response clears uncertainty, not broken transport')
          equal(stillBroken.settlements, 1)
          equal(worker.requests.length, 1)
          equal(workers.length, 1)
          equal(worker.kills, 0)
          equal(worker.ends, 0)
        }
        assertConfigUnlocked(service)
        const fresh = observe(service.getStatus())
        await flush()
        equal(workers.length, 2, 'Explicit saved configuration permits a fresh worker')
        equal(workers[1].requests.length, 1)
        workers[1].respond(workers[1].requests[0].id)
        await flush()
        equal(fresh.value?.Return, true)
        equal(failed.settlements, 1)
        equal(queued.settlements, 1)
        equal(blocked.settlements, 1)
      })
    }
  }

  await runCase('uncertain synchronous stdin write failure keeps config busy until exit', async ({ create, workers, nextWorkers, assertBusy, assertConfigUnlocked }) => {
    nextWorkers.push({ writeError: true })
    const service = create()
    const failed = observe(service.getStatus())
    await flush()
    equal(failed.error, 'FISCAL_CALL_FAILED')
    equal(service.pending.size, 0)
    equal(service.workerRequestsInFlight.size, 1)
    equal(workers[0].kills, 0)
    assertBusy(service)
    workers[0].exit()
    await flush()
    assertConfigUnlocked(service)
  })

  await runCase('late errors, data and exit from stopped A cannot affect live B', async ({ create, workers, assertBusy }) => {
    const service = create()
    const first = observe(service.getStatus())
    await flush()
    const oldWorker = workers[0]
    service.stopWorker()
    await flush()
    equal(first.settled, true)
    const current = observe(service.getStatus())
    await flush()
    const liveWorker = workers[1]
    equal(workers.length, 2)
    const id = liveWorker.requests[0].id
    for (const emitter of [oldWorker, oldWorker.stdin, oldWorker.stdout, oldWorker.stderr]) {
      noThrow(() => emitter.emit('error', new Error('synthetic late old-worker error')))
    }
    oldWorker.stdout.emit('data', responseLine({ id, ok: true, result: { Return: true, marker: 'wrong-worker' } }))
    oldWorker.stdout.emit('data', 'incomplete-old-data')
    oldWorker.exit()
    await flush()
    equal(current.settled, false, 'Old worker does not settle B request')
    equal(service.worker, liveWorker)
    equal(service.pending.size, 1)
    equal(service.workerRequestsInFlight.size, 1)
    equal(liveWorker.kills, 0)
    assertBusy(service)
    liveWorker.respond(id, { Return: true, marker: 'live-B' })
    await flush()
    equal(current.value, { Return: true, marker: 'live-B' })
    equal(service.pending.size, 0)
    equal(service.workerRequestsInFlight.size, 0)
  })

  console.log(JSON.stringify({ ok: true, runtime: 'electron-application', build, checks, cases: reports,
    filesystemCountsAreSynthetic: true, shopDatabaseOpened: false, networkRequests: false,
    realComCalls: 0, realRegistryCalls: 0, realWorkerProcesses: 0, fiscalActions: 0 }))
  clearTimeout(deadline)
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })

app.on('quit', () => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  // This is only the unique disposable profile created above, never a shop path.
  if (path.dirname(profileRoot) === path.resolve(os.tmpdir())
    && path.basename(profileRoot).startsWith('forsage-cashalot-worker-')
    && cleanupFs.existsSync(profileRoot) && cleanupFs.realpathSync(profileRoot) === profileRoot) {
    try { cleanupFs.rmSync(profileRoot, { recursive: true, force: true }) } catch { /* Electron can still hold its own isolated cache. */ }
  }
})
