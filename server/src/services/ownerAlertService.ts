import { createHash } from 'node:crypto'
import { pool } from '../db/pg.js'
import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { BACKUP_BUCKET, MAX_BACKUP_BYTES, VERIFIED_BACKUP_NAME } from './backupPolicy.js'

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
  open_shifts: Array<{ id: string; opened_at: string }>
  /** Зміни, закриті за останні дві доби. */
  closed_shifts: Array<{ id: string; closed_at: string; cash_variance: number | null }>
  negative_products: Array<{ id: string; name: string; sku: string | null; qty_on_hand: number }>
  /** Час останньої перевіреної хмарної копії; undefined — дізнатися не вдалося (тривоги немає). */
  last_backup_at: string | null | undefined
  /** Розмір цієї копії, байти; немає значення — дізнатися не вдалося (тривоги немає). */
  last_backup_bytes?: number | null
  /** Розмір хмарної бази, байти; немає значення — дізнатися не вдалося (тривоги немає). */
  database_bytes?: number | null
}

/**
 * Ліміти хмари (22.11.2026: безкоштовний тариф — файл копії до 45 МБ, база до 500 МБ; повна база стає
 * «лише для читання», і копія даних у хмарі перестає оновлюватись). Попереджаємо на 80 %, раз на місяць.
 * На іншому тарифі чи власному сервері ліміт бази задається змінною CLOUD_DATABASE_LIMIT_MB.
 */
export const CLOUD_NEAR_LIMIT = 0.8
export const cloudDatabaseLimitBytes = () => (Number(process.env.CLOUD_DATABASE_LIMIT_MB) > 0 ? Number(process.env.CLOUD_DATABASE_LIMIT_MB) : 500) * 1024 * 1024
const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0).replace('.', ',')
export interface OwnerAlert { key: string; text: string }

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
      text: `⏰ Зміну не закрито вже ${Math.floor(hours)} год (відкрита ${kyivTime(shift.opened_at)}).\nЗакрити можна на касі або з вебу: Статистика → «Відкриті зміни на касі».`,
    })
  }

  // 3. Велика різниця каси при закритті зміни — один раз на зміну.
  for (const shift of facts.closed_shifts) {
    const variance = Number(shift.cash_variance)
    if (Number.isFinite(variance) && Math.abs(variance) >= settings.cash_diff_kopecks) alerts.push({
      key: `cash_diff:${shift.id}`,
      text: `💵 Різниця каси при закритті зміни (${kyivTime(shift.closed_at)}): ${variance < 0 ? 'недостача' : 'надлишок'} ${uah(variance)}.`,
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

  // 6. Копія бази підходить до ліміту файлу в хмарі — раз на місяць, поки так: є час зробити «копію частинами».
  if (typeof facts.last_backup_bytes === 'number' && facts.last_backup_bytes >= MAX_BACKUP_BYTES * CLOUD_NEAR_LIMIT) alerts.push({
    key: `backup_size:${today.slice(0, 7)}`,
    text: `🗄 Копія бази в хмарі вже ${megabytes(facts.last_backup_bytes)} МБ із ${megabytes(MAX_BACKUP_BYTES)} дозволених. Коли перевищить — хмарні копії перестануть завантажуватись. Потрібна доробка «копія частинами».`,
  })

  // 7. Хмарна база заповнюється — раз на місяць, поки так.
  const databaseLimit = cloudDatabaseLimitBytes()
  if (typeof facts.database_bytes === 'number' && facts.database_bytes >= databaseLimit * CLOUD_NEAR_LIMIT) alerts.push({
    key: `database_size:${today.slice(0, 7)}`,
    text: `🗃 Хмарна база заповнена на ${Math.floor(facts.database_bytes / databaseLimit * 100)} % (${megabytes(facts.database_bytes)} МБ із ${megabytes(databaseLimit)}). Коли заповниться — копія даних у хмарі перестане оновлюватись; каса продавати продовжить.`,
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

async function collectFacts(tenantId: string): Promise<OwnerAlertFacts> {
  const [presence, open, closed, negative, backup] = await Promise.all([
    pool.query('SELECT seen_at FROM till_presence WHERE tenant_id = $1', [tenantId]),
    pool.query(`SELECT id, opened_at FROM shifts WHERE tenant_id = $1 AND status = 'open' ORDER BY opened_at LIMIT 20`, [tenantId]),
    pool.query(`SELECT id, closed_at, cash_variance FROM shifts WHERE tenant_id = $1 AND status = 'closed' AND closed_at > now() - interval '48 hours' ORDER BY closed_at LIMIT 50`, [tenantId]),
    pool.query(`SELECT id, name, sku, qty_on_hand FROM products WHERE tenant_id = $1 AND deleted_at IS NULL AND qty_on_hand < 0 ORDER BY updated_at DESC LIMIT 50`, [tenantId]),
    lastVerifiedBackup(tenantId),
  ])
  // Окремо й останнім: розмір бази не має зупинити решту тривог.
  const databaseBytes = await cloudDatabaseBytes()
  return {
    till_seen_at: presence.rows[0]?.seen_at ? new Date(presence.rows[0].seen_at).toISOString() : null,
    open_shifts: open.rows.map(row => ({ id: String(row.id), opened_at: new Date(row.opened_at).toISOString() })),
    closed_shifts: closed.rows.map(row => ({ id: String(row.id), closed_at: new Date(row.closed_at).toISOString(), cash_variance: row.cash_variance == null ? null : Number(row.cash_variance) })),
    negative_products: negative.rows.map(row => ({ id: String(row.id), name: String(row.name ?? ''), sku: row.sku ? String(row.sku) : null, qty_on_hand: Number(row.qty_on_hand) })),
    last_backup_at: backup === undefined ? undefined : backup.at,
    last_backup_bytes: backup?.bytes ?? null,
    database_bytes: databaseBytes,
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
