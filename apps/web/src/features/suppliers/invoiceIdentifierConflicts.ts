import type { LineItem } from './invoiceFormModel'

export interface InvoiceIdentifierConflict {
  index: number
  other: number
  field: 'barcode' | 'sku'
  value: string
  message: string
}

const clean = (value: unknown) => String(value ?? '').trim()
const skuKey = (value: unknown) => clean(value).normalize('NFKC').toLocaleUpperCase('uk-UA')
const nameKey = (value: unknown) => clean(value).normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ')
const barcodeKey = (value: unknown) => clean(value).replace(/[\s\-._/]+/g, '')

/**
 * Ті самі правила, що й під час проведення на касі: два різні товари накладної не можуть мати
 * однаковий штрихкод чи артикул, бо другий рядок мовчки ліг би в картку першого.
 * Той самий товар у двох рядках дозволено. Повертає всі конфліктні рядки, а не лише перший.
 */
export function findInvoiceIdentifierConflicts(items: Pick<LineItem, 'product_id' | 'product_name' | 'sku' | 'barcode'>[]): InvoiceIdentifierConflict[] {
  const seen = { barcode: new Map<string, number>(), sku: new Map<string, number>() }
  const sameGoods = (a: typeof items[number], b: typeof items[number]) => a.product_id && b.product_id
    ? a.product_id === b.product_id : nameKey(a.product_name) === nameKey(b.product_name)
  const conflicts: InvoiceIdentifierConflict[] = []
  items.forEach((line, index) => {
    for (const field of ['barcode', 'sku'] as const) {
      const key = field === 'barcode' ? barcodeKey(line.barcode) : skuKey(line.sku)
      if (!key) continue
      const other = seen[field].get(key)
      if (other === undefined) { seen[field].set(key, index); continue }
      if (sameGoods(items[other], line)) continue
      const value = clean(line[field])
      conflicts.push({ index, other, field, value,
        message: `Рядок ${index + 1}: ${field === 'barcode' ? 'штрихкод' : 'артикул'} «${value}» вже є в рядку ${other + 1} з іншим товаром. `
          + 'Виправте штрихкод/артикул в одному з рядків або виберіть ту саму картку.' })
      break
    }
  })
  return conflicts
}

/** Службові мітки проведення потрібні журналу, а не касиру. */
export function receivingErrorText(message: string): { line: number | null; text: string } {
  const line = message.match(/RECEIVING_LINE:(\d+):(?:[a-z-]+:)?\s*([\s\S]*)/)
  if (line) return { line: Number(line[1]), text: line[2] }
  return { line: null, text: message.replace(/RECEIVING_STEP:[a-z-]+:\s*/, '') }
}
