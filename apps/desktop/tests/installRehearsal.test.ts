import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { runInstallRehearsal, REHEARSAL_TEST } = require('../scripts/install-rehearsal.cjs') as {
  runInstallRehearsal: (input: { repoRoot: string; dataRoot: string; run?: unknown; exists?: (file: string) => boolean; timeoutMs?: number }) => { status: string; reason?: string; output?: string }
  REHEARSAL_TEST: string
}

const repoRoot = path.join('C:', 'repo')
const dataRoot = path.join('C:', 'data', 'Forsage')
const everything = () => true
const answer = (status: number | null, stdout: string, error?: Error) => vi.fn(() => ({ status, stdout, stderr: '', error }))

// 23.11.2026 (план T5): встановлювач сам проганяє репетицію на копії бази й не ставить збірку, якщо вона впала.
describe('install rehearsal on a copy of the real database', () => {
  it('runs the rehearsal test of this very checkout against the till data folder', () => {
    const run = answer(0, ' Test Files  1 passed (1)\n      Tests  7 passed (7)\n')
    const result = runInstallRehearsal({ repoRoot, dataRoot, run, exists: everything })
    expect(result.status).toBe('passed')
    expect(result.reason).toBe('7 перевірок')
    const [command, options] = run.mock.calls[0] as unknown as [string, { cwd: string; env: Record<string, string>; timeout: number }]
    expect(command).toBe('pnpm --filter desktop exec vitest run ' + REHEARSAL_TEST)
    expect(options.cwd).toBe(repoRoot)
    expect(options.env.FORSAGE_REHEARSAL_DB).toBe(dataRoot)
    expect(options.timeout).toBeGreaterThan(60_000)
  })

  it('a failed or unstartable rehearsal stops the installation', () => {
    expect(runInstallRehearsal({ repoRoot, dataRoot, run: answer(1, ' FAIL  tests/webRehearsalOnCopy.test.ts\n      Tests  1 failed | 6 passed (7)\n'), exists: everything }).status).toBe('failed')
    expect(runInstallRehearsal({ repoRoot, dataRoot, run: answer(null, '', new Error('spawn pnpm ENOENT')), exists: everything })).toMatchObject({ status: 'failed', reason: expect.stringContaining('не вдалося запустити') })
  })

  it('«passed» counts only when the checks really ran: skipped tests are not a pass', () => {
    const skipped = runInstallRehearsal({ repoRoot, dataRoot, run: answer(0, ' Test Files  1 skipped (1)\n      Tests  7 skipped (7)\n'), exists: everything })
    expect(skipped).toMatchObject({ status: 'failed', reason: expect.stringContaining('нічого не перевірила') })
    expect(runInstallRehearsal({ repoRoot, dataRoot, run: answer(0, '      Tests  5 passed | 2 skipped (7)\n'), exists: everything }).status).toBe('failed')
    expect(runInstallRehearsal({ repoRoot, dataRoot, run: answer(0, 'no summary at all'), exists: everything }).status).toBe('failed')
  })

  it('a PC without a till database yet has nothing to rehearse on — the reason is said, nothing is run', () => {
    const run = answer(0, '')
    const result = runInstallRehearsal({ repoRoot, dataRoot, run, exists: file => !file.endsWith('forsage.db') })
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('forsage.db')
    expect(run).not.toHaveBeenCalled()
  })

  it('the installer rehearses after the till is closed and before anything is replaced', () => {
    const installer = readFileSync(new URL('../scripts/install-main-till.cjs', import.meta.url), 'utf8')
    const closed = installer.indexOf('Каса відкрита — закрийте Forsage')
    const rehearsal = installer.indexOf('runInstallRehearsal({')
    const install = installer.indexOf('installRelease({ source, destination, rollback, expectedHash })')
    expect(closed).toBeGreaterThan(-1)
    expect(rehearsal).toBeGreaterThan(closed)
    expect(install).toBeGreaterThan(rehearsal)
    // Впала — виходимо з кодом 4 і повертаємо фоновий режим на попередній версії.
    const failure = installer.slice(installer.indexOf("if (rehearsal.status === 'failed')"), install)
    expect(failure).toContain('restartBackground()')
    expect(failure).toContain('process.exit(4)')
    expect(readFileSync(new URL('./webRehearsalOnCopy.test.ts', import.meta.url), 'utf8')).toContain('FORSAGE_REHEARSAL_DB')
  })
})
