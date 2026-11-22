import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { RequestListener } from 'node:http'
import { pool } from '../db/pg.js'
import { logger } from '../lib/logger.js'
import { SELF_CHECK_HEADER, closeSelfCheckPass, openSelfCheckPass } from './selfCheckAccess.js'
import { sendOwnerTelegram } from './ownerAlertService.js'

/**
 * Самоперевірка сервера (22.11.2026).
 *
 * Того дня «помилку сервера» у вебі знайшов власник із телефона: запит звертався до стовпця, якого немає
 * в справжній базі, а тести цього не бачили — вони працюють на маленьких саморобних таблицях.
 * Тепер сервер сам, після кожної публікації і раз на три години, відкриває всі свої адреси читання (GET)
 * на справжній базі від імені власника й дивиться, чи жодна не відповідає «внутрішньою помилкою» (500).
 * Список адрес береться із самого сервера, тож нова сторінка потрапляє в перевірку без жодних списків.
 * Перевірка лише читає. Про збій — повідомлення власнику в Telegram і запис у server_self_check.
 */
export const SELF_CHECK_EVERY_MS = 3 * 60 * 60_000
const NIL_ID = '00000000-0000-4000-8000-000000000000'
const REQUEST_TIMEOUT_MS = 20_000
/** Не чіпаємо: службові завдання, обмін каси, платний ШІ, вхід, публічні посилання, зв'язок каси, великі вивантаження. */
const SKIP_PREFIXES = ['/api/v1/internal', '/api/v1/jobs', '/api/v1/telegram', '/api/v1/sync', '/api/v1/ai', '/api/v1/vin', '/api/v1/auth',
  '/api/v1/public', '/api/v1/price-links', '/api/v1/till-', '/api/v1/import', '/api/v1/backups', '/api/v1/health', '/api/v1/version', '/api/v1/search/hybrid']
const SKIP_WORDS = /export|generate|download/i

interface Layer { route?: { path: unknown; methods?: Record<string, boolean> }; name?: string; handle?: { stack?: Layer[] }; regexp?: RegExp & { fast_slash?: boolean } }

/** Шлях, на який підключено вкладений маршрутизатор (лише прості шляхи без параметрів). */
function mountPath(layer: Layer): string | null {
  if (!layer.regexp || layer.regexp.fast_slash) return ''
  const path = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/').replace(/\\([.-])/g, '$1')
  return /^[A-Za-z0-9/_.-]*$/.test(path) ? path : null
}

/** Усі адреси GET сервера, як їх оголошено (з параметрами виду :id). */
export function collectGetRoutes(app: unknown): string[] {
  const found = new Set<string>()
  const walk = (stack: Layer[] | undefined, prefix: string) => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        if (!layer.route.methods?.get) continue
        for (const path of Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path])
          if (typeof path === 'string') found.add((prefix + path).replace(/\/+$/, '') || '/')
      } else if (layer.handle?.stack) {
        const mount = mountPath(layer)
        if (mount !== null) walk(layer.handle.stack, prefix + mount)
      }
    }
  }
  walk((app as { _router?: { stack?: Layer[] } })._router?.stack, '')
  return [...found].sort()
}

/** Адреса, яку можна безпечно відкрити: параметри замінено порожнім номером; null — не перевіряємо. */
export function checkablePath(route: string): string | null {
  if (!route.startsWith('/api/v1/') || SKIP_PREFIXES.some(prefix => route.startsWith(prefix)) || SKIP_WORDS.test(route)) return null
  if (/[*()+?]/.test(route.replace(/:[A-Za-z0-9_]+\?/g, ''))) return null
  return route.replace(/\/:[A-Za-z0-9_]+\?/g, '').replace(/:[A-Za-z0-9_]+/g, NIL_ID)
}

export interface SelfCheckResult {
  checked: number
  /** Адреси, що відповіли «внутрішньою помилкою» — це й є збій. */
  failures: Array<{ path: string; status: number; code: string | null }>
  /** Не встигли за відведений час (звіт на великій базі) — не збій, але видно. */
  slow: string[]
  /** Скільки адрес відповіло кожним кодом: видно, чи перевірка справді доходить до запитів у базу (200), а не зупиняється на «бракує параметра» (4xx). */
  statuses: Record<string, number>
  ms: number
}

/** Один прохід для одного магазину. Сервер слухає сам себе на внутрішній адресі; назовні нічого не йде. */
export async function runSelfCheck(app: unknown, identity: { id: string; email: string; tenant_id: string }, paths?: string[]): Promise<SelfCheckResult> {
  const started = Date.now()
  const list = paths ?? collectGetRoutes(app).map(checkablePath).filter((path): path is string => Boolean(path))
  const unique = [...new Set(list)]
  const server = createServer(app as RequestListener)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const pass = openSelfCheckPass({ ...identity, role: 'owner' })
  const result: SelfCheckResult = { checked: 0, failures: [], slow: [], statuses: {}, ms: 0 }
  try {
    for (const path of unique) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { [SELF_CHECK_HEADER]: pass }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        result.checked += 1
        result.statuses[response.status] = (result.statuses[response.status] ?? 0) + 1
        if (response.status === 500) {
          const body = await response.json().catch(() => null) as { error?: { code?: string } } | null
          result.failures.push({ path, status: response.status, code: body?.error?.code ?? null })
        } else await response.arrayBuffer().catch(() => undefined)
      } catch { result.slow.push(path) }
    }
  } finally {
    closeSelfCheckPass()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  result.ms = Date.now() - started
  return result
}

