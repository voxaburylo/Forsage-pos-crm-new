import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
vi.mock('../../db/supabase.js', () => ({ db: { storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) } } }))
import { DEFAULT_OWNER_ALERTS, groupOwnerAlerts, planOwnerAlerts, readOwnerAlertSettings, runOwnerAlerts, telegramWebhookSecret, type OwnerAlertFacts } from '../ownerAlertService.js'
import { ownerBotReply } from '../../routes/telegramWebhook.js'
import { ownerBotWebhookUrl } from '../ownerBotConnect.js'

// 22.11.2026 — неділя; Київ узимку = UTC+2.
const at = (kyiv: string) => new Date(`2026-11-22T${kyiv}:00+02:00`)
const facts = (over: Partial<OwnerAlertFacts> = {}): OwnerAlertFacts =>
  ({ till_seen_at: at('11:58').toISOString(), open_shifts: [], closed_shifts: [], negative_products: [], last_backup_at: at('07:00').toISOString(), ...over })
const keys = (list: Array<{ key: string }>) => list.map(alert => alert.key)

describe('owner alerts in Telegram (stage 11, owner decision 22.11.2026: all alerts, shop works 8–19 daily)', () => {
  beforeEach(() => { query.mockReset(); vi.unstubAllGlobals(); delete process.env.TELEGRAM_BOT_TOKEN })

  it('says nothing when everything is fine', () => {
    expect(planOwnerAlerts(facts(), at('12:00'))).toEqual([])
  })
  it('reports a silent till only during working hours, after a grace period, once per outage', () => {
    const silent = facts({ till_seen_at: at('11:30').toISOString() })
    const noon = planOwnerAlerts(silent, at('12:00'))
    expect(noon).toHaveLength(1)
    expect(noon[0].text).toContain('Каса не в мережі вже 30 хв')
    // Та сама «тиша» через 5 хвилин дає той самий ключ — повтору не буде.
    expect(keys(planOwnerAlerts(silent, at('12:05')))).toEqual(keys(noon))
    expect(planOwnerAlerts(facts({ till_seen_at: at('11:50').toISOString() }), at('12:00'))).toEqual([])
    // Вночі й до відкриття каса має право мовчати; у перші хвилини після 8:00 — теж.
    const overnight = facts({ till_seen_at: new Date('2026-11-21T19:05:00+02:00').toISOString() })
    for (const time of ['07:59', '08:10', '19:00', '23:30']) expect(keys(planOwnerAlerts(overnight, at(time))), time).toEqual([])
    expect(planOwnerAlerts(overnight, at('08:15'))).toHaveLength(1)
    expect(planOwnerAlerts(facts({ till_seen_at: null }), at('12:00'))).toEqual([])
  })
  it('reminds about a shift open for more than a day once per day per shift', () => {
    const open = facts({ open_shifts: [{ id: 's1', opened_at: new Date('2026-11-15T09:00:00+02:00').toISOString() }, { id: 's2', opened_at: at('08:05').toISOString() }] })
    const alerts = planOwnerAlerts(open, at('12:00'))
    expect(keys(alerts)).toEqual(['shift_open:s1:2026-11-22'])
    expect(alerts[0].text).toContain('Зміну не закрито вже 171 год')
  })
  // 24.11.2026 (слово власника: «у сповіщеннях бота немає, хто закрив зміну»).
  it('says who closed the shift and whose shift is still open; old closings are not reported', () => {
    const closed = facts({ closed_shifts: [
      { id: 'new', closed_at: at('11:31').toISOString(), cash_variance: 0, cashier_name: 'Олексій', closing_cash: 50_000 },
      { id: 'old', closed_at: new Date('2026-11-21T19:00:00+02:00').toISOString(), cash_variance: 0, cashier_name: 'Никита', closing_cash: 0 },
      { id: 'nameless', closed_at: at('11:40').toISOString(), cash_variance: null },
    ] })
    const alerts = planOwnerAlerts(closed, at('12:00'))
    expect(keys(alerts)).toEqual(['shift_closed:new', 'shift_closed:nameless'])
    expect(alerts[0].text).toMatch(/^✅ Зміну закрито: Олексій, .*11:31. У касі лишилось 500.00 грн.$/)
    expect(alerts[1].text).toContain('Зміну закрито: касир,')
    const open = planOwnerAlerts(facts({ open_shifts: [{ id: 's1', opened_at: new Date('2026-11-15T09:00:00+02:00').toISOString(), cashier_name: 'Никита' }] }), at('12:00'))
    expect(open[0].text).toContain('год: Никита (відкрита')
    const diff = planOwnerAlerts(facts({ closed_shifts: [{ id: 'a', closed_at: at('10:00').toISOString(), cash_variance: -25_000, cashier_name: 'Олексій' }] }), at('12:00'))
    expect(diff.find(alert => alert.key === 'cash_diff:a')!.text).toContain('(Олексій, ')
  })
  // 25.11.2026 (власник: «где полный отчёт — выторг 47 тысяч, осталось 4, 10 отдал властнику»).
  it('the shift-closed message carries the revenue, payments, money handed to the owner and what stays in the till', () => {
    const closed = facts({ closed_shifts: [{ id: 'v', closed_at: at('18:07').toISOString(), cash_variance: 0, cashier_name: 'Володимир', closing_cash: 400_000,
      summary: { revenue: 4_795_500, receipts: 54, cash: 1_422_000, card: 3_373_500, transfer: 0, debt: 0, handed: 1_022_000 } }] })
    const text = planOwnerAlerts(closed, at('18:10')).find(alert => alert.key === 'shift_closed:v')!.text
    expect(text.split('\n')[0]).toMatch(/^✅ Зміну закрито: Володимир, .*18:07\.$/)
    expect(text).toContain('💰 Виторг: 47')
    expect(text).toContain('955,00 грн (чеків: 54)')
    expect(text).toContain('готівка 14')
    expect(text).toContain('💵 Здано власнику: 10')
    expect(text).toContain('🏦 У касі лишилось: 4')
    expect(text).not.toContain('переказ')
  })
  it('reports a cash difference at shift close from the threshold, once per shift', () => {
    const closed = facts({ closed_shifts: [
      { id: 'a', closed_at: at('10:00').toISOString(), cash_variance: -25_000 },
      { id: 'b', closed_at: at('10:30').toISOString(), cash_variance: 19_999 },
      { id: 'c', closed_at: at('11:00').toISOString(), cash_variance: null },
      { id: 'd', closed_at: at('11:30').toISOString(), cash_variance: 20_000 },
    ] })
    const alerts = planOwnerAlerts(closed, at('12:00')).filter(alert => alert.key.startsWith('cash_diff:'))
    expect(keys(alerts)).toEqual(['cash_diff:a', 'cash_diff:d'])
    expect(alerts[0].text).toContain('недостача 250.00 грн')
    expect(alerts[1].text).toContain('надлишок 200.00 грн')
  })
  it('reports a sale into minus once per stock change and groups several products into one message', () => {
    const minus = facts({ negative_products: [{ id: 'p1', name: 'Фільтр_масляний *W712*', sku: 'W712', qty_on_hand: -1 }, { id: 'p2', name: 'Свічка', sku: null, qty_on_hand: -2 }] })
    const alerts = planOwnerAlerts(minus, at('12:00'))
    expect(keys(alerts)).toEqual(['negative:p1:-1', 'negative:p2:-2'])
    // Наступного дня той самий залишок — той самий ключ: «висить у мінусі» не нагадує щодня.
    const nextDay = new Date('2026-11-23T12:00:00+02:00')
    expect(keys(planOwnerAlerts({ ...minus, till_seen_at: nextDay.toISOString(), last_backup_at: nextDay.toISOString() }, nextDay))).toEqual(keys(alerts))
    const grouped = groupOwnerAlerts(alerts)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].keys).toEqual(['negative:p1:-1', 'negative:p2:-2'])
    expect(grouped[0].text).toContain('товарів 2')
    expect(grouped[0].text).toContain('• Фільтр_масляний *W712* (W712) — залишок -1.')
  })
  it('reports a missing cloud backup once per day and stays silent when the storage could not be read', () => {
    expect(keys(planOwnerAlerts(facts({ last_backup_at: new Date('2026-11-20T20:00:00+02:00').toISOString() }), at('12:00')))).toEqual(['backup:2026-11-22'])
    expect(keys(planOwnerAlerts(facts({ last_backup_at: null }), at('12:00')))).toEqual(['backup:2026-11-22'])
    expect(planOwnerAlerts(facts({ last_backup_at: undefined }), at('12:00'))).toEqual([])
  })
  it('reads thresholds from shop settings and falls back to defaults for anything broken', () => {
    expect(readOwnerAlertSettings(null)).toEqual(DEFAULT_OWNER_ALERTS)
    expect(DEFAULT_OWNER_ALERTS).toMatchObject({ work_from_hour: 8, work_to_hour: 19, till_offline_minutes: 15, cash_diff_kopecks: 20_000 })
    expect(readOwnerAlertSettings({ till_offline_minutes: 30, cash_diff_kopecks: 'x', work_from_hour: 20, work_to_hour: 9 }))
      .toEqual({ ...DEFAULT_OWNER_ALERTS, till_offline_minutes: 30 })
  })
  it('sends each alert once: the key is reserved first and released when Telegram refuses', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    const sent: string[] = []
    let telegramOk = true
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body).text); return { ok: telegramOk } }))
    const reserved = new Set<string>()
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM shop_settings')) return { rows: [{ tenant_id: 't', owner_telegram_chat_id: 42, owner_alerts: null }] }
      if (sql.includes('FROM till_presence')) return { rows: [{ seen_at: at('11:58').toISOString() }] }
      if (sql.includes("status = 'open'")) return { rows: [] }
      if (sql.includes("status = 'closed'")) return { rows: [{ id: 'a', closed_at: at('08:30').toISOString(), cash_variance: -25_000 }] }
      if (sql.includes('FROM products')) return { rows: [] }
      if (sql.startsWith('INSERT INTO owner_alert_log')) { const key = String(params[1]); if (reserved.has(key)) return { rowCount: 0 }; reserved.add(key); return { rowCount: 1 } }
      if (sql.startsWith('DELETE FROM owner_alert_log WHERE tenant_id')) { for (const key of params[1] as string[]) reserved.delete(key); return { rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    })
    // Сховище копій у тесті порожнє → тривога про копію теж; разом дві.
    await expect(runOwnerAlerts(at('12:00'))).resolves.toEqual({ shops: 1, sent: 2, failed: 0 })
    await expect(runOwnerAlerts(at('12:05'))).resolves.toEqual({ shops: 1, sent: 0, failed: 0 })
    expect(sent).toHaveLength(2)
    // Telegram відмовив: ключ знято, наступний прохід спробує ще раз.
    reserved.clear(); telegramOk = false
    await expect(runOwnerAlerts(at('12:10'))).resolves.toEqual({ shops: 1, sent: 0, failed: 2 })
    expect(reserved.size).toBe(0)
  })
  it('answers only the owner service commands and never reveals anything to an unlinked chat', () => {
    expect(ownerBotReply('/id', 42, false)?.reply).toContain('Ваш chat ID: 42')
    expect(ownerBotReply('/start@forsage_bot', 42, false)?.reply).toContain('42')
    expect(ownerBotReply('/zvit', 42, true)).toEqual({ digest: true, reply: '' })
    expect(ownerBotReply('/zvit', 42, false)).toMatchObject({ digest: false })
    expect(ownerBotReply('/tryvogy', 42, true)?.reply).toContain('Тривоги підключено')
    expect(ownerBotReply('/tryvogy', 42, false)?.reply).toContain('не прив’язаний')
    expect(ownerBotReply('/unknown', 42, true)).toBeNull()
  })
  it('registers the webhook only on the permanent domain and derives its secret from the token', () => {
    expect(ownerBotWebhookUrl('preview-abc.vercel.app', 'forsage-pos-crm-new-web.vercel.app')).toBe('https://forsage-pos-crm-new-web.vercel.app/api/v1/telegram/webhook')
    expect(ownerBotWebhookUrl('shop.example.com', '')).toBe('https://shop.example.com/api/v1/telegram/webhook')
    for (const bad of ['localhost:3000', '', 'evil.com/path']) expect(() => ownerBotWebhookUrl(bad, '')).toThrow()
    process.env.TELEGRAM_BOT_TOKEN = 'a'
    const first = telegramWebhookSecret()
    process.env.TELEGRAM_BOT_TOKEN = 'b'
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(telegramWebhookSecret()).not.toBe(first)
  })
})

