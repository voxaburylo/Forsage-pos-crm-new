import Papa from 'papaparse'
import { parseSupplyText, type AiSupplyInput, type AiSupplyRow } from '@/features/ai/aiSupplyImport'
import { assertSupplyPriceHeader, assertSupplyQuantityHeader } from '@/features/ai/aiSupplySourceGuard'
import { readAiSupplyInput } from '@/features/ai/readAiSupplyInput'
import { cleanImportCell, guessInvoiceImport, makeDraftItem, type InvoiceImportField, type InvoiceImportMapping, type LineItem } from './invoiceFormModel'

const labels: Record<InvoiceImportField, string> = { sku: 'Артикул', name: 'Назва', barcode: 'Штрихкод', unit: 'Одиниця', qty: 'Кількість', purchase: 'Закупівля', retail: 'Ціна продажу', storage_bin: 'Комірка' }
const ordered = Object.keys(labels) as InvoiceImportField[]
type Reader = (input: { text?: string }) => Promise<AiSupplyInput>
export function assertInvoiceSource(parsed: AiSupplyInput): void {
  if (parsed.reviewReason) throw new Error(parsed.reviewReason)
  if (parsed.sourceCurrency) throw new Error(`У файлі ${parsed.sourceCurrency}. Спочатку вкажіть курс у наявному ШІ-розборі; валютну ціну не записано як гривні.`)
}
export function supplyRowsForInvoicePreview(products: AiSupplyRow[]): unknown[][] {
  return [ordered.map(key => labels[key]), ...products.map(p => [p.sku ?? '', p.name, p.barcode ?? '', p.unit ?? 'шт', p.qty, p.purchase_price_uah, p.retail_price_uah ?? '', p.storage_bin ?? ''])]
}
export function supplyRowsToInvoiceItems(products: AiSupplyRow[]): LineItem[] {
  return products.map(p => makeDraftItem({ product_name: p.name, sku: p.sku ?? '', barcode: p.barcode ?? '', unit: p.unit ?? 'шт', qty: p.qty,
    purchase_price: Math.round(p.purchase_price_uah * 100), retail_price: Math.round((p.retail_price_uah ?? 0) * 100), total: Math.round(p.qty * Math.round(p.purchase_price_uah * 100)), storage_bin: p.storage_bin ?? null }))
}

/** Try the exact same local reader as the assistant. Headerless six-column input
 * remains supported, but goes through its strict numeric validation too. */
export async function prepareInvoiceClipboard(text: string, read: Reader = readAiSupplyInput): Promise<{ products?: AiSupplyRow[]; rows?: unknown[][] }> {
  const parsed = await read({ text })
  assertInvoiceSource(parsed)
  if (parsed.products.length) return { products: parsed.products }
  const rows = Papa.parse<string[]>(text, { delimiter: text.includes('\t') ? '\t' : '', skipEmptyLines: 'greedy' }).data
  if (guessInvoiceImport(rows).headerRow !== null) return { rows }
  if (!rows.length || rows.some(row => row.length < 4 || row.length > 6)) throw new Error('Не вдалося визначити колонки. Додайте заголовки «Назва», «Кількість», «Закупівля»; жоден рядок не додано.')
  const legacy = await read({ text: Papa.unparse([['Артикул', 'Назва', 'Кількість', 'Закупівля', 'Ціна продажу', 'Комірка'], ...rows], { delimiter: '\t' }) })
  assertInvoiceSource(legacy)
  if (!legacy.products.length) throw new Error('Не вдалося прочитати всі рядки; жоден товар не додано.')
  return { products: legacy.products }
}

/** Manual mapping changes column roles, never the validation of their values. */
export function buildCheckedInvoiceImport(rows: unknown[][], mapping: InvoiceImportMapping, startRow: number, headerRow: number | null, numericRows?: unknown[][]): { items: LineItem[]; skipped: number; error?: string } {
  if (!rows.length) return { items: [], skipped: 0 }
  try {
    if (mapping.name === null || mapping.qty === null || mapping.purchase === null) throw new Error('Виберіть колонки назви, кількості та закупівельної ціни.')
    const mapped = ordered.filter(key => mapping[key] !== null)
    if (new Set(mapped.map(key => mapping[key])).size !== mapped.length) throw new Error('Одна колонка не може бути кількома полями одночасно.')
    const width = Math.max(...rows.map(row => row.length))
    const original = headerRow === null ? [] : rows[headerRow] ?? []
    if (original.length) {
      assertSupplyPriceHeader(original[mapping.purchase], 'Колонка закупівлі')
      assertSupplyQuantityHeader(original[mapping.qty], 'Колонка кількості')
    }
    const headers = Array.from({ length: width }, (_, index) => cleanImportCell(original[index]) || 'Колонка ' + (index + 1))
    for (const key of mapped) headers[mapping[key]!] = labels[key]
    const selected = rows.slice(startRow).map((row, offset) => row.map((cell, column) => {
      const raw = numericRows?.[startRow + offset]?.[column]
      // Codes keep formatted leading zeroes; numbers keep actual cell precision.
      return [mapping.qty, mapping.purchase, mapping.retail].includes(column) && typeof raw === 'number' ? raw : cell
    })).filter(row => !original.length || JSON.stringify(row.map(cleanImportCell)) !== JSON.stringify(original.map(cleanImportCell)))
    const parsed = parseSupplyText(Papa.unparse([headers, ...selected], { delimiter: '\t' }))
    assertInvoiceSource(parsed)
    if (!parsed.products.length) throw new Error('Не вдалося перевірити всі рядки. Перевірте колонки; жоден товар не пропущено.')
    return { items: supplyRowsToInvoiceItems(parsed.products), skipped: Math.max(0, selected.length - parsed.products.length) }
  } catch (error) { return { items: [], skipped: 0, error: error instanceof Error ? error.message : 'Не вдалося перевірити таблицю.' } }
}

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>
const storageKey = 'forsage:invoice-import:checked-layouts:v1'
function signature(rows: unknown[][], headerRow: number | null): string | null {
  return headerRow === null || !rows[headerRow]?.length ? null : JSON.stringify(rows[headerRow].map(cleanImportCell))
}
export function restoredInvoiceLayout(rows: unknown[][], headerRow: number | null, storage: LayoutStorage = localStorage): InvoiceImportMapping | null {
  const key = signature(rows, headerRow)
  if (!key) return null
  try {
    const value = JSON.parse(storage.getItem(storageKey) ?? '{}')[key] as InvoiceImportMapping | undefined
    const width = rows[headerRow!].length
    if (!value || !ordered.every(field => value[field] === null || (Number.isInteger(value[field]) && value[field]! >= 0 && value[field]! < width))) return null
    const indices = ordered.map(field => value[field]).filter(index => index !== null)
    return new Set(indices).size === indices.length ? value : null
  } catch { return null }
}
export function rememberInvoiceLayout(rows: unknown[][], headerRow: number | null, mapping: InvoiceImportMapping, storage: LayoutStorage = localStorage): void {
  const key = signature(rows, headerRow)
  if (!key) return
  try {
    const saved = JSON.parse(storage.getItem(storageKey) ?? '{}')
    const entries = Object.entries(saved).filter(([previous]) => previous !== key).slice(-9)
    storage.setItem(storageKey, JSON.stringify(Object.fromEntries([...entries, [key, mapping]])))
  } catch { /* Remembering layout must never prevent an invoice import. */ }
}
