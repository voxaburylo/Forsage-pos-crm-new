import type { LocalDatabase } from '../db/localDatabase'
import { aggregateWriteoffs, writeoffMonthRange, type WriteoffSnapshot } from '../lib/writeoffReport'

export function readWriteoffSummary(db: LocalDatabase, tenantId: string, month: string) {
  const range = writeoffMonthRange(month)
  return db.readSnapshot(() => {
    const scope = `WITH selected AS (
      SELECT w.id,w.reason,w.created_at FROM writeoffs w
      WHERE w.tenant_id=?1 AND w.deleted_at IS NULL
        AND (julianday(w.created_at) IS NULL OR (julianday(w.created_at)>=julianday(?2)
          AND julianday(w.created_at)<julianday(?3)))
    ) `
    const args = [tenantId, range.from, range.toExclusive]
    const documents = db.prepare(scope + 'SELECT * FROM selected').all(...args)
    // Do not filter corrupt/deleted/foreign lines away and silently lower the sum.
    const lines = db.prepare(scope + `SELECT i.id,i.writeoff_id,i.product_id,i.qty,i.cost_kopecks,
      p.id known_product_id,i.deleted_at IS NOT NULL deleted,i.tenant_id=?1 tenant_matches
      FROM writeoff_items i JOIN selected w ON w.id=i.writeoff_id
      LEFT JOIN products p ON p.id=i.product_id AND p.tenant_id=?1`).all(...args)
      .map((line: any) => ({ ...line, deleted: Boolean(line.deleted), tenant_matches: Boolean(line.tenant_matches) }))
    return aggregateWriteoffs({ documents, lines } as WriteoffSnapshot, month)
  })
}
