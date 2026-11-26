/**
 * Сигнал «прокинься» для головного ПК. Це лише прискорювач: каса й без нього сама питає сервер,
 * чи є для неї робота (див. tillLinkService). Тому транспорт сигналу можна замінити — на власному
 * сервері це буде довге з'єднання, — не чіпаючи ані касу, ані веб.
 * Зараз сигнал іде через Supabase Realtime, без даних у повідомленні.
 */
export type TillWake = (tenantId: string) => Promise<void>

export function tillWakeTopic(tenantId: string): string {
  return `till-rpc-${tenantId}`
}

export const wakeTill: TillWake = async tenantId => {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return
  await fetch(`${url}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ topic: tillWakeTopic(tenantId), event: 'wake', payload: {} }] }),
    // 27.11.2026: сигнал — лише прискорювач; під навантаженням він висів 3 с і стільки ж чекав кожен екран вебу.
    signal: AbortSignal.timeout(1000),
  }).catch(() => undefined)
}
