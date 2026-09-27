import type { LocalDatabase } from '../db/localDatabase'

export interface ActiveSession { id: string; tenant_id: string; role: string }
/** Resolve privileges from the authoritative database, never from a stale UI session. */
export function activeSession(db: LocalDatabase, identity: Pick<ActiveSession, 'id' | 'tenant_id'>): ActiveSession | null {
  const row = db.prepare(`SELECT id, tenant_id, role FROM staff_users
    WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL
      AND role IN ('owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer')`)
    .get(identity.id, identity.tenant_id) as ActiveSession | undefined
  return row ? { id: row.id, tenant_id: row.tenant_id, role: row.role } : null
}
