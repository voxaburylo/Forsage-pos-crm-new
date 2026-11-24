import { desktopBridge, isDesktopRuntime } from './desktopBridge'

/**
 * 24.11.2026 (власник: «прибери пароль у ШІ-помічнику, я не просив його додавати»).
 * На головному ПК працівник входить локальним паролем чи PIN, серверної сесії в нього немає — помічник просив
 * «пароль вашого акаунта». Тепер запит помічника передає сам головний ПК своїм ключем звʼязку: касу працівник уже
 * пройшов, другий пароль не потрібен. На ПК менеджера й у вебі ключа ПК немає — там усе, як було.
 * Ключ ШІ та його перевірка (/ai/config, /ai/test) цим шляхом не ходять: їх змінює власник зі своїм входом.
 */
export function isAssistantPath(path: string): boolean {
  // 24.11.2026: розділ «Сайт» власника ходить тим самим шляхом.
  if (/^\/api\/v1\/site-admin(?:\/|$)/.test(path)) return true
  // 24.11.2026: товари постачальників під замовлення й налаштування їх ключів — теж.
  if (/^\/api\/v1\/supplier-(?:offers|api)(?:\/|\?|$)/.test(path)) return true
  return /^\/api\/v1\/(?:ai|vin)\//.test(path) && !/^\/api\/v1\/ai\/(?:config|test)(?:[/?]|$)/.test(path)
}

type Answer = { status: number; content_type: string; text: string }

async function call(input: { method: string; path: string; body?: string }): Promise<Answer | null> {
  if (!isDesktopRuntime()) return null
  const send = desktopBridge()?.link?.assistant
  if (!send) return null
  try { return await send(input) } catch { return null }
}

/** Відповідь сервера через головний ПК у звичному вигляді; null — цим шляхом піти не можна (діє звичайний). */
export async function assistantThroughMainPc(path: string, method: string | undefined, body: unknown): Promise<Response | null> {
  if (!isAssistantPath(path)) return null
  const answer = await call({ method: (method ?? 'GET').toUpperCase(), path: path.slice('/api/v1'.length), body: typeof body === 'string' ? body : undefined })
  if (!answer || !Number.isInteger(answer.status) || answer.status < 200 || answer.status > 599) return null
  const empty = answer.status === 204 || answer.status === 304
  return new Response(empty ? null : answer.text, { status: answer.status, headers: { 'content-type': answer.content_type || 'application/json' } })
}

export const MAIN_PC_UPLOAD_MAX_BYTES = 12 * 1024 * 1024

/** Вкладення помічника (фото накладної, VIN) через головний ПК; null — цим шляхом піти не можна. */
export async function uploadThroughMainPc(blob: Blob, purpose: string, mimeType: string): Promise<{ path: string; mimeType: string } | null> {
  if ((purpose !== 'ai' && purpose !== 'vin') || !isDesktopRuntime() || !desktopBridge()?.link?.assistant) return null
  if (blob.size > MAIN_PC_UPLOAD_MAX_BYTES) throw new Error('Файл завеликий — максимум 12 МБ')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  const answer = await call({ method: 'POST', path: '/assistant-upload', body: JSON.stringify({ purpose, mime_type: mimeType, data_base64: btoa(binary) }) })
  if (!answer) return null
  let parsed: { data?: { path?: unknown; mimeType?: unknown }; error?: { message?: string } } | null = null
  try { parsed = JSON.parse(answer.text) } catch { /* нижче */ }
  if (answer.status !== 200 || typeof parsed?.data?.path !== 'string') {
    // Ключ ПК не прийнято — нехай спрацює звичайний шлях (сесія працівника), а не глуха помилка.
    if (answer.status === 401) return null
    throw new Error(parsed?.error?.message || 'Не вдалося підготувати файл. Перевірте інтернет і повторіть.')
  }
  return { path: parsed.data.path, mimeType: typeof parsed.data.mimeType === 'string' ? parsed.data.mimeType : mimeType }
}
