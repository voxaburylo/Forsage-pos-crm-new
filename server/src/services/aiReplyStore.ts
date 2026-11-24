import { db } from '../db/supabase.js'
import { AI_MEMORY_BUCKET } from './aiMemoryService.js'

/**
 * 24.11.2026 (власник: «у веб-версії, якщо згорнути браузер або вийти з вкладки помічника, він перестає працювати»).
 * Відповідь помічника приходила лише в те саме зʼєднання. Телефон, згортаючи браузер, рве його; вихід із вкладки
 * закривав екран — готову (уже оплачену) відповідь ніхто не забирав. Тепер сервер кладе готову відповідь у приватне
 * сховище помічника за номером запиту, а екран, повернувшись, забирає її. Номер запиту — випадковий UUID від екрана;
 * читати відповідь може лише той самий користувач того самого магазину. Відповіді старші за добу прибираються.
 */
export const AI_REPLY_TTL_MS = 24 * 60 * 60 * 1000
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isAiRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value)
}

function folder(tenantId: string, userId: string) { return `${tenantId}/replies/${userId}` }
export function aiReplyPath(tenantId: string, userId: string, requestId: string) {
  if (!isAiRequestId(requestId)) throw new Error('bad request id')
  return `${folder(tenantId, userId)}/${requestId}.json`
}

export type StoredAiReply = { data?: unknown; error?: { code: string; message: string; status: number }; saved_at: string }

/** Не кидає: якщо зберегти не вдалось, відповідь усе одно йде у звичайне зʼєднання. */
export async function saveAiReply(tenantId: string, userId: string, requestId: string, reply: Omit<StoredAiReply, 'saved_at'>): Promise<boolean> {
  try {
    const body = JSON.stringify({ ...reply, saved_at: new Date().toISOString() })
    const { error } = await db.storage.from(AI_MEMORY_BUCKET)
      .upload(aiReplyPath(tenantId, userId, requestId), body, { contentType: 'application/json', upsert: true })
    void pruneAiReplies(tenantId, userId).catch(() => {})
    return !error
  } catch { return false }
}

/** null — відповіді ще немає (помічник думає або запит не дійшов). */
export async function readAiReply(tenantId: string, userId: string, requestId: string): Promise<StoredAiReply | null> {
  const { data, error } = await db.storage.from(AI_MEMORY_BUCKET).download(aiReplyPath(tenantId, userId, requestId))
  if (error || !data) return null
  try {
    const parsed = JSON.parse(await data.text()) as StoredAiReply
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

export async function pruneAiReplies(tenantId: string, userId: string, now = Date.now()): Promise<void> {
  const { data } = await db.storage.from(AI_MEMORY_BUCKET).list(folder(tenantId, userId), { limit: 200 })
  const old = (data ?? []).filter(file => {
    const created = Date.parse(String(file.created_at ?? ''))
    return Number.isFinite(created) && now - created > AI_REPLY_TTL_MS
  }).map(file => `${folder(tenantId, userId)}/${file.name}`)
  if (old.length) await db.storage.from(AI_MEMORY_BUCKET).remove(old)
}
