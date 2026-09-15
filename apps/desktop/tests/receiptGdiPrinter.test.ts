import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import { canUseReceiptGdiFallback, RECEIPT_GDI_SCRIPT } from '../src/print/receiptGdiPrinter'
describe('receipt driver fallback', () => {
  it('only retries an explicitly rejected receipt, not labels or uncertain jobs', () => {
    expect(canUseReceiptGdiFallback('receipt', new Error('Invalid printer settings'))).toBe(true)
    for (const role of ['label', undefined]) expect(canUseReceiptGdiFallback(role, new Error('Invalid printer settings'))).toBe(false)
    for (const message of ['PRINT_OUTCOME_UNKNOWN', 'PRINT_NOT_CONFIRMED', 'PRINT_CANCELLED', 'PRINT_FAILED']) expect(canUseReceiptGdiFallback('receipt', new Error(message))).toBe(false)
  })
  it('keeps the selected printer and paginates without modifying other jobs', () => {
    expect(RECEIPT_GDI_SCRIPT).toContain('$document.PrinterSettings.PrinterName = $PrinterName')
    expect(RECEIPT_GDI_SCRIPT).toContain('$event.HasMorePages')
    expect(RECEIPT_GDI_SCRIPT).not.toMatch(/Remove-PrintJob|SetDefaultPrinter|RAW/)
  })
})
