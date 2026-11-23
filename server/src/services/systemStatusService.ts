import { pool } from '../db/pg.js'

/**
 * 23.11.2026 (план T2 і T3).
 * T2 «Стан системи»: власник бачить у вебі те, що раніше було видно лише з журналів, — чи на зв'язку каса,
 * яка на ній версія, вікно чи фон, чи все передано на сервер, коли була остання копія бази, скільки місця на диску.
 * T3: помилки сервера записуються в базу. Журнал хостингу не завжди можна прочитати; помилку на кшталт
 * «FOR UPDATE … GROUP BY» 23.11 було видно лише в черзі каси.
 */

/** Каса вважається «на зв'язку», якщо озивалась не давніше за це (опитування — щопівхвилини). */
export const TILL_ONLINE_SECONDS = 120
const MODES = new Set(['window', 'background'])
const ROLES = new Set(['main', 'manager'])

const text = (value: unknown, max: number): string | null => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
const time = (value: unknown): string | null => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null
const size = (value: unknown): number | null => { const bytes = Number(value); return value !== null && value !== undefined && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null }

export type TillStatusReport = {
  version: string | null; release_id: string | null; built_at: string | null
  mode: 'window' | 'background'; role: 'main' | 'manager'
  disk_free_bytes: number | null; disk_total_bytes: number | null; database_bytes: number | null
  local_backup_at: string | null; cloud_backup_at: string | null; external_backup_at: string | null
  schema_version: number | null; started_at: string | null
  /** План T6: остання нічна перевірка бази каси. */
  check_at: string | null; check_findings: Array<{ code: string; title: string; count: number }>
  manager_release_id?: string | null; manager_seen_at?: string | null
}

/** Повідомлення каси приймається лише у відомому вигляді: зайве відкидається, неправильне — стає null. */
export function readStatusReport(raw: unknown): TillStatusReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  if (!MODES.has(String(input.mode)) || !ROLES.has(String(input.role))) return null
  const schema = Number(input.schema_version)
  return {
    version: text(input.version, 40), release_id: text(input.release_id, 80), built_at: time(input.built_at),
    mode: input.mode as 'window' | 'background', role: input.role as 'main' | 'manager',
    disk_free_bytes: size(input.disk_free_bytes), disk_total_bytes: size(input.disk_total_bytes), database_bytes: size(input.database_bytes),
    local_backup_at: time(input.local_backup_at), cloud_backup_at: time(input.cloud_backup_at), external_backup_at: time(input.external_backup_at),
    schema_version: Number.isSafeInteger(schema) && schema > 0 ? schema : null, started_at: time(input.started_at),
    check_at: time(input.check_at),
    check_findings: (Array.isArray(input.check_findings) ? input.check_findings as Array<Record<string, unknown>> : [])
      .filter(item => item && typeof item === 'object' && typeof item.code === 'string' && typeof item.title === 'string')
      .slice(0, 10).map(item => ({ code: String(item.code).slice(0, 60), title: String(item.title).slice(0, 120), count: Math.max(0, Math.trunc(Number(item.count)) || 0) })),
    // 23.11.2026 (план T7): збірка ПК менеджера й коли він востаннє звертався до головного ПК.
    manager_release_id: text(input.manager_release_id, 80), manager_seen_at: time(input.manager_seen_at),
  }
}

export async function saveStatusReport(tenantId: string, raw: unknown): Promise<boolean> {
  const report = readStatusReport(raw)
  if (!report) return false
  await pool.query('UPDATE till_presence SET status_report = $2::jsonb, status_reported_at = now() WHERE tenant_id = $1', [tenantId, JSON.stringify(report)])
  return true
}

// ─── T3: помилки сервера в базі ────────────────────────────────────────────────

export type ServerErrorInput = { tenantId?: string | null; source: 'request' | 'sync' | 'job'; route?: string | null; status?: number | null; code?: string | null; message: string }

/** Адреса без параметрів і без ідентифікаторів: «/api/v1/orders/:id», а не чийсь номер замовлення чи телефон. */
export function safeRoute(method: string | undefined, url: string | undefined): string | null {
  if (!url) return null
  const pathOnly = url.split('?')[0].split('#')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/(?:\+|%2B)?\d[\d+()\s-]{2,}(?=\/|$)/gi, '/:n')
    .replace(/\/[^/]{48,}(?=\/|$)/g, '/:long')
  return ((method ? method.toUpperCase() + ' ' : '') + pathOnly).slice(0, 200)
}

/** Технічний текст помилки без того, що схоже на особисті дані чи ключі. */
export function safeErrorText(message: unknown): string {
  return String(message ?? 'unknown error')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\d[\d\s()-]{8,}\d/g, '[number]')
    .replace(/(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|sk-[\w-]{16,}|[A-Za-z0-9_-]{40,})/g, '[secret]')
    .replace(/\s+/g, ' ').trim().slice(0, 500) || 'unknown error'
}

const REPEAT_WINDOW_MS = 10 * 60_000
const MAX_KEYS = 200
const recent = new Map<string, number>()
let lastPruneAt = 0

