import { createHash } from 'node:crypto'
import { pool } from '../db/pg.js'
import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { BACKUP_BUCKET, MAX_CHUNKED_BACKUP_BYTES, VERIFIED_BACKUP_NAME } from './backupPolicy.js'

/**
 * Тривоги власнику в Telegram (етап 11 плану, рішення власника 22.11.2026: «усі»).
 * Запускається раз на кілька хвилин зовнішнім планувальником (на Vercel власного немає).
 * Кожна тривога має ключ; ту саму тривогу двічі не надсилаємо (журнал owner_alert_log).
 * Нічого не змінює в даних магазину — лише читає й пише в журнал тривог.
 */
export interface OwnerAlertSettings {
  /** Каса мовчить довше за стільки хвилин у робочий час. */
  till_offline_minutes: number
  /** Робочі години за Києвом: [from, to). Власник 22.11.2026: з 8 до 19 щодня. */
  work_from_hour: number
  work_to_hour: number
  /** Різниця каси при закритті зміни, копійки. */
  cash_diff_kopecks: number
  /** Хмарна копія старша за стільки годин. */
  backup_max_hours: number
  /** Зміна відкрита довше за стільки годин. */
  shift_open_hours: number
}
export const DEFAULT_OWNER_ALERTS: OwnerAlertSettings = {
  till_offline_minutes: 15, work_from_hour: 8, work_to_hour: 19, cash_diff_kopecks: 20_000, backup_max_hours: 36, shift_open_hours: 24,
}

export interface OwnerAlertFacts {
  /** Коли каса востаннє виходила на зв'язок; null — ще ніколи (тривоги немає). */
  till_seen_at: string | null
  open_shifts: Array<{ id: string; opened_at: string; cashier_name?: string | null }>
  /** Зміни, закриті за останні дві доби. */
  closed_shifts: Array<{ id: string; closed_at: string; cash_variance: number | null; cashier_name?: string | null; closing_cash?: number | null
    /** 25.11.2026 (власник: «где полный отчёт — выторг, осталось, отдал властнику»): підсумки зміни. */
    summary?: ShiftCloseSummary | null }>
  negative_products: Array<{ id: string; name: string; sku: string | null; qty_on_hand: number }>
  /** Час останньої перевіреної хмарної копії; undefined — дізнатися не вдалося (тривоги немає). */
  last_backup_at: string | null | undefined
  /** Розмір цієї копії, байти; немає значення — дізнатися не вдалося (тривоги немає). */
  last_backup_bytes?: number | null
  /** Розмір хмарної бази, байти; немає значення — дізнатися не вдалося (тривоги немає). */
  database_bytes?: number | null
  /** 23.11.2026: черга передачі каси на сервер, як її востаннє повідомила каса; немає — невідомо (тривоги немає). */
  outbox?: { waiting: number; oldest_at: string | null; error: string | null; reported_at: string } | null
  /** 26.11.2026 (власник: «можна попередження в тг»): версії програми на касі й на ПК менеджера зі звіту каси. */
  versions?: { till_release_id: string | null; manager_release_id: string | null; manager_seen_at: string | null } | null
}
/** Скільки днів тому ПК менеджера мав звертатися, щоб про його версію ще варто було попереджати. */
export const MANAGER_VERSION_FRESH_DAYS = 3
/** Скільки документ може чекати передачі, перш ніж попередити власника; і наскільки свіжим має бути звіт каси. */
export const OUTBOX_STUCK_MINUTES = 30
export const OUTBOX_REPORT_FRESH_MINUTES = 15

/**
 * Ліміти хмари (22.11.2026: безкоштовний тариф — файл копії до 45 МБ, база до 500 МБ; повна база стає
 * «лише для читання», і копія даних у хмарі перестає оновлюватись). Попереджаємо на 80 %, раз на місяць.
 * На іншому тарифі чи власному сервері ліміт бази задається змінною CLOUD_DATABASE_LIMIT_MB.
 */
