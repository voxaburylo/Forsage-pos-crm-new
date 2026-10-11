import { beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: fake.spawn }))
import { POWER_SHELL_PROBE_TIMEOUT_MS, POWER_SHELL_TEST_TIMEOUT_MS, runPowerShellProbe } from './powerShellProbe'

const ok = () => ({ status: 0, signal: null, stdout: 'OK', stderr: '' })
beforeEach(() => { fake.spawn.mockReset(); fake.spawn.mockReturnValue(ok()) })

it('uses a bounded startup budget and exact Unicode script in one hidden process', () => {
  expect(runPowerShellProbe("'Українська'")).toBe('OK')
  expect(fake.spawn).toHaveBeenCalledTimes(1)
  const [exe, args, options] = fake.spawn.mock.calls[0]
  expect(exe).toBe('powershell.exe')
  expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  expect(Buffer.from(args[3], 'base64').toString('utf16le')).toContain("'Українська'")
  expect(options).toEqual({ encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  expect(POWER_SHELL_TEST_TIMEOUT_MS).toBeGreaterThan(POWER_SHELL_PROBE_TIMEOUT_MS)
})

it.each(['ETIMEDOUT', 'ENOENT'])('propagates %s without retrying or accepting stdout', code => {
  const error = Object.assign(new Error(code), { code })
  fake.spawn.mockReturnValue({ ...ok(), error })
  expect(() => runPowerShellProbe('fixture')).toThrow(error)
  expect(fake.spawn).toHaveBeenCalledTimes(1)
})
it.each([1, 2147483651, null])('rejects exit %s even after an OK marker', status => {
  fake.spawn.mockReturnValue({ ...ok(), status })
  expect(() => runPowerShellProbe('fixture')).toThrow('did not exit cleanly')
})
it('rejects a signal even if the exit status and marker look successful', () => {
  fake.spawn.mockReturnValue({ ...ok(), signal: 'SIGTERM' })
  expect(() => runPowerShellProbe('fixture')).toThrow('did not exit cleanly')
})
it('does not ignore PowerShell errors written to stderr', () => {
  fake.spawn.mockReturnValue({ ...ok(), stderr: 'synthetic failure' })
  expect(() => runPowerShellProbe('fixture')).toThrow('synthetic failure')
})
it.each(['stdout', 'stderr'])('rejects missing %s', field => {
  fake.spawn.mockReturnValue({ ...ok(), [field]: null })
  expect(() => runPowerShellProbe('fixture')).toThrow('incomplete output')
})
it('leaves semantic success checks to each probe assertion', () => {
  fake.spawn.mockReturnValue({ ...ok(), stdout: 'FAILED: TSPL_PRINT_NOT_CONFIRMED' })
  expect(runPowerShellProbe('fixture')).toBe('FAILED: TSPL_PRINT_NOT_CONFIRMED')
})
