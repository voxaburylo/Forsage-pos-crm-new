import { db } from '../../db/supabase.js'
import { logger } from '../../lib/logger.js'
import { sendSms } from './channelSms.js'
import { sendMessageToChat } from '../messengers/MessengerService.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

export interface NotificationEvent {
  eventType: string
  userId?: string     // for staff In-App notifications
  customerId?: string // for customer SMS/Telegram notifications
  vars?: Record<string, string | number>
  link?: string
}

function renderTemplate(tpl: string, vars: Record<string, string | number> = {}): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''))
}

export async function dispatch(event: NotificationEvent): Promise<void> {
  try {
    const { data: templates } = await db
      .from('notification_templates')
      .select('*')
      .eq('tenant_id', TENANT_ID)
      .eq('event_type', event.eventType)
      .eq('is_active', true)

    if (!templates || templates.length === 0) return

    // Pre-load customer details if customerId is provided
    let customer: { phone: string | null; telegram_chat_id: string | null } | null = null
    if (event.customerId) {
      const { data } = await db
        .from('customers')
        .select('phone, telegram_chat_id')
        .eq('id', event.customerId)
        .maybeSingle()
      customer = data
    }

    for (const tpl of templates) {
      const title = renderTemplate(tpl.title_template, event.vars)
      const body  = renderTemplate(tpl.body_template, event.vars)
      const fullText = title ? `${title}\n\n${body}` : body

      if (tpl.channel === 'in_app') {
        await db.from('in_app_notifications').insert({
          tenant_id:  TENANT_ID,
          user_id:    event.userId ?? null,
          event_type: event.eventType,
          title,
          body,
          link: event.link ?? null,
        })
        logger.info({ userId: event.userId, eventType: event.eventType }, 'In-App notification dispatched')
      }

      if (tpl.channel === 'sms' && event.customerId && customer) {
        // Check preferences
        const { data: pref } = await db
          .from('customer_notification_preferences')
          .select('is_enabled')
          .eq('customer_id', event.customerId)
          .eq('channel', 'sms')
          .eq('event_type', event.eventType)
          .maybeSingle()

        if (pref && !pref.is_enabled) {
          logger.info({ customerId: event.customerId, eventType: event.eventType }, 'SMS notification skipped due to customer preferences')
          continue
        }

        if (customer.phone) {
          await sendSms(customer.phone, fullText)
        } else {
          logger.warn({ customerId: event.customerId }, 'SMS dispatch skipped: no phone number found')
        }
      }

      if (tpl.channel === 'telegram' && event.customerId && customer) {
        // Check preferences
        const { data: pref } = await db
          .from('customer_notification_preferences')
          .select('is_enabled')
          .eq('customer_id', event.customerId)
          .eq('channel', 'telegram')
          .eq('event_type', event.eventType)
          .maybeSingle()

        if (pref && !pref.is_enabled) {
          logger.info({ customerId: event.customerId, eventType: event.eventType }, 'Telegram notification skipped due to customer preferences')
          continue
        }

        if (customer.telegram_chat_id) {
          const { data: chat } = await db
            .from('messenger_chats')
            .select('id')
            .eq('platform_chat_id', customer.telegram_chat_id)
            .eq('tenant_id', TENANT_ID)
            .maybeSingle()

          if (chat) {
            await sendMessageToChat(chat.id, fullText)
            logger.info({ customerId: event.customerId, eventType: event.eventType }, 'Telegram notification dispatched via MessengerService')
          } else {
            logger.warn({ platformChatId: customer.telegram_chat_id }, 'Telegram dispatch skipped: chat not found in messenger_chats')
          }
        } else {
          logger.warn({ customerId: event.customerId }, 'Telegram dispatch skipped: no telegram_chat_id found')
        }
      }
    }
  } catch (err: any) {
    logger.warn({ eventType: event.eventType, error: err?.message }, 'Notification dispatch failed (non-fatal)')
  }
}
