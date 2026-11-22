/**
 * Копія даних, які живуть лише в хмарі (22.11.2026): лист очікування, сповіщення, канали й листування,
 * посилання на прайс, пороги тривог, правила помічника. Хмарна база на безкоштовному тарифі сама не копіюється,
 * тому головний ПК раз на добу забирає ці дані й кладе у власну базу (app_meta) — так вони потрапляють у кожну
 * копію бази: на диску, на флешці й у хмарному сховищі. Робочі дані каси це не чіпає.
 * Ключів і паролів сторонніх служб у цих даних немає (сервер їх не віддає).
 */
export const SERVER_DATA_KEY = 'server_only_data'
/** Раз на добу з запасом: каса працює не цілодобово. */
export const SERVER_DATA_EVERY_MS = 20 * 60 * 60_000
/** Дані службові й малі; більше — ознака помилки, у базу не кладемо. */
export const SERVER_DATA_MAX_BYTES = 4 * 1024 * 1024

interface MetaDatabase {
  prepare(sql: string): { get(...values: unknown[]): unknown; run(...values: unknown[]): unknown }
}

export function serverDataDue(db: MetaDatabase, now: Date): boolean {
  const row = db.prepare('SELECT updated_at FROM app_meta WHERE key = ?').get(SERVER_DATA_KEY) as { updated_at?: string } | undefined
  const last = row?.updated_at ? Date.parse(row.updated_at) : NaN
  return !Number.isFinite(last) || now.getTime() - last >= SERVER_DATA_EVERY_MS
}

/** Зберігає копію; порожню, чужого вигляду чи завелику відповідь не приймає й стару копію не затирає. */
export function storeServerData(db: MetaDatabase, payload: unknown, now: Date): { stored: boolean; bytes: number; reason?: string } {
  const data = payload as { version?: unknown; tables?: unknown; exported_at?: unknown } | null
  if (!data || typeof data !== 'object' || data.version !== 1 || !data.tables || typeof data.tables !== 'object' || Array.isArray(data.tables)
    || typeof data.exported_at !== 'string') return { stored: false, bytes: 0, reason: 'unexpected-shape' }
  const json = JSON.stringify(data)
  const bytes = Buffer.byteLength(json)
  if (bytes > SERVER_DATA_MAX_BYTES) return { stored: false, bytes, reason: 'too-large' }
  db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at')
    .run(SERVER_DATA_KEY, json, now.toISOString())
  return { stored: true, bytes }
}
