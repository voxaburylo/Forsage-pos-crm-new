import { afterEach, describe, expect, it, vi } from 'vitest'
import { installLocalDiagnostics, reportLocalError } from './localDiagnostics'

afterEach(() => vi.unstubAllGlobals())
describe('local renderer diagnostics bridge', () => {
  it('does nothing in a browser or an older desktop', () => {
    const addEventListener = vi.fn()
    vi.stubGlobal('window', { addEventListener })
    installLocalDiagnostics(); reportLocalError(new Error('test'))
    expect(addEventListener).not.toHaveBeenCalled()
  })
  it('forwards actual UI errors and rejected promises without form data', () => {
    const listeners = new Map<string, (event: unknown) => void>(), reportError = vi.fn()
    vi.stubGlobal('window', { forsageDesktop: { diagnostics: { reportError } },
      addEventListener: (event: string, handler: (event: unknown) => void) => listeners.set(event, handler) })
    installLocalDiagnostics()
    const error = new Error('test')
    listeners.get('error')!({ error, formValues: 'PRIVATE' })
    listeners.get('unhandledrejection')!({ reason: error })
    expect(reportError).toHaveBeenNthCalledWith(1, 'renderer-error', error.message, error.stack)
    expect(reportError).toHaveBeenNthCalledWith(2, 'renderer-rejection', error.message, error.stack)
    expect(JSON.stringify(reportError.mock.calls)).not.toContain('PRIVATE')
  })
  it('does not throw when the bridge fails', () => {
    vi.stubGlobal('window', { forsageDesktop: { diagnostics: { reportError: () => { throw new Error('bridge closed') } } } })
    expect(() => reportLocalError('test')).not.toThrow()
  })
})
