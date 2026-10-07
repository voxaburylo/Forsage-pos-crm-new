import { returnedCommission } from './commissionBasis'
import { stockUnits } from './stockQuantity'

export type LegacyCommissionAward = {
  id: string; employee_id: string; employee_name: string; amount: number
  type: string; deleted_at: string | null; valid_source: boolean
}
export type LegacyCommissionReversal = {
  employee_id: string; amount: number; type: string
  deleted_at: string | null; valid_source: boolean
}
type LegacyLine = { id: string; qty: number; deleted_at: string | null }
type ReturnedLine = { sale_item_id: string; quantity: number }
export type LegacyCommissionPlan =
  | { kind: 'none' }
  | { kind: 'review'; reason: 'manual-review' | 'invalid-history' | 'ambiguous-lines' }
  | { kind: 'exact'; corrections: Array<{ original: LegacyCommissionAward; amount: number }> }

export const legacyCommissionReviewKey = (tenantId: string, saleId: string) => 'commission-legacy-review:v1:' + tenantId + ':' + saleId
export const legacyCommissionDecisionKey = (tenantId: string, returnId: string) => 'commission-legacy-return:v1:' + tenantId + ':' + returnId

/**
 * The approved fallback never reads current rules or current product cards.
 * A full receipt or a single historical line has a known share. A partial
 * multi-line return does not: the original per-line rates were not saved.
 */
export function planLegacyCommissionReturn(input: {
  manualReview: boolean; awards: LegacyCommissionAward[]; reversals: LegacyCommissionReversal[]
  lines: LegacyLine[]; returned: ReturnedLine[]
}): LegacyCommissionPlan {
  const review = (reason: Extract<LegacyCommissionPlan, { kind: 'review' }>['reason']): LegacyCommissionPlan => ({ kind: 'review', reason })
  if (input.manualReview) return review('manual-review')
  const byEmployee = new Map<string, LegacyCommissionAward>()
  for (const award of input.awards) {
    if (!award.valid_source || award.deleted_at || award.type !== 'bonus'
      || !award.employee_id || !Number.isSafeInteger(award.amount) || award.amount <= 0
      || byEmployee.has(award.employee_id)) return review('invalid-history')
    byEmployee.set(award.employee_id, award)
  }
  const reversed = new Map<string, number>()
  for (const prior of input.reversals) {
    if (!prior.valid_source || prior.deleted_at || prior.type !== 'bonus'
      || !Number.isSafeInteger(prior.amount) || prior.amount >= 0
      || !byEmployee.has(prior.employee_id)) return review('invalid-history')
    const amount = (reversed.get(prior.employee_id) ?? 0) - prior.amount
    if (!Number.isSafeInteger(amount) || amount > byEmployee.get(prior.employee_id)!.amount) return review('invalid-history')
    reversed.set(prior.employee_id, amount)
  }
  if (byEmployee.size === 0) return { kind: 'none' }

  // Invalid historical quantities are a review case, not permission to guess.
  let sold: Map<string, number>, returned: Map<string, number>
  try {
    sold = new Map(input.lines.map(line => [line.id, stockUnits(Number(line.qty))]))
    returned = new Map(input.returned.map(line => [line.sale_item_id, stockUnits(Number(line.quantity))]))
  } catch { return review('invalid-history') }
  if (!sold.size || sold.size !== input.lines.length || returned.size !== input.returned.length
    || input.lines.some(line => line.deleted_at || !line.id)
    || [...sold.values()].some(qty => qty <= 0)
    || [...returned].some(([id, qty]) => !sold.has(id) || qty < 0 || qty > sold.get(id)!)) return review('invalid-history')

  let returnedUnits = 1, soldUnits = 1
  if (sold.size === 1) {
    const [id, qty] = [...sold][0]
    returnedUnits = returned.get(id) ?? 0; soldUnits = qty
  } else if (![...sold].every(([id, qty]) => returned.get(id) === qty)) {
    return review('ambiguous-lines')
  }
  const corrections: Array<{ original: LegacyCommissionAward; amount: number }> = []
  for (const original of byEmployee.values()) {
    const target = returnedCommission(original.amount, returnedUnits, soldUnits)
    const amount = target - (reversed.get(original.employee_id) ?? 0)
    if (amount < 0) return review('invalid-history')
    if (amount > 0) corrections.push({ original, amount })
  }
  return { kind: 'exact', corrections }
}
