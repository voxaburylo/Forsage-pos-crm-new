import { spawnSync } from 'node:child_process'

// Only isolated test probes use this budget. Production printer timeouts are unchanged.
// The first Windows PowerShell launch on a hosted runner can exceed 10 seconds.
export const POWER_SHELL_PROBE_TIMEOUT_MS = 30_000
export const POWER_SHELL_TEST_TIMEOUT_MS = 45_000

export function runPowerShellProbe(script: string): string {
  const command = "$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n" + script
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: POWER_SHELL_PROBE_TIMEOUT_MS })
  // A longer startup budget must not turn a timeout, signal or failed process into success.
  // No automatic retry: each probe is executed exactly once.
  if (result.error) throw result.error
  if (result.status !== 0 || result.signal != null)
    throw new Error('PowerShell probe did not exit cleanly: ' + String(result.status) + ' / ' + String(result.signal))
  if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string')
    throw new Error('PowerShell probe returned incomplete output')
  if (result.stderr.trim()) throw new Error('PowerShell probe stderr: ' + result.stderr)
  return result.stdout
}
