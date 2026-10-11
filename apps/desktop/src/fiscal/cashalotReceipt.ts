import type { CashalotRetVal } from './cashalotService'

/** Keep legacy saved results readable without coercing arbitrary values to IDs. */
export function cashalotReceiptNumber(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const receipt = result as Record<string, unknown>
  const fiscal = typeof receipt.ReceiptFiscalNum === 'string' ? receipt.ReceiptFiscalNum.trim() : ''
  const local = typeof receipt.ReceiptLocalNum === 'string' ? receipt.ReceiptLocalNum.trim() : ''
  return fiscal || local || null
}

/** Read unfinished legacy evidence without inventing an absent Return flag.
 * An explicit rejection or malformed identity is never a confirmed receipt.
 * The caller decides how to block recovery; the stored evidence stays intact.
 */
export function readSavedCashalotReceipt(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const receipt = result as Record<string, unknown>
  if (receipt.Return !== undefined && receipt.Return !== true) return null
  for (const field of ['ReceiptFiscalNum', 'ReceiptLocalNum']) {
    if (receipt[field] != null && typeof receipt[field] !== 'string') return null
  }
  if (!cashalotReceiptNumber(receipt)) return null
  return {
    ...receipt,
    ...(typeof receipt.ReceiptFiscalNum === 'string' ? { ReceiptFiscalNum: receipt.ReceiptFiscalNum.trim() } : {}),
    ...(typeof receipt.ReceiptLocalNum === 'string' ? { ReceiptLocalNum: receipt.ReceiptLocalNum.trim() } : {}),
  }
}

/** Validate new sale/return acknowledgements, not status queries or old history.
 * API COM v5.9 documents Return:boolean and receipt numbers:string (section 5).
 * Transport ok only means the COM call did not throw, not that a receipt exists.
 */
export function requireCashalotReceipt(result: unknown): CashalotRetVal {
  const invalid = () => new Error(
    'FISCAL_RECEIPT_UNCONFIRMED|ПРРО не повернув підтвердження успіху та номер чека',
  )
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid()
  const receipt = result as Record<string, unknown>
  if (receipt.Return !== true) throw invalid()
  for (const field of ['ReceiptFiscalNum', 'ReceiptLocalNum']) {
    if (receipt[field] != null && typeof receipt[field] !== 'string') throw invalid()
  }
  if (!cashalotReceiptNumber(receipt)) throw invalid()
  // Preserve the provider's metadata and local-only receipts. Empty fiscal IDs
  // must not suppress the local ID in storage, recovery, or the renderer.
  return {
    ...receipt,
    ...(typeof receipt.ReceiptFiscalNum === 'string' ? { ReceiptFiscalNum: receipt.ReceiptFiscalNum.trim() } : {}),
    ...(typeof receipt.ReceiptLocalNum === 'string' ? { ReceiptLocalNum: receipt.ReceiptLocalNum.trim() } : {}),
  } as CashalotRetVal
}
