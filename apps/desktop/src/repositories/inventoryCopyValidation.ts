import type { LocalDatabase } from '../db/localDatabase'

export function matchesCompletedInventory(db: LocalDatabase, tenantId: string, id: string, payload: any): boolean {
  if (!Array.isArray(payload?.items) || !payload.items.length || (payload.id && payload.id !== id)) return false
  const session = db.prepare(`SELECT id FROM inventory_sessions
    WHERE id=? AND tenant_id=? AND status='completed' AND deleted_at IS NULL`).get(id, tenantId)
  if (!session) return false
  const items = db.prepare(`SELECT product_id, expected_stock, counted_stock FROM inventory_items
    WHERE session_id=? AND tenant_id=? AND was_counted=1 AND deleted_at IS NULL`).all(id, tenantId) as any[]
  const known = new Map(items.map(item => [item.product_id, item]))
  const seen = new Set<string>()
  return items.length === payload.items.length && payload.items.every((item: any) => {
    if (!item || seen.has(item.product_id)) return false
    seen.add(item.product_id)
    const original = known.get(item.product_id)
    return original && ['expected_stock','counted_stock'].every(key =>
      typeof item[key] === 'number' && Number.isFinite(item[key]) && item[key] === Number(original[key]))
      && item.counted_stock >= 0
  })
}
