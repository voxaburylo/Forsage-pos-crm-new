import { createHash } from 'node:crypto'

const numbers = new Set(['duration_ms', 'lag_ms', 'rss_mb', 'pid', 'exitCode', 'attempt', 'attempts', 'sequence', 'dropped', 'schemaVersion'])
const tokens = new Set(['channel', 'role', 'reason', 'type', 'version', 'build', 'release', 'builtAt', 'electron', 'node', 'platform', 'arch', 'status', 'section', 'serviceName'])

const errorTypes = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError']
const errorPatterns = [
  [/AI_SUPPLY_RESPONSE_INVALID/, 'ai-supply-response-invalid'],
  [/AI_SUPPLY_TEXT_NO_TABLE/, 'ai-supply-text-no-table'],
  [/AI_SUPPLY_PHOTO_NO_TABLE/, 'ai-supply-photo-no-table'],
  [/AI_STATUS_SESSION/, 'ai-session-required'],
  [/AI_STATUS_ACCESS/, 'ai-access-denied'],
  [/AI_STATUS_NETWORK/, 'ai-network-unavailable'],
  [/AI_STATUS_TIMEOUT/, 'ai-status-timeout'],
  [/AI_STATUS_SERVER/, 'ai-status-server-error'],
  [/AI_PROCESSING_CLEANUP_FAILED/, 'ai-processing-cleanup-failed'],
  [/AI_COMMITTED_CHECKPOINT_UNAVAILABLE/, 'ai-committed-checkpoint-unavailable'],
  [/AI_COMMITTED_DRAFT_VIEW_UNAVAILABLE/, 'ai-committed-draft-view-unavailable'],
  [/Програму заблоковано|LOCAL_SESSION_LOCKED/i, 'session-locked'],
  [/LOCAL_SALE_INVALID_|LOCAL_SALE_PAYMENT_MISMATCH/i, 'invalid-sale-input'],
  [/LOCAL_BACKUP_(CORRUPT|MISSING_TABLE|BROKEN_REFERENCES|INVALID_SCHEMA|NOT_FORSAGE)/i, 'backup-validation-failed'],
  [/LOCAL_ASYNC_TRANSACTION_FORBIDDEN/i, 'invalid-transaction'],
  [/MIRROR_IDENTITY_UNAVAILABLE|decryptString|decryption failed/i, 'mirror-key-unavailable'],
  [/Недостатньо товару|INSUFFICIENT_STOCK/i, 'insufficient-stock'],
  [/Картку вже змінено/i, 'stale-customer-card'],
  [/PRINT_DOCUMENT_LOAD_FAILED|PRINT_SESSION_REQUIRED/i, 'print-document-load-failed'],
  [/PRINT_RUNTIME_FILES_MISSING/i, 'print-runtime-files-missing'],
  [/PRINT_RENDER_TIMEOUT|PRINT_RESOURCES_TIMEOUT|TSPL_(RENDER|SCRIPT|CAPTURE|STYLE|RESOURCES|COLLECT|PREPARE_PAGE)_TIMEOUT/i, 'print-render-timeout'],
  [/PRINT_QUEUE_STUCK|TSPL_QUEUE_STUCK/i, 'print-queue-stuck'],
  [/PRINT_PRINTER_NOT_READY|TSPL_PRINTER_NOT_READY/i, 'printer-not-ready'],
  [/PRINT_NOT_CONFIRMED|TSPL_PRINT_NOT_CONFIRMED|PRINT_OUTCOME_UNKNOWN/i, 'print-outcome-unknown'],
  [/RAW_PRINT_TIMEOUT|TSPL_PRINT_ABORTED|PRINT_GUARD_TIMEOUT/i, 'print-timeout'],
  [/RAW_PRINT_OPEN_FAILED|RAW_PRINT_WRITE_FAILED|RAW_PRINT_INCOMPLETE|RAW_PRINT_STARTDOC_FAILED|PRINT_GUARD_UNAVAILABLE/i, 'print-driver-error'],
  [/FOREIGN KEY constraint failed/i, 'foreign-key'], [/UNIQUE constraint failed/i, 'unique-constraint'],
  [/database is locked|SQLITE_BUSY/i, 'database-busy'], [/SQLITE_CORRUPT|database disk image is malformed/i, 'database-corrupt'],
  [/ENOSPC|disk full/i, 'disk-full'], [/EACCES|EPERM/i, 'file-permission'], [/ERR_FAILED/i, 'renderer-load-failed'],
  [/timed? ?out|ETIMEDOUT/i, 'timeout'],
] as const
const errorCodes = new Set<string>(errorPatterns.map(([, code]) => code))

