export type PrinterRole = 'receipt' | 'label'

const RECEIPT_PRINTER_RE = /(?:^|[^0-9])(?:pos|xp)?[- _]?58(?:[^0-9]|$)|58\s*mm|58мм|receipt|чек/i
const LABEL_PRINTER_RE = /hl[- _]?80|hilabel|label|tspl|3\s*inch|80\s*mm|80мм|(?:^|[^0-9])(?:pos|xp)?[- _]?80(?:[^0-9]|$)/i

export function assertPrinterRole(printerName: string, role: PrinterRole): void {
  const name = printerName.trim()
  if (!name) {
    throw new Error(role === 'receipt' ? 'PRINT_RECEIPT_PRINTER_NOT_SET' : 'TSPL_PRINTER_NOT_SET')
  }

  const isReceipt = RECEIPT_PRINTER_RE.test(name)
  const isLabel = !isReceipt && (LABEL_PRINTER_RE.test(name) || name.length > 0)
  if (role === 'receipt' && !isReceipt) throw new Error(`PRINT_RECEIPT_PRINTER_MISMATCH: ${name}`)
  if (role === 'label' && !isLabel) throw new Error(`PRINT_LABEL_PRINTER_MISMATCH: ${name}`)
}

