import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: fake.spawn }))
vi.mock('node:fs', () => ({ default: { writeFileSync: vi.fn() } }))
vi.mock('electron', () => ({ app: { getPath: () => 'unused-test-directory' } }))
import { postflightPrinter } from '../src/print/spoolerGuard'
import { printDefinitelyNotSent } from '../src/print/printAttemptGuard'

it('keeps post-submission printer errors uncertain rather than permitting an unchecked repeat', async () => {
  const process = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
  })
  fake.spawn.mockReturnValue(process)
  const failure = postflightPrinter('POS-58', 'test-receipt', new Date().toISOString()).catch(error => error)
  process.stderr.emit('data', 'PRINT_PRINTER_NOT_READY')
  process.emit('close', 1)
  const error = await failure
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain('PRINT_SUBMISSION_STARTED')
  expect(printDefinitelyNotSent(error)).toBe(false)
})
