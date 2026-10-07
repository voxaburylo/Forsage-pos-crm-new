import { readSupplyNumber } from './aiSupplyNumber'

type Kind = 'generic' | 'page' | 'document' | 'carried' | 'brought'
export interface SupplySummary {
  kind: Kind; at: number; location: string; amount?: bigint; positions?: number
}
type Product = { qty: number; purchase_price_uah: number }
export interface SupplySummaryGroup { products: Product[]; summaries: SupplySummary[] }
const clean = (value: unknown) => String(value ?? '').replace(/[\u00a0\u202f]/g, ' ').trim()
const prefix = /^(?:разом|всього|усього|итого|всего|підсумок|загальна сума|общая сумма|сума до сплати|сумма к оплате|grand total|invoice total|total due|amount due|page total|subtotal|total|перенос|перенесено|brought forward|carried forward)(?=\s|[:(]|$)/i
const currency = /^(?:грн\.?|UAH|₴|USD|EUR|PLN|\$|€)\.?$/i

export function isSupplySummaryLabel(value: unknown): boolean {
  const label = clean(value)
  const match = prefix.exec(label)
  if (!match) return false
  const tail = label.slice(match[0].length).trim()
  // Total is also an oil brand. Only financial qualifiers make a suffix a footer;
  // an arbitrary product description must stay a product even without an SKU.
  return !tail || /^[(:]/.test(tail) || currency.test(tail)
    || /^[+-]?\d[\d.,\s]*(?:(?:грн\.?|UAH|₴|USD|EUR|PLN|\$|€)\.?)?$/i.test(tail)
    || /^(?:на суму|на сумму|найменувань|наименований|позицій|позиций|items|positions)(?=\s|:|$)/i.test(tail)
    || /^(?:(?:за|по|у|в)\s+(?:накладн|документ|сторін|аркуш|страниц|лист)|(?:з|із|с)\s+(?:поперед|предыдущ|пдв|ндс)|на\s+(?:наступн|следующ)|до сплати|к оплате|(?:без|with|including|incl)\s+(?:пдв|ндс|vat))/i.test(tail)
}
function kindOf(label: string): Kind {
  if (/^(?:brought forward|(?:перенос|перенесено)\s+(?:з|із|с)\s+поперед|(?:перенос|перенесено)\s+с\s+предыдущ)/i.test(label)) return 'brought'
  if (/^(?:carried forward|перенос|перенесено)/i.test(label)) return 'carried'
  if (/^(?:grand total|invoice total|total due|amount due|загальна сума|общая сумма|сума до сплати|сумма к оплате)/i.test(label)
    || /(?:за|по|у|в)\s+(?:накладн|документ)|до сплати|к оплате/i.test(label)) return 'document'
  if (/сторін|аркуш|страниц|листа|page total/i.test(label)) return 'page'
  return 'generic'
}
function money(value: unknown, location: string): bigint {
  const source = typeof value === 'string' ? clean(value).replace(/\s*(?:грн\.?|UAH|₴|USD|EUR|PLN|\$|€)\.?\s*$/i, '').trim() : value
  return BigInt(Math.round(readSupplyNumber(source, 'price', location + ': підсумок') * 100))
}

/** Only call on a structural summary row, never on a product's name or description. */
export function readSupplySummary(
  values: unknown[], at: number, location: string,
  options: { quantityColumn?: number; rawValues?: unknown[] } = {},
): SupplySummary | null {
  const cells = values.map(clean)
  const labelIndex = cells.findIndex(Boolean)
  const label = cells[labelIndex] ?? ''
  if (!isSupplySummaryLabel(label)) return null
  const summary: SupplySummary = { kind: kindOf(label), at, location }
  const suffix = label.slice(prefix.exec(label)![0].length).trim()
  const count = /(?:найменувань|наименований|позицій|позиций|items|positions)\s*:?\s*(.*)$/i.exec(label)
  if (count) {
    const value = count[1].split(/,?\s*на сум(?:у|му)\s/i)[0].trim()
    if (!/^\d+$/.test(value) || Number(value) > 2000)
      throw Error(location + ': некоректна кількість позицій у підсумку.')
    summary.positions = Number(value)
  }
  // A printed page number or position count is not a money amount.
  const inline = /(?:на суму|на сумму|на суммy)\s+(.+)$/i.exec(label)?.[1]
    ?? (count ? undefined : /:\s*(.+)$/.exec(label)?.[1]
      ?? (/^[+\-\d]/.test(suffix) ? suffix : undefined))
  const candidates: unknown[] = inline ? [inline] : []
  for (let i = 0; i < cells.length; i++) {
    if (i === labelIndex || i === options.quantityColumn || !cells[i] || currency.test(cells[i]) || /^(?:без пдв|без ндс)$/i.test(cells[i])) continue
    candidates.push(typeof options.rawValues?.[i] === 'number' ? options.rawValues[i] : values[i])
  }
  for (const candidate of candidates) {
    const amount = money(candidate, location)
    if (summary.amount !== undefined && summary.amount !== amount)
      throw Error(location + ': у рядку різні суми підсумку. Уточніть таблицю; числа не підмінено.')
    summary.amount = amount
  }
  if (summary.amount === undefined && options.quantityColumn !== undefined && cells[options.quantityColumn])
    throw Error(location + ': неясно, чи підсумок містить суму грошей, чи кількість. Уточніть колонку суми.')
  return summary
}

/** Local table control totals in source currency, before any exchange-rate conversion. */
export function assertSupplySummaries(groups: SupplySummaryGroup[]): void {
  const prefixes = groups.map(group => {
    const sums = [0n]
    for (const row of group.products) sums.push(sums[sums.length - 1] +
      (BigInt(Math.round(row.qty * 1000)) * BigInt(Math.round(row.purchase_price_uah * 100)) + 500n) / 1000n)
    return sums
  })
  const documentSum = prefixes.reduce((sum, values) => sum + values[values.length - 1], 0n)
  const documentRows = groups.reduce((sum, group) => sum + group.products.length, 0)
  let earlierSheets = 0n
  for (const [index, group] of groups.entries()) {
    const sums = prefixes[index]
    const meaningful = group.summaries.filter(summary => summary.amount !== undefined || summary.positions !== undefined)
    const boundaries = [...new Set(meaningful.filter(summary => ['generic','page','carried'].includes(summary.kind)).map(summary => summary.at))].sort((a,b)=>a-b)
    for (const summary of meaningful) {
      let previous = 0
      for (const boundary of boundaries) {
        if (boundary >= summary.at) break
        previous = boundary
      }
      let amount: bigint, positions: number
      if (summary.kind === 'document') {
        amount = documentSum; positions = documentRows
      } else if (summary.kind === 'carried' || summary.kind === 'brought') {
        amount = earlierSheets + sums[summary.at]; positions = groups.slice(0,index).reduce((sum,g)=>sum+g.products.length,0) + summary.at
      } else {
        if (summary.kind === 'generic' && summary.at === group.products.length && previous > 0)
          throw Error(summary.location + ': неоднозначний останній підсумок після проміжних. Уточніть «Разом за сторінку» або «Разом за накладною»; суму не вгадано.')
        const start = summary.kind === 'page' || summary.at < group.products.length ? previous : 0
        amount = sums[summary.at] - sums[start]; positions = summary.at - start
      }
      if (summary.amount !== undefined && summary.amount !== amount)
        throw Error(summary.location + ': ' + (summary.kind === 'carried' || summary.kind === 'brought' ? 'перенесена сума' : 'підсумок') +
          ' не збігається із сумою товарів. Перевірте всі рядки, знижку та ПДВ; числа не виправлено автоматично.')
      if (summary.positions !== undefined && summary.positions !== positions)
        throw Error(summary.location + ': кількість позицій не збігається із заявленою в підсумку. Перевірте пропущені або повторні рядки.')
    }
    earlierSheets += sums[sums.length - 1]
  }
}
