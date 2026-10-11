import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
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
}))

// No real filesystem or Electron/COM implementation is exposed to the service.
vi.mock('node:fs', () => ({ default: mocks.fs, ...mocks.fs }))
vi.mock('electron', () => ({ safeStorage: mocks.storage }))
vi.mock('node:child_process', () => ({ default: mocks.processes, ...mocks.processes }))

import { CashalotService, type CashalotConfig } from '../src/fiscal/cashalotService'
import { CASHALOT_DLL } from '../src/fiscal/cashalotPaths'

// Fictitious paths only. All path probes are intercepted even if the host has
// a Cashalot installation or a disconnected network share of its own.
const ROOT = 'Z:\\__cashalot_startup_unit_only__'
const DATA_ROOT = path.join(ROOT, 'data')
const CONFIG_PATH = path.join(DATA_ROOT, 'fiscal.json')
const LOCAL_APP_DATA = path.join(ROOT, 'profile', 'AppData', 'Local')
const INSTALLED = path.join(LOCAL_APP_DATA, 'Cashalot')
const MANUAL = path.join(ROOT, 'manual-install')
const OLD_UNC = '\\\\unit-only-offline-host\\disconnected-share\\Cashalot'
const SAVED_FIELDS = {
  cashalotDir: OLD_UNC,
  fiscalNumberRRO: '4000000000',
  certificateDir: path.join(ROOT, 'certificate'),
  encryptedKeyPassword: 'dW5pdC10ZXN0LWNpcGhlcnRleHQ=',
}

type ServiceAdapter = {
  config: CashalotConfig
  sendRequest(request: {
    id: string
    method: string
    comMethod?: string
    args?: unknown[]
    config: { cashalotDir: string; fiscalNumberRRO: string; certificateDir: string | null; keyPassword: string | null }
  }): Promise<{ id: string; ok: boolean; result?: { Return?: boolean } }>
  isComRegistered(): boolean
}

function inspect(service: CashalotService): ServiceAdapter {
  return service as unknown as ServiceAdapter
}

