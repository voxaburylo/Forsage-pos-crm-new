import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { pool } from '../db/pg.js'
import { logger } from '../lib/logger.js'
import { sendOwnerTelegram, telegramToken, telegramWebhookSecret } from '../services/ownerAlertService.js'

/**
 * Команди бота власника на Vercel (етап 11, 22.11.2026). Довге опитування Telegram у serverless не працює,
 * тому Telegram сам приносить повідомлення сюди. Обробляються лише службові команди власника:
 * /id (дізнатися свій chat ID), /zvit (звіт зараз), /tryvogy (перевірити, що тривоги підключено).
 * Листування з клієнтами тут не відновлюється.
 */
const router = Router()

/** Відповідь на команду. Чиста функція: що відповісти й чи треба надіслати звіт. */
export function ownerBotReply(text: string, chatId: number, linked: boolean): { reply: string; digest: boolean } | null {
  const command = text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '')
  if (command === '/id' || command === '/start') return { digest: false,
    reply: `Ваш chat ID: ${chatId}\nВставте його в програмі (на касі чи у вебі): Налаштування → Повідомлення → «Вечірній звіт власнику», і збережіть. Після цього сюди приходитимуть звіт о 21:00 і тривоги.` }
  if (command === '/zvit') return linked ? { digest: true, reply: '' }
    : { digest: false, reply: 'Цей chat ID не прив’язаний до магазину. Надішліть /id і збережіть номер у Налаштуваннях (на касі чи у вебі): вкладка «Повідомлення». Якщо вже зберегли — зачекайте хвилину: номер має дійти з каси на сервер.' }
  if (command === '/tryvogy' || command === '/test') return { digest: false, reply: linked
    ? 'Тривоги підключено. Сюди прийде повідомлення, якщо каса не в мережі в робочий час, зміну не закрито понад добу, товар продано в мінус, велика різниця каси або не зроблено хмарну копію.'
    : 'Цей chat ID ще не прив’язаний до магазину. Надішліть /id і збережіть номер у Налаштуваннях (на касі чи у вебі): вкладка «Повідомлення». Якщо вже зберегли — зачекайте хвилину: номер має дійти з каси на сервер.' }
  return null
}

router.post('/', async (req, res) => {
  // Telegram повторює запит, якщо не отримав 200, тому відповідаємо 200 завжди, а чужі запити просто ігноруємо.
  try {
    const given = Buffer.from(String(req.get('x-telegram-bot-api-secret-token') ?? ''))
    const expected = Buffer.from(telegramWebhookSecret())
    if (!telegramToken() || given.length !== expected.length || !timingSafeEqual(given, expected)) { res.status(200).json({ ok: true }); return }
    const message = req.body?.message
    const chatId = Number(message?.chat?.id)
    const text = typeof message?.text === 'string' ? message.text : ''
    if (!Number.isSafeInteger(chatId) || !text.startsWith('/') || message?.chat?.type !== 'private') { res.status(200).json({ ok: true }); return }
    const { rows } = await pool.query('SELECT tenant_id FROM shop_settings WHERE owner_telegram_chat_id = $1 LIMIT 1', [chatId])
    const answer = ownerBotReply(text, chatId, rows.length > 0)
    if (answer?.digest) {
      const { sendOwnerDigest } = await import('../services/dailyDigestService.js')
      if (!await sendOwnerDigest(rows[0].tenant_id)) await sendOwnerTelegram(chatId, 'Не вдалося сформувати звіт. Спробуйте за хвилину.')
    } else if (answer) await sendOwnerTelegram(chatId, answer.reply)
  } catch (error) {
    logger.warn({ err: (error as Error)?.message }, '[telegram-webhook] failed')
  }
  res.status(200).json({ ok: true })
})

export default router
