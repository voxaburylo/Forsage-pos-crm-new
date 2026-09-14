import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
describe('printer safety boundaries', () => {
  for (const file of ['spoolerGuard.ts','tsplLabelPrinter.ts']) it(file + ' never removes pre-existing print jobs', () => {
    const source = readFileSync(new URL('../src/print/' + file, import.meta.url), 'utf8')
    const preflight = source.slice(source.indexOf('function Get-StuckJobs'), source.indexOf(file === 'spoolerGuard.ts' ? 'const POSTFLIGHT_SCRIPT' : '# ── Postflight'))
    expect(preflight).not.toContain('Remove-PrintJob')
    expect(preflight).toContain(file === 'spoolerGuard.ts' ? 'SPOOLER_ERRORS.queueStuck' : 'TSPL_QUEUE_STUCK')
  })
  it('does not report a successful check on process failure or timeout', () => {
    const source = readFileSync(new URL('../src/print/spoolerGuard.ts', import.meta.url), 'utf8')
    expect(source).toContain('reject(new Error(SPOOLER_ERRORS.checkFailed))')
    expect(source).toContain('reject(new Error(SPOOLER_ERRORS.checkTimeout))')
  })
})
