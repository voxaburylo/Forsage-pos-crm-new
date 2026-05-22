import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'

const MVP_TENANT_ID = '00000000-0000-0000-0000-000000000001'

interface AuditParams {
  tenantId?:    string
  userId:       string
  userRole:     string
  action:       string
  entityType:   string
  entityId?:    string
  entityLabel?: string
  oldValue?:    unknown
  newValue?:    unknown
  note?:        string
}

// Не кидає помилку якщо лог не записався, але логує в stderr
export async function logAction(p: AuditParams): Promise<void> {
  try {
    const userName = p.userRole + ':' + p.userId.slice(0, 8)
    const { error } = await db.from('audit_log').insert({
      tenant_id:    p.tenantId ?? MVP_TENANT_ID,
      user_id:      p.userId,
      user_name:    userName,
      action:       p.action,
      entity_type:  p.entityType,
      entity_id:    p.entityId ?? null,
      entity_label: p.entityLabel ?? null,
      old_value:    p.oldValue ?? null,
      new_value:    p.newValue ?? null,
      note:         p.note ?? null,
    })
    if (error) {
      logger.warn({ action: p.action, entityId: p.entityId, error: error.message }, 'Audit log write failed')
    }
  } catch (err: any) {
    logger.warn({ action: p.action, error: err?.message }, 'Audit log exception')
  }
}
