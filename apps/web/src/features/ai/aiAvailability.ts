export interface AiAvailabilityProblem { kind: 'session' | 'access' | 'network' | 'timeout' | 'server'; message: string }
export function aiAvailabilityProblem(error: unknown, depth = 0): AiAvailabilityProblem {
  const value = error as { status?: number; code?: string; message?: string; cause?: unknown } | null
  if (depth < 3 && value?.cause && value.cause !== error) return aiAvailabilityProblem(value.cause, depth + 1)
  if (value?.status === 401 || value?.code === 'DESKTOP_SERVER_AUTH_REQUIRED'
    || /Серверна сесія ще не відновлена|Необхідна авторизація|Сесія закінчилась/.test(value?.message ?? ''))
    return { kind: 'session', message: 'Локальний вхід працює, але для ШІ потрібне підключення акаунта до сервера. Вкладення збережені в цьому вікні.' }
  if (value?.status === 403) return { kind: 'access', message: 'Сервер не дозволив цьому акаунту користуватися ШІ. Зверніться до власника; локальна програма продовжує працювати.' }
  if (value?.code === 'PROCESSING_TIMEOUT' || value?.code === 'AI_TIMEOUT' || value?.status === 504
    || /не відповів вчасно|timeout/i.test(value?.message ?? '')) return { kind: 'timeout', message: 'ШІ не завершив операцію вчасно. Спробуйте ще раз; вкладення залишилися в цьому вікні.' }
  if (typeof navigator !== 'undefined' && navigator.onLine === false
    || /Сервер недоступний|failed to fetch|network|offline/i.test(value?.message ?? ''))
    return { kind: 'network', message: 'Немає зв’язку із сервером ШІ. Перевірте мережу або повторіть пізніше. Локальний розбір Excel працює без інтернету.' }
  return { kind: 'server', message: 'Сервер не зміг перевірити налаштування ШІ. Це не означає, що зник інтернет. Спробуйте ще раз або повідомте власника.' }
}