const deployedCommit = () => String(process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || '').slice(0, 40)

/** Чи час перевіряти: нова публікація (інший коміт) або минуло три години. */
export function selfCheckDue(last: { checked_at: string | Date | null; commit: string | null } | undefined, now: Date, commit: string): boolean {
  if (!last?.checked_at) return true
  if ((last.commit ?? '') !== commit) return true
  return now.getTime() - new Date(last.checked_at).getTime() >= SELF_CHECK_EVERY_MS
}

export function selfCheckAlertText(failures: SelfCheckResult['failures']): string {
  const lines = failures.slice(0, 10).map(failure => '• ' + failure.path.replace(NIL_ID, '…') + (failure.code ? ` (${failure.code})` : ''))
  return `⚠️ Сервер: ${failures.length} ${failures.length === 1 ? 'сторінка вебу відповідає' : 'сторінок вебу відповідають'} помилкою.\n${lines.join('\n')}`
    + `${failures.length > 10 ? `\n…і ще ${failures.length - 10}` : ''}\nКаса працює як завжди. Перешліть це повідомлення Claude.`
}

/**
 * Запускається планувальником кожні кілька хвилин; сама вирішує, чи час. Бронює прохід у базі, щоб два
 * одночасні виклики не перевіряли двічі. Про ті самі збої вдруге за день не пише.
 */
export async function runSelfCheckIfDue(app: unknown, now: Date = new Date()): Promise<{ ran: boolean; results?: Array<{ tenant_id: string } & SelfCheckResult> }> {
  const commit = deployedCommit()
  const { rows } = await pool.query('SELECT checked_at, commit FROM server_self_check WHERE id = 1')
  if (!selfCheckDue(rows[0], now, commit)) return { ran: false }
  const claimed = await pool.query(
    `INSERT INTO server_self_check (id, checked_at, commit, result) VALUES (1, now(), $1, NULL)
     ON CONFLICT (id) DO UPDATE SET checked_at = now(), commit = EXCLUDED.commit
       WHERE server_self_check.checked_at IS NOT DISTINCT FROM $2`,
    [commit, rows[0]?.checked_at ?? null],
  )
  if (!claimed.rowCount) return { ran: false }
  const { rows: shops } = await pool.query('SELECT tenant_id, owner_telegram_chat_id FROM shop_settings ORDER BY tenant_id LIMIT 3')
  const results: Array<{ tenant_id: string } & SelfCheckResult> = []
  for (const shop of shops) {
    const owner = await pool.query(
      `SELECT id, email FROM auth.users WHERE raw_app_meta_data->>'tenant_id' = $1 AND raw_app_meta_data->>'role' = 'owner' ORDER BY created_at LIMIT 1`,
      [shop.tenant_id],
    )
    if (!owner.rows[0]) continue
    let result: SelfCheckResult
    try {
      result = await runSelfCheck(app, { id: String(owner.rows[0].id), email: String(owner.rows[0].email ?? ''), tenant_id: String(shop.tenant_id) })
    } catch (error) {
      // Сама перевірка не запустилась (наприклад, середовище не дало слухати внутрішню адресу) — це має бути видно, а не мовчати.
      const text = error instanceof Error ? error.message : String(error)
      logger.error({ err: text }, '[self-check] could not run')
      await pool.query('UPDATE server_self_check SET result = $1::jsonb WHERE id = 1', [JSON.stringify({ error: text.slice(0, 500) })])
      return { ran: false }
    }
    results.push({ tenant_id: String(shop.tenant_id), ...result })
    if (result.failures.length) {
      logger.error({ tenantId: shop.tenant_id, failures: result.failures }, '[self-check] pages answer with an internal error')
      const key = 'self_check:' + now.toISOString().slice(0, 10) + ':' + createHash('sha256').update(result.failures.map(failure => failure.path).sort().join('|')).digest('hex').slice(0, 16)
      const fresh = await pool.query('INSERT INTO owner_alert_log (tenant_id, alert_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [shop.tenant_id, key])
      if (fresh.rowCount && shop.owner_telegram_chat_id) {
        const sent = await sendOwnerTelegram(Number(shop.owner_telegram_chat_id), selfCheckAlertText(result.failures))
        if (!sent) await pool.query('DELETE FROM owner_alert_log WHERE tenant_id = $1 AND alert_key = $2', [shop.tenant_id, key])
      }
    }
  }
  await pool.query('UPDATE server_self_check SET result = $1::jsonb WHERE id = 1', [JSON.stringify(results.map(({ tenant_id, checked, failures, slow, statuses, ms }) => ({ tenant_id, checked, failures, slow, statuses, ms })))])
  return { ran: true, results }
}
