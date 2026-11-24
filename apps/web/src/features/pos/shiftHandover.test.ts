import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { closingHandover, suggestedKeep } from './shiftCashData'

// 24.11.2026 (рішення власника): розмін лишається в касі, решту здають власнику.
describe('closing a shift: change and handover', () => {
  it('splits the counted cash into change and handover', () => {
    expect(closingHandover(260000, '500')).toEqual({ keep: 50000, handover: 210000 })
    expect(closingHandover(260000, '')).toEqual({ keep: 0, handover: 260000 })
    expect(closingHandover(260000, '2600,00')).toEqual({ keep: 260000, handover: 0 })
    expect(closingHandover(260000, '2600.01')).toEqual({ error: 'На розмін не можна лишити більше, ніж є в касі.' })
    expect(closingHandover(260000, 'abc')).toHaveProperty('error')
  })
  it('suggests what was kept last time, but never more than there is now', () => {
    expect(suggestedKeep('500.00', 260000)).toBe('500.00')
    expect(suggestedKeep('500.00', 30000)).toBe('300.00')
    expect(suggestedKeep(null, 260000)).toBe('')
    expect(suggestedKeep('сміття', 260000)).toBe('')
  })
  it('the next shift is offered to open with the change, not with the whole takings', () => {
    const modal = readFileSync(new URL('./ShiftCloseModal.tsx', import.meta.url), 'utf8')
    expect(modal).toContain('desktop.pos.closeShift(cashierId, cashReceived, comment.trim() || null, shiftId, keep)')
    expect(modal).toContain('localStorage.setItem(lastCloseCashKey(cashierId), (keep / 100).toFixed(2))')
    expect(modal).not.toContain('localStorage.setItem(lastCloseCashKey(cashierId), (cashReceived / 100).toFixed(2))')
  })
})
