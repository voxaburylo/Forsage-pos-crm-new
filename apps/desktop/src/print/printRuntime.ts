import { statSync } from 'node:fs'
import path from 'node:path'

// A portable wrapper used to share one extraction directory between launches.
// When a second launch exited, it removed unlocked Chromium resources still
// needed by the first process. Do not spawn another doomed print renderer.
export const PRINT_RUNTIME_FILES = [
  'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak',
  'chrome_200_percent.pak', 'v8_context_snapshot.bin', 'locales/en-US.pak',
] as const

export function assertPrintRuntimeFiles(runtimeDirectory = path.dirname(process.execPath), platform = process.platform): void {
  if (platform !== 'win32') return
  for (const name of PRINT_RUNTIME_FILES) {
    try {
      const file = statSync(path.join(runtimeDirectory, name))
      if (!file.isFile() || file.size === 0) throw new Error('missing runtime')
    } catch {
      // No paths, customer content or HTML in user-facing diagnostics.
      throw new Error('PRINT_RUNTIME_FILES_MISSING')
    }
  }
}
