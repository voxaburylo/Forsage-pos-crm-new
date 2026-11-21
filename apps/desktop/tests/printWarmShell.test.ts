import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ spawn: vi.fn(), write: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: fake.spawn }))
vi.mock('node:fs', () => ({ default: { writeFileSync: fake.write } }))
import { disposePrintWarmShell, prewarmPrintShell, runPrintScript } from '../src/print/printWarmShell'

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    stdin: Object.assign(new EventEmitter(), { writable: true, write: vi.fn(), end: vi.fn() }),
    exitCode: null, signalCode: null, killed: false,
  })
}
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { disposePrintWarmShell(); fake.spawn.mockReset(); Object.defineProperty(process, 'platform', platform) })

it('hands the script and its parameters to the helper as one base64 line (Cyrillic printer names survive)', () => {
  const child = fakeChild()
  fake.spawn.mockReturnValue(child)
  runPrintScript('C:/data/raw-print.ps1', { PrinterName: 'Етикетки HL80', DocumentName: 'Forsage-label-1' })
  const line = String(child.stdin.write.mock.calls[0][0])
  expect(line.endsWith('\n')).toBe(true)
  expect(JSON.parse(Buffer.from(line.trim(), 'base64').toString('utf8'))).toEqual({
    file: 'C:/data/raw-print.ps1', params: { PrinterName: 'Етикетки HL80', DocumentName: 'Forsage-label-1' },
  })
  // stdin stays open: the label script still reads its raw bytes after the request line.
  expect(child.stdin.end).not.toHaveBeenCalled()
})

it('reuses a prewarmed helper instead of starting PowerShell at print time', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const warm = fakeChild()
  fake.spawn.mockReturnValueOnce(warm)
  prewarmPrintShell('C:/data')
  expect(fake.spawn).toHaveBeenCalledTimes(1)
  const used = runPrintScript('C:/data/print-preflight.ps1', { PrinterName: 'POS-58' })
  expect(used).toBe(warm)
  expect(fake.spawn).toHaveBeenCalledTimes(1)
})

it('starts a fresh helper when the spare one has died', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const dead = fakeChild()
  fake.spawn.mockReturnValueOnce(dead)
  prewarmPrintShell('C:/data')
  dead.exitCode = 1 as never
  dead.emit('exit', 1)
  const fresh = fakeChild()
  fake.spawn.mockReturnValueOnce(fresh)
  expect(runPrintScript('C:/data/print-preflight.ps1', { PrinterName: 'POS-58' })).toBe(fresh)
})