// 22.11.2026: безкоштовна хмара — файл копії до 45 МБ, база до 500 МБ. Про наближення до ліміту власник має знати заздалегідь.
describe('owner alerts about cloud limits', () => {
  const MB = 1024 * 1024
  beforeEach(() => { delete process.env.CLOUD_DATABASE_LIMIT_MB })

  it('says nothing while the copy and the database are far from the limits, or when the size is unknown', () => {
    expect(planOwnerAlerts(facts({ last_backup_bytes: 18 * MB, database_bytes: 160 * MB }), at('12:00'))).toEqual([])
    expect(planOwnerAlerts(facts({ last_backup_bytes: null, database_bytes: null }), at('12:00'))).toEqual([])
    expect(planOwnerAlerts(facts(), at('12:00'))).toEqual([])
  })

  // 24.11.2026 (план C10): велика копія йде частинами — межа тепер 400 МБ на всю копію; 36 МБ уже не тривога.
  it('warns once a month when the cloud copy reaches 80% of the allowed size in parts', () => {
    expect(planOwnerAlerts(facts({ last_backup_bytes: 36 * MB }), at('12:00'))).toEqual([])
    const near = planOwnerAlerts(facts({ last_backup_bytes: 330 * MB }), at('12:00'))
    expect(keys(near)).toEqual(['backup_size:2026-11'])
    expect(near[0].text).toContain('330 МБ із 400 дозволених (частинами)')
    // Наступного дня того самого місяця ключ той самий — повтору не буде; у новому місяці нагадаємо ще раз.
    const nextDay = new Date('2026-11-23T12:00:00+02:00')
    expect(keys(planOwnerAlerts(facts({ last_backup_bytes: 331 * MB, till_seen_at: nextDay.toISOString(), last_backup_at: nextDay.toISOString() }), nextDay))).toEqual(['backup_size:2026-11'])
    const december = new Date('2026-12-01T12:00:00+02:00')
    expect(keys(planOwnerAlerts(facts({ last_backup_bytes: 331 * MB, till_seen_at: december.toISOString(), last_backup_at: december.toISOString() }), december))).toEqual(['backup_size:2026-12'])
    expect(planOwnerAlerts(facts({ last_backup_bytes: 319 * MB }), at('12:00'))).toEqual([])
  })

  it('warns when the cloud database is 80% full; the limit follows the plan', () => {
    const full = planOwnerAlerts(facts({ database_bytes: 410 * MB }), at('12:00'))
    expect(keys(full)).toEqual(['database_size:2026-11'])
    expect(full[0].text).toContain('82 %')
    expect(full[0].text).toContain('410 МБ із 500')
    expect(planOwnerAlerts(facts({ database_bytes: 399 * MB }), at('12:00'))).toEqual([])
    // Платний тариф чи власний сервер: ліміт задається змінною оточення.
    process.env.CLOUD_DATABASE_LIMIT_MB = '8000'
    expect(planOwnerAlerts(facts({ database_bytes: 410 * MB }), at('12:00'))).toEqual([])
  })
})
