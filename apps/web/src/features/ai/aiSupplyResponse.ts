import type { AiSupplyRow } from './aiSupplyImport'
import { MAX_SUPPLY_ROWS, normalizeSupplyRows } from './aiSupplyImport'
import { readSupplyNumber } from './aiSupplyNumber'
import { assertSupplySourceChecks, type SupplySourceCheck } from './aiSupplySourceChecks'

type Metadata = { supplier_id?: string; supplier_name?: string; invoice_number?: string; total_note?: string }
const uah = (kopecks: bigint) => (Number(kopecks) / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' грн'
export class AiSupplyResponseError extends Error {
  constructor(message: string, readonly kind: 'missing-table' | 'invalid-part' | 'conflict' | 'source-mismatch') {
    super(message)
    this.name = 'AiSupplyResponseError'
  }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function validateFields<T>(read: () => T): T {
  try { return read() }
  catch (error) {
    throw new AiSupplyResponseError(error instanceof Error ? error.message : 'Пошкоджені поля таблиці ШІ.', 'invalid-part')
  }
}

/** All-or-nothing boundary: validate every response/action BEFORE flattening rows.
 * Does not deduplicate valid repeated lines or infer missing fields from another part.
 */
export function collectSupplyResponse(responses: readonly unknown[], expectedParts: number, sourceChecks: readonly SupplySourceCheck[] = []): { products: AiSupplyRow[]; metadata: Metadata } {
  if (!Number.isInteger(expectedParts) || expectedParts < 1 || responses.length !== expectedParts)
    throw new AiSupplyResponseError('Отримано не всі частини накладної. Неповну накладну не створено.', 'invalid-part')
  const products: AiSupplyRow[] = []
  const metadata: Metadata = {}
  const invoiceTotals: bigint[] = []
  for (const [partIndex, response] of responses.entries()) {
    const part = 'Частина ' + (partIndex + 1)
    if (!record(response) || !Array.isArray(response.actions) || !response.actions.length)
      throw new AiSupplyResponseError(part + ': ШІ повернув відповідь без таблиці приходу.', 'missing-table')
    for (const action of response.actions) {
      if (!record(action) || !['create_products_bulk', 'create_supply_invoice_bulk'].includes(String(action.tool)))
        throw new AiSupplyResponseError(part + ': ШІ повернув відповідь без таблиці приходу.', 'missing-table')
      if (!record(action.payload) || !Array.isArray(action.payload.products) || !action.payload.products.length)
        throw new AiSupplyResponseError(part + ': одна з таблиць товарів порожня або пошкоджена. Неповну накладну не створено.', 'invalid-part')
      const rawTotal = action.payload.invoice_total
      if (rawTotal !== undefined && rawTotal !== null && rawTotal !== '') {
        const total = BigInt(Math.round(validateFields(() => readSupplyNumber(rawTotal, 'price', part + ': підсумок накладної')) * 100))
        if (!invoiceTotals.includes(total)) invoiceTotals.push(total)
      }
      // 25.11.2026: розбіжність сум сервер описує приміткою (знижка постачальника) — переносимо її в чернетку.
      const serverNote = action.payload.total_note
      if (typeof serverNote === 'string' && serverNote.trim()) metadata.total_note = [metadata.total_note, serverNote.trim().slice(0, 1000)].filter(Boolean).join(' ')
      const rows = action.payload.products
      if (action.count !== undefined && (!Number.isInteger(action.count) || action.count !== rows.length))
        throw new AiSupplyResponseError(part + ': заявлена кількість позицій не збігається з таблицею. Повторіть розбір.', 'invalid-part')
      if (products.length + rows.length > MAX_SUPPLY_ROWS)
        throw new AiSupplyResponseError('За один раз можна розібрати до ' + MAX_SUPPLY_ROWS + ' позицій. Розділіть файл.', 'invalid-part')
      products.push(...validateFields(() => normalizeSupplyRows(rows)))
      for (const key of ['supplier_id', 'supplier_name', 'invoice_number'] as const) {
        const value = action.payload[key]
        if (value === undefined || value === null || value === '') continue
        if (typeof value !== 'string')
          throw new AiSupplyResponseError(part + ': некоректні реквізити накладної. Повторіть розбір.', 'invalid-part')
        const normalized = value.trim()
        if (!normalized) continue
        if (metadata[key] !== undefined && metadata[key] !== normalized)
          throw new AiSupplyResponseError('У частинах різні постачальники або номери накладної. Розділіть документи та повторіть розбір.', 'conflict')
        metadata[key] = normalized
      }
    }
  }
  const sum = products.reduce((total, row) => total + (BigInt(Math.round(row.qty * 1000)) * BigInt(Math.round(row.purchase_price_uah * 100)) + 500n) / 1000n, 0n)
  // 27.11.2026 (PDF власника з колонками «грн» і «$»): частини назвали різні підсумки — не відмова. Береться той, що
  // дорівнює сумі рядків; жоден — помітна примітка (як і для знижки), накладну перевіряє людина.
  const invoiceTotal = invoiceTotals.length > 1 ? invoiceTotals.find(total => total === sum) : invoiceTotals[0]
  if (invoiceTotals.length > 1) {
    const note = 'У частинах різні підсумки накладної: ' + invoiceTotals.map(uah).join(', ') + (invoiceTotal !== undefined
      ? '. Сума рядків ' + uah(sum) + ' збігається з одним із них (інший, імовірно, в іншій валюті).'
      : ', а сума рядків ' + uah(sum) + '. Перевірте рядки й закупівлю перед проведенням.')
    metadata.total_note = [metadata.total_note, note].filter(Boolean).join(' ')
  }
  // 25.11.2026 (власник: «деякі постачальники роблять суму зі знижкою»): не скасовуємо, а пишемо помітну примітку.
  if (invoiceTotal !== undefined && invoiceTotal !== sum) {
    const diff = sum - invoiceTotal
    const note = 'Підсумок накладної ' + uah(invoiceTotal) + ', сума рядків ' + uah(sum) + ' (різниця ' + uah(diff < 0n ? -diff : diff) + (diff > 0n ? ', можлива знижка постачальника' : '') + '). Ціни в рядках — як у джерелі; перевірте закупівлю перед проведенням.'
    metadata.total_note = [metadata.total_note, note].filter(Boolean).join(' ')
  }
  try { assertSupplySourceChecks(products, sourceChecks) }
  catch (error) {
    throw new AiSupplyResponseError('Відповідь ШІ не збігається з підсумком джерела. ' + (error instanceof Error ? error.message : 'Перевірте вихідну таблицю.'), 'source-mismatch')
  }
  return { products, metadata }
}

/**
 * 18.11.2026: з таблиці «Voice LX-303D2» ШІ записав назву «LX-303D4». Для текстових джерел (Excel, буфер)
 * кожен модельний номер у назві має бути у файлі; якщо ні — рядок отримує примітку «перевірте назву».
 */
export function flagNamesNotInSource(products: AiSupplyRow[], sourceText: string): AiSupplyRow[] {
  const source = sourceText.normalize('NFKC').toUpperCase().replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
  if (!source) return products
  return products.map(product => {
    const codes = (product.name.normalize('NFKC').match(/[\p{L}\p{N}]+(?:[-/.][\p{L}\p{N}]+)*/gu) ?? [])
      .filter(token => /\p{L}/u.test(token) && /\d/.test(token) && token.replace(/\D/g, '').length >= 2)
      .map(token => ({ token, key: token.toUpperCase().replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '') }))
      .filter(code => code.key.length >= 4 && !source.includes(code.key))
    if (!codes.length) return product
    const note = `Назва містить «${codes.map(code => code.token).join('», «')}», чого немає у файлі — перевірте назву.`
    return { ...product, purchase_price_note: product.purchase_price_note ? product.purchase_price_note + ' ' + note : note }
  })
}
