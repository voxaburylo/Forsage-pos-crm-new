import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'

/**
 * 23.11.2026 (план T6): нічна перевірка бази каси. Розбіжність має знаходитись уночі, а не тоді, коли власник
 * помітить її в зошиті. Перевірка ЛИШЕ читає базу й нічого не виправляє (правило: непідтверджені залишки, ціни
 * й платежі автоматично не «лагодяться») — знайдене йде в журнал проблем і на екран «Стан системи».
 */
export type NightlyFinding = { code: string; severity: 'error' | 'warning'; title: string; detail: string; count: number }
export type NightlyResult = { checked_at: string; duration_ms: number; findings: NightlyFinding[] }

/** Коди всіх перевірок: те, що цього разу не знайдено, закривається в журналі проблем. */
export const NIGHTLY_CODES = ['nightly-db-file', 'nightly-db-references', 'nightly-stock-ledger', 'nightly-sale-totals', 'nightly-stale-shift', 'nightly-fiscal-stuck',
  'nightly-price-below-cost', 'nightly-same-name-cards', 'nightly-supply-never-sold'] as const
/** «Приходить, але не продається»: стільки приходів за стільки днів без жодного продажу. */
export const NEVER_SOLD_SUPPLIES = 3
export const NEVER_SOLD_DAYS = 21
/** Зміна, відкрита довше за це, — забута. */
export const STALE_SHIFT_HOURS = 36
/** Фіскальний чек, що чекає довше за це, — застряг. */
export const FISCAL_STUCK_HOURS = 6
const EXAMPLES = 5

type Row = Record<string, unknown>
const names = (rows: Row[], key: string) => rows.slice(0, EXAMPLES).map(row => String(row[key] ?? '—')).join('; ')

