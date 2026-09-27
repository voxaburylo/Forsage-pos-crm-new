import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { PRINT_RUNTIME_FILES, assertPrintRuntimeFiles } from '../src/print/printRuntime'
import { localizeDesktopIpcError } from '../src/ipcError'
import { safeDiagnosticDetails } from '../src/diagnostics/blackBoxData'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-runtime-test-')); roots.push(root)
  for (const file of PRINT_RUNTIME_FILES) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), 'test runtime resource')
  }
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-runtime-test-')) rmSync(root, { recursive: true, force: true })
})
it('accepts an intact runtime without changing its files', () => {
  const root = fixture()
  expect(() => assertPrintRuntimeFiles(root, 'win32')).not.toThrow()
  for (const file of PRINT_RUNTIME_FILES) expect(readFileSync(path.join(root, file), 'utf8')).toBe('test runtime resource')
})
it.each(PRINT_RUNTIME_FILES)('rejects removed resource %s before creating a renderer', file => {
  const root = fixture(); unlinkSync(path.join(root, file))
  expect(() => assertPrintRuntimeFiles(root, 'win32')).toThrow(/^PRINT_RUNTIME_FILES_MISSING$/)
})
it('rejects empty files and directories in place of runtime resources', () => {
  const root = fixture(), file = path.join(root, PRINT_RUNTIME_FILES[0])
  writeFileSync(file, '')
  expect(() => assertPrintRuntimeFiles(root, 'win32')).toThrow('PRINT_RUNTIME_FILES_MISSING')
  unlinkSync(file); mkdirSync(file)
  expect(() => assertPrintRuntimeFiles(root, 'win32')).toThrow('PRINT_RUNTIME_FILES_MISSING')
})
it('does not impose Windows resource paths on other platforms', () => {
  expect(() => assertPrintRuntimeFiles('nonexistent', 'linux')).not.toThrow()
})
it('explains recovery without blaming the printer or leaking runtime paths', () => {
  const error = new Error('PRINT_RUNTIME_FILES_MISSING')
  expect(localizeDesktopIpcError(error).message).toContain('повністю закрийте «Форсаж»')
  expect(localizeDesktopIpcError(error).message).toContain('ще не надіслано принтеру')
  expect(safeDiagnosticDetails(error).error_code).toBe('print-runtime-files-missing')
})
it('keeps per-launch extraction enabled for the installed electron-builder implementation', () => {
  // 26.15.3 implementation uses true for $PLUGINSDIR (its type comment says
  // false). The executable lifecycle smoke also checks the actual NSIS output.
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
  expect(pkg.build.portable.unpackDirName).toBe(true)
})