export const CLOUD_NEAR_LIMIT = 0.8
export const cloudDatabaseLimitBytes = () => (Number(process.env.CLOUD_DATABASE_LIMIT_MB) > 0 ? Number(process.env.CLOUD_DATABASE_LIMIT_MB) : 500) * 1024 * 1024
const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0).replace('.', ',')
export interface OwnerAlert { key: string; text: string }
export interface ShiftCloseSummary { revenue: number; receipts: number; cash: number; card: number; transfer: number; debt: number; handed: number }

const money = (kopecks: number) => (kopecks / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' грн'
/** Повідомлення про закриття зміни: хто й коли, виторг, як заплатили, скільки здано власнику й лишилось у касі. */
export function shiftClosedText(shift: OwnerAlertFacts['closed_shifts'][number]): string {
  const lines = [`✅ Зміну закрито: ${who(shift.cashier_name)}, ${kyivTime(shift.closed_at)}.`]
  const sum = shift.summary
  if (sum) {
    lines.push(`💰 Виторг: ${money(sum.revenue)} (чеків: ${sum.receipts})`)
    const parts = [sum.cash ? 'готівка ' + money(sum.cash) : '', sum.card ? 'картка ' + money(sum.card) : '',
      sum.transfer ? 'переказ ' + money(sum.transfer) : '', sum.debt ? 'у борг ' + money(sum.debt) : ''].filter(Boolean)
    if (parts.length) lines.push('   ' + parts.join(', '))
    if (sum.handed > 0) lines.push(`💵 Здано власнику: ${money(sum.handed)}`)
  }
  if (shift.closing_cash != null) lines.push(sum ? `🏦 У касі лишилось: ${money(shift.closing_cash)}` : `У касі лишилось ${uah(shift.closing_cash)}.`)
  return sum ? lines.join('\n') : lines.join(' ')
}

const KYIV = 'Europe/Kyiv'
const kyivDate = (now: Date) => now.toLocaleDateString('sv-SE', { timeZone: KYIV })
const kyivHour = (now: Date) => Number(now.toLocaleString('en-US', { timeZone: KYIV, hour: 'numeric', hour12: false })) % 24
const kyivMinute = (now: Date) => Number(now.toLocaleString('en-US', { timeZone: KYIV, minute: 'numeric' }))
const kyivTime = (value: string) => new Date(value).toLocaleString('uk-UA', { timeZone: KYIV, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const uah = (kopecks: number) => (Math.abs(kopecks) / 100).toFixed(2) + ' грн'
const hoursBetween = (from: string, now: Date) => (now.getTime() - new Date(from).getTime()) / 3_600_000

/** Пороги з налаштувань магазину; усе некоректне замінюється значенням за замовчуванням. */
export function readOwnerAlertSettings(raw: unknown): OwnerAlertSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pick = (key: keyof OwnerAlertSettings, min: number, max: number) => {
    const value = Number(input[key])
    return Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : DEFAULT_OWNER_ALERTS[key]
  }
  const settings = {
    till_offline_minutes: pick('till_offline_minutes', 5, 240), work_from_hour: pick('work_from_hour', 0, 23), work_to_hour: pick('work_to_hour', 1, 24),
    cash_diff_kopecks: pick('cash_diff_kopecks', 100, 100_000_000), backup_max_hours: pick('backup_max_hours', 12, 720), shift_open_hours: pick('shift_open_hours', 12, 720),
  }
  return settings.work_from_hour < settings.work_to_hour ? settings
    : { ...settings, work_from_hour: DEFAULT_OWNER_ALERTS.work_from_hour, work_to_hour: DEFAULT_OWNER_ALERTS.work_to_hour }
}

/** Які тривоги мають бути надіслані зараз. Чиста функція: ті самі факти → ті самі ключі. */
export function planOwnerAlerts(facts: OwnerAlertFacts, now: Date, settings: OwnerAlertSettings = DEFAULT_OWNER_ALERTS): OwnerAlert[] {
  const alerts: OwnerAlert[] = []
  const today = kyivDate(now), hour = kyivHour(now)

  // 1. Каса не в мережі — лише в робочий час і не в перші хвилини після відкриття магазину.
  const minutesSinceOpen = (hour - settings.work_from_hour) * 60 + kyivMinute(now)
  if (facts.till_seen_at && hour >= settings.work_from_hour && hour < settings.work_to_hour && minutesSinceOpen >= settings.till_offline_minutes) {
    const silent = hoursBetween(facts.till_seen_at, now) * 60
    if (silent >= settings.till_offline_minutes) alerts.push({
      // Один раз на кожне «зникнення»: поки каса мовчить, час останнього зв'язку не змінюється.
      key: `till_offline:${today}:${new Date(facts.till_seen_at).toISOString()}`,
      text: `⚠️ Каса не в мережі вже ${Math.floor(silent)} хв.\nОстанній зв’язок: ${kyivTime(facts.till_seen_at)}. Перевірте, що програма на касі увімкнена й має інтернет.`,
    })
  }

  // 2. Зміна відкрита довше доби — нагадування раз на день по кожній зміні.
  for (const shift of facts.open_shifts) {
    const hours = hoursBetween(shift.opened_at, now)
    if (hours >= settings.shift_open_hours) alerts.push({
      key: `shift_open:${shift.id}:${today}`,
      text: `⏰ Зміну не закрито вже ${Math.floor(hours)} год: ${who(shift.cashier_name)} (відкрита ${kyivTime(shift.opened_at)}).\nЗакрити можна на касі або з вебу: Статистика → «Відкриті зміни на касі».`,
    })
  }

  // 3. Зміну закрито — хто й коли (слово власника 24.11.2026: «у сповіщеннях бота немає, хто закрив зміну»). Один раз на
  // зміну й лише про свіжі закриття (до 3 год), щоб після увімкнення не прийшла пачка про вчорашні.
  for (const shift of facts.closed_shifts) {
    if (hoursBetween(shift.closed_at, now) < 3) alerts.push({
      key: `shift_closed:${shift.id}`,
      text: shiftClosedText(shift),
    })
  }

  // 3а. Велика різниця каси при закритті зміни — один раз на зміну.
  for (const shift of facts.closed_shifts) {
    const variance = Number(shift.cash_variance)
    if (Number.isFinite(variance) && Math.abs(variance) >= settings.cash_diff_kopecks) alerts.push({
      key: `cash_diff:${shift.id}`,
      text: `💵 Різниця каси при закритті зміни (${who(shift.cashier_name)}, ${kyivTime(shift.closed_at)}): ${variance < 0 ? 'недостача' : 'надлишок'} ${uah(variance)}.`,
    })
  }

  // 4. Продаж у мінус — один раз на кожну зміну залишку: новий продаж у мінус дає нову тривогу, а «висить у мінусі» — ні.
  for (const product of facts.negative_products) alerts.push({
    key: `negative:${product.id}:${product.qty_on_hand}`,
    text: `📦 Продаж у мінус: ${product.name}${product.sku ? ` (${product.sku})` : ''} — залишок ${product.qty_on_hand}. Товар у списку «потребують інвентаризації».`,
  })

  // 5. Хмарна копія не робилась — раз на день.
  if (facts.last_backup_at !== undefined) {
    const hours = facts.last_backup_at ? hoursBetween(facts.last_backup_at, now) : Number.POSITIVE_INFINITY
    if (hours >= settings.backup_max_hours) alerts.push({
      key: `backup:${today}`,
      text: facts.last_backup_at
        ? `🗄 Хмарна копія бази не робилась ${Math.floor(hours)} год (остання — ${kyivTime(facts.last_backup_at)}).`
        : '🗄 У хмарі немає жодної перевіреної копії бази.',
    })
  }

  // 6. Копія бази підходить до межі — раз на місяць, поки так. 24.11.2026 (план C10): велика копія вже йде частинами
  //    по 40 МБ, тож межа тепер — загальний розмір копії частинами (400 МБ), а не один файл.
  if (typeof facts.last_backup_bytes === 'number' && facts.last_backup_bytes >= MAX_CHUNKED_BACKUP_BYTES * CLOUD_NEAR_LIMIT) alerts.push({
    key: `backup_size:${today.slice(0, 7)}`,
    text: `🗄 Копія бази в хмарі вже ${megabytes(facts.last_backup_bytes)} МБ із ${megabytes(MAX_CHUNKED_BACKUP_BYTES)} дозволених (частинами). Варто стиснути старий журнал у Налаштуваннях → ПК і копії або збільшити межу.`,
  })

  // 7. Хмарна база заповнюється — раз на місяць, поки так.
  const databaseLimit = cloudDatabaseLimitBytes()
  if (typeof facts.database_bytes === 'number' && facts.database_bytes >= databaseLimit * CLOUD_NEAR_LIMIT) alerts.push({
    key: `database_size:${today.slice(0, 7)}`,
    text: `🗃 Хмарна база заповнена на ${Math.floor(facts.database_bytes / databaseLimit * 100)} % (${megabytes(facts.database_bytes)} МБ із ${megabytes(databaseLimit)}). Коли заповниться — копія даних у хмарі перестане оновлюватись; каса продавати продовжить.`,
  })

  // 8. Каса не може передати зміни на сервер (23.11.2026: 4 документи висіли з помилкою, і ніхто не знав —
  // через це не прив'язався бот). Раз на кожний «затор»: ключ — найстаріший документ, що чекає.
  const outbox = facts.outbox
  if (outbox && outbox.waiting > 0 && outbox.oldest_at
    && hoursBetween(outbox.reported_at, now) * 60 <= OUTBOX_REPORT_FRESH_MINUTES
    && hoursBetween(outbox.oldest_at, now) * 60 >= OUTBOX_STUCK_MINUTES) alerts.push({
    key: `outbox:${new Date(outbox.oldest_at).toISOString()}`,
    text: `🔄 Каса не може передати на сервер ${outbox.waiting} ${outbox.waiting === 1 ? 'зміну' : 'змін'} — найстаріша чекає з ${kyivTime(outbox.oldest_at)}.`
      + (outbox.error ? `\nПричина: ${outbox.error}` : '') + '\nКаса працює як завжди; не оновлюється лише копія для перегляду у вебі.',
  })

  // 9. ПК менеджера на іншій версії, ніж каса (26.11.2026, власник: «попередження в тг»). Один раз на кожну пару версій:
  // після оновлення ПК менеджера пара зміниться, і нова розбіжність (наступне оновлення каси) знову прийде одним повідомленням.
  const versions = facts.versions
  if (versions?.till_release_id && versions.manager_seen_at && hoursBetween(versions.manager_seen_at, now) <= MANAGER_VERSION_FRESH_DAYS * 24
    && versions.manager_release_id !== versions.till_release_id) alerts.push({
    key: `manager_version:${versions.manager_release_id ?? 'old'}:${versions.till_release_id}`,
    text: `🖥 ПК менеджера працює на іншій версії програми, ніж каса.\nКаса: ${versions.till_release_id}\nПК менеджера: ${versions.manager_release_id ?? 'стара програма (версію не повідомляє)'}`
      + `\nОстанній зв’язок ПК менеджера: ${kyivTime(versions.manager_seen_at)}.`
      + '\nНова версія сама встановиться, коли на ПК менеджера закриють програму. Якщо за день не оновилась — оновіть флешкою з архіву «Форсаж — ПК менеджера».',
  })
  return alerts
}

/** Кілька товарів «у мінус» за один прохід — одне повідомлення, а не десять. */
export function groupOwnerAlerts(alerts: OwnerAlert[]): Array<{ keys: string[]; text: string }> {
  const negative = alerts.filter(alert => alert.key.startsWith('negative:'))
  const rest = alerts.filter(alert => !alert.key.startsWith('negative:')).map(alert => ({ keys: [alert.key], text: alert.text }))
  if (negative.length <= 1) return [...rest, ...negative.map(alert => ({ keys: [alert.key], text: alert.text }))]
  const lines = negative.slice(0, 10).map(alert => '• ' + alert.text.replace(/^📦 Продаж у мінус: /, '').replace(/ Товар у списку.*$/, ''))
  return [...rest, { keys: negative.map(alert => alert.key),
    text: `📦 Продаж у мінус: товарів ${negative.length}.\n${lines.join('\n')}${negative.length > 10 ? `\n…і ще ${negative.length - 10}` : ''}\nУсі — в «Аналітика → Товари потребують інвентаризації».` }]
}

export const telegramToken = () => process.env.TELEGRAM_BOT_TOKEN || ''
/** Секрет вебхука виводиться з токена бота: окремої змінної оточення не потрібно, сам токен нікуди не передається. */
export const telegramWebhookSecret = () => createHash('sha256').update(telegramToken() + ':forsage-webhook').digest('hex')

/** Простий текст без розмітки: назви товарів із «_» чи «*» не ламають повідомлення. */
export async function sendOwnerTelegram(chatId: number, text: string): Promise<boolean> {
  const token = telegramToken()
  if (!token) return false
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    })
    return response.ok
  } catch { return false }
}

