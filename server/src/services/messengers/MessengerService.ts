import { Telegraf } from 'telegraf'
import { logger } from '../../lib/logger.js'
import { db } from '../../db/supabase.js'

// Один інстанс Telegraf для відправки повідомлень (не створюємо новий на кожне)
let _senderBot: Telegraf | null = null
function getSenderBot(token: string): Telegraf {
  if (!_senderBot || (_senderBot as any).token !== token) {
    _senderBot = new Telegraf(token)
  }
  return _senderBot
}

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

/**
 * Синхронізує токен з env у таблицю messenger_channels.
 * НЕ запускає власний polling — головний бот (telegramBot.ts) вже це робить.
 * Це потрібно щоб sendMessageToChat міг відправляти відповіді менеджера.
 */
export async function initMessengers(): Promise<void> {
  const envToken = process.env.TELEGRAM_BOT_TOKEN
  if (!envToken) {
    logger.warn('Messengers: TELEGRAM_BOT_TOKEN не задано — пропуск синхронізації каналу')
    return
  }

  try {
    const { data: channels } = await db
      .from('messenger_channels')
      .select('id, credentials')
      .eq('platform', 'telegram')
      .eq('tenant_id', TENANT_ID)
      .limit(1)

    const existing = channels?.[0]

    if (existing) {
      if ((existing.credentials as any)?.token !== envToken) {
        await db.from('messenger_channels')
          .update({ credentials: { token: envToken }, is_active: true, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
        logger.info({ channelId: existing.id }, 'Messengers: токен каналу синхронізовано з env')
      }
    } else {
      const { data: created } = await db.from('messenger_channels').insert({
        tenant_id: TENANT_ID,
        name: 'Telegram Bot',
        platform: 'telegram',
        credentials: { token: envToken },
        is_active: true,
      }).select('id').single()
      logger.info({ channelId: created?.id }, 'Messengers: канал створено з env-токена')
    }
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : err }, 'Messengers: помилка синхронізації каналу')
  }
}

export function stopMessengers(): void {
  // Polling веде telegramBot.ts — тут нічого зупиняти
  logger.info('Messengers: stopMessengers called (no-op)')
}

/**
 * Отримуємо або створюємо чат, повертаємо його id.
 */
export async function getOrCreateChat(
  channelId: string,
  platformChatId: string,
  username?: string,
  firstName?: string,
): Promise<{ chatId: string; isNew: boolean }> {
  const { data: existing } = await db
    .from('messenger_chats')
    .select('id')
    .eq('channel_id', channelId)
    .eq('platform_chat_id', platformChatId)
    .eq('status', 'open')
    .maybeSingle()

  if (existing) return { chatId: existing.id, isNew: false }

  const { data: newChat, error } = await db
    .from('messenger_chats')
    .insert({
      tenant_id: TENANT_ID,
      channel_id: channelId,
      platform_chat_id: platformChatId,
      username: username ?? null,
      first_name: firstName ?? null,
    })
    .select('id')
    .single()

  if (error || !newChat) throw new Error('Failed to create chat: ' + error?.message)
  return { chatId: newChat.id, isNew: true }
}

/**
 * Надсилає повідомлення менеджера клієнту через канал.
 */
export async function sendMessageToChat(chatId: string, text: string): Promise<boolean> {
  const { data: chat, error: chatErr } = await db
    .from('messenger_chats')
    .select('*, channel:messenger_channels(id, platform, credentials)')
    .eq('id', chatId)
    .single()

  if (chatErr || !chat) {
    logger.error({ chatId }, 'Messengers: чат не знайдено')
    return false
  }

  const channel = chat.channel as any
  const token = channel?.credentials?.token

  if (channel?.platform !== 'telegram' || !token) {
    logger.warn({ chatId, platform: channel?.platform }, 'Messengers: непідтримувана платформа або немає токена')
    return false
  }

  try {
    const tgBot = getSenderBot(token)
    await tgBot.telegram.sendMessage(chat.platform_chat_id, text)
  } catch (err) {
    logger.error({ chatId, error: err instanceof Error ? err.message : err }, 'Messengers: send failed')
    return false
  }

  await db.from('messenger_messages').insert({ chat_id: chatId, sender_type: 'manager', text })
  await db.from('messenger_chats').update({ last_message_at: new Date().toISOString(), unread_count: 0 }).eq('id', chatId)
  return true
}
