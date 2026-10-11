import { describe, expect, it } from 'vitest'
import type { SalaryPayment } from './staffApi'
import { payrollOperationLabel } from './payrollOperationLabel'

describe('monthly payroll operation labels', () => {
  it.each([
    ['commission_reversal', -6300, 'Сторно нарахування за повернення'],
    ['commission', 12600, 'Нарахування за чек'],
    ['daily_rate', 5000, 'Ставка'],
  ] as const)('labels known source %s without changing the signed amount', (source, amount, label) => {
    const operation = Object.freeze({ type: 'bonus' as const, source, amount })
    expect(payrollOperationLabel(operation)).toBe(label)
    expect(payrollOperationLabel(operation, 'Legacy caller label')).toBe(label)
    expect(operation.amount).toBe(amount)
  })

  describe.each([
    ['missing', {}],
    ['null', { source: null }],
    ['empty', { source: '' }],
    ['whitespace', { source: ' ' }],
    ['unknown', { source: 'future_source' }],
    ['manual', { source: 'manual' }],
  ] as const)('legacy fallback for %s source', (_description, metadata) => {
    it.each([
      ['salary', 'Ставка'],
      ['bonus', 'Премія'],
      ['advance', 'Виплата / аванс'],
      ['penalty', 'Штраф'],
    ] as const)('keeps the previous label for %s', (type, label) => {
      expect(payrollOperationLabel({ type, ...metadata })).toBe(label)
      expect(payrollOperationLabel({ type, ...metadata }, 'Legacy caller label')).toBe('Legacy caller label')
    })
  })

  it('does not infer a reversal from a negative amount or a note', () => {
    const operation: Pick<SalaryPayment, 'type' | 'amount' | 'note'> = {
      type: 'bonus', amount: -6300, note: 'Сторно комісії за повернення',
    }
    expect(payrollOperationLabel(operation)).toBe('Премія')
  })

  it('preserves caller-specific legacy payout wording', () => {
    expect(payrollOperationLabel({ type: 'advance' })).toBe('Виплата / аванс')
    expect(payrollOperationLabel({ type: 'advance' }, 'Виплата')).toBe('Виплата')
  })
})
