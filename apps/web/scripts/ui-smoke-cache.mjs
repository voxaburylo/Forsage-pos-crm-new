import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Every fixture has its own dependency cache, including parallel test processes.
export function createSmokeCache() {
  const root = realpathSync(os.tmpdir())
  const directory = mkdtempSync(path.join(root, 'forsage-ui-smoke-'))
  process.once('exit', () => {
    // Only remove the exact private directory that this process created.
    if (path.dirname(directory) !== root || !path.basename(directory).startsWith('forsage-ui-smoke-')) return
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 2 }) } catch { /* OS may retain a temporary handle. */ }
  })
  return directory
}
