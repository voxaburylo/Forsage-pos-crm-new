import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { isPaymentRepeatWarning } from './ReadyOrdersPanel'

// Етап 6 (22.11.2026): каса просить підтвердити однаковий платіж за те саме замовлення протягом 2 хв.
it('recognises the till repeat warning with the same wording the till uses', () => {
  const repo = readFileSync(new URL('../../../../desktop/src/repositories/orderRepository.ts', import.meta.url), 'utf8')
  const mark = repo.match(/ORDER_PAYMENT_REPEAT_MARK = '([^']+)'/)?.[1] ?? ''
  expect(mark).not.toBe('')
  expect(isPaymentRepeatWarning(mark + ': 500.00 грн (Петро). Якщо це справді ще один платіж — підтвердіть.')).toBe(true)
  expect(isPaymentRepeatWarning('Сума перевищує залишок до сплати')).toBe(false)
  const panel = readFileSync(new URL('./ReadyOrdersPanel.tsx', import.meta.url), 'utf8')
  expect(panel).toContain('confirm_repeat: true')
})
