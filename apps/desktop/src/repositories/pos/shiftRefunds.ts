import type { LocalDatabase } from '../../db/localDatabase'
import { cashSum } from '../cashBalance'

export type ShiftMoneyByMethod = { cash: number; card: number; transfer: number; account: number; debt: number }

type ReportShift = { id: string; cashier_id: string; opened_at: string; closed_at: string | null }
type RefundRow = {
  id: string; shift_id: string | null; cash_shift_id: string | null
  event_shift_ids: string; interval_shift_ids: string; known_link_shift_ids: string
  refund_method: string; refund_kopecks: number
}

/** Read-only compatibility for returns written before shift_id was persisted.
 * Exact links outrank time. Conflicting links or overlapping shifts are never guessed.
 * Do not use the original sale's shift: a refund may happen days later.
 */
export function readShiftRefunds(db: LocalDatabase, tenantId: string, shift: ReportShift) {
  const until = shift.closed_at ?? new Date().toISOString()
  const rows = db.prepare(`
    WITH event_links AS (
      SELECT aggregate_id,
             json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.shift_id') AS shift_id
      FROM sync_outbox
      WHERE tenant_id = ? AND aggregate_type = 'customer_return' AND operation_type = 'return.created'
    )
    SELECT r.id, r.shift_id, r.refund_method, r.refund_kopecks, c.shift_id AS cash_shift_id,
           (SELECT json_group_array(e.shift_id) FROM event_links e
            WHERE e.aggregate_id = r.id AND typeof(e.shift_id) = 'text' AND length(trim(e.shift_id)) > 0) AS event_shift_ids,
           (SELECT json_group_array(s.id) FROM shifts s
            WHERE s.tenant_id = r.tenant_id AND (s.id = r.shift_id OR s.id = c.shift_id
              OR s.id IN (SELECT e.shift_id FROM event_links e WHERE e.aggregate_id = r.id))) AS known_link_shift_ids,
           (SELECT json_group_array(s.id) FROM shifts s
            WHERE s.tenant_id = r.tenant_id AND s.cashier_id = r.approved_by
              AND s.deleted_at IS NULL AND s.status IN ('open', 'closed')
              AND julianday(r.created_at) >= julianday(s.opened_at)
              AND julianday(r.created_at) <= julianday(COALESCE(s.closed_at, ?))) AS interval_shift_ids
    FROM customer_returns r
    LEFT JOIN cash_operations c ON c.id = r.id AND c.tenant_id = r.tenant_id
      AND c.type = 'return_cash' AND c.deleted_at IS NULL
    WHERE r.tenant_id = ? AND r.deleted_at IS NULL AND r.status = 'completed'
      AND (
        r.shift_id = ? OR c.shift_id = ?
        OR r.id IN (SELECT aggregate_id FROM event_links WHERE shift_id = ?)
        OR (r.approved_by = ?
          AND julianday(r.created_at) >= julianday(?)
          AND julianday(r.created_at) <= julianday(?))
      )
  `).all(tenantId, until, tenantId, shift.id, shift.id, shift.id, shift.cashier_id, shift.opened_at, until) as RefundRow[]

  const byMethod: ShiftMoneyByMethod = { cash: 0, card: 0, transfer: 0, account: 0, debt: 0 }
  const methods: Record<string, keyof ShiftMoneyByMethod> = {
    cash: 'cash', terminal: 'card', credit: 'account', debt_reduction: 'debt',
  }
  let total = 0, unassignedCount = 0
  for (const row of rows) {
    const exact = new Set<string>([row.shift_id, row.cash_shift_id, ...JSON.parse(row.event_shift_ids)]
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
    const knownLinks = new Set<string>(JSON.parse(row.known_link_shift_ids))
    if ([...exact].some(id => !knownLinks.has(id))) {
      unassignedCount += 1
      continue
    }
    const intervals = new Set<string>(JSON.parse(row.interval_shift_ids))
    const evidence = exact.size ? exact : intervals
    if (evidence.size === 1 && !evidence.has(shift.id)) continue
    if (evidence.size !== 1 || !evidence.has(shift.id)) {
      unassignedCount += 1
      continue
    }
    const bucket = Object.hasOwn(methods, row.refund_method) ? methods[row.refund_method] : undefined
    const amount = Number(row.refund_kopecks)
    if (!bucket || !Number.isSafeInteger(amount) || amount < 0) {
      unassignedCount += 1
      continue
    }
    byMethod[bucket] = cashSum(byMethod[bucket], amount)
    total = cashSum(total, amount)
  }
  // Reducing an unpaid debt changes net sales, not money already received.
  return { total, byMethod, paymentRefunded: total - byMethod.debt, unassignedCount }
}
