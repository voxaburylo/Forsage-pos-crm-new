import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PrintAttemptGuard, printDefinitelyNotSent } from '../src/print/printAttemptGuard'

let root: string
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-print-guard-')) })
afterEach(() => { if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-print-guard-')) rmSync(root, { recursive: true, force: true }) })
const guard = (confirm = vi.fn(async () => true), record = vi.fn()) => new PrintAttemptGuard(path.join(root, 'attempt'), confirm, record)
it('does not silently retry an uncertain job, including after restarting', async () => {
  await expect(guard().run('POS-58', async () => { throw new Error('PRINT_OUTCOME_UNKNOWN') })).rejects.toThrow('UNKNOWN')
  const confirm = vi.fn(async () => false), print = vi.fn(async () => 'ok')
  await expect(guard(confirm).run('pos-58', print)).rejects.toThrow('PRINT_REPEAT_CANCELLED')
  expect(confirm).toHaveBeenCalledOnce(); expect(print).not.toHaveBeenCalled()
  await expect(guard().run('POS-58', print)).resolves.toBe('ok')
  const noQuestion = vi.fn(async () => false)
  await expect(guard(noQuestion).run('POS-58', print)).resolves.toBe('ok')
  expect(noQuestion).not.toHaveBeenCalled()
})
it('preparation failure permits retry, but a submitted failure always requires confirmation', async () => {
  const confirm = vi.fn(async () => true), instance = guard(confirm)
  await expect(instance.run('POS-80', async () => { throw new Error('PRINT_DOCUMENT_LOAD_FAILED') })).rejects.toThrow()
  await instance.run('POS-80', async () => true)
  expect(confirm).not.toHaveBeenCalled()
  expect(printDefinitelyNotSent(new Error('TSPL_PRINTER_NOT_READY [PRINT_SUBMISSION_STARTED]'))).toBe(false)
  expect(printDefinitelyNotSent(new Error('write EOF'))).toBe(false)
})
it('keeps printers independent and records Windows acceptance, not physical completion', async () => {
  const record = vi.fn(), instance = guard(undefined, record)
  let finish!: () => void
  const receipt = instance.run('POS-58', () => new Promise<void>(resolve => { finish = resolve }))
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await expect(instance.run('POS-80', async () => 2)).resolves.toBe(2)
  finish(); await receipt
  expect(record.mock.calls.filter(call => call[0] === 'print-attempt-accepted')).toHaveLength(2)
})
