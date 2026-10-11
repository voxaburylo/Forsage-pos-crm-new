import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const isolated = {
    protocol: { handle: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
  }
  return { isolated, fromPartition: vi.fn(() => isolated) }
})
vi.mock('electron', () => ({ session: { fromPartition: fake.fromPartition } }))

describe('lazy print session', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })

  it('does not initialise print services while identifying ordinary windows', async () => {
    const { isPrintSession } = await import('../src/print/printSession')
    const ordinary = {} as Electron.Session
    for (let i = 0; i < 10; i++) expect(isPrintSession(ordinary)).toBe(false)
    expect(fake.fromPartition).not.toHaveBeenCalled()
    expect(fake.isolated.protocol.handle).not.toHaveBeenCalled()
  })

  it('rejects a document in the shop session without initialising print services', async () => {
    const { loadPrintHtml } = await import('../src/print/loadPrintHtml')
    const target = { loadURL: vi.fn(), isDestroyed: () => false, webContents: { session: {} as Electron.Session } }
    await expect(loadPrintHtml(target, '<p>private receipt</p>')).rejects.toThrow('PRINT_SESSION_REQUIRED')
    expect(target.loadURL).not.toHaveBeenCalled()
    expect(fake.fromPartition).not.toHaveBeenCalled()
  })

  it('initialises exactly once on demand and only recognises the isolated session', async () => {
    const { getPrintSession, isPrintSession } = await import('../src/print/printSession')
    const isolated = getPrintSession()
    expect(isPrintSession(isolated)).toBe(true)
    expect(isPrintSession({} as Electron.Session)).toBe(false)
    expect(getPrintSession()).toBe(isolated)
    expect(fake.fromPartition).toHaveBeenCalledExactlyOnceWith('forsage-print-memory', { cache: false })
    expect(fake.isolated.protocol.handle).toHaveBeenCalledOnce()
    expect(fake.isolated.setPermissionRequestHandler).toHaveBeenCalledOnce()
    expect(fake.isolated.setPermissionCheckHandler).toHaveBeenCalledOnce()
    expect(fake.isolated.webRequest.onBeforeRequest).toHaveBeenCalledOnce()
  })

  it('still refuses all permission checks and permission requests', async () => {
    const { getPrintSession } = await import('../src/print/printSession')
    getPrintSession()
    const check = fake.isolated.setPermissionCheckHandler.mock.calls[0][0]
    const request = fake.isolated.setPermissionRequestHandler.mock.calls[0][0]
    const respond = vi.fn()
    expect(check({}, 'media', 'https://example.invalid', {})).toBe(false)
    request({}, 'media', respond)
    expect(respond).toHaveBeenCalledExactlyOnceWith(false)
  })

  it.each([
    ['forsage-print://document/test', false], ['data:image/png;base64,test', false], ['blob:null/test', false],
    ['https://example.invalid', true], ['http://example.invalid', true], ['file:///private.db', true],
    ['https://example.invalid/forsage-print:', true], ['forsage-print-lookalike://document/test', true],
  ])('preserves the request boundary for %s', async (url, cancel) => {
    const { getPrintSession } = await import('../src/print/printSession')
    getPrintSession()
    const callback = vi.fn()
    fake.isolated.webRequest.onBeforeRequest.mock.calls[0][0]({ url }, callback)
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel })
  })

  it('uses the non-creating predicate in the production web-contents hook', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const hook = main.slice(main.indexOf("app.on('web-contents-created'"), main.indexOf("app.on('browser-window-created'"))
    expect(hook).toContain('if (!isPrintSession(contents.session)) return')
    expect(hook).not.toContain('getPrintSession()')
    expect(hook).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))")
    expect(hook).toContain("'render-process-gone'")
    expect(hook).toContain("'did-fail-load'")
  })
})
