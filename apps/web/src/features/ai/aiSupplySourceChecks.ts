import { isSupplySummaryLabel, readSupplySummary, assertSupplySummaries, type SupplySummary } from './aiSupplySummary'

/** Captured locally, before AI. Strings keep exact cents serializable through the worker. */
export interface SupplySourceCheck { location: string; amount?: string; positions?: number }
export interface SupplySourceSheet { name: string; rows: unknown[][]; rawRows?: unknown[][]; rowOffset?: number; text?: string }

export function readSupplySourceChecks(sheets: SupplySourceSheet[]): SupplySourceCheck[] {
  const summaries: SupplySummary[] = []
  for (const sheet of sheets) {
    const lines = sheet.text?.split(/\r?\n/)
    for (const [index, row] of sheet.rows.entries()) {
      const line = lines?.length === sheet.rows.length ? lines[index].trim() : ''
      // Commas in a prose footer are punctuation/decimals, not CSV columns.
      // Only use the exact original line for this explicit sentence form;
      // never join arbitrary numeric columns or multiline quoted records.
      const prose = line && !/[\t;"]/.test(line) && isSupplySummaryLabel(line)
        && /(?:найменувань|наименований|позицій|позиций).*на сум(?:у|му)/i.test(line)
      const summary = readSupplySummary(prose ? [line] : row, 0, '«' + sheet.name + '», рядок ' + ((sheet.rowOffset ?? 0) + index + 1), { rawValues: prose ? undefined : sheet.rawRows?.[index] })
      if (summary && (summary.amount !== undefined || summary.positions !== undefined)) summaries.push(summary)
    }
  }
  // An unknown layout does not provide trustworthy row/page boundaries. Never
  // promote page/carry totals, or a subtotal from one of several sheets, to a
  // whole-document total. Explicit document totals remain independently usable.
  const genericIsDocument = sheets.length === 1 && !summaries.some(s => ['page','carried','brought'].includes(s.kind))
  return summaries.filter(s => s.kind === 'document' || (genericIsDocument && s.kind === 'generic')).map(s => ({
    location:s.location, ...(s.amount === undefined ? {} : {amount:String(s.amount)}),
    ...(s.positions === undefined ? {} : {positions:s.positions}),
  }))
}

export function assertSupplySourceChecks(products: Array<{qty:number;purchase_price_uah:number}>, checks: readonly SupplySourceCheck[]): void {
  assertSupplySummaries([{ products, summaries:checks.map(check => ({
    kind:'document', at:0, location:check.location,
    ...(check.amount === undefined ? {} : {amount:BigInt(check.amount)}),
    ...(check.positions === undefined ? {} : {positions:check.positions}),
  })) }])
}
