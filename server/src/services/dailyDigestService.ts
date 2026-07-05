// Вечірній звіт власнику: контрольні метрики дня (виторг, повернення, знижки,
// недостачі каси, борги, мінусові залишки). Використовується:
//  - GET /api/v1/reports/daily-control — блок «Контроль дня» у Денному звіті
//  - планувальник о 21:00 — відправка тексту власнику в Telegram (owner_telegram_chat_id)
import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { sendTelegramMessage } from './telegramBot.js'

export interface DailyControl {
  date: string
  revenue: number          // виторг (копійки)
  receipts: number         // кількість чеків
  avg_receipt: number
  cash: number             // готівкою
  card: number             // карткою
  debt_sales: number       // продано в борг (сума)
  discounts: number        // сума знижок за день
  returns_count: number
  returns_sum: number
  returns_reasons: Array<{ reason: string; count: number }>
  recon_diffs: Array<{ difference: number; comment: string | null }>  // недостачі/надлишки звірок
  negative_stock: number   // товарів з мінусовим залишком
  no_price: number         // товарів без роздрібної ціни
}

// Метрики за день (дата у форматі YYYY-MM-DD, локальний день Києва)
export async function buildDailyControl(tenantId: string, date: string): Promise<DailyControl> {
  // Київ = UTC+2/+3; беремо з запасом [00:00 місцевого ~ -03:00 UTC] через явні межі
  const from = date + 'T00:00:00+03:00'
  const to = date + 'T23:59:59.999+03:00'

  const [salesQ, returnsQ, reconQ, negQ, nopriceQ] = await Promise.all([
    db.from('sales')
      .select('total, discount, payment_method, is_debt, cash_amount, card_amount')
      .eq('tenant_id', tenantId).eq('status', 'completed')
      .gte('completed_at', from).lte('completed_at', to),
    db.from('returns')
      .select('refund_amount, reason, reason_text')
      .eq('tenant_id', tenantId)
      .gte('created_at', from).lte('created_at', to),
    db.from('cash_reconciliations')
      .select('difference_amount, comment')
      .eq('tenant_id', tenantId)
      .gte('created_at', from).lte('created_at', to),
    db.from('products')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).is('deleted_at', null).lt('qty_on_hand', 0),
    db.from('products')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).is('deleted_at', null).eq('retail_price', 0),
  ])

  const sales = salesQ.data ?? []
  const revenue = sales.reduce((s, x) => s + (x.total ?? 0), 0)
  const receipts = sales.length
  const discounts = sales.reduce((s, x) => s + (x.discount ?? 0), 0)
  let cash = 0, card = 0, debtSales = 0
  for (const s of sales) {
    if (s.is_debt) { debtSales += s.total ?? 0; continue }
    if (s.payment_method === 'card') card += s.total ?? 0
    else if (s.payment_method === 'mixed') { cash += s.cash_amount ?? 0; card += s.card_amount ?? 0 }
    else cash += s.total ?? 0
  }

  const returns = returnsQ.data ?? []
  const reasonsMap = new Map<string, number>()
  for (const r of returns) {
    const key = r.reason_text || r.reason || 'без причини'
    reasonsMap.set(key, (reasonsMap.get(key) ?? 0) + 1)
  }

  const recons = (reconQ.data ?? []).filter((r) => (r.difference_amount ?? 0) !== 0)

  return {
    date,
    revenue,
    receipts,
    avg_receipt: receipts > 0 ? Math.round(revenue / receipts) : 0,
    cash,
    card,
    debt_sales: debtSales,
    discounts,
    returns_count: returns.length,
    returns_sum: returns.reduce((s, r) => s + (r.refund_amount ?? 0), 0),
    returns_reasons: [...reasonsMap.entries()].map(([reason, count]) => ({ reason, count })),
    recon_diffs: recons.map((r) => ({ difference: r.difference_amount, comment: r.comment ?? null })),
    negative_stock: negQ.count ?? 0,
    no_price: nopriceQ.count ?? 0,
  }
}