/** Час і розмір найновішої перевіреної копії. undefined — дізнатися не вдалося; at: null — копій немає. */
async function lastVerifiedBackup(tenantId: string): Promise<{ at: string | null; bytes: number | null } | undefined> {
  try {
    const devices = await db.storage.from(BACKUP_BUCKET).list(tenantId, { limit: 100 })
    if (devices.error) return undefined
    let newest: string | null = null, bytes: number | null = null
    for (const device of devices.data ?? []) {
      if (!/^[a-f0-9-]{36}$/i.test(device.name)) continue
      const files = await db.storage.from(BACKUP_BUCKET).list(tenantId + '/' + device.name, { limit: 20, sortBy: { column: 'created_at', order: 'desc' } })
      if (files.error) return undefined
      // Архів лежить поряд із маніфестом: те саме ім'я без «.json».
      const sizes = new Map((files.data ?? []).map(file => [file.name, Number((file as { metadata?: { size?: unknown } }).metadata?.size)]))
      for (const file of files.data ?? []) {
        if (!VERIFIED_BACKUP_NAME.test(file.name) || !file.created_at) continue
        if (newest && file.created_at <= newest) continue
        newest = file.created_at
        const size = sizes.get(file.name.slice(0, -5))
        bytes = Number.isFinite(size) && Number(size) > 0 ? Number(size) : null
      }
    }
    return { at: newest, bytes }
  } catch { return undefined }
}