/** Та сама помилка за 10 хвилин — один запис із лічильником, а не сотня рядків. */
export function errorRepeatKey(input: ServerErrorInput): string {
  return [input.tenantId ?? '', input.source, input.route ?? '', input.code ?? '', safeErrorText(input.message).slice(0, 120)].join('|')
}

type Query = (sql: string, params: unknown[]) => Promise<unknown>

/**
 * Записати помилку. Ніколи не кидає й нічого не чекає від бази довше, ніж треба:
 * запис помилки не має зламати відповідь або створити другу помилку.
 */
export async function recordServerError(input: ServerErrorInput, query: Query = (sql, params) => pool.query(sql, params), now: () => number = Date.now): Promise<'inserted' | 'repeated' | 'failed'> {
  try {
    const key = errorRepeatKey(input)
    const at = now()
    const seen = recent.get(key)
    const message = safeErrorText(input.message)
    if (seen !== undefined && at - seen < REPEAT_WINDOW_MS) {
      await query(
        `UPDATE server_errors SET repeats = repeats + 1 WHERE id = (
           SELECT id FROM server_errors WHERE tenant_id IS NOT DISTINCT FROM $1 AND source = $2 AND route IS NOT DISTINCT FROM $3 AND message = $4
           ORDER BY created_at DESC LIMIT 1)`,
        [input.tenantId ?? null, input.source, input.route ?? null, message],
      )
      return 'repeated'
    }
    if (recent.size >= MAX_KEYS) recent.clear()
    recent.set(key, at)
    await query(
      'INSERT INTO server_errors (tenant_id, source, route, status, code, message) VALUES ($1, $2, $3, $4, $5, $6)',
      [input.tenantId ?? null, input.source, input.route ?? null, input.status ?? null, text(input.code, 80), message],
    )
    // Прибирання старого — рідко й тим самим шляхом: окремого завдання за розкладом не потрібно.
    if (at - lastPruneAt > 6 * 60 * 60_000) {
      lastPruneAt = at
      void query(`DELETE FROM server_errors WHERE created_at < now() - interval '30 days'`, []).catch(() => undefined)
    }
    return 'inserted'
  } catch { return 'failed' }
}

/** Лише для тестів. */
export function forgetServerErrors() { recent.clear(); lastPruneAt = 0 }

// ─── T2: відповідь для екрана «Стан системи» ───────────────────────────────────

export type SystemStatus = {
  server: { build: string | null; time: string }
  till: {
    seen_at: string | null; online: boolean; offline_minutes: number | null
    outbox: { waiting: number; oldest_at: string | null; error: string | null; reported_at: string | null } | null
    report: TillStatusReport | null; reported_at: string | null
  }
  errors: { last_day: number; rows: Array<{ created_at: string; source: string; route: string | null; code: string | null; message: string; repeats: number }> }
}

export function tillOnline(seenAt: string | Date | null | undefined, now: number): { online: boolean; offline_minutes: number | null } {
  if (!seenAt) return { online: false, offline_minutes: null }
  const age = now - new Date(seenAt).getTime()
  if (!Number.isFinite(age)) return { online: false, offline_minutes: null }
  const online = age < TILL_ONLINE_SECONDS * 1000
  return { online, offline_minutes: online ? 0 : Math.floor(age / 60_000) }
}

export async function readSystemStatus(tenantId: string, now: () => number = Date.now): Promise<SystemStatus> {
  const iso = (value: unknown) => value ? new Date(value as string).toISOString() : null
  // Кожна частина — окремо: якщо однієї таблиці чи колонки ще немає, решта екрана однаково показується.
  const presence = await pool.query('SELECT * FROM till_presence WHERE tenant_id = $1', [tenantId]).then(result => result.rows[0] ?? null, () => null)
  const errors = await pool.query(
    `SELECT created_at, source, route, code, message, repeats FROM server_errors
     WHERE (tenant_id = $1 OR tenant_id IS NULL) AND created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 30`, [tenantId],
  ).then(result => result.rows, () => [])
  const link = tillOnline(presence?.seen_at, now())
  return {
    server: { build: text(process.env.VERCEL_GIT_COMMIT_SHA, 40)?.slice(0, 8) ?? null, time: new Date(now()).toISOString() },
    till: {
      seen_at: iso(presence?.seen_at), ...link,
      outbox: presence && presence.outbox_reported_at ? {
        waiting: Number(presence.outbox_waiting) || 0, oldest_at: iso(presence.outbox_oldest_at),
        error: text(presence.outbox_error, 300), reported_at: iso(presence.outbox_reported_at),
      } : null,
      report: readStatusReport(presence?.status_report), reported_at: iso(presence?.status_reported_at),
    },
    errors: {
      last_day: errors.reduce((sum: number, row: { repeats?: number }) => sum + (Number(row.repeats) || 1), 0),
      rows: errors.map((row: Record<string, unknown>) => ({
        created_at: iso(row.created_at) ?? '', source: String(row.source), route: text(row.route, 200), code: text(row.code, 80),
        message: String(row.message ?? ''), repeats: Number(row.repeats) || 1,
      })),
    },
  }
}
