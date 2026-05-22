import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { sendTelegramMessage } from '../services/telegramBot.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

const replySchema = z.object({
  chat_id:  z.number(),
  text:     z.string().min(1).max(2000),
  order_id: z.string().uuid().optional(),
})

// POST /api/v1/telegram/reply — надіслати повідомлення клієнту в Telegram
router.post('/reply', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = replySchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    }

    const ok = await sendTelegramMessage(parsed.data.chat_id, parsed.data.text)

    if (!ok) {
      throw new AppError('TELEGRAM_ERROR', 'Не вдалося надіслати повідомлення. Перевірте chat_id.', 502)
    }

    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

// GET /api/v1/telegram/orders — замовлення з Telegram
router.get('/orders', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('customer_orders')
      .select('*, customer:customers(id,full_name,phone,telegram_chat_id)')
      .eq('tenant_id', req.user!.tenant_id)
      .eq('source', 'telegram_bot')
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

export default router
