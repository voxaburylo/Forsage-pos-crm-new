import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

export async function processOrderDeadlines() {
  try {
    const now = new Date().toISOString()

    // Знаходимо прострочені замовлення зі статусами ready/in_progress
    const { data: orders, error } = await db
      .from('customer_orders')
      .select('id, total_amount, prepayment, pickup_deadline_at, status, customer:customers(id, full_name, phone, telegram_chat_id)')
      .eq('tenant_id', TENANT_ID)
      .in('status', ['ready', 'in_progress'])
      .lt('pickup_deadline_at', now)
      .limit(50)

    if (error || !orders || orders.length === 0) return

    for (const order of orders) {
      const customer = order.customer as any
      const deadlinePassedMs = Date.now() - new Date(order.pickup_deadline_at!).getTime()
      const daysOverdue = Math.floor(deadlinePassedMs / 86400000)

      // Telegram нагадування клієнту (перші 7 днів)
      if (daysOverdue <= 7 && customer?.telegram_chat_id) {
        try {
          const remaining = order.total_amount - (order.prepayment ?? 0)
          const msg = `⏰ Нагадування!\n\nВаше замовлення чекає на видачу в магазині "Форсаж" вже ${daysOverdue} дн.${remaining > 0 ? `\nЗалишок до сплати: ${(remaining / 100).toFixed(2)} грн.` : ''}\n\nБудь ласка, заберіть його найближчим часом.`

          const { sendTelegramMessage } = await import('./telegramBot.js')
          await sendTelegramMessage(parseInt(customer.telegram_chat_id), msg)

          await db.from('order_activity_log').insert({
            order_id: order.id,
            user_id: null,
            action: 'deadline_reminder_sent',
            details: { days_overdue: daysOverdue, method: 'telegram' },
          })
          logger.info({ orderId: order.id, daysOverdue }, 'Deadline reminder sent via Telegram')
        } catch {
          // Telegram не доступний — пропускаємо
        }
      }

      // Сповіщення власнику для дуже прострочених (>7 днів)
      if (daysOverdue > 7) {
        await db.from('order_activity_log').insert({
          order_id: order.id,
          user_id: null,
          action: 'deadline_critical',
          details: { days_overdue: daysOverdue, message: 'Потребує уваги власника' },
        })
        logger.warn({ orderId: order.id, daysOverdue }, 'Critical overdue order — owner attention needed')
      }
    }
  } catch (err) {
    logger.error(err, 'processOrderDeadlines failed')
  }
}
