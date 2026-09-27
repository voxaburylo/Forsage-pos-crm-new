/** Allocate the final receipt amount before filtering out services or free-price lines.
 * Money is in integer kopecks. Largest remainders preserve every kopeck, independent
 * of query order. Keep identical to server/src/lib/receiptRevenue.ts (parity tested).
 */
export function allocateReceiptRevenue(total: number, lines: { id: string; total: number; coreTotal?: number }[]): Map<string, number> {
  if (!Number.isSafeInteger(total) || total < 0 || lines.some(line => !Number.isSafeInteger(line.total) || line.total < 0)
    || new Set(lines.map(line => line.id)).size !== lines.length) throw new Error('Invalid receipt amounts')
  const weight = lines.reduce((sum, line) => sum + BigInt(line.total), 0n)
  if (BigInt(total) > weight) throw new Error('Receipt lines do not cover its total')
  const coreLines = lines.map(line => ({ id: line.id, total: line.coreTotal ?? 0 }))
  if (coreLines.some((core, i) => !Number.isSafeInteger(core.total) || core.total < 0 || core.total > lines[i].total)) {
    throw new Error('Invalid receipt core deposit')
  }
  const coreTotal = coreLines.reduce((sum, line) => sum + line.total, 0)
  if (!Number.isSafeInteger(coreTotal)) throw new Error('Invalid receipt core deposit')
  if (coreTotal > 0) {
    // Return calculations protect core deposits from ordinary product discounts.
    const core = allocateReceiptRevenue(Math.min(total, coreTotal), coreLines)
    const goods = allocateReceiptRevenue(Math.max(0, total - coreTotal),
      lines.map((line, i) => ({ id: line.id, total: line.total - coreLines[i].total })))
    return new Map(lines.map(line => [line.id, core.get(line.id)! + goods.get(line.id)!]))
  }
  if (total === 0) return new Map(lines.map(line => [line.id, 0]))
  const amounts = lines.map(line => {
    const numerator = BigInt(line.total) * BigInt(total)
    return { id: line.id, base: Number(numerator / weight), remainder: numerator % weight }
  }).sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1)
  let remainder = total - amounts.reduce((sum, line) => sum + line.base, 0)
  return new Map(amounts.map(line => [line.id, line.base + (remainder-- > 0 ? 1 : 0)]))
}
