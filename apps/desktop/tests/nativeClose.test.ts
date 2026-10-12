import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferQuitForMainWindow, NativeCloseController, requestUnloadScript } from '../src/nativeClose'

const flush = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(requestApproval = vi.fn<() => Promise<unknown>>().mockResolvedValue(false)) {
  const state = { destroyed: false, rendererVeto: false, beforeUnload: 0, closed: 0 }
  const failed = vi.fn()
  const nativeEvents: ReturnType<typeof vi.fn>[] = []
  const close = vi.fn(() => {
    const preventDefault = vi.fn()
    nativeEvents.push(preventDefault)
    controller.onClose({ preventDefault })
    if (!preventDefault.mock.calls.length) {
      state.beforeUnload++
      if (!state.rendererVeto) { state.destroyed = true; state.closed++; controller.stop() }
    }
  })
  const controller = new NativeCloseController({
    isDestroyed: () => state.destroyed, requestApproval, close, failed, timeoutMs: 100,
  })
  return { controller, state, nativeEvents, close, failed, requestApproval }
}

afterEach(() => vi.useRealTimers())

describe('native close approval handshake', () => {
  it('passes the original absolute deadline without renewing it after a delayed first microtask', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const f = fixture()
    f.close()
    vi.setSystemTime(1_040)
    await flush()
    expect(f.requestApproval).toHaveBeenCalledExactlyOnceWith(1_100)
  })

  it.each([100, 101])('rejects a reply at elapsed %i ms even before the timeout callback runs', async elapsed => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const answer = deferred<unknown>()
    const f = fixture(vi.fn(() => answer.promise))
    f.close(); await flush()
    vi.setSystemTime(1_000 + elapsed)
    expect(f.failed).not.toHaveBeenCalled()
    answer.resolve(true); await flush()
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.state.closed).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not send an already expired request after a stalled main microtask', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const f = fixture()
    f.close()
    vi.setSystemTime(1_100)
    await flush()
    expect(f.requestApproval).not.toHaveBeenCalled()
    expect(f.state.closed).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('blocks the first event and coalesces repeated native close requests into one prompt', async () => {
    const answer = deferred<unknown>()
    const f = fixture(vi.fn(() => answer.promise))
    f.close(); f.close(); f.close()
    expect(f.nativeEvents.every(event => event.mock.calls.length === 1)).toBe(true)
    await flush()
    expect(f.requestApproval).toHaveBeenCalledTimes(1)
    expect(f.state.beforeUnload).toBe(0)
    answer.resolve(true); await flush()
    expect(f.close).toHaveBeenCalledTimes(4)
    expect(f.nativeEvents[3]).not.toHaveBeenCalled()
    expect(f.state.beforeUnload).toBe(1)
    expect(f.state.closed).toBe(1)
  })

  it.each([false, undefined, null, 'true', 1, {}])('denies unconfirmed renderer response %j without another close', async approval => {
    const f = fixture(vi.fn().mockResolvedValue(approval))
    f.close(); await flush()
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.state.beforeUnload).toBe(0)
    expect(f.state.destroyed).toBe(false)
  })

  it.each(['sync', 'async'])('fails closed on %s execution error and permits a later explicit attempt', async mode => {
    const error = new Error('renderer failed')
    const approval = vi.fn<() => Promise<unknown>>().mockImplementationOnce(() => {
      if (mode === 'sync') throw error
      return Promise.reject(error)
    }).mockResolvedValue(true)
    const f = fixture(approval)
    f.close(); await flush()
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.failed).toHaveBeenCalledWith(error)
    expect(f.state.closed).toBe(0)
    f.close(); await flush()
    expect(f.state.closed).toBe(1)
    expect(approval).toHaveBeenCalledTimes(2)
  })

  it('leaves beforeunload active when a new edit or busy revision vetoes the approved close', async () => {
    const f = fixture(vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false))
    f.state.rendererVeto = true
    f.close(); await flush()
    expect(f.state.beforeUnload).toBe(1)
    expect(f.state.closed).toBe(0)
    f.close(); await flush()
    expect(f.requestApproval).toHaveBeenCalledTimes(2)
    expect(f.nativeEvents.at(-1)).toHaveBeenCalledTimes(1)
    expect(f.state.beforeUnload).toBe(1)
  })

  it('ignores approval after stop and clears its timer', async () => {
    vi.useFakeTimers()
    const answer = deferred<unknown>()
    const f = fixture(vi.fn(() => answer.promise))
    f.close(); await flush(); f.controller.stop()
    expect(vi.getTimerCount()).toBe(0)
    answer.resolve(true); await flush()
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.state.closed).toBe(0)
  })

  it('does not start a queued renderer evaluation after stop before its first microtask', async () => {
    const f = fixture()
    f.close(); f.controller.stop(); await flush()
    expect(f.requestApproval).not.toHaveBeenCalled()
    expect(f.state.closed).toBe(0)
  })

  it('does not close a destroyed window after late approval', async () => {
    const answer = deferred<unknown>()
    const f = fixture(vi.fn(() => answer.promise))
    f.close(); await flush(); f.state.destroyed = true
    answer.resolve(true); await flush()
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.state.beforeUnload).toBe(0)
  })

  it('expires a silent request without overlapping prompts or accepting its late approval', async () => {
    vi.useFakeTimers()
    const answer = deferred<unknown>()
    const approval = vi.fn<() => Promise<unknown>>().mockImplementationOnce(() => answer.promise).mockResolvedValue(true)
    const f = fixture(approval)
    f.close(); await flush(); await vi.advanceTimersByTimeAsync(100)
    expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'RENDERER_CLOSE_APPROVAL_TIMEOUT' }))
    f.close(); await flush()
    expect(approval).toHaveBeenCalledTimes(1)
    answer.resolve(true); await flush()
    expect(f.state.closed).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    f.close(); await flush()
    expect(approval).toHaveBeenCalledTimes(2)
    expect(f.state.closed).toBe(1)
  })

  it('permits the already confirmed native recovery choice without bypassing beforeunload', async () => {
    const answer = deferred<unknown>()
    const f = fixture(vi.fn(() => answer.promise))
    f.close(); await flush()
    f.state.rendererVeto = true
    f.controller.closeAfterConfirmedRecovery()
    expect(f.state.beforeUnload).toBe(1)
    expect(f.state.closed).toBe(0)
    answer.resolve(true); await flush()
    expect(f.state.beforeUnload).toBe(1)
    f.state.rendererVeto = false
    f.controller.closeAfterConfirmedRecovery()
    expect(f.state.closed).toBe(1)
    expect(f.requestApproval).toHaveBeenCalledTimes(1)
  })
})

