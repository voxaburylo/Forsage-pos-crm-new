import { pool } from '../db/pg.js'

/**
 * 26.11.2026, слово власника: «на будь-якому пристрої однаковий чат — щоб не було на телефоні у вебі один,
 * а на компʼютері інший». Раніше чат жив лише в памʼяті браузера кожного пристрою. Тепер стан чату (репліки,
 * відмітки «застосовано») зберігається на сервері для кожного користувача; пристрій бере новіший.
 * Відповідь, яку сервер дорахував, коли телефон уже згорнули, сервер сам дописує в цей чат — її видно й на ПК.
 */
export type ChatKind = 'assistant' | 'invoice'
export const CHAT_MAX_ENTRIES = 80
/** Стан чату не може бути безрозмірним: фото в репліках не зберігаються, лише текст і пропозиції. */
export const CHAT_MAX_BYTES = 2 * 1024 * 1024

type Entry = { role: string; text: string; rid?: string; [key: string]: unknown }
export type ChatState = { entries?: Entry[]; applied?: Record<string, unknown>; applyMsg?: Record<string, unknown>; applyStatus?: Record<string, unknown>; applyErrors?: Record<string, unknown>; savedAt?: number }

export function cleanChatState(raw: unknown): ChatState {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const object = (item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
  const entries = (Array.isArray(value.entries) ? value.entries : [])
    .filter((entry): entry is Entry => Boolean(entry) && typeof entry === 'object' && ['user', 'model'].includes((entry as Entry).role) && typeof (entry as Entry).text === 'string')
    .slice(-CHAT_MAX_ENTRIES)
  return { entries, applied: object(value.applied), applyMsg: object(value.applyMsg), applyStatus: object(value.applyStatus), applyErrors: object(value.applyErrors), savedAt: Number(value.savedAt) || 0 }
}

export async function readChat(tenantId: string, userId: string, kind: ChatKind): Promise<ChatState | null> {
  const { rows } = await pool.query('SELECT state, saved_at FROM ai_chats WHERE tenant_id = $1 AND user_id = $2 AND kind = $3', [tenantId, userId, kind])
  if (!rows[0]) return null
  return { ...cleanChatState(rows[0].state), savedAt: Number(rows[0].saved_at) || 0 }
}

/** Записує, лише якщо стан новіший за збережений; інакше повертає збережений (пристрій візьме його). */
export async function writeChat(tenantId: string, userId: string, kind: ChatKind, raw: unknown): Promise<{ accepted: boolean; state: ChatState | null }> {
  const state = cleanChatState(raw)
  const body = JSON.stringify(state)
  if (Buffer.byteLength(body, 'utf8') > CHAT_MAX_BYTES) return { accepted: false, state: await readChat(tenantId, userId, kind) }
  const { rowCount } = await pool.query(
    `INSERT INTO ai_chats (tenant_id, user_id, kind, state, saved_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, now())
     ON CONFLICT (tenant_id, user_id, kind) DO UPDATE SET state = EXCLUDED.state, saved_at = EXCLUDED.saved_at, updated_at = now()
      WHERE ai_chats.saved_at < EXCLUDED.saved_at`, [tenantId, userId, kind, body, state.savedAt ?? 0])
  return rowCount ? { accepted: true, state: null } : { accepted: false, state: await readChat(tenantId, userId, kind) }
}

/**
 * Сервер дорахував відповідь (номер запиту rid). Якщо в чаті цієї відповіді ще немає — дописує питання (якщо його
 * теж немає) і відповідь. Повтори за тим самим rid нічого не додають.
 */
export function appendReply(state: ChatState | null, rid: string, question: string, reply: Record<string, unknown>, now = Date.now()): ChatState | null {
  const current = cleanChatState(state ?? {})
  const entries = current.entries ?? []
  if (entries.some(entry => entry.rid === rid && entry.role === 'model')) return null
  const next = [...entries]
  if (!next.some(entry => entry.rid === rid && entry.role === 'user')) next.push({ role: 'user', text: question, rid })
  next.push({ ...reply, role: 'model', text: String(reply.text ?? ''), rid })
  return { ...current, entries: next.slice(-CHAT_MAX_ENTRIES), savedAt: Math.max(now, (current.savedAt ?? 0) + 1) }
}

export async function appendReplyToChat(tenantId: string, userId: string, kind: ChatKind, rid: string, question: string, reply: Record<string, unknown>): Promise<void> {
  const next = appendReply(await readChat(tenantId, userId, kind), rid, question, reply)
  if (next) await writeChat(tenantId, userId, kind, next)
}
