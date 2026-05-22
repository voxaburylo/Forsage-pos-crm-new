import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { sendMessageToChat } from '../services/messengers/MessengerService.js'
import { extractVin, getMake } from '../services/telegramBot.js'
import { logger } from '../lib/logger.js'

const router = Router()
router.use(requireAuth)


// GET /api/v1/chats — список чатів
router.get('/', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('messenger_chats')
      .select('*, channel:messenger_channels(id, name, platform), customer:customers(id, phone, full_name)')
      .eq('tenant_id', req.user!.tenant_id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(100)

    if (error) {
      // Таблиця може не існувати (міграція не застосована) — повертаємо порожній список
      console.warn('[chats] DB error:', error.message)
      res.json({ data: [] })
      return
    }
    // Фільтруємо чати з відсутнім каналом (може статись при неконсистентних даних)
    const chats = (data ?? []).filter((c) => c.channel != null)
    res.json({ data: chats })
  } catch (err) { next(err) }
})

// GET /api/v1/chats/:id/messages — повідомлення чату
router.get('/:id/messages', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const chatId = String(req.params.id)
    const { data, error } = await db
      .from('messenger_messages')
      .select('*')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true })
      .limit(200)

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // Скидаємо unread_count
    await db.from('messenger_chats').update({ unread_count: 0 }).eq('id', chatId)

    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// PATCH /api/v1/chats/:id/link-customer — прив'язати клієнта до чату
router.patch('/:id/link-customer', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const chatId = String(req.params.id)
    const schema = z.object({ customer_id: z.string().uuid() })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний customer_id', 422)

    const customerId = parsed.data.customer_id

    // 1. Отримуємо чат — потрібен platform_chat_id, channel_id, tenant_id
    const { data: chat, error: chatErr } = await db
      .from('messenger_chats')
      .select('*')
      .eq('id', chatId)
      .single()
    if (chatErr || !chat) throw new AppError('NOT_FOUND', 'Чат не знайдено', 404)

    // 2. Прив'язуємо клієнта до чату
    const { data: updatedChat, error: updateErr } = await db
      .from('messenger_chats')
      .update({ customer_id: customerId })
      .eq('id', chatId)
      .select('*, channel:messenger_channels(id, name, platform), customer:customers(id, phone, full_name)')
      .single()
    if (updateErr) throw new AppError('DB_ERROR', updateErr.message, 500)

    // 3. Для Telegram — записуємо telegram_chat_id клієнту, щоб бот міг авторизувати цей чат
    if (chat.channel_id) {
      const { data: channel } = await db
        .from('messenger_channels')
        .select('platform')
        .eq('id', chat.channel_id)
        .single()
      if (channel?.platform === 'telegram' && chat.platform_chat_id) {
        await db
          .from('customers')
          .update({ telegram_chat_id: chat.platform_chat_id })
          .eq('id', customerId)
      }
    }

    // 4. Автопідв'язка анонімних лідів/замовлень цього чату до клієнта
    await db
      .from('customer_orders')
      .update({ customer_id: customerId })
      .eq('chat_id', chatId)
      .is('customer_id', null)

    // 5. Сканування історії чату на VIN-коди → додавання в гараж клієнта
    try {
      const { data: messages } = await db
        .from('messenger_messages')
        .select('text')
        .eq('chat_id', chatId)

      if (messages && messages.length > 0) {
        const foundVins = new Set<string>()
        for (const msg of messages) {
          if (!msg.text) continue
          const vin = extractVin(String(msg.text).toUpperCase())
          if (vin) foundVins.add(vin)
        }

        for (const vin of foundVins) {
          const { data: existing } = await db
            .from('customer_cars')
            .select('id')
            .eq('customer_id', customerId)
            .eq('vin', vin)
            .maybeSingle()
          if (existing) continue

          await db.from('customer_cars').insert({
            tenant_id: chat.tenant_id,
            customer_id: customerId,
            make: getMake(vin),
            model: 'VIN: ' + vin.slice(0, 8),
            vin,
            notes: '📸 Автоімпорт з чату Telegram',
          })
        }
      }
    } catch (vinErr) {
      logger.error({ error: vinErr instanceof Error ? vinErr.message : vinErr }, 'link-customer VIN import')
    }

    res.json({ data: updatedChat })
  } catch (err) { next(err) }
})

// PATCH /api/v1/chats/:id/resolve — закрити чат
router.patch('/:id/resolve', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('messenger_chats')
      .update({ status: 'resolved' })
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)
      .select()
      .single()

    if (error || !data) throw new AppError('NOT_FOUND', 'Чат не знайдено або він вже закритий', 404)
    res.json({ data })
  } catch (err) { next(err) }
})

// POST /api/v1/chats/:id/send — відправити повідомлення
router.post('/:id/send', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const chatId = String(req.params.id)
    const schema = z.object({ text: z.string().min(1).max(2000) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Текст обов\'язковий', 422)

    const ok = await sendMessageToChat(chatId, parsed.data.text)
    if (!ok) throw new AppError('SEND_FAILED', 'Не вдалося відправити повідомлення', 502)

    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

export default router