// Never accept arbitrary messages, arguments, results, URLs, SQL or entity IDs.
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get

function dataField(value: unknown, key: string): unknown {
  try {
    let current = value
    for (let depth = 0; current && typeof current === 'object' && depth < 3; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor) {
        if ('value' in descriptor) return descriptor.value
        // Node 24 exposes even an assigned Error.stack through its native getter.
        // Never invoke arbitrary accessors supplied by an exception/payload.
        if (key === 'stack' && nativeStackGetter && descriptor.get === nativeStackGetter
          && value instanceof Error
          && typeof dataField(value, 'message') === 'string'
          && typeof dataField(value, 'name') === 'string') return nativeStackGetter.call(value)
        return undefined
      }
      current = Object.getPrototypeOf(current)
    }
  } catch { /* Diagnostics must tolerate broken Error objects. */ }
  return undefined
}
const boundedText = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : ''

export function safeDiagnosticDetails(value: unknown): Record<string, unknown> {
  try { return collectDetails(value, 0, new WeakSet()) }
  catch { return { error_code: 'diagnostic-data-unreadable' } }
}
function collectDetails(value: unknown, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (depth > 3) return result
  if (value && typeof value === 'object') {
    if (seen.has(value)) return result
    seen.add(value)
  }
  if (value instanceof Error || typeof value === 'string') {
    const name = boundedText(dataField(value, 'name'), 64)
    const stack = boundedText(dataField(value, 'stack'), 4096)
    const text = (value instanceof Error ? name + '\n' + boundedText(dataField(value, 'message'), 4096) + '\n' + stack : value).slice(0, 8192)
    result.fingerprint = createHash('sha256').update(text).digest('hex').slice(0, 20)
    for (const [pattern, code] of errorPatterns) {
      if (pattern.test(text)) { result.error_code = code; break }
    }
    const aiOperation = /\bAI_OPERATION_(FILE|CLIPBOARD|RECOGNITION|WRITE)_(SESSION|ACCESS|NETWORK|TIMEOUT|SERVER|VALIDATION)\b/.exec(text)
    if (aiOperation) result.error_code = 'ai-' + aiOperation[1].toLowerCase() + '-' + aiOperation[2].toLowerCase()
    if (value instanceof Error) {
      result.error_type = errorTypes.includes(name) ? name : 'Error'
      result.frames = stack.split('\n').slice(1, 9).flatMap(line => {
        const match = /(?:[/\\])([a-zA-Z0-9_.-]+\.(?:js|cjs|mjs|ts)):(\d+):(\d+)/.exec(line)
        return match ? [`${match[1]}:${match[2]}:${match[3]}`] : []
      })
    }
    return result
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const key of numbers) {
    const data = dataField(value, key)
    if (typeof data === 'number' && Number.isFinite(data)) result[key] = data
  }
  for (const key of tokens) {
    const data = dataField(value, key)
    if (typeof data === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(data)) result[key] = data
  }
  // Keep only validated error identifiers when reading an already sanitized record.
  // Raw SDK objects must not smuggle free-form messages into these fields.
  const fingerprint = dataField(value, 'fingerprint')
  if (typeof fingerprint === 'string' && /^[a-f0-9]{20}$/.test(fingerprint)) result.fingerprint = fingerprint
  const errorCode = dataField(value, 'error_code')
  if (typeof errorCode === 'string' && (errorCodes.has(errorCode)
    || /^ai-(file|clipboard|recognition|write)-(session|access|network|timeout|server|validation)$/.test(errorCode))) result.error_code = errorCode
  const errorType = dataField(value, 'error_type')
  if (typeof errorType === 'string' && errorTypes.includes(errorType)) result.error_type = errorType
  const error = dataField(value, 'error')
  if (error !== undefined) result.error = collectDetails(error, depth + 1, seen)
  return result
}

export function safeDiagnosticEvent(event: string): string {
  return /^[a-z][a-z0-9_.-]{0,79}$/.test(event) ? event : 'unknown-event'
}
