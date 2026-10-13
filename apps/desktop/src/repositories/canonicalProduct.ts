import type { LocalDatabase } from '../db/localDatabase'

/** Identity only, never edits document FKs. Follow explicit merge provenance, not fuzzy names/codes. */
export function canonicalProductId(db: Pick<LocalDatabase, 'prepare'>, tenantId: string, originalId: string): string | null {
  const seen = new Set<string>(); let id = originalId
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(id)) return null
    seen.add(id)
    const row = db.prepare('SELECT id,is_active,deleted_at,specs_json FROM products WHERE id=? AND tenant_id=?').get(id, tenantId) as
      { id: string; is_active: number; deleted_at: string | null; specs_json: string | null } | undefined
    if (!row) return null
    let merged: unknown
    try { merged = JSON.parse(row.specs_json || '{}').merged_into_product_id } catch { return null }
    if (merged !== undefined && merged !== null) {
      if (typeof merged !== 'string' || !merged || !row.deleted_at || row.is_active) return null
      id = merged; continue
    }
    return row.is_active && !row.deleted_at ? id : null
  }
  return null
}
