import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForPrintProcess, setPrintProcessReporter } from '../src/print/printProcess'

function fake() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn(),
  }) as unknown as ChildProcessWithoutNullStreams
}
const options = { successMarker: 'PRINT_OK', failureCode: 'PRINT_FAILED', timeoutCode: 'PRINT_OUTCOME_UNKNOWN', timeoutMs: 100 }
afterEach(() => vi.useRealTimers())
describe('print subprocess completion', () => {
  it('records chunked spooler job stages and marks a later failure as possibly printed', async () => {
    const record = vi.fn(); setPrintProcessReporter(record)
    const child = fake(); const result = waitForPrintProcess(child, 'test', { ...options, printer: 'POS-80', documentName: 'test-job' })
    child.stdout.emit('data', 'FORSAGE_PRINT_STAGE:submis')
    child.stdout.emit('data', 'sion-started\nFORSAGE_PRINT_STAGE:job-created:42\n')
    child.stderr.emit('data', 'TSPL_PRINT_NOT_CONFIRMED'); child.emit('close', 1)
    await expect(result).rejects.toThrow('PRINT_SUBMISSION_STARTED')
    expect(record.mock.calls.filter(call => call[0] === 'print-helper-stage').map(call => call[1].stage)).toEqual(['submission-started', 'job-created:42'])
    setPrintProcessReporter(() => {})
  })
  it('waits for the actual helper rejection after stdin EOF', async () => {
    const child = fake(); const done = vi.fn()
    const result = waitForPrintProcess(child, 'test', options)
    void result.then(done, done)
    child.stdin.emit('error', new Error('write EOF'))
    await Promise.resolve(); expect(done).not.toHaveBeenCalled()
    child.stderr.emit('data', 'TSPL_QUEUE_STUCK: old job')
    child.emit('close', 1)
    await expect(result).rejects.toThrow('TSPL_QUEUE_STUCK: old job')
    expect(child.stdin.end).toHaveBeenCalledTimes(1)
  })
  it('requires the success marker, exit zero, and no input failure', async () => {
    for (const [code, marker, inputError, succeeds] of [[0, true, false, true], [1, true, false, false], [0, false, false, false], [0, true, true, false]] as const) {
      const child = fake(); const result = waitForPrintProcess(child, 'test', options)
      if (marker) child.stdout.emit('data', 'PRINT_OK')
      if (inputError) child.stdin.emit('error', new Error('write EOF'))
      child.emit('close', code)
      if (succeeds) await expect(result).resolves.toBeUndefined()
      else await expect(result).rejects.toThrow()
    }
  })
  it('reports an unknown outcome on timeout without resending', async () => {
    vi.useFakeTimers()
    const child = fake(); const result = waitForPrintProcess(child, 'test', options)
    const assertion = expect(result).rejects.toThrow('PRINT_OUTCOME_UNKNOWN')
    child.stdin.emit('error', new Error('write EOF'))
    await vi.advanceTimersByTimeAsync(100); await assertion
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.stdin.end).toHaveBeenCalledTimes(1)
  })
  it('stops on abort, including a signal already aborted', async () => {
    for (const alreadyAborted of [false, true]) {
      const controller = new AbortController(); if (alreadyAborted) controller.abort()
      const child = fake(); const result = waitForPrintProcess(child, 'test', { ...options, signal: controller.signal, abortCode: 'PRINT_ABORTED' })
      if (!alreadyAborted) controller.abort()
      await expect(result).rejects.toThrow('PRINT_ABORTED')
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.stdin.end).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1)
    }
  })
  it('keeps a useful helper error even when end throws synchronously', async () => {
    const child = fake(); vi.mocked(child.stdin.end).mockImplementation(() => { throw new Error('EPIPE') })
    const result = waitForPrintProcess(child, 'test', options)
    child.stderr.emit('data', 'PRINTER_NOT_FOUND'); child.emit('close', 1)
    await expect(result).rejects.toThrow('PRINTER_NOT_FOUND')
  })
})