const uah = (kop: number) => (kop / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' грн'

export function formatDigestText(c: DailyControl): string {
  const lines: string[] = []
  lines.push(`📊 *Підсумок дня ${c.date.split('-').reverse().join('.')}*`)
  lines.push('')
  lines.push(`💰 Виторг: *${uah(c.revenue)}*  (${c.receipts} чеків, середній ${uah(c.avg_receipt)})`)
  lines.push(`   готівка ${uah(c.cash)} · картка ${uah(c.card)}${c.debt_sales > 0 ? ` · в борг ${uah(c.debt_sales)}` : ''}`)
  if (c.discounts > 0) lines.push(`🏷 Знижок за день: ${uah(c.discounts)}`)
  lines.push('')
  if (c.returns_count > 0) {
    lines.push(`↩️ Повернення: *${c.returns_count} шт на ${uah(c.returns_sum)}*`)
    for (const r of c.returns_reasons.slice(0, 5)) lines.push(`   • ${r.reason} ×${r.count}`)
  } else {
    lines.push('↩️ Повернень не було')
  }
  if (c.recon_diffs.length > 0) {
    lines.push('')
    lines.push('⚠️ *Розбіжності каси при звірці:*')
    for (const d of c.recon_diffs) {
      lines.push(`   • ${d.difference > 0 ? '+' : ''}${uah(d.difference)}${d.comment ? ' (' + d.comment + ')' : ''}`)
    }
  }
  lines.push('')
  const tails: string[] = []
  if (c.negative_stock > 0) tails.push(`мінусові залишки: ${c.negative_stock}`)
  if (c.no_price > 0) tails.push(`без ціни: ${c.no_price}`)
  if (tails.length) lines.push(`📦 Каталог: ${tails.join(' · ')} (Товари → фільтри «− Мінуси» / «₴0 Без ціни»)`)
  return lines.join('\n')
}

function kyivToday(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }) // YYYY-MM-DD
}
function kyivHour(): number {
  return Number(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour: 'numeric', hour12: false }))
}

// Надіслати дайджест власнику зараз (повертає true якщо надіслано)
export async function sendOwnerDigest(tenantId: string, date?: string): Promise<boolean> {
  const { data: st } = await db.from('shop_settings')
    .select('owner_telegram_chat_id').eq('tenant_id', tenantId).single()
  const chatId = (st as any)?.owner_telegram_chat_id
  if (!chatId) return false
  const control = await buildDailyControl(tenantId, date ?? kyivToday())
  const ok = await sendTelegramMessage(Number(chatId), formatDigestText(control))
  if (ok) logger.info({ tenantId }, '[digest] вечірній звіт надіслано власнику')
  return ok
}

// Планувальник: щовечора о 21:00 за Києвом, один раз на день
export function startDailyDigestScheduler() {
  const tick = async () => {
    try {
      if (kyivHour() < 21) return
      const today = kyivToday()
      const { data: shops } = await db.from('shop_settings')
        .select('tenant_id, owner_telegram_chat_id, last_digest_date')
        .not('owner_telegram_chat_id', 'is', null)
      for (const s of shops ?? []) {
        if ((s as any).last_digest_date === today) continue
        const ok = await sendOwnerDigest(s.tenant_id, today)
        if (ok) {
          await db.from('shop_settings').update({ last_digest_date: today }).eq('tenant_id', s.tenant_id)
        }
      }
    } catch (e: any) {
      logger.warn({ err: e?.message }, '[digest] scheduler tick failed')
    }
  }
  setInterval(tick, 10 * 60 * 1000) // кожні 10 хв
  setTimeout(tick, 30 * 1000)       // і невдовзі після старту сервера
  logger.info('Daily owner digest scheduler started (21:00 Kyiv)')
}
