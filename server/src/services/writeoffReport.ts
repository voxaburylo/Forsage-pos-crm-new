import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { aggregateWriteoffs, writeoffMonth, writeoffMonthRange, type WriteoffSnapshot } from '../lib/writeoffReport.js'

// A single statement reads all headers and lines in one MVCC snapshot, without a REST cap.
export async function readWriteoffSummary(tenantId: string, month = writeoffMonth()) {
  let range
  try { range = writeoffMonthRange(month) }
  catch { throw new AppError('VALIDATION_ERROR', 'Некоректний місяць звіту списань', 400) }
  const result = await pool.query(`
    WITH selected AS (
      SELECT w.id,w.reason,w.created_at FROM inventory_writeoffs w
      WHERE w.tenant_id=$1 AND to_jsonb(w)->>'deleted_at' IS NULL
        AND w.created_at >= $2::timestamptz AND w.created_at < $3::timestamptz
    )
    SELECT COALESCE((SELECT jsonb_agg(to_jsonb(w)) FROM selected w),'[]'::jsonb) documents,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',i.id,'writeoff_id',i.writeoff_id,'product_id',i.product_id,'qty',i.qty,'cost_kopecks',i.cost_kopecks,
        'known_product_id',p.id,'deleted',to_jsonb(i)->>'deleted_at' IS NOT NULL,
        'tenant_matches',COALESCE(to_jsonb(i)->>'tenant_id',$1::text)=$1::text))
        FROM inventory_writeoff_items i JOIN selected w ON w.id=i.writeoff_id
        LEFT JOIN products p ON p.id=i.product_id AND p.tenant_id=$1),'[]'::jsonb) lines
  `, [tenantId, range.from, range.toExclusive])
  try { return aggregateWriteoffs(result.rows[0] as WriteoffSnapshot, month) }
  catch (error) { throw new AppError('INCOMPLETE_REPORT', error instanceof Error ? error.message : 'Неповний звіт списань', 503) }
}
