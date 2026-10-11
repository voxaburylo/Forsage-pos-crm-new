// Normal Electron runtime, synthetic fiscal configuration only. No application
// main, working database, network, COM, registry, PowerShell, or fiscal worker.
const { app, safeStorage } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')

if (!app?.whenReady) throw new Error('Run with normal Electron, without ELECTRON_RUN_AS_NODE')
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-cashalot-startup-'))
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
// --staged intentionally follows the clean-release checkout supplied as cwd,
// not the checkout containing this harness. --compiled-dir takes precedence.
const dist = compiledArg >= 0 ? path.resolve(process.argv[compiledArg + 1])
  : process.argv.includes('--staged')
    ? path.resolve(process.cwd(), 'apps/desktop/release/staged/win-unpacked/resources/app.asar/dist')
    : path.resolve(__dirname, '../dist')
const deadline = setTimeout(() => { console.error('Synthetic Cashalot startup probe timed out'); app.exit(1) }, 60_000)
let checks = 0
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++ }
const ok = (value, message) => { assert.ok(value, message); checks++ }

app.whenReady().then(async () => {
  // Load both compiled modules before replacing filesystem methods: ASAR and
  // Node module loading must retain their normal, unmodified filesystem access.
  const { CashalotService } = require(path.join(dist, 'fiscal/cashalotService.js'))
  const cashalotPaths = require(path.join(dist, 'fiscal/cashalotPaths.js'))
  const buildPath = path.join(dist, 'build-info.json')
  const build = fs.existsSync(buildPath) ? JSON.parse(fs.readFileSync(buildPath, 'utf8')).releaseId : null
  const reports = []
  const fallback = path.join(environment.LOCALAPPDATA, 'Cashalot')
  const existing = path.join(profileRoot, 'explicit-installation')
  const stale = path.join(profileRoot, 'missing-old-installation')
  const unc = String.raw`  \\synthetic-cashalot.invalid\not-a-real-share\Cashalot  `
  const base = {
    enabled: false, cashalotDir: unc, fiscalNumberRRO: '0000001234',
    certificateDir: path.join(profileRoot, 'synthetic-certificate'),
    encryptedKeyPassword: 'synthetic-encrypted-value-not-a-real-key',
  }

  async function runCase(name, rawConfig, dllDirectories, action) {
    const dataRoot = path.join(profileRoot, `fixture-${reports.length}`)
    const configPath = path.join(dataRoot, 'fiscal.json')
    const dlls = new Set(dllDirectories.map(directory => path.join(directory, cashalotPaths.CASHALOT_DLL)))
    let configText = rawConfig === undefined ? undefined : typeof rawConfig === 'string' ? rawConfig : JSON.stringify(rawConfig)
    const calls = { reads: 0, stats: 0, exists: 0, opens: 0, writes: 0, fsyncs: 0, closes: 0, renames: 0, unlinks: 0,
      resolutions: 0, processAttempts: 0, mockedComChecks: 0, stubbedStatusRequests: 0, mockedEncryptionCalls: 0, fakeWorkerStops: 0 }
    const written = []
    const ioEvents = []
    const temporaryFiles = new Map()
    const descriptors = new Map()
    let nextDescriptor = 1000
    const faults = { fsync: false, rename: false, encryption: false, encryptionAvailable: true }
    const originalFs = Object.fromEntries(['readFileSync', 'statSync', 'writeFileSync', 'existsSync',
      'openSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync'].map(key => [key, fs[key]]))
    const originalStorage = Object.fromEntries(['isEncryptionAvailable', 'encryptString', 'decryptString'].map(key => [key, safeStorage[key]]))
    const processMethods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
    const originalProcess = Object.fromEntries(processMethods.map(key => [key, childProcess[key]]))
    const resolve = cashalotPaths.resolveCashalotDir
    const services = []
    const fakeWorkers = new Set()
    const missing = target => Object.assign(new Error(`Synthetic ENOENT: ${String(target)}`), { code: 'ENOENT' })
    try {
      fs.readFileSync = target => {
        calls.reads++
        assert.equal(String(target), configPath, 'Only the synthetic fiscal configuration may be read')
        if (configText === undefined) throw missing(target)
        return configText
      }
      fs.statSync = target => {
        calls.stats++
        // No fallback to the real filesystem, including for the synthetic UNC.
        if (dlls.has(String(target))) return { isFile: () => true, isDirectory: () => false }
        if (dllDirectories.includes(String(target))) return { isFile: () => false, isDirectory: () => true }
        throw missing(target)
      }
      fs.existsSync = target => {
        calls.exists++
        return (String(target) === configPath && configText !== undefined) || temporaryFiles.has(String(target))
          || dlls.has(String(target)) || dllDirectories.includes(String(target))
      }
      fs.openSync = (target, flags, mode) => {
        calls.opens++
        const filename = String(target)
        assert.equal(path.dirname(filename), dataRoot, 'Temporary file must be a sibling of the synthetic configuration')
        assert.notEqual(filename, configPath, 'Atomic save must not open the live configuration for writing')
        assert.equal(flags, 'wx', 'Temporary configuration creation must be exclusive')
        assert.equal(mode, 0o600, 'Temporary configuration must request private permissions')
        if (temporaryFiles.has(filename)) throw Object.assign(new Error('Synthetic EEXIST'), { code: 'EEXIST' })
        const record = { filename, text: '', flushed: false, closed: false }
        const descriptor = nextDescriptor++
        temporaryFiles.set(filename, record)
        descriptors.set(descriptor, record)
        ioEvents.push('open')
        return descriptor
      }
      fs.writeFileSync = (target, value) => {
        calls.writes++
        const record = descriptors.get(target)
        assert.ok(record, 'Only an owned, open synthetic temporary-file descriptor may be written')
        record.text = String(value)
        record.flushed = false
        ioEvents.push('write')
      }
      fs.fsyncSync = descriptor => {
        calls.fsyncs++
        const record = descriptors.get(descriptor)
        assert.ok(record, 'Only an owned open descriptor may be flushed')
        ioEvents.push('fsync')
        if (faults.fsync) throw new Error('Synthetic fsync failure')
        record.flushed = true
      }
      fs.closeSync = descriptor => {
        calls.closes++
        const record = descriptors.get(descriptor)
        assert.ok(record, 'Only an owned open descriptor may be closed')
        record.closed = true
        descriptors.delete(descriptor)
        ioEvents.push('close')
      }
      fs.renameSync = (source, destination) => {
        calls.renames++
        assert.equal(String(destination), configPath, 'Only the synthetic configuration may be published')
        const record = temporaryFiles.get(String(source))
        assert.ok(record, 'Only this save\'s owned temporary file may be published')
        assert.ok(record.flushed && record.closed, 'Publish only after successful fsync and close')
        ioEvents.push('rename')
        if (faults.rename) throw new Error('Synthetic rename failure')
        configText = record.text
        written.push(JSON.parse(configText))
        temporaryFiles.delete(String(source))
      }
      fs.unlinkSync = target => {
        calls.unlinks++
        assert.notEqual(String(target), configPath, 'Failure cleanup must not remove the live configuration')
        assert.ok(temporaryFiles.has(String(target)), 'Failure cleanup may remove only its own temporary file')
        assert.ok(temporaryFiles.get(String(target)).closed, 'Close owned descriptors before cleanup')
        temporaryFiles.delete(String(target))
        ioEvents.push('unlink')
      }
      const fakeStorage = {
        isEncryptionAvailable: () => { calls.mockedEncryptionCalls++; return faults.encryptionAvailable },
        encryptString: () => {
          calls.mockedEncryptionCalls++
          if (faults.encryption) throw new Error('Synthetic encryption failure')
          return Buffer.from('synthetic-encrypted-new-password')
        },
        decryptString: () => { calls.mockedEncryptionCalls++; return 'synthetic-decrypted-password' },
      }
      Object.assign(safeStorage, fakeStorage)
      for (const [method, implementation] of Object.entries(fakeStorage)) {
        assert.equal(safeStorage[method], implementation, 'Native key storage must be replaced before exercising configuration')
      }
      cashalotPaths.resolveCashalotDir = (...args) => { calls.resolutions++; return resolve(...args) }
      for (const method of processMethods) childProcess[method] = () => {
        calls.processAttempts++
        throw new Error(`Forbidden process action: ${method}`)
      }
      const create = () => {
        const service = new CashalotService(dataRoot)
        // Private-method replacements exercise the real public methods without
        // registry access, worker creation, COM objects, or real fiscal calls.
        service.isComRegistered = () => { calls.mockedComChecks++; return true }
        service.sendRequest = async request => {
          calls.stubbedStatusRequests++
          equal(request.method, 'call')
          equal(request.comMethod, 'GetCurrentStatus', 'Only the synthetic status path may be exercised')
          return { id: request.id, ok: true, result: { Return: false, Description: 'Synthetic shift is closed' } }
        }
        services.push(service)
        return service
      }
      const attachIdleWorker = service => {
        const activity = { ends: 0, kills: 0 }
        const worker = { exitCode: null, stdin: { end: () => { activity.ends++ } }, kill: () => {
          activity.kills++
          calls.fakeWorkerStops++
          worker.exitCode = 0
        } }
        fakeWorkers.add(worker)
        service.worker = worker
        return { worker, activity }
      }
      await action({ create, calls, written, faults, ioEvents, attachIdleWorker, diskText: () => configText })
      equal(calls.processAttempts, 0, 'No process, COM, registry or PowerShell access is allowed')
      equal(services.every(service => service.worker === null || fakeWorkers.has(service.worker)), true, 'Only explicit synthetic workers are permitted')
      equal(descriptors.size, 0, 'Atomic saves must not leak descriptors')
      equal(temporaryFiles.size, 0, 'Atomic saves must clean up their owned temporary files')
      reports.push({ name, ...calls })
    } finally {
      // Restore even after an assertion fails. Profile cleanup uses real fs only.
      for (const service of services) service.stopWorker()
      cashalotPaths.resolveCashalotDir = resolve
      Object.assign(childProcess, originalProcess)
      Object.assign(safeStorage, originalStorage)
      Object.assign(fs, originalFs)
    }
  }

  const quietStartup = (service, calls) => {
    equal(service.isEnabled(), false)
    equal(service.isEnabled(), false)
    equal({ reads: calls.reads, stats: calls.stats, exists: calls.exists, writes: calls.writes, resolutions: calls.resolutions, processAttempts: calls.processAttempts },
      { reads: 1, stats: 0, exists: 0, writes: 0, resolutions: 0, processAttempts: 0 },
      'Disabled construction and isEnabled must read configuration only, without path discovery')
    equal([calls.opens, calls.fsyncs, calls.closes, calls.renames, calls.unlinks, calls.mockedEncryptionCalls], [0, 0, 0, 0, 0, 0])
  }
  const publicFields = (config, directory, enabled = false) => {
    equal(config, { enabled, cashalotDir: directory, fiscalNumberRRO: base.fiscalNumberRRO,
      certificateDir: base.certificateDir, hasPassword: true, comRegistered: true, dllFound: true })
  }

  await runCase('disabled missing config', undefined, [fallback], ({ create, calls }) => quietStartup(create(), calls))
  await runCase('disabled malformed config', '{malformed-json', [fallback], ({ create, calls }) => quietStartup(create(), calls))
  await runCase('disabled raw UNC config', base, [fallback], ({ create, calls }) => {
    const service = create()
    quietStartup(service, calls)
    equal(service.config, base, 'Disabled startup must preserve the raw path and all saved fields')
  })
  // Two variants share one behavioral case: enabled startup still resolves a
  // real synthetic DLL or a stale path before a public getter is requested.
  for (const [name, storedPath, expectedPath] of [['existing', existing, existing], ['stale fallback', stale, fallback]]) {
    await runCase(`enabled ${name} before getter`, { ...base, enabled: true, cashalotDir: storedPath }, [existing, fallback], ({ create, calls, written }) => {
      const service = create()
      equal(service.isEnabled(), true)
      ok(calls.stats > 0, 'Enabled construction must retain DLL discovery')
      equal(calls.mockedComChecks, 0, 'Construction must not query COM registration')
      equal(service.config, { ...base, enabled: true, cashalotDir: expectedPath })
      for (const saved of written) equal(saved, { ...base, enabled: true, cashalotDir: expectedPath })
    })
  }
  await runCase('disabled explicit public config resolves once', base, [fallback], ({ create, calls, written }) => {
    const service = create()
    quietStartup(service, calls)
    publicFields(service.getPublicConfig(), fallback)
    publicFields(service.getPublicConfig(), fallback)
    equal(calls.resolutions, 1, 'Repeated getters must not repeat deferred path healing')
    equal(written, [], 'Deferred resolution must remain memory-only')
    equal(service.isEnabled(), false)
  })
  await runCase('enabling update resolves once and preserves fields', base, [fallback], ({ create, calls, written }) => {
    const service = create()
    quietStartup(service, calls)
    publicFields(service.updateConfig({ enabled: true }), fallback, true)
    publicFields(service.getPublicConfig(), fallback, true)
    equal(service.isEnabled(), true)
    equal(calls.resolutions, 1, 'Enable and its public response must share one deferred resolution')
    equal(written, [{ ...base, enabled: true, cashalotDir: fallback }], 'Explicit enable must save the final configuration exactly once')
  })
  await runCase('explicit status call resolves once without a worker', { ...base, encryptedKeyPassword: null }, [fallback], async ({ create, calls, written }) => {
    const service = create()
    quietStartup(service, calls)
    const requests = []
    service.sendRequest = async request => {
      calls.stubbedStatusRequests++
      requests.push(request)
      return { id: request.id, ok: true, result: { Return: false, Description: 'Synthetic shift is closed' } }
    }
    equal(await service.getStatus(), { Return: false, Description: 'Synthetic shift is closed' })
    equal(await service.getStatus(), { Return: false, Description: 'Synthetic shift is closed' })
    equal(calls.resolutions, 1, 'Repeated status calls must share one deferred path resolution')
    equal(calls.stubbedStatusRequests, 2)
    for (const request of requests) {
      equal([request.method, request.comMethod, request.args], ['call', 'GetCurrentStatus', [base.fiscalNumberRRO]])
      equal(request.config, { cashalotDir: fallback, fiscalNumberRRO: base.fiscalNumberRRO, certificateDir: base.certificateDir, keyPassword: null })
    }
    equal(written, [], 'Deferred status resolution must remain memory-only')
    equal(service.isEnabled(), false, 'An explicit status inspection must not enable fiscalization')
  })

  for (const fault of ['fsync', 'rename']) {
    await runCase(`atomic update preserves old config on ${fault} failure`, base, [fallback], ({ create, faults, written, ioEvents, attachIdleWorker, diskText }) => {
      const service = create()
      const memoryBefore = { ...service.config }
      const resolvedBefore = service.cashalotDirResolved
      const bytesBefore = diskText()
      const { worker, activity } = attachIdleWorker(service)
      faults[fault] = true
      assert.throws(() => service.updateConfig({ enabled: true, fiscalNumberRRO: '0000005678', certificateDir: null }), new RegExp(`Synthetic ${fault} failure`))
      checks++
      equal(service.config, memoryBefore, 'A failed save must not publish candidate fields into memory')
      equal(service.cashalotDirResolved, resolvedBefore, 'A failed save must not mark deferred configuration as resolved')
      equal(diskText(), bytesBefore, 'A failed save must preserve every byte of the previous config file')
      equal(service.worker, worker)
      equal(activity, { ends: 0, kills: 0 }, 'A failed save must not stop the idle worker')
      equal(written, [], 'A failed save must not publish a replacement')
      equal(ioEvents, fault === 'fsync' ? ['open', 'write', 'fsync', 'close', 'unlink']
        : ['open', 'write', 'fsync', 'close', 'rename', 'unlink'])
      equal(create().config, memoryBefore, 'A fresh instance must still load the previous configuration')
    })
  }

  for (const fault of ['unavailable', 'encryption']) {
    await runCase(`failed password ${fault} leaves config and worker untouched`, base, [fallback], ({ create, faults, calls, written, ioEvents, attachIdleWorker, diskText }) => {
      const service = create()
      const memoryBefore = { ...service.config }
      const resolvedBefore = service.cashalotDirResolved
      const bytesBefore = diskText()
      const { worker, activity } = attachIdleWorker(service)
      faults.encryptionAvailable = fault !== 'unavailable'
      faults.encryption = fault === 'encryption'
      assert.throws(() => service.updateConfig({ enabled: true, fiscalNumberRRO: '0000005678', keyPassword: 'synthetic-new-password' }),
        fault === 'unavailable' ? /FISCAL_ENCRYPTION_UNAVAILABLE/ : /Synthetic encryption failure/)
      checks++
      equal(service.config, memoryBefore)
      equal(service.cashalotDirResolved, resolvedBefore)
      equal(diskText(), bytesBefore)
      equal(service.worker, worker)
      equal(activity, { ends: 0, kills: 0 })
      equal(written, [])
      equal(ioEvents, [], 'Encryption failure must occur before any temporary file is opened')
      equal(calls.mockedEncryptionCalls, fault === 'unavailable' ? 1 : 2)
    })
  }

  await runCase('atomic success publishes before stopping idle worker and survives reopen', base, [fallback], ({ create, written, ioEvents, attachIdleWorker, diskText }) => {
    const service = create()
    const { worker, activity } = attachIdleWorker(service)
    const expected = { ...base, enabled: true, cashalotDir: fallback, fiscalNumberRRO: '0000005678', certificateDir: null,
      encryptedKeyPassword: Buffer.from('synthetic-encrypted-new-password').toString('base64') }
    const previousKill = worker.kill
    worker.kill = () => {
      equal(JSON.parse(diskText()), expected, 'Disk publication must precede worker shutdown')
      equal(service.config, expected, 'The saved configuration must be published in memory before worker shutdown')
      previousKill()
    }
    const result = service.updateConfig({ enabled: true, fiscalNumberRRO: '0000005678', certificateDir: null, keyPassword: 'synthetic-new-password' })
    equal(written, [expected])
    equal(ioEvents, ['open', 'write', 'fsync', 'close', 'rename'])
    equal(diskText(), JSON.stringify(expected, null, 2))
    equal(result.fiscalNumberRRO, expected.fiscalNumberRRO)
    equal(result.hasPassword, true)
    equal(activity, { ends: 1, kills: 1 })
    equal(service.worker, null)
    equal(create().config, expected, 'A fresh instance must read the atomically published config')
  })

  await runCase('queued and in-flight status calls reject settings changes until all settle', { ...base, cashalotDir: fallback, encryptedKeyPassword: null }, [fallback], async ({ create, calls, written, ioEvents, attachIdleWorker, diskText }) => {
    const service = create()
    const { worker, activity } = attachIdleWorker(service)
    const requests = []
    const completions = []
    const started = []
    const startedPromises = [0, 1].map(index => new Promise(resolve => { started[index] = resolve }))
    service.sendRequest = request => {
      calls.stubbedStatusRequests++
      const index = requests.length
      requests.push(request)
      started[index]()
      return new Promise(resolve => { completions[index] = resolve })
    }
    const rejectWhileBusy = label => {
      const before = { config: { ...service.config }, resolved: service.cashalotDirResolved, bytes: diskText(), counts: { ...calls } }
      assert.throws(() => service.updateConfig({ enabled: true, cashalotDir: existing, fiscalNumberRRO: '0000009999', keyPassword: 'must-not-be-encrypted' }), /FISCAL_CONFIG_BUSY/)
      checks++
      equal(service.config, before.config, label)
      equal(service.cashalotDirResolved, before.resolved, label)
      equal(diskText(), before.bytes, label)
      equal(calls, before.counts, 'Busy rejection must precede path discovery, encryption, IO, and worker shutdown')
      equal(service.worker, worker)
      equal(activity, { ends: 0, kills: 0 })
    }
    const first = service.getStatus()
    rejectWhileBusy('The immediately queued first call must guard settings before its microtask runs')
    await startedPromises[0]
    rejectWhileBusy('The in-flight first call must guard settings')
    const second = service.getStatus()
    rejectWhileBusy('A second queued call must keep settings guarded')
    completions[0]({ id: requests[0].id, ok: true, result: { Return: false } })
    equal(await first, { Return: false })
    await startedPromises[1]
    rejectWhileBusy('Settings must remain guarded after the first call settles while the second is in flight')
    completions[1]({ id: requests[1].id, ok: true, result: { Return: false } })
    equal(await second, { Return: false })
    for (const request of requests) {
      equal([request.method, request.comMethod, request.args], ['call', 'GetCurrentStatus', [base.fiscalNumberRRO]])
      equal(request.config, { cashalotDir: fallback, fiscalNumberRRO: base.fiscalNumberRRO, certificateDir: base.certificateDir, keyPassword: null })
    }
    equal(written, [])
    equal(ioEvents, [])
    equal(service.updateConfig({ fiscalNumberRRO: '0000005678' }).fiscalNumberRRO, '0000005678', 'Settings must become editable once all queued calls have settled')
    equal(written.length, 1)
    equal(ioEvents, ['open', 'write', 'fsync', 'close', 'rename'])
    equal(activity, { ends: 1, kills: 1 })
    equal(service.worker, null)
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
  if (path.dirname(profileRoot) === path.resolve(os.tmpdir())
    && path.basename(profileRoot).startsWith('forsage-cashalot-startup-')
    && fs.existsSync(profileRoot) && fs.realpathSync(profileRoot) === profileRoot) {
    try { fs.rmSync(profileRoot, { recursive: true, force: true }) } catch { /* Electron can briefly hold its isolated cache on Windows. */ }
  }
})