/** Розмір хмарної бази; null — дізнатися не вдалося. */
async function cloudDatabaseBytes(): Promise<number | null> {
  try {
    const { rows } = await pool.query('SELECT pg_database_size(current_database()) AS bytes')
    const bytes = Number(rows[0]?.bytes)
    return Number.isFinite(bytes) && bytes > 0 ? bytes : null
  } catch { return null }
}

/** Імʼя касира зміни — з облікового запису працівника. */
const CASHIER_NAME_SQL = `(SELECT u.raw_user_meta_data->>'full_name' FROM auth.users u WHERE u.id = s.cashier_id)`
const who = (name: string | null | undefined) => name?.trim() || 'касир'

/** Підсумки зміни з копії на сервері: чеки зміни й «здано власнику при закритті» (каса пише цей рядок). */
const SHIFT_SUMMARY_SQL = `(SELECT json_build_object('revenue', COALESCE(SUM(x.total), 0), 'receipts', COUNT(*), 'cash', COALESCE(SUM(x.cash_amount), 0),
    'card', COALESCE(SUM(x.card_amount), 0), 'transfer', COALESCE(SUM(x.transfer_amount), 0), 'debt', COALESCE(SUM(x.debt_amount), 0))
  FROM sales x WHERE x.tenant_id = s.tenant_id AND x.shift_id = s.id AND x.status IN ('completed', 'returned')) AS sales_summary,
  (SELECT COALESCE(SUM(c.amount), 0) FROM cash_operations c WHERE c.tenant_id = s.tenant_id AND c.shift_id = s.id AND c.note = 'Здано власнику при закритті зміни') AS handed`
