import type { SalaryPayment } from './staffApi'

const operationLabels: Record<SalaryPayment['type'], string> = {
  salary: 'Ставка',
  bonus: 'Премія',
  advance: 'Виплата / аванс',
  penalty: 'Штраф',
}

export function payrollOperationLabel(
  operation: Pick<SalaryPayment, 'type' | 'source'>,
  fallbackLabel = operationLabels[operation.type],
): string {
  if (operation.source === 'commission_reversal') return 'Сторно нарахування за повернення'
  if (operation.source === 'commission') return 'Нарахування за чек'
  if (operation.source === 'daily_rate') return 'Ставка'
  // Older history responses can omit source; keep their existing type-based labels.
  return fallbackLabel
}
