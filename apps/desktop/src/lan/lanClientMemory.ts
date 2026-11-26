import type { LocalDatabase } from '../db/localDatabase'

/**
 * 26.11.2026 (план T7): головний ПК памʼятав версію ПК менеджера лише до свого перезапуску — після оновлення каси
 * «Стан системи» показував «ще не звертався». Тепер остання побачена версія зберігається в app_meta: видно, яка
 * програма стоїть на ПК менеджера й коли він звертався востаннє, навіть якщо сьогодні його ще не вмикали.
 */
export interface LanClientSeen { release_id: string | null; seen_at: string }
const KEY = 'lan-manager-client:v1'

function valid(value: unknown): LanClientSeen | null {
  const row = value as { release_id?: unknown; seen_at?: unknown } | null
  if (!row || typeof row.seen_at !== 'string' || Number.isNaN(Date.parse(row.seen_at))) return null
  const release = typeof row.release_id === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(row.release_id) ? row.release_id : null
  return { release_id: release, seen_at: new Date(row.seen_at).toISOString() }
}

/** Свіже з памʼяті — записати (якщо змінилось); немає свіжого — віддати збережене. */
export function rememberedManagerClient(db: LocalDatabase, fresh: unknown): LanClientSeen | null {
  const now = valid(fresh)
  const stored = (() => {
    const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(KEY) as { value_json: string } | undefined
    try { return row ? valid(JSON.parse(row.value_json)) : null } catch { return null }
  })()
  if (!now) return stored
  if (!stored || stored.release_id !== now.release_id || stored.seen_at !== now.seen_at) {
    db.prepare(`INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(KEY, JSON.stringify(now), new Date().toISOString())
  }
  return now
}
