const IPC_PREFIX = /^Error invoking remote method ['"][^'"]+['"]:\s*/i

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '')
}

export function localizeDesktopIpcError(error: unknown): Error {
  let message = rawMessage(error).trim()

  // This marker is part of the fiscal recovery protocol. Keep it byte-for-byte
  // from the marker onwards so the renderer can offer the recovery flow.
  const fiscalMarker = message.indexOf('FISCAL_INTENT_UNKNOWN|')
  if (fiscalMarker >= 0) return new Error(message.slice(fiscalMarker))

  const pendingReturnMarker = 'FISCAL_RETURN_PENDING|'
  const pendingReturnAt = message.indexOf(pendingReturnMarker)
  if (pendingReturnAt >= 0) {
    const visibleMessage = message.slice(pendingReturnAt + pendingReturnMarker.length).trim()
    return new Error(visibleMessage || 'Є незавершене фіскальне повернення')
  }

  message = message.replace(IPC_PREFIX, '').replace(/^Error:\s*/i, '').trim()
  const lower = message.toLowerCase()

  if (lower.includes('foreign key constraint failed')) {
    return new Error('Не вдалося зберегти зміни: пов’язаний запис не знайдено. Оновіть дані та повторіть.')
  }
  if (lower.includes('unique constraint failed') || lower.includes('constraint unique')) {
    return new Error('Такий запис уже існує. Перевірте введені дані.')
  }
  if (
    lower.includes('sqlite_busy') ||
    lower.includes('database is locked') ||
    lower.includes('database table is locked')
  ) {
    return new Error('Локальна база зараз зайнята іншою операцією. Зачекайте кілька секунд і повторіть.')
  }

  return new Error(message || 'Не вдалося виконати локальну операцію')
}
