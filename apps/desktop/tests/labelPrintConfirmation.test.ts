import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { POWER_SHELL_TEST_TIMEOUT_MS, runPowerShellProbe } from './powerShellProbe'
// Exercise the actual PowerShell postflight with a fake queue. No printer is contacted.
function checkQueue(jobs: Array<{ DocumentName: string; JobStatus: string | number; PagesPrinted: number }>): string {
  const source = readFileSync(new URL('../src/print/tsplLabelPrinter.ts', import.meta.url), 'utf8')
  const start = source.indexOf('# ── Postflight')
  const end = source.indexOf("[Console]::Out.Write('RAW_PRINT_OK')", start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  expect(source.slice(start, end)).toContain('.AddSeconds(15)')
  const postflight = source.slice(start, end).replace('.AddSeconds(15)', '.AddSeconds(0)')
  const json = JSON.stringify(jobs).replace(/'/g, "''")
  const script = [
    "$ErrorActionPreference='Stop'; $docName='test'; $fatalPattern='Error|Offline|PaperOut|UserIntervention'",
    "$script:queue = ConvertFrom-Json '" + json + "'",
    'function Get-PrintJob { $script:queue }',
    'function Get-StuckJobs { @() }',
    "function Remove-PrintJob { [CmdletBinding(SupportsShouldProcess=$true)] param([Parameter(ValueFromPipeline=$true)]$InputObject) process { if ($null -ne $InputObject) { throw 'UNEXPECTED_QUEUE_MUTATION' } } }",
    "try { " + postflight + "; [Console]::Out.Write('OK') } catch { [Console]::Out.Write('FAILED: '+$_.Exception.Message) }",
  ].join('\n')
  return runPowerShellProbe(script)
}
it.runIf(process.platform === 'win32')('does not mistake numeric Normal=0 status for successful printing', () => {
  expect(checkQueue([{ DocumentName: 'test', JobStatus: 0, PagesPrinted: 0 }])).toContain('FAILED: TSPL_PRINT_NOT_CONFIRMED')
}, POWER_SHELL_TEST_TIMEOUT_MS)
it.runIf(process.platform === 'win32')('does not report a queued job without pages as success', () => {
  expect(checkQueue([{ DocumentName: 'test', JobStatus: 'Printing, Retained', PagesPrinted: 0 }])).toContain('FAILED: TSPL_PRINT_NOT_CONFIRMED')
}, POWER_SHELL_TEST_TIMEOUT_MS)
it.runIf(process.platform === 'win32')('accepts a drained queue', () => {
  expect(checkQueue([])).toBe('OK')
}, POWER_SHELL_TEST_TIMEOUT_MS)
it.runIf(process.platform === 'win32')('accepts confirmed progress in a long batch', () => {
  expect(checkQueue([{ DocumentName: 'test', JobStatus: 'Printing', PagesPrinted: 1 }])).toBe('OK')
}, POWER_SHELL_TEST_TIMEOUT_MS)
