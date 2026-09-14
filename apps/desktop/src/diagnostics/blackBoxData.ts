import { createHash } from 'node:crypto'

const numbers = new Set(['duration_ms', 'lag_ms', 'rss_mb', 'pid', 'exitCode', 'attempt', 'sequence', 'dropped', 'schemaVersion'])
const tokens = new Set(['channel', 'role', 'reason', 'type', 'version', 'build', 'electron', 'node', 'platform', 'arch', 'status', 'section', 'serviceName'])

// Never accept arbitrary messages, arguments, results, URLs, SQL or entity IDs.
export function safeDiagnosticDetails(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (value instanceof Error || typeof value === 'string') {
    const text = (value instanceof Error ? `${value.name}\n${value.message}\n${value.stack ?? ''}` : value).slice(0, 8192)
    result.fingerprint = createHash('sha256').update(text).digest('hex').slice(0, 20)
    for (const [pattern, code] of [
      [/Програму заблоковано|LOCAL_SESSION_LOCKED/i, 'session-locked'],
      [/MIRROR_IDENTITY_UNAVAILABLE|decryptString|decryption failed/i, 'mirror-key-unavailable'],
      [/Недостатньо товару|INSUFFICIENT_STOCK/i, 'insufficient-stock'],
      [/Картку вже змінено/i, 'stale-customer-card'],
      [/PRINT_QUEUE_STUCK|TSPL_QUEUE_STUCK/i, 'print-queue-stuck'],
      [/PRINT_PRINTER_NOT_READY|TSPL_PRINTER_NOT_READY/i, 'printer-not-ready'],
      [/PRINT_NOT_CONFIRMED|TSPL_PRINT_NOT_CONFIRMED|PRINT_OUTCOME_UNKNOWN/i, 'print-outcome-unknown'],
      [/RAW_PRINT_TIMEOUT|TSPL_PRINT_ABORTED|PRINT_GUARD_TIMEOUT/i, 'print-timeout'],
      [/RAW_PRINT_OPEN_FAILED|RAW_PRINT_WRITE_FAILED|RAW_PRINT_INCOMPLETE|RAW_PRINT_STARTDOC_FAILED|PRINT_GUARD_UNAVAILABLE/i, 'print-driver-error'],
      [/FOREIGN KEY constraint failed/i, 'foreign-key'], [/UNIQUE constraint failed/i, 'unique-constraint'],
      [/database is locked|SQLITE_BUSY/i, 'database-busy'], [/SQLITE_CORRUPT|database disk image is malformed/i, 'database-corrupt'],
      [/ENOSPC|disk full/i, 'disk-full'], [/EACCES|EPERM/i, 'file-permission'], [/ERR_FAILED/i, 'renderer-load-failed'],
      [/timed? ?out|ETIMEDOUT/i, 'timeout'],
    ] as const) {
      if (pattern.test(text)) { result.error_code = code; break }
    }
    if (value instanceof Error) {
      result.error_type = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'].includes(value.name) ? value.name : 'Error'
      result.frames = (value.stack ?? '').split('\n').slice(1, 9).flatMap(line => {
        const match = /(?:[/\\])([a-zA-Z0-9_.-]+\.(?:js|cjs|mjs|ts)):(\d+):(\d+)/.exec(line)
        return match ? [`${match[1]}:${match[2]}:${match[3]}`] : []
      })
    }
    return result
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, data] of Object.entries(value)) {
    if (numbers.has(key) && typeof data === 'number' && Number.isFinite(data)) result[key] = data
    else if (tokens.has(key) && typeof data === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(data)) result[key] = data
    else if (key === 'error') result.error = safeDiagnosticDetails(data)
  }
  return result
}

export function safeDiagnosticEvent(event: string): string {
  return /^[a-z][a-z0-9_.-]{0,79}$/.test(event) ? event : 'unknown-event'
}