describe('Cashalot startup stays passive while disabled', () => {
  let configText: string | undefined
  let installedDirs: Set<string>

  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('USERPROFILE', path.join(ROOT, 'profile'))
    vi.stubEnv('LOCALAPPDATA', LOCAL_APP_DATA)
    vi.stubEnv('APPDATA', path.join(ROOT, 'profile', 'AppData', 'Roaming'))
    vi.stubEnv('ProgramFiles', path.join(ROOT, 'Program Files'))
    vi.stubEnv('ProgramFiles(x86)', path.join(ROOT, 'Program Files (x86)'))
    configText = JSON.stringify({ ...SAVED_FIELDS, enabled: false })
    installedDirs = new Set([INSTALLED])
    mocks.fs.readFileSync.mockImplementation((target: unknown, encoding: unknown) => {
      if (String(target) !== CONFIG_PATH || encoding !== 'utf8') throw new Error('Unexpected mocked file read')
      if (configText === undefined) throw Object.assign(new Error('Mock fiscal.json missing'), { code: 'ENOENT' })
      return configText
    })
    mocks.fs.writeFileSync.mockImplementation(() => undefined)
    mocks.fs.openSync.mockReturnValue(79)
    mocks.fs.statSync.mockImplementation((target: unknown) => {
      const name = String(target)
      const file = [...installedDirs].some(dir => name === path.join(dir, CASHALOT_DLL))
      const directory = installedDirs.has(name)
      if (!file && !directory) throw Object.assign(new Error('Mock path missing'), { code: 'ENOENT' })
      return { isFile: () => file, isDirectory: () => directory }
    })
    mocks.fs.existsSync.mockImplementation((target: unknown) =>
      [...installedDirs].some(dir => String(target) === path.join(dir, CASHALOT_DLL)) || installedDirs.has(String(target)))
    mocks.storage.isEncryptionAvailable.mockReturnValue(true)
    mocks.storage.encryptString.mockReturnValue(Buffer.from('mock-encrypted-value'))
    mocks.storage.decryptString.mockReturnValue('mock-decrypted-value')
    for (const [method, mock] of Object.entries(mocks.processes)) {
      mock.mockImplementation(() => { throw new Error(`Unexpected mocked subprocess: ${method}`) })
    }
    // Registry reads performed by explicit settings calls are synthetic too.
    mocks.processes.execSync.mockReturnValue(Buffer.from('mock registry entry'))

    // isComRegistered currently uses CommonJS require, which can bypass
    // vi.mock. Replace the native module methods as well BEFORE any service call.
    const nativeProcesses = createRequire(import.meta.url)('node:child_process') as
      Record<keyof typeof mocks.processes, (...args: any[]) => any>
    for (const method of Object.keys(mocks.processes) as Array<keyof typeof mocks.processes>) {
      vi.spyOn(nativeProcesses, method).mockImplementation(mocks.processes[method])
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  function expectNoEncryption(): void {
    for (const mock of Object.values(mocks.storage)) expect(mock).not.toHaveBeenCalled()
  }

  function expectNoProcesses(): void {
    for (const mock of Object.values(mocks.processes)) expect(mock).not.toHaveBeenCalled()
  }

  function expectPassiveStartup(): void {
    expect(mocks.fs.readFileSync).toHaveBeenCalledExactlyOnceWith(CONFIG_PATH, 'utf8')
    expect(mocks.fs.statSync).not.toHaveBeenCalled()
    expect(mocks.fs.existsSync).not.toHaveBeenCalled()
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled()
    for (const name of ['openSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync'] as const) {
      expect(mocks.fs[name]).not.toHaveBeenCalled()
    }
    expectNoProcesses()
    expectNoEncryption()
  }

  it.each([
    ['false', { ...SAVED_FIELDS, enabled: false }],
    ['missing enabled', { ...SAVED_FIELDS }],
    ['string true', { ...SAVED_FIELDS, enabled: 'true' }],
    ['number one', { ...SAVED_FIELDS, enabled: 1 }],
    ['number zero', { ...SAVED_FIELDS, enabled: 0 }],
    ['null enabled', { ...SAVED_FIELDS, enabled: null }],
    ['object enabled', { ...SAVED_FIELDS, enabled: {} }],
    ['array enabled', { ...SAVED_FIELDS, enabled: [true] }],
  ])('only reads local configuration for %s, including its saved UNC path', (_label, input) => {
    configText = JSON.stringify(input)
    const service = new CashalotService(DATA_ROOT)
    expect(service.isEnabled()).toBe(false)
    expect(service.isEnabled()).toBe(false)
    expect(inspect(service).config).toMatchObject({ ...SAVED_FIELDS, enabled: false })
    expectPassiveStartup()
  })

  it.each([
    ['missing file', undefined],
    ['malformed JSON', '{broken-json'],
    ['null JSON', 'null'],
    ['empty array JSON', '[]'],
    ['array containing enabled object', '[{"enabled":true}]'],
    ['string JSON', '"not a config"'],
    ['number JSON', '1'],
  ])('has safe disabled defaults without probing paths for %s', (_label, input) => {
    configText = input
    const service = new CashalotService(DATA_ROOT)
    expect(service.isEnabled()).toBe(false)
    expect(inspect(service).config).toMatchObject({
      enabled: false, fiscalNumberRRO: '', certificateDir: null, encryptedKeyPassword: null,
    })
    expect(typeof inspect(service).config.cashalotDir).toBe('string')
    expectPassiveStartup()
  })

  it.each(['4000000000', ''])('preserves eager directory resolution for explicitly enabled configuration with RRO %s', fiscalNumberRRO => {
    configText = JSON.stringify({ ...SAVED_FIELDS, enabled: true, fiscalNumberRRO })
    const service = new CashalotService(DATA_ROOT)
    // Check before getPublicConfig: enabled installations retain their existing
    // eager setup behaviour, even when the RRO number has not been filled yet.
    expect(inspect(service).config).toMatchObject({ ...SAVED_FIELDS, cashalotDir: INSTALLED, enabled: true, fiscalNumberRRO })
    expect(mocks.fs.statSync).toHaveBeenCalled()
    expect(mocks.fs.readFileSync).toHaveBeenCalledExactlyOnceWith(CONFIG_PATH, 'utf8')
    const probes = mocks.fs.statSync.mock.calls.length
    const writes = mocks.fs.writeFileSync.mock.calls.length
    expect(service.isEnabled()).toBe(fiscalNumberRRO.length > 0)
    expect(mocks.fs.statSync).toHaveBeenCalledTimes(probes)
    expect(mocks.fs.writeFileSync).toHaveBeenCalledTimes(writes)
    expectNoProcesses()
    expectNoEncryption()
  })

  it('resolves a disabled stale path on first explicit configuration read, in memory only, without repeating autodetection', () => {
    const service = new CashalotService(DATA_ROOT)
    expectPassiveStartup()
    const config = service.getPublicConfig()
    expect(config).toMatchObject({
      enabled: false, cashalotDir: INSTALLED, fiscalNumberRRO: SAVED_FIELDS.fiscalNumberRRO,
      certificateDir: SAVED_FIELDS.certificateDir, hasPassword: true, dllFound: true, comRegistered: true,
    })
    expect(inspect(service).config.encryptedKeyPassword).toBe(SAVED_FIELDS.encryptedKeyPassword)
    expect(mocks.fs.statSync).toHaveBeenCalledWith(path.join(OLD_UNC, CASHALOT_DLL))
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled()
    expect(mocks.processes.spawn).not.toHaveBeenCalled()
    expectNoEncryption()

    mocks.fs.statSync.mockClear()
    expect(service.getPublicConfig()).toEqual(config)
    // Repeated reads may retain the existing DLL/registry health checks, but
    // must not revisit the stale UNC path or scan all installation candidates.
    expect(mocks.fs.statSync).toHaveBeenCalledExactlyOnceWith(path.join(INSTALLED, CASHALOT_DLL))
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled()
    expect(mocks.fs.readFileSync).toHaveBeenCalledTimes(1)
  })

  it('enables a previously disabled service without restart and preserves fiscal, certificate and encrypted fields', () => {
    const service = new CashalotService(DATA_ROOT)
    expectPassiveStartup()
    const result = service.updateConfig({ enabled: true })
    expect(service.isEnabled()).toBe(true)
    expect(result).toMatchObject({
      enabled: true, cashalotDir: INSTALLED, fiscalNumberRRO: SAVED_FIELDS.fiscalNumberRRO,
      certificateDir: SAVED_FIELDS.certificateDir, hasPassword: true, dllFound: true,
    })
    expect(mocks.fs.writeFileSync).toHaveBeenCalledTimes(1)
    const [target, stored, encoding] = mocks.fs.writeFileSync.mock.calls[0]
    expect([target, encoding]).toEqual([79, 'utf8'])
    expect(mocks.fs.openSync).toHaveBeenCalledWith(expect.stringContaining(CONFIG_PATH + '.'), 'wx', 0o600)
    expect(mocks.fs.renameSync).toHaveBeenCalledWith(mocks.fs.openSync.mock.calls[0][0], CONFIG_PATH)
    expect(JSON.parse(String(stored))).toEqual({ ...SAVED_FIELDS, enabled: true, cashalotDir: INSTALLED })
    expect(mocks.processes.spawn).not.toHaveBeenCalled()
    expectNoEncryption()
  })

  it('keeps a valid manually saved directory ahead of an automatically detected installation', () => {
    installedDirs.add(MANUAL)
    configText = JSON.stringify({ ...SAVED_FIELDS, enabled: false, cashalotDir: MANUAL })
    const service = new CashalotService(DATA_ROOT)
    expectPassiveStartup()
    expect(service.getPublicConfig()).toMatchObject({ cashalotDir: MANUAL, dllFound: true })
    expect(inspect(service).config.cashalotDir).toBe(MANUAL)
    expect(mocks.fs.statSync.mock.calls.every(([target]) => target === path.join(MANUAL, CASHALOT_DLL))).toBe(true)
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled()
    expectNoEncryption()
  })

  it('gives an explicit manual path priority when enabling through updateConfig', () => {
    installedDirs.add(MANUAL)
    const service = new CashalotService(DATA_ROOT)
    expectPassiveStartup()
    const result = service.updateConfig({ enabled: true, cashalotDir: MANUAL })
    expect(result).toMatchObject({ enabled: true, cashalotDir: MANUAL, dllFound: true, hasPassword: true })
    expect(inspect(service).config).toEqual({ ...SAVED_FIELDS, enabled: true, cashalotDir: MANUAL })
    expect(mocks.fs.statSync.mock.calls.every(([target]) => target === path.join(MANUAL, CASHALOT_DLL))).toBe(true)
    expect(mocks.processes.spawn).not.toHaveBeenCalled()
    expectNoEncryption()
  })

  it('resolves before a direct status call even when no configuration getter has run', async () => {
    const service = new CashalotService(DATA_ROOT)
    expectPassiveStartup()
    const send = vi.spyOn(inspect(service), 'sendRequest').mockResolvedValue({ id: 'mock-request', ok: true, result: { Return: true } })
    await expect(service.getStatus()).resolves.toEqual({ Return: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({
      comMethod: 'GetCurrentStatus',
      config: {
        cashalotDir: INSTALLED, fiscalNumberRRO: SAVED_FIELDS.fiscalNumberRRO,
        certificateDir: SAVED_FIELDS.certificateDir, keyPassword: 'mock-decrypted-value',
      },
    })
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled()
    expectNoProcesses()
  })

  it('keeps explicit empty-path autodetection without probing the discarded UNC path', () => {
    const service = new CashalotService(DATA_ROOT)
    expectPassiveStartup()
    expect(service.updateConfig({ enabled: true, cashalotDir: '' })).toMatchObject({
      enabled: true, cashalotDir: INSTALLED, dllFound: true,
    })
    expect(mocks.fs.statSync.mock.calls.every(([target]) => target === path.join(INSTALLED, CASHALOT_DLL))).toBe(true)
    expect(mocks.fs.writeFileSync).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(mocks.fs.writeFileSync.mock.calls[0][1])))
      .toEqual({ ...SAVED_FIELDS, enabled: true, cashalotDir: INSTALLED })
    expect(mocks.processes.spawn).not.toHaveBeenCalled()
    expectNoEncryption()
  })

  it('rejects a direct status call without an RRO before path, encryption or process work', async () => {
    configText = JSON.stringify({ ...SAVED_FIELDS, enabled: false, fiscalNumberRRO: '' })
    const service = new CashalotService(DATA_ROOT)
    await expect(service.getStatus()).rejects.toThrow('FISCAL_RRO_NOT_CONFIGURED')
    expectPassiveStartup()
  })

  it('resolves before explicit COM registration without starting a real process or using real COM', async () => {
    const service = new CashalotService(DATA_ROOT)
    expectPassiveStartup()
    const registered = vi.spyOn(inspect(service), 'isComRegistered').mockReturnValue(true)
    const fakeProcess = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    mocks.processes.spawn.mockReturnValue(fakeProcess)

    const registration = service.registerCom()
    fakeProcess.emit('exit', 0)
    await expect(registration).resolves.toEqual({ registered: true })
    expect(inspect(service).config.cashalotDir).toBe(INSTALLED)
    expect(mocks.fs.existsSync).toHaveBeenCalledExactlyOnceWith(path.join(INSTALLED, CASHALOT_DLL))
    expect(mocks.processes.spawn).toHaveBeenCalledTimes(1)
    expect(registered).toHaveBeenCalledTimes(1)
    expect(mocks.processes.execSync).not.toHaveBeenCalled()
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled()
    expectNoEncryption()
  })
})
