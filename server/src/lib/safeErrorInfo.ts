import { createHash } from 'node:crypto'

function field(value: unknown, key: string): unknown {
  try {
    let current = value
    for (let depth = 0; current && typeof current === 'object' && depth < 3; depth++) {
      const property = Object.getOwnPropertyDescriptor(current, key)
      if (property) return 'value' in property ? property.value : undefined
      current = Object.getPrototypeOf(current)
    }
  } catch { /* A hostile error must not break diagnostics. */ }
  return undefined
}
function textField(value: unknown, key: string): string {
  const item = field(value, key)
  return typeof item === 'string' ? item.slice(0, 8192) : ''
}

/** Only finite categories and HTTP statuses may leave the error boundary. */
export function safeErrorInfo(error: unknown): { category: string; status?: number } {
  const rawStatus = field(error, 'status')
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus)
    && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined
  const message = typeof error === 'string' ? error.slice(0, 8192) : textField(error, 'message')
  const code = textField(error, 'code')
  let category = 'unknown'
  if (status === 429 || /\b429\b|quota|rate limit|resource_exhausted/i.test(message)) category = 'quota'
  else if (status === 401 || status === 403 || /\b401\b|\b403\b|api.?key|permission|unauth/i.test(message)) category = 'access'
  else if (status === 504 || /timeout|timed out|deadline/i.test(message) || code === 'AI_TIMEOUT') category = 'timeout'
  else if (/network|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang/i.test(message)) category = 'network'
  else if (code === 'DB_ERROR' || /^(?:PGRST\d{3}|\d{5})$/.test(code)) category = 'database'
  else if (status === 400 || status === 422 || code === 'VALIDATION_ERROR') category = 'validation'
  else if (status !== undefined && status >= 500 || /\b50[0-9]\b|overload|unavailable/i.test(message)) category = 'upstream'
  return { category, ...(status === undefined ? {} : { status }) }
}

/** Group repeated failures without storing provider text, documents, credentials or full stacks. */
export function safeUnhandledErrorInfo(error: unknown): ReturnType<typeof safeErrorInfo> & { error_type: string; fingerprint: string } {
  const name = textField(error, 'name')
  const error_type = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'].includes(name) ? name : 'Error'
  const message = typeof error === 'string' ? error.slice(0, 8192) : textField(error, 'message')
  const identity = JSON.stringify([error_type, message, textField(error, 'stack')])
  return { ...safeErrorInfo(error), error_type, fingerprint: createHash('sha256').update(identity).digest('hex').slice(0, 20) }
}
