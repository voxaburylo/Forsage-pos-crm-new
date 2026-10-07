import { createHash } from 'node:crypto'
import type { Bindings, ChildLoggerOptions, Logger, LoggerOptions } from 'pino'
import { safeUnhandledErrorInfo } from './safeErrorInfo.js'

const metrics = [
  'accepted', 'actions', 'added', 'ageMs', 'amount', 'amountKopecks', 'attempt',
  'attempts', 'cancelled', 'candidates', 'cardAmount', 'claimed', 'closed', 'closedCount',
  'count', 'daysOverdue', 'daysReady', 'failed', 'imageIndex', 'itemCount', 'iter',
  'length', 'linked', 'maxAttempts', 'notFound', 'processed', 'products', 'releasedReservesCount',
  'responseChars', 'retryInSeconds', 'row', 'rowCount', 'skuUpdated', 'totalKopecks',
  'pid', 'port', 'duration_ms',
]
const correlations = [
  'candidateId', 'channelId', 'chatId', 'customerId', 'entityId', 'entryId', 'existingProductId',
  'fileId', 'idempotencyKey', 'importId', 'jobId', 'orderId', 'ownerUserId', 'paymentRef',
  'previousProductId', 'productId', 'saleId', 'supplierId', 'targetUserId', 'tenantId',
  'userId', 'workerId', 'shift_id', 'ref', 'saleNumber',
  'action', 'eventType', 'field', 'jobType', 'mode', 'namespace', 'platform', 'provider', 'queue', 'type',
]
const enums: Record<string, readonly string[]> = {
  category: ['unknown', 'quota', 'access', 'timeout', 'network', 'database', 'validation', 'upstream'],
  error_type: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'],
  status: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'ok', 'error', 'success'],
  nextStatus: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
  newStatus: ['new', 'confirmed', 'ordered', 'arrived', 'ready', 'completed', 'cancelled', 'processing'],
  model: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'other'],
  finishReason: ['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'UNKNOWN'],
  code: ['AI_PROCESSING_CLEANUP_FAILED'],
}
const errorKeys = ['error', 'err', 'reason', 'cancelError']
const fingerprintPattern = /^[a-f0-9]{20}$/
function own(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== 'object') return undefined
    const property = Object.getOwnPropertyDescriptor(value, key)
    return property && 'value' in property ? property.value : undefined
  } catch { return undefined }
}
function safeError(value: unknown) {
  const category = own(value, 'category'), fingerprint = own(value, 'fingerprint')
  if (typeof category === 'string' && enums.category.includes(category)) {
    const status = own(value, 'status'), type = own(value, 'error_type')
    return { category,
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
      ...(typeof type === 'string' && enums.error_type.includes(type) ? { error_type: type } : {}),
      ...(typeof fingerprint === 'string' && fingerprintPattern.test(fingerprint) ? { fingerprint } : {}),
    }
  }
  return safeUnhandledErrorInfo(value)
}

/** No documents, arbitrary nesting, accessors or toJSON may reach the serializer. */
export function safeLogData(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of metrics) {
    const data = own(value, key)
    if (typeof data === 'number' && Number.isFinite(data)) result[key] = data
  }
  for (const key of ['isFatal', 'hasJsonObject']) {
    const data = own(value, key)
    if (typeof data === 'boolean') result[key] = data
  }
  for (const [key, allowed] of Object.entries(enums)) {
    const data = own(value, key)
    if (typeof data === 'string' && allowed.includes(data)) result[key] = data
    else if (key === 'status' && typeof data === 'number' && Number.isInteger(data) && data >= 100 && data <= 599) result[key] = data
  }
  for (const key of correlations) {
    const data = own(value, key), fingerprint = own(value, key + '_fingerprint')
    if (typeof data === 'string' || typeof data === 'number' && Number.isFinite(data)) {
      result[key + '_fingerprint'] = createHash('sha256').update(String(data).slice(0, 8192)).digest('hex').slice(0, 20)
    } else if (typeof fingerprint === 'string' && fingerprintPattern.test(fingerprint)) result[key + '_fingerprint'] = fingerprint
  }
  const fingerprint = own(value, 'fingerprint')
  if (typeof fingerprint === 'string' && fingerprintPattern.test(fingerprint)) result.fingerprint = fingerprint
  for (const key of errorKeys) {
    const error = own(value, key)
    if (error !== undefined) result[key] = safeError(error)
  }
  return result
}

/** Pino's fast child path bypasses formatters.bindings without child options. */
export function protectLoggerChildren(logger: Logger): Logger {
  const child = logger.child<never>
  const setBindings = logger.setBindings
  function protect(current: Logger): Logger {
    const protectedChild = function (this: Logger, bindings: Bindings, options?: ChildLoggerOptions) {
      return protect(child.call(this, safeLogData(bindings), {
        ...options, formatters: { bindings: safeLogData, log: safeLogData }, msgPrefix: undefined,
      }))
    }
    // Child custom levels still come from Pino; only bindings/formatters are wrapped.
    current.child = protectedChild as unknown as Logger['child']
    current.setBindings = function (bindings) { setBindings.call(this, safeLogData(bindings)) }
    return current
  }
  return protect(logger)
}

/** Static messages are enforced by loggerCallsites.test.ts; interpolation is disabled. */
export const privateLogOptions: Pick<LoggerOptions, 'hooks' | 'formatters'> = {
  formatters: { bindings: safeLogData, log: safeLogData },
  hooks: {
    logMethod(args, method) {
      try {
        const first = args[0]
        let data: Record<string, unknown>
        try { data = first instanceof Error ? { error: safeUnhandledErrorInfo(first) } : safeLogData(first) }
        catch { data = {} }
        const message = typeof first === 'string' ? first
          : typeof args[1] === 'string' ? args[1] : 'Application diagnostic'
        // Pass only controlled metadata and the literal message. No format args.
        return method.apply(this, [data, message.slice(0, 500).replace(/[\r\n]/g, ' ')])
      } catch {
        // Diagnostics must not replace a successful business result with a logger failure.
      }
    },
  },
}
