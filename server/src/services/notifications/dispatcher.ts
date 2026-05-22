import { db } from '../../db/supabase.js'
import { logger } from '../../lib/logger.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

export interface NotificationEvent {
  eventType: string
  userId?: string
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

    for (const tpl of templates) {
      const title = renderTemplate(tpl.title_template, event.vars)
      const body  = renderTemplate(tpl.body_template, event.vars)

      if (tpl.channel === 'in_app') {
        await db.from('in_app_notifications').insert({
          tenant_id:  TENANT_ID,
          user_id:    event.userId ?? null,
          event_type: event.eventType,
          title,
          body,
          link: event.link ?? null,
        })
      }
      // SMS/Telegram — розширити пізніше
    }
  } catch (err: any) {
    logger.warn({ eventType: event.eventType, error: err?.message }, 'Notification dispatch failed (non-fatal)')
  }
}
