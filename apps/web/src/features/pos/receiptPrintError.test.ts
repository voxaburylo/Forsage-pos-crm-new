import { expect, it } from 'vitest'
import { receiptPrintErrorMessage } from './receiptPrintError'
it('explains document load failures without exposing the markup', () => {
  for (const error of ['PRINT_DOCUMENT_LOAD_FAILED', "ERR_FAILED (-2) loading 'data:text/html,PRIVATE'"]) {
    const message = receiptPrintErrorMessage(new Error(error))
    expect(message).toContain('макет чека')
    expect(message).not.toContain('PRIVATE')
  }
})
it('keeps the localized Windows queue failure returned by desktop IPC', () => {
  expect(receiptPrintErrorMessage(new Error("Error invoking remote method 'desktop:print:html': Error: У черзі принтера зависло попереднє завдання. Очистіть чергу друку.")))
    .toBe('У черзі принтера зависло попереднє завдання. Очистіть чергу друку.')
})
it('explains raw codes too, without accidentally claiming a print succeeded', () => {
  expect(receiptPrintErrorMessage(new Error('PRINT_QUEUE_STUCK'))).toContain('залипло')
  expect(receiptPrintErrorMessage(new Error('PRINT_NOT_CONFIRMED'))).toContain('не підтвердила')
  expect(receiptPrintErrorMessage(new Error('PRINT_OUTCOME_UNKNOWN'))).toContain('не підтвердила')
})
