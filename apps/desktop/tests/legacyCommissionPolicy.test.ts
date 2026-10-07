import { describe, expect, it } from 'vitest'
import { planLegacyCommissionReturn, type LegacyCommissionAward, type LegacyCommissionReversal } from '../src/repositories/legacyCommissionReturn'

function fixture() {
  return {
    manualReview: false,
    awards: [{ id: 'award', employee_id: 'worker', employee_name: 'Worker', amount: 100,
      type: 'bonus', deleted_at: null, valid_source: true }] as LegacyCommissionAward[],
    reversals: [] as LegacyCommissionReversal[],
    lines: [{ id: 'line', qty: 2, deleted_at: null as string | null }],
    returned: [{ sale_item_id: 'line', quantity: 1 }],
  }
}
describe('legacy commission evidence, not mutable rates', () => {
  it('uses the known cumulative share of the only original line', () => {
    const input = fixture()
    expect(planLegacyCommissionReturn(input)).toEqual({ kind: 'exact', corrections: [{ original: input.awards[0], amount: 50 }] })
  })
  it.each(['duplicate-award', 'deleted-award', 'wrong-source', 'wrong-type', 'fractional-money',
    'bad-quantity', 'unknown-return-line', 'duplicate-return-line', 'deleted-line', 'too-many-returned',
    'reverse-without-award', 'reversal-over-target', 'deleted-reversal', 'invalid-reversal-source', 'positive-reversal'])(
    'requires review for %s instead of silently changing salary', damage => {
      const input = fixture()
      if (damage === 'duplicate-award') input.awards.push({ ...input.awards[0], id: 'duplicate' })
      if (damage === 'deleted-award') input.awards[0].deleted_at = '2026-09-28'
      if (damage === 'wrong-source') input.awards[0].valid_source = false
      if (damage === 'wrong-type') input.awards[0].type = 'advance'
      if (damage === 'fractional-money') input.awards[0].amount = 100.5
      if (damage === 'bad-quantity') input.returned[0].quantity = 0.0001
      if (damage === 'unknown-return-line') input.returned[0].sale_item_id = 'not-in-receipt'
      if (damage === 'duplicate-return-line') input.returned.push({ ...input.returned[0] })
      if (damage === 'deleted-line') input.lines[0].deleted_at = '2026-09-28'
      if (damage === 'too-many-returned') input.returned[0].quantity = 3
      if (damage.includes('reversal') || damage === 'reverse-without-award') {
        input.reversals.push({ employee_id: 'worker', amount: -20, type: 'bonus', deleted_at: null, valid_source: true })
        if (damage === 'reverse-without-award') input.awards = []
        if (damage === 'reversal-over-target') input.reversals[0].amount = -60
        if (damage === 'deleted-reversal') input.reversals[0].deleted_at = '2026-09-28'
        if (damage === 'invalid-reversal-source') input.reversals[0].valid_source = false
        if (damage === 'positive-reversal') input.reversals[0].amount = 10
      }
      expect(planLegacyCommissionReturn(input)).toEqual({ kind: 'review', reason: 'invalid-history' })
    })
  it('keeps a manual hold even if the original award is no longer present', () => {
    const input = fixture(); input.manualReview = true; input.awards = []
    expect(planLegacyCommissionReturn(input)).toEqual({ kind: 'review', reason: 'manual-review' })
  })
  it('does not assume equal rates for two partially returned original lines', () => {
    const input = fixture()
    input.lines.push({ id: 'other-line', qty: 2, deleted_at: null })
    input.returned.push({ sale_item_id: 'other-line', quantity: 1 })
    expect(planLegacyCommissionReturn(input)).toEqual({ kind: 'review', reason: 'ambiguous-lines' })
  })
})
