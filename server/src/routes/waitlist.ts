import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/waitlist — список очікувань
router.get('/', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('product_waitlist')
      .select('*, product:products(id, sku, name, retail_price, qty_on_hand), customer:customers(id, phone, full_name)')
      .eq('tenant_id', req.user!.tenant_id)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// POST /api/v1/waitlist — додати в лист очікування
router.post('/', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const schema = z.object({
      product_id:  z.string().uuid(),
      customer_id: z.string().uuid(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422)

    const { data: existing } = await db
      .from('product_waitlist')
      .select('id')
      .eq('product_id', parsed.data.product_id)
      .eq('customer_id', parsed.data.customer_id)
      .maybeSingle()

    if (existing) {
      return res.json({ data: existing })
    }

    const { data, error } = await db
      .from('product_waitlist')
      .insert({
        tenant_id:   req.user!.tenant_id,
        product_id:  parsed.data.product_id,
        customer_id: parsed.data.customer_id,
        status:      'waiting',
      })
      .select()
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// POST /api/v1/waitlist/:id/notify — вручну сповістити
router.post('/:id/notify', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { data: entry, error } = await db
      .from('product_waitlist')
      .select('*, product:products(name, retail_price), customer:customers(id)')
      .eq('id', req.params.id)
      .single()
    if (error || !entry) throw new AppError('NOT_FOUND', 'Запис не знайдено', 404)

    await notifyCustomer(entry as any)
    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

// DELETE /api/v1/waitlist/:id — видалити запис
router.delete('/:id', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { error } = await db
      .from('product_waitlist')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (err) { next(err) }
})

/**
 * Авто-сповіщення клієнтів, які чекають на товар
 */
export async function notifyWaitlistCustomers(productId: string) {
  try {
    const { data: entries } = await db
      .from('product_waitlist')
      .select('*, product:products(id, sku, name, retail_price), customer:customers(id, phone, full_name)')
      .eq('product_id', productId)
      .eq('status', 'waiting')

    for (const entry of entries ?? []) {
      await notifyCustomer(entry as any)
    }
  } catch (err) {
    logger.error({ productId, error: err instanceof Error ? err.message : err }, 'Waitlist notification error')
  }
}

async function notifyCustomer(entry: any) {
  if (!entry.product || !entry.customer) return

  const productName = entry.product.name
  const price = ((entry.product.retail_price ?? 0) / 100).toFixed(2)
  const msg = `🔔 Доброго дня${entry.customer.full_name ? ', ' + entry.customer.full_name : ''}! Товар "*${productName}*", який ви очікували, знову в наявності за ціною *${price} грн*. Чекаємо на вас у магазині!`

  // Знаходимо чат клієнта
  const { data: chat } = await db.from('messenger_chats')
    .select('platform_chat_id, channel:messenger_channels(id, platform, credentials)')
    .eq('customer_id', entry.customer.id)
    .maybeSingle()

  if (chat) {
    const chatData = chat as any
    const channel = Array.isArray(chatData.channel) ? chatData.channel[0] : chatData.channel
    if (channel?.platform === 'telegram' && channel?.credentials?.token) {
      try {
        const { Telegraf } = await import('telegraf')
        const bot = new Telegraf(channel.credentials.token)
        await bot.telegram.sendMessage(chatData.platform_chat_id, msg, { parse_mode: 'Markdown' })
        await db.from('product_waitlist').update({ status: 'notified', notified_at: new Date().toISOString() }).eq('id', entry.id)
        logger.info({ entryId: entry.id, productId: entry.product_id }, 'Waitlist: клієнта сповіщено')
      } catch {}
    }
  }
}

export default router