describe('fixed renderer approval dispatch', () => {
  function evaluate(handler?: (detail: { handled: boolean; approved: boolean; deadline: number }) => void) {
    const events: unknown[] = []
    const value: unknown = runInNewContext(requestUnloadScript(12_345), {
      CustomEvent: class { constructor(readonly type: string, readonly options: { detail: unknown }) {} get detail() { return this.options.detail } },
      window: { dispatchEvent(event: { type: string; detail: { handled: boolean; approved: boolean; deadline: number } }) {
        events.push(event.type)
        // DOM reports listener exceptions without throwing them to dispatchEvent.
        try { handler?.(event.detail) } catch { /* synthetic error reporting only */ }
      } },
    })
    expect(events).toEqual(['forsage:request-unload'])
    return value
  }
  it('lets startup without a mounted guard attempt ordinary native close', async () => {
    const f = fixture(vi.fn().mockResolvedValue(evaluate()))
    f.close(); await flush()
    expect(f.state.beforeUnload).toBe(1)
    expect(f.state.closed).toBe(1)
  })
  it('requires exact approval from a mounted handler', () => {
    expect(evaluate(detail => { detail.handled = true })).toBe(false)
    expect(evaluate(detail => { detail.handled = true; detail.approved = true })).toBe(true)
  })
  it('serializes the same finite deadline in the fixed dispatch', () => {
    let captured: number | undefined
    evaluate(detail => { captured = detail.deadline })
    expect(captured).toBe(12_345)
  })
  it.each([NaN, Infinity, -Infinity, '1; window.close()', null, undefined])('rejects unsafe deadline %j before generating JavaScript', deadline => {
    expect(() => requestUnloadScript(deadline as number)).toThrow('Invalid close approval deadline')
  })
  it('does not turn a throwing listener into approval', () => {
    expect(evaluate(detail => { detail.handled = true; throw new Error('fixture listener failed') })).toBe(false)
  })
})

describe('before-quit deferral', () => {
  it('defers cleanup while a live main window has not actually closed', async () => {
    const f = fixture()
    const preventDefault = vi.fn()
    const cleanup = vi.fn()
    if (!deferQuitForMainWindow({ preventDefault }, { close: f.close, isDestroyed: () => f.state.destroyed })) cleanup()
    await flush()
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(f.state.closed).toBe(0)
    expect(cleanup).not.toHaveBeenCalled()
  })
  it.each(['null', 'destroyed'])('does not defer when the main window is %s', kind => {
    const preventDefault = vi.fn(), close = vi.fn()
    expect(deferQuitForMainWindow({ preventDefault }, kind === 'null' ? null : { close, isDestroyed: () => true })).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })
  it('defers only until actual closure, then permits cleanup even with other windows remaining', async () => {
    const f = fixture(vi.fn().mockResolvedValue(true))
    const main = { close: f.close, isDestroyed: () => f.state.destroyed }
    expect(deferQuitForMainWindow({ preventDefault: vi.fn() }, main)).toBe(true)
    await flush()
    expect(f.state.closed).toBe(1)
    expect(deferQuitForMainWindow({ preventDefault: vi.fn() }, main)).toBe(false)
  })
})

it('guards the live main window before any shutdown cleanup begins', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const shutdown = main.slice(main.indexOf("app.on('before-quit'"))
  const mainGuard = shutdown.indexOf('if (deferQuitForMainWindow(event, mainWindow)) return')
  expect(mainGuard).toBeGreaterThanOrEqual(0)
  expect(mainGuard).toBeLessThan(shutdown.indexOf('databaseMaintenance = true'))
  const branch = shutdown.slice(mainGuard, shutdown.indexOf('if (quitAfterCleanup)'))
  expect(branch).toContain('deferQuitForMainWindow(event, mainWindow)')
  expect(branch).toContain('return')
  const closed = main.slice(main.indexOf("window.on('closed'"), main.indexOf('mainWindow.webContents.setWindowOpenHandler'))
  expect(closed.indexOf('closeController.stop()')).toBeLessThan(closed.indexOf('app.quit()'))
  expect(closed.indexOf('mainWindow = null')).toBeLessThan(closed.indexOf('app.quit()'))
  expect(shutdown.indexOf('await Promise.allSettled([...activeDesktopCommands])')).toBeLessThan(shutdown.indexOf('localDatabase?.close()'))
  expect(main).toContain('requestApproval: deadline => window.webContents.executeJavaScript(requestUnloadScript(deadline))')
  expect(main).toContain('if (result.response === 1) { closeController.closeAfterConfirmedRecovery(); return }')
})
