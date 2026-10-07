import { AppError } from '../middleware/errorHandler.js'

const FINISH_REASONS = new Set([
  'STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER',
  'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL',
])
const BLOCKED_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'])

/** Provider text, errors and URLs can contain document data or credentials. */
export function safeAiFinishReason(value: unknown): string {
  return typeof value === 'string' && FINISH_REASONS.has(value) ? value : 'UNKNOWN'
}

export function aiResponseCompletionError(response: {
  candidates?: { finishReason?: unknown }[]
  promptFeedback?: { blockReason?: unknown }
}, allowMalformedToolRecovery = false): AppError | undefined {
  const reasons = (response.candidates ?? []).map(candidate => candidate.finishReason)
  const blockReason = response.promptFeedback?.blockReason
  if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED'
    || reasons.some(reason => BLOCKED_REASONS.has(String(reason)))) {
    return new AppError('AI_RESPONSE_BLOCKED',
      'Сервіс ШІ заблокував відповідь. Дані не збережено. Перевірте вкладення й повторіть розбір.', 422)
  }
  if (reasons.includes('MAX_TOKENS')) {
    return new AppError('AI_RESPONSE_TOO_LARGE',
      'Відповідь ШІ обірвалася через обсяг даних. Неповну таблицю не прийнято. Розділіть документ на менші частини.', 422)
  }
  if (reasons.some(reason => reason != null && reason !== '' && reason !== 'STOP'
    && !(allowMalformedToolRecovery && reason === 'MALFORMED_FUNCTION_CALL'))) {
    return new AppError('AI_INVALID_RESPONSE',
      'Сервіс ШІ не підтвердив завершення відповіді. Неповну пропозицію не прийнято; повторіть розбір.', 422)
  }
  return undefined
}

export function isAiIncompleteResponseError(error: unknown): error is AppError {
  return error instanceof AppError && ['AI_RESPONSE_TOO_LARGE', 'AI_RESPONSE_BLOCKED', 'AI_INVALID_RESPONSE'].includes(error.code)
}

export { safeErrorInfo as safeAiErrorInfo } from '../lib/safeErrorInfo.js'
