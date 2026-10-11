// Normal Electron runtime, synthetic fiscal configuration only. No application
// main, working database, network, COM, registry, PowerShell, or fiscal worker.
const { app } = require('electron')
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
    const calls = { reads: 0, stats: 0, exists: 0, writes: 0, resolutions: 0, processAttempts: 0, mockedComChecks: 0, stubbedStatusRequests: 0 }
    const written = []
    const originalFs = Object.fromEntries(['readFileSync', 'statSync', 'writeFileSync', 'existsSync'].map(key => [key, fs[key]]))
    const processMethods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
    const originalProcess = Object.fromEntries(processMethods.map(key => [key, childProcess[key]]))
    const resolve = cashalotPaths.resolveCashalotDir
    const services = []
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
      fs.existsSync = target => { calls.exists++; return dlls.has(String(target)) || dllDirectories.includes(String(target)) }
      fs.writeFileSync = (target, value) => {
        calls.writes++
        assert.equal(String(target), configPath, 'Writing a worker or any non-fixture file is forbidden')
        configText = String(value)
        written.push(JSON.parse(configText))
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
      await action({ create, calls, written })
      equal(calls.processAttempts, 0, 'No process, COM, registry or PowerShell access is allowed')
      equal(services.every(service => service.worker === null), true, 'No fiscal worker may be created')
      reports.push({ name, ...calls })
    } finally {
      // Restore even after an assertion fails. Profile cleanup uses real fs only.
      for (const service of services) service.stopWorker()
      cashalotPaths.resolveCashalotDir = resolve
      Object.assign(childProcess, originalProcess)
      Object.assign(fs, originalFs)
    }
  }

  const quietStartup = (service, calls) => {
    equal(service.isEnabled(), false)
    equal(service.isEnabled(), false)
    equal({ reads: calls.reads, stats: calls.stats, exists: calls.exists, writes: calls.writes, resolutions: calls.resolutions, processAttempts: calls.processAttempts },
      { reads: 1, stats: 0, exists: 0, writes: 0, resolutions: 0, processAttempts: 0 },
      'Disabled construction and isEnabled must read configuration only, without path discovery')
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
