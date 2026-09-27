import { afterEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({
  handler: undefined as undefined | ((request: Request) => Response),
  session: { protocol: { handle: vi.fn() }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } },
}))
vi.mock('electron', () => ({ session: { fromPartition: vi.fn(() => fake.session) } }))
import { loadPrintHtml } from '../src/print/loadPrintHtml'
import { getPrintSession } from '../src/print/printSession'
fake.session.protocol.handle.mockImplementation((_scheme, handler) => { fake.handler = handler })

function target() {
  return { loadURL: vi.fn(async (_url: string) => {}), isDestroyed: vi.fn(() => false), webContents: { session: getPrintSession() } }
}
describe('isolated in-memory print document', () => {
  afterEach(() => vi.useRealTimers())
  it.each(['<h1>Етикетка 000123 — 25 грн</h1>', '<!--' + 'я'.repeat(2_100_000) + '--><p>last label</p>', '<p>" \\ \n </script> ; throw new Error("not code")</p>'])('serves complete markup without a data URL, script injection or disk file', async html => {
    const window = target()
    window.loadURL.mockImplementation(async url => {
      expect(url.length).toBeLessThan(100)
      const response = fake.handler!(new Request(url))
      expect(await response.text()).toBe(html)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    })
    await loadPrintHtml(window, html)
    expect(window.loadURL).toHaveBeenCalledOnce()
    expect(fake.handler!(new Request(window.loadURL.mock.calls[0][0])).status).toBe(404)
  })
  it('retries only document preparation once, with a new URL', async () => {
    vi.useFakeTimers()
    const window = target()
    window.loadURL.mockRejectedValueOnce(new Error('ERR_FAILED (-2)')).mockResolvedValueOnce(undefined)
    const result = loadPrintHtml(window, '<p>receipt</p>')
    await vi.runAllTimersAsync(); await result
    expect(window.loadURL).toHaveBeenCalledTimes(2)
    expect(window.loadURL.mock.calls[0][0]).not.toBe(window.loadURL.mock.calls[1][0])
  })
  it('bounds repeat failures and does not expose document or URL', async () => {
    vi.useFakeTimers()
    const window = target()
    window.loadURL.mockRejectedValue(new Error('ERR_FAILED private document'))
    const result = expect(loadPrintHtml(window, '<p>secret</p>')).rejects.toThrow(/^PRINT_DOCUMENT_LOAD_FAILED \(ERR_FAILED\)$/)
    await vi.runAllTimersAsync(); await result
    expect(window.loadURL).toHaveBeenCalledTimes(2)
    for (const [url] of window.loadURL.mock.calls) expect(fake.handler!(new Request(url)).status).toBe(404)
  })
  it('does not retry permanent errors or use the shop session', async () => {
    const window = target()
    window.loadURL.mockRejectedValue(new Error('ERR_INVALID_URL private document'))
    await expect(loadPrintHtml(window, '<p>secret</p>')).rejects.toThrow('ERR_INVALID_URL')
    expect(window.loadURL).toHaveBeenCalledOnce()
    await expect(loadPrintHtml({ ...window, webContents: { session: {} as Electron.Session } }, '<p>x</p>')).rejects.toThrow('PRINT_SESSION_REQUIRED')
  })
  it('never starts another load after the enclosing stage timeout destroyed the window', async () => {
    const window = target()
    window.loadURL.mockImplementation(async () => { window.isDestroyed.mockReturnValue(true); throw new Error('ERR_ABORTED') })
    await expect(loadPrintHtml(window, '<p>receipt</p>')).rejects.toThrow('PRINT_DOCUMENT_LOAD_FAILED')
    expect(window.loadURL).toHaveBeenCalledOnce()
  })
  it('rejects empty documents before any navigation', async () => {
    const window = target()
    await expect(loadPrintHtml(window, '  ')).rejects.toThrow('PRINT_HTML_EMPTY')
    expect(window.loadURL).not.toHaveBeenCalled()
  })
})
