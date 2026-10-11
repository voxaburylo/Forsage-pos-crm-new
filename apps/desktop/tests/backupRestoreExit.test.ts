import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const { assertCleanRestoreExit } = createRequire(import.meta.url)('../scripts/backup-restore-electron-smoke.cjs')
const report = { runtime: 'electron-application', rowsIdentical: true, previousRowsIdentical: true,
  sourceUnchanged: true, previousSourceUnchanged: true }
const result = () => ({ signal: null, status: 0, stdout: JSON.stringify(report) + '\n' })

it('accepts a complete restore report only with clean natural shutdown', () => {
  expect(assertCleanRestoreExit(result())).toEqual(report)
})
it.each([2147483651, 1, null])('does not hide a late exit failure %s behind a success report', status => {
  expect(() => assertCleanRestoreExit({ ...result(), status })).toThrow('did not exit cleanly')
})
it('rejects a killed process even with a complete report', () => {
  expect(() => assertCleanRestoreExit({ ...result(), signal: 'SIGTERM' })).toThrow('was terminated')
})
it('propagates process startup or timeout failures', () => {
  expect(() => assertCleanRestoreExit({ ...result(), error: new Error('timeout') })).toThrow('timeout')
})
it.each(['', '{}\n', JSON.stringify(report) + '\n' + JSON.stringify(report) + '\n'])('rejects missing, incomplete or duplicate reports', stdout => {
  expect(() => assertCleanRestoreExit({ ...result(), stdout })).toThrow()
})
it.each(['rowsIdentical', 'previousRowsIdentical', 'sourceUnchanged', 'previousSourceUnchanged'])('requires positive evidence of %s', field => {
  expect(() => assertCleanRestoreExit({ ...result(), stdout: JSON.stringify({ ...report, [field]: false }) })).toThrow()
})