function readSummary(row: Record<string, unknown>): ShiftCloseSummary | null {
  const sales = row.sales_summary as Record<string, unknown> | null | undefined
  if (!sales) return null
  const n = (value: unknown) => { const v = Number(value); return Number.isFinite(v) ? Math.round(v) : 0 }
  return { revenue: n(sales.revenue), receipts: n(sales.receipts), cash: n(sales.cash), card: n(sales.card), transfer: n(sales.transfer), debt: n(sales.debt), handed: n(row.handed) }
}
async function collectFacts(tenantId: string): Promise<OwnerAlertFacts> {
  const [presence, open, closed, negative, backup] = await Promise.all([
    pool.query('SELECT seen_at FROM till_presence WHERE tenant_id = $1', [tenantId]),
    pool.query(`SELECT s.id, s.opened_at, ${CASHIER_NAME_SQL} AS cashier_name FROM shifts s WHERE s.tenant_id = $1 AND s.status = 'open' ORDER BY s.opened_at LIMIT 20`, [tenantId]),
    pool.query(`SELECT s.id, s.closed_at, s.cash_variance, s.closing_cash, ${CASHIER_NAME_SQL} AS cashier_name FROM shifts s WHERE s.tenant_id = $1 AND s.status = 'closed' AND s.closed_at > now() - interval '48 hours' ORDER BY s.closed_at LIMIT 50`, [tenantId]),
    pool.query(`SELECT id, name, sku, qty_on_hand FROM products WHERE tenant_id = $1 AND deleted_at IS NULL AND qty_on_hand < 0 ORDER BY updated_at DESC LIMIT 50`, [tenantId]),
    lastVerifiedBackup(tenantId),
  ])
  // 25.11.2026: підсумки зміни — окремим запитом; помилка в ньому не зупиняє решту тривог (тоді — коротке повідомлення).
  const summaries = new Map<string, ShiftCloseSummary>()
  const freshIds = closed.rows.map(row => String(row.id))
  if (freshIds.length) await pool.query(`SELECT s.id, ${SHIFT_SUMMARY_SQL} FROM shifts s WHERE s.tenant_id = $1 AND s.id = ANY($2::uuid[])`, [tenantId, freshIds])
    .then(result => { for (const row of result.rows) { const summary = readSummary(row); if (summary) summaries.set(String(row.id), summary) } })
    .catch(error => logger.warn({ err: error }, 'shift close summary unavailable'))
  // Окремо й останнім: розмір бази не має зупинити решту тривог.
  const databaseBytes = await cloudDatabaseBytes()
  // Теж окремо: до міграції 20261123100000 цих колонок немає — тоді просто без цієї тривоги.
  const outbox = await pool.query('SELECT outbox_waiting, outbox_oldest_at, outbox_error, outbox_reported_at FROM till_presence WHERE tenant_id = $1', [tenantId])
    .then(result => result.rows[0], () => undefined)
  // 26.11.2026: версії програм — зі звіту каси для «Стан системи»; помилка тут не зупиняє решту тривог.
  const report = await pool.query('SELECT status_report FROM till_presence WHERE tenant_id = $1', [tenantId])
    .then(result => result.rows[0]?.status_report as Record<string, unknown> | null | undefined, () => undefined)
  const textOf = (value: unknown) => typeof value === 'string' && value ? value : null
  return {
    till_seen_at: presence.rows[0]?.seen_at ? new Date(presence.rows[0].seen_at).toISOString() : null,
    open_shifts: open.rows.map(row => ({ id: String(row.id), opened_at: new Date(row.opened_at).toISOString(), cashier_name: row.cashier_name ? String(row.cashier_name) : null })),
    closed_shifts: closed.rows.map(row => ({ id: String(row.id), closed_at: new Date(row.closed_at).toISOString(), cash_variance: row.cash_variance == null ? null : Number(row.cash_variance),
      cashier_name: row.cashier_name ? String(row.cashier_name) : null, closing_cash: row.closing_cash == null ? null : Number(row.closing_cash), summary: summaries.get(String(row.id)) ?? null })),
    negative_products: negative.rows.map(row => ({ id: String(row.id), name: String(row.name ?? ''), sku: row.sku ? String(row.sku) : null, qty_on_hand: Number(row.qty_on_hand) })),
    last_backup_at: backup === undefined ? undefined : backup.at,
    last_backup_bytes: backup?.bytes ?? null,
    database_bytes: databaseBytes,
    outbox: outbox?.outbox_reported_at ? { waiting: Number(outbox.outbox_waiting ?? 0), oldest_at: outbox.outbox_oldest_at ? new Date(outbox.outbox_oldest_at).toISOString() : null,
      error: outbox.outbox_error ? String(outbox.outbox_error) : null, reported_at: new Date(outbox.outbox_reported_at).toISOString() } : null,
    versions: report ? { till_release_id: textOf(report.release_id), manager_release_id: textOf(report.manager_release_id), manager_seen_at: textOf(report.manager_seen_at) } : null,
  }
}