export function runNightlyCheck(db: LocalDatabase, options: { tenantId?: string; now?: () => Date } = {}): NightlyResult {
  const tenant = options.tenantId ?? DEFAULT_TENANT_ID
  const startedAt = options.now?.() ?? new Date()
  const started = Date.now()
  const findings: NightlyFinding[] = []
  const all = (sql: string, ...params: Array<string | number>) => db.prepare(sql).all(...params) as Row[]

  // 1. Сам файл бази: сторінки цілі.
  const pages = all('PRAGMA quick_check')
  if (pages.length !== 1 || pages[0]?.quick_check !== 'ok') {
    findings.push({ code: 'nightly-db-file', severity: 'error', title: 'Файл бази пошкоджено', count: pages.length,
      detail: 'Перевірка файлу бази знайшла пошкодження. Не закривайте зміну й не робіть копію поверх старих — покажіть це Claude.' })
    // Далі на пошкодженому файлі рахувати немає сенсу: числа можуть бути неправдиві.
    return { checked_at: startedAt.toISOString(), duration_ms: Date.now() - started, findings }
  }

  // 2. Посилання між документами: рядок чека без чека, платіж без замовлення тощо.
  const broken = all('PRAGMA foreign_key_check')
  if (broken.length) {
    const tables = [...new Set(broken.map(row => String(row.table)))].slice(0, EXAMPLES).join(', ')
    findings.push({ code: 'nightly-db-references', severity: 'error', title: 'У базі є документи без пари', count: broken.length,
      detail: `Записів із посиланням на неіснуючий документ: ${broken.length} (таблиці: ${tables}).` })
  }

  // 3. Залишок картки проти останнього руху по ній: кожна зміна залишку записує «стало стільки-то».
  // Якщо залишок у картці інший — його змінили повз облік руху.
  const LEDGER = `
    FROM products p
    JOIN inventory_movements m ON m.rowid = (
      SELECT x.rowid FROM inventory_movements x
      WHERE x.product_id = p.id AND x.tenant_id = p.tenant_id AND x.deleted_at IS NULL
      ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1)
    WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND ABS(p.qty_on_hand - m.qty_after) > 0.0005`
  const ledgerCount = Number(all('SELECT COUNT(*) AS total' + LEDGER, tenant)[0]?.total) || 0
  if (ledgerCount) {
    const ledger = all('SELECT p.sku AS sku, p.name AS name, p.qty_on_hand AS card, m.qty_after AS ledger' + LEDGER + ' ORDER BY ABS(p.qty_on_hand - m.qty_after) DESC LIMIT ' + EXAMPLES, tenant)
    findings.push({ code: 'nightly-stock-ledger', severity: 'warning', title: 'Залишок не збігається з рухом товару', count: ledgerCount,
      detail: `Товарів: ${ledgerCount}. Приклади: ` + ledger.slice(0, EXAMPLES).map(row => `${row.sku ?? row.name}: у картці ${row.card}, за рухом ${row.ledger}`).join('; ')
        + '. Програма нічого не виправляє сама — перерахуйте ці товари на полиці.' })
  }

  // 4. Чек: сума рядків проти суми чека (обидві в копійках).
  const totals = all(`
    SELECT s.id AS id, s.total AS total, COALESCE(SUM(i.total), 0) AS lines
    FROM sales s LEFT JOIN sale_items i ON i.sale_id = s.id AND i.deleted_at IS NULL
    WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND s.status = 'completed' AND s.created_at >= ?
    GROUP BY s.id HAVING ABS(s.total - COALESCE(SUM(i.total), 0)) > 1
    ORDER BY s.created_at DESC LIMIT 100`, tenant, new Date(startedAt.getTime() - 45 * 86_400_000).toISOString())
  if (totals.length) {
    findings.push({ code: 'nightly-sale-totals', severity: 'warning', title: 'Сума чека не дорівнює сумі його рядків', count: totals.length,
      detail: `Чеків за останні 45 днів: ${totals.length}. Приклади (чек: сума / рядки, коп.): ` + totals.slice(0, EXAMPLES).map(row => `${String(row.id).slice(0, 8)}: ${row.total} / ${row.lines}`).join('; ') })
  }

  // 5. Забута зміна.
  const shifts = all(`SELECT id, opened_at FROM shifts WHERE tenant_id = ? AND status = 'open' AND closed_at IS NULL AND deleted_at IS NULL AND opened_at < ? ORDER BY opened_at ASC`,
    tenant, new Date(startedAt.getTime() - STALE_SHIFT_HOURS * 3_600_000).toISOString())
  if (shifts.length) {
    findings.push({ code: 'nightly-stale-shift', severity: 'warning', title: 'Зміну не закрито', count: shifts.length,
      detail: `Відкритих змін старших за ${STALE_SHIFT_HOURS} год: ${shifts.length} (відкрито: ${names(shifts, 'opened_at')}).` })
  }

  // 6. Фіскальний чек, що так і не дійшов до податкової.
  const fiscal = all(`SELECT created_at FROM fiscal_sale_intents WHERE tenant_id = ? AND state IN ('fiscalizing', 'unknown') AND resolved_at IS NULL AND created_at < ? ORDER BY created_at ASC`,
    tenant, new Date(startedAt.getTime() - FISCAL_STUCK_HOURS * 3_600_000).toISOString())
  if (fiscal.length) {
    findings.push({ code: 'nightly-fiscal-stuck', severity: 'error', title: 'Фіскальний чек не відправлено', count: fiscal.length,
      detail: `Чеків, що чекають відправки в податкову довше ${FISCAL_STUCK_HOURS} год: ${fiscal.length} (найстаріший — ${names(fiscal, 'created_at')}).` })
  }

  // 26.11.2026 (аудит): три види помилок у картках, які власник знаходив сам, уже на полиці чи в накладній.
  const ACTIVE = `p.tenant_id = ? AND p.deleted_at IS NULL AND p.is_active = 1 AND COALESCE(p.is_service, 0) = 0`

  // 7. Ціна продажу нижча за закупку, а товар є на полиці: каса такий товар не продасть (правило власника).
  const BELOW = ` FROM products p WHERE ${ACTIVE} AND p.qty_on_hand > 0 AND p.retail_price > 0 AND p.retail_price < p.purchase_price`
  const belowCount = Number(all('SELECT COUNT(*) AS total' + BELOW, tenant)[0]?.total) || 0
  if (belowCount) {
    const rows = all('SELECT p.sku AS sku, p.name AS name, p.purchase_price AS buy, p.retail_price AS sell' + BELOW + ' ORDER BY (p.purchase_price - p.retail_price) * p.qty_on_hand DESC LIMIT ' + EXAMPLES, tenant)
    findings.push({ code: 'nightly-price-below-cost', severity: 'warning', title: 'Ціна продажу нижча за закупку', count: belowCount,
      detail: `Товарів на полиці: ${belowCount}. Приклади: ` + rows.map(row => `${row.name}: закупка ${(Number(row.buy) / 100).toFixed(2)}, продаж ${(Number(row.sell) / 100).toFixed(2)}`).join('; ')
        + '. Часто це ціна за упаковку проти ціни за штуку. Програма цін сама не змінює — виправте в картці.' })
  }

  // 8. Кілька діючих карток із точно однаковою назвою: накладна на такий товар не проводиться, залишок і ціна розходяться.
  // Групуємо тут, а не в запиті: SQLite не вміє переводити кирилицю в малі літери («Запобіжники» ≠ «запобіжники»).
  const groups = new Map<string, { name: string; cards: number; qty: number }>()
  for (const row of all(`SELECT p.name AS name, p.qty_on_hand AS qty FROM products p WHERE ${ACTIVE}`, tenant)) {
    const key = String(row.name ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
    if (!key) continue
    const group = groups.get(key) ?? { name: String(row.name), cards: 0, qty: 0 }
    group.cards += 1; group.qty += Number(row.qty) || 0
    groups.set(key, group)
  }
  const twins = [...groups.values()].filter(group => group.cards > 1).sort((x, y) => y.qty - x.qty)
  if (twins.length) {
    findings.push({ code: 'nightly-same-name-cards', severity: 'warning', title: 'Кілька карток з однаковою назвою', count: twins.length,
      detail: `Назв, що повторюються: ${twins.length}. Приклади: ` + twins.slice(0, EXAMPLES).map(row => `${row.name} (${row.cards} картки)`).join('; ')
        + '. Обʼєднайте дублі в «Очищенні номенклатури»: накладна на такий товар не проводиться, доки картку не вибрано вручну.' })
  }

  // 9. Товар кілька разів приходив накладними, але з цієї картки не продано жодної штуки: імовірно, у картці чужий
  // артикул постачальника (26.11.2026: антифриз шість накладних поспіль ішов у «Масло Промывочное», 44 зайві штуки).
  const ghosts = all(`SELECT p.sku AS sku, p.name AS name, p.qty_on_hand AS qty, COUNT(*) AS supplies
    FROM supply_invoice_items i
    JOIN supply_invoices v ON v.id = i.invoice_id AND v.tenant_id = i.tenant_id AND v.deleted_at IS NULL
    JOIN products p ON p.id = i.product_id AND p.tenant_id = i.tenant_id
    WHERE ${ACTIVE} AND i.deleted_at IS NULL AND p.qty_on_hand > 0
      AND NOT EXISTS (SELECT 1 FROM sale_items s WHERE s.product_id = p.id AND s.tenant_id = p.tenant_id AND s.deleted_at IS NULL)
    GROUP BY p.id HAVING COUNT(*) >= ${NEVER_SOLD_SUPPLIES} AND julianday(MAX(v.created_at)) - julianday(MIN(v.created_at)) >= ${NEVER_SOLD_DAYS}
    ORDER BY COUNT(*) DESC, p.qty_on_hand DESC`, tenant)
  if (ghosts.length) {
    findings.push({ code: 'nightly-supply-never-sold', severity: 'warning', title: 'Товар приходить, але з картки не продається', count: ghosts.length,
      detail: `Карток: ${ghosts.length}. Приклади: ` + ghosts.slice(0, EXAMPLES).map(row => `${row.name}: приходів ${row.supplies}, залишок ${row.qty}`).join('; ')
        + '. Перевірте, чи це не чужий артикул постачальника в картці: тоді товар оприбутковується не туди, а продається з іншої картки.' })
  }

  return { checked_at: startedAt.toISOString(), duration_ms: Date.now() - started, findings }
}

/** Час перевірки: уночі, коли каса не продає; якщо вночі програма не працювала — при першій нагоді наступного дня. */
export const NIGHTLY_FROM_HOUR = 2
export const NIGHTLY_TO_HOUR = 5
export function nightlyCheckDue(lastCheckedAt: string | null, now: Date): boolean {
  const last = lastCheckedAt ? Date.parse(lastCheckedAt) : NaN
  const hours = Number.isFinite(last) ? (now.getTime() - last) / 3_600_000 : Infinity
  if (hours < 20) return false
  const hour = now.getHours()
  // Більше 30 годин без перевірки — не чекаємо ночі.
  return hours >= 30 || (hour >= NIGHTLY_FROM_HOUR && hour < NIGHTLY_TO_HOUR)
}
