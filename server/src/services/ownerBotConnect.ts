import { AppError } from '../middleware/errorHandler.js'
import { telegramToken, telegramWebhookSecret } from './ownerAlertService.js'

/** Адреса, на яку Telegram приноситиме команди: лише наш постійний домен, ніколи не тимчасова збірка. */
export function ownerBotWebhookUrl(host: string | undefined, productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL): string {
  const chosen = String(productionHost || host || '').trim().toLowerCase()
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(chosen) || chosen.startsWith('localhost')) throw new AppError('BOT_HOST', 'Не вдалося визначити адресу сервера для бота', 503)
  return 'https://' + chosen + '/api/v1/telegram/webhook'
}

async function telegram(method: string, body?: Record<string, unknown>): Promise<any> {
  const response = await fetch(`https://api.telegram.org/bot${telegramToken()}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(10_000),
  })
  const data = await response.json().catch(() => null) as { ok?: boolean; result?: any; description?: string } | null
  if (!response.ok || !data?.ok) throw new AppError('TELEGRAM_ERROR', 'Telegram відмовив: ' + String(data?.description ?? response.status).slice(0, 200), 502)
  return data.result
}

/**
 * Підключає бота власника (етап 11, 22.11.2026): реєструє в Telegram адресу нашого сервера для його команд.
 * Токен бота лишається на сервері; у відповідь віддаємо лише ім'я бота, щоб людина знала, кому писати /id.
 */
export async function connectOwnerBot(host: string | undefined): Promise<{ bot_username: string; webhook: string }> {
  if (!telegramToken()) throw new AppError('BOT_NOT_CONFIGURED', 'На сервері не задано токен бота Telegram (TELEGRAM_BOT_TOKEN). Додайте його в налаштуваннях Vercel і опублікуйте ще раз.', 503)
  const url = ownerBotWebhookUrl(host)
  const me = await telegram('getMe')
  await telegram('setWebhook', { url, secret_token: telegramWebhookSecret(), allowed_updates: ['message'], drop_pending_updates: true })
  return { bot_username: String(me?.username ?? ''), webhook: url }
}