/**
 * Один прохід: для кожного магазину з підключеним Telegram власника — зібрати факти, надіслати нові тривоги.
 * Ключ спершу бронюється в журналі (щоб два одночасні проходи не надіслали двічі); якщо надіслати не вдалося —
 * бронь знімається, і наступний прохід спробує ще раз.
 */
export async function runOwnerAlerts(now: Date = new Date()): Promise<{ shops: number; sent: number; failed: number }> {
  const { rows: shops } = await pool.query('SELECT tenant_id, owner_telegram_chat_id, owner_alerts FROM shop_settings WHERE owner_telegram_chat_id IS NOT NULL')
  let sent = 0, failed = 0
  for (const shop of shops) {
    try {
      const settings = readOwnerAlertSettings(shop.owner_alerts)
      const planned = planOwnerAlerts(await collectFacts(shop.tenant_id), now, settings)
      const fresh: OwnerAlert[] = []
      for (const alert of planned) {
        const { rowCount } = await pool.query('INSERT INTO owner_alert_log (tenant_id, alert_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [shop.tenant_id, alert.key])
        if (rowCount) fresh.push(alert)
      }
      for (const message of groupOwnerAlerts(fresh)) {
        if (await sendOwnerTelegram(Number(shop.owner_telegram_chat_id), message.text)) { sent += 1; continue }
        failed += 1
        await pool.query('DELETE FROM owner_alert_log WHERE tenant_id = $1 AND alert_key = ANY($2::text[])', [shop.tenant_id, message.keys])
      }
    } catch (error) {
      failed += 1
      logger.warn({ err: (error as Error)?.message, tenantId: shop.tenant_id }, '[owner-alerts] shop pass failed')
    }
  }
  // Журнал потрібен лише проти повторів: старше місяця не зберігаємо.
  await pool.query(`DELETE FROM owner_alert_log WHERE created_at < now() - interval '30 days'`).catch(() => {})
  return { shops: shops.length, sent, failed }
}
