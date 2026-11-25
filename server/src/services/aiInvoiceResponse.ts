import { AppError } from '../middleware/errorHandler.js'

type InvoiceRow = { name: string; qty: number; purchase_price_uah: number; [key: string]: string | number }
type InvoicePage = { supplier_name?: string; invoice_number?: string; invoice_total?: number; total_note?: string; products: InvoiceRow[] }
const uah = (kopecks: bigint) => (Number(kopecks) / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' грн'
const invalidInvoice = (message: string): never => { throw new AppError('AI_INVALID_RESPONSE', message + ' Неповну накладну не створено; повторіть розбір.', 422) }
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function invoiceNumber(value: unknown, quantity: boolean, location: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') return invalidInvoice(location + ': не розпізнано ' + (quantity ? 'кількість.' : 'закупівельну ціну.'))
  const text = String(value).trim().replace(',', '.')
  const valid = quantity ? /^\d+(?:\.\d{1,3})?$/.test(text) : /^\d+(?:\.\d{1,2})?$/.test(text)
  const number = Number(text)
  if (!valid || !Number.isFinite(number) || number < 0 || (quantity && number === 0) || number > (quantity ? 1_000_000 : 21_474_836.47)) {
    return invalidInvoice(location + ': некоректна ' + (quantity ? 'кількість.' : 'закупівельна ціна або сума.'))
  }
  return number
}

function assertPhotoInvoiceCurrency(value: unknown, location: string): void {
  if (value === undefined || value === null || value === '') return
  if (typeof value !== 'string' || !/^(?:UAH|грн\.?|₴|гривн[аяіи])$/i.test(value.trim())) {
    return invalidInvoice(location + ': валюта закупівлі не є гривнею або не розпізнана. Використайте таблицю з явно вказаною валютою та курсом; автоматичної конвертації фото немає.')
  }
}


type PageControl = {
  number?: number; count?: number; invoice?: bigint; page?: bigint
  brought?: bigint; carried?: bigint; sum: bigint; location: string; rows: number
}
const present = (value: unknown) => value !== undefined && value !== null && value !== ''
const rowKopecks = (row: InvoiceRow) =>
  (BigInt(Math.round(row.qty * 1000)) * BigInt(Math.round(row.purchase_price_uah * 100)) + 500n) / 1000n

function pageOrdinal(value: unknown, location: string): number | undefined {
  if (!present(value)) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10_000)
    return invalidInvoice(location + ': некоректна нумерація сторінок.')
  return value
}
function printedMoney(value: unknown, location: string): bigint | undefined {
  if (!present(value)) return undefined
  return BigInt(Math.round(invoiceNumber(value, false, location + ': сума підсумку') * 100))
}
function samePrintedTotal(a: bigint | undefined, b: bigint | undefined, location: string): bigint | undefined {
  if (a !== undefined && b !== undefined && a !== b) return invalidInvoice(location + ': на фото різні підсумки.')
  return a ?? b
}

/** A footer photo may have no goods, but it must carry an explicit printed control total. */
export function hasAiInvoicePhotoContent(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.products) && (value.products.length > 0 ||
    ['invoice_total', 'page_total', 'brought_forward_total', 'carried_forward_total'].some(key => present(value[key])))
}

/**
 * Sum rounded line kopecks. Never allocate VAT/discounts or silently drop repeated goods.
 * 25.11.2026 (власник: «деякі постачальники роблять суму зі знижкою»): розбіжність СУМ більше не скасовує розбір —
 * вона стає помітною приміткою в чернетці, яку все одно перевіряє й проводить людина. Плутанина сторінок — і далі помилка.
 */
function checkPrintedTotals(controls: PageControl[]): { total?: number; notes: string[] } {
  const notes: string[] = []
  let invoice: bigint | undefined
  let count: number | undefined
  let sum = 0n
  const groups = new Map<string, PageControl>()
  for (const [index, control] of controls.entries()) {
    invoice = samePrintedTotal(invoice, control.invoice, 'Загальний підсумок накладної')
    sum += control.sum
    if (control.count !== undefined) {
      if (count !== undefined && count !== control.count) return invalidInvoice('На фото різна кількість сторінок накладної.')
      count = control.count
    }
    // A close-up of the final amount is evidence, not a new physical page.
    if (control.rows === 0 && control.number === undefined && control.page === undefined && control.brought === undefined && control.carried === undefined) continue
    const key = control.number === undefined ? 'photo:' + index : 'page:' + control.number
    const group = groups.get(key)
    if (!group) groups.set(key, { ...control })
    else {
      group.sum += control.sum
      group.page = samePrintedTotal(group.page, control.page, 'Підсумок сторінки ' + control.number)
      group.brought = samePrintedTotal(group.brought, control.brought, 'Перенесена сума сторінки ' + control.number)
      group.carried = samePrintedTotal(group.carried, control.carried, 'Перенесена сума сторінки ' + control.number)
    }
  }
  const pages = [...groups.values()]
  const numbered = pages.every(page => page.number !== undefined)
  if (count !== undefined && !numbered)
    return invalidInvoice('Не вдалося перевірити всі сторінки накладної. Додайте фото з читабельною нумерацією сторінок.')
  if (numbered) {
    pages.sort((a, b) => a.number! - b.number!)
    if ((count !== undefined && pages.length !== count) || pages.some((page, index) => page.number !== index + 1))
      return invalidInvoice('Додано не всі сторінки накладної або їхня нумерація суперечлива.')
  }
  if (!numbered && pages.length > 1 && pages.some(page => page.brought !== undefined || page.carried !== undefined))
    return invalidInvoice('Не вдалося визначити порядок сторінок для перевірки перенесеної суми. Додайте фото з номерами сторінок.')
  let cumulative = 0n
  for (const page of pages) {
    // 25.11.2026 (власник: «веб не розпізнає фото накладної»; фото 3 — низ накладної з підсумком): без номерів сторінок
    // підсумок на фото, що дорівнює сумі товарів УСІХ фото до нього включно, — це підсумок накладної, а не сторінки.
    const runningTotal = !numbered && page.page !== undefined && page.page !== page.sum && page.page === cumulative + page.sum
    if (page.page !== undefined && page.page !== page.sum && !runningTotal) {
      // Пронумерована сторінка — строго: два фото однієї сторінки подвоїли б товар на складі.
      if (numbered) return invalidInvoice(page.location + ': підсумок сторінки не збігається з її товарами. Перевірте пропущені або повторні рядки.')
      notes.push(page.location + ': підсумок сторінки ' + uah(page.page) + ', а сума рядків ' + uah(page.sum) + ' — перевірте знижку, пропущені або повторні рядки.')
    }
    if (page.brought !== undefined && page.brought !== cumulative)
      return invalidInvoice(page.location + ': перенесена сума з попередніх сторінок не збігається.')
    cumulative += page.sum
    if (page.carried !== undefined && page.carried !== cumulative)
      return invalidInvoice(page.location + ': перенесена сума на наступну сторінку не збігається.')
  }
  if (invoice !== undefined && invoice !== sum) {
    const diff = sum - invoice
    notes.push('Підсумок накладної ' + uah(invoice) + ', сума рядків ' + uah(sum) + ' (різниця ' + uah(diff < 0n ? -diff : diff) + (diff > 0n ? ', можлива знижка постачальника' : '') + '). Ціни в рядках — як надруковано; перевірте закупівлю перед проведенням.')
    return { notes }
  }
  return { total: invoice === undefined ? undefined : Number(invoice) / 100, notes }
}

/** Validate every photo and row before publishing a proposal; no guessed 1/0 or filtered rows. */
export function mergeAiInvoicePages(pages: readonly unknown[]): InvoicePage {
  const merged: InvoicePage = { products: [] }
  const controls: PageControl[] = []
  for (const [pageIndex, page] of pages.entries()) {
    const location = 'Фото ' + (pageIndex + 1)
    if (!isRecord(page) || !Array.isArray(page.products) || !hasAiInvoicePhotoContent(page)) return invalidInvoice(location + ': відсутня таблиця товарів.')
    const control: PageControl = {
      number: pageOrdinal(page.page_number, location), count: pageOrdinal(page.page_count, location),
      invoice: printedMoney(page.invoice_total, location), page: printedMoney(page.page_total, location),
      brought: printedMoney(page.brought_forward_total, location), carried: printedMoney(page.carried_forward_total, location),
      sum: 0n, location, rows: page.products.length,
    }
    controls.push(control)
    assertPhotoInvoiceCurrency(page.currency, location)
    if (merged.products.length + page.products.length > 2000) return invalidInvoice('У накладній більше 2000 позицій. Розділіть її на частини.')
    for (const key of ['supplier_name', 'invoice_number'] as const) {
      const value = page[key]
      if (value === undefined || value === null || value === '') continue
      if (typeof value !== 'string') return invalidInvoice(location + ': некоректні реквізити накладної.')
      const text = value.trim()
      if (!text) continue
      if (merged[key] !== undefined && merged[key] !== text) return invalidInvoice('На фото різні постачальники або номери накладної.')
      merged[key] = text
    }
    for (const [index, raw] of page.products.entries()) {
      const rowLocation = location + ', рядок ' + (index + 1)
      if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name.trim()) return invalidInvoice(rowLocation + ': відсутня назва товару.')
      assertPhotoInvoiceCurrency(raw.currency, rowLocation)
      const product: InvoiceRow = {
        name: raw.name.trim(), qty: invoiceNumber(raw.qty, true, rowLocation),
        purchase_price_uah: invoiceNumber(raw.purchase_price_uah, false, rowLocation),
      }
      for (const key of ['sku','brand_name','category_name','barcode','unit','source_name','purchase_price_note']) {
        const value = raw[key]
        if (value === undefined || value === null || value === '') continue
        if (typeof value !== 'string') return invalidInvoice(rowLocation + ': некоректне текстове поле «' + key + '».')
        if (value.trim()) product[key] = value.trim()
      }
      if (raw.line_total !== undefined && raw.line_total !== null && raw.line_total !== '') {
        const total = invoiceNumber(raw.line_total, false, rowLocation)
        const expected = rowKopecks(product)
        // 25.11.2026: сума рядка зі знижкою — не помилка розбору, а примітка до рядка; ціну не підмінюємо.
        if (expected !== BigInt(Math.round(total * 100))) {
          const note = 'Сума рядка в накладній ' + uah(BigInt(Math.round(total * 100))) + ', а кількість × ціна = ' + uah(expected) + ' — можлива знижка, перевірте закупівлю.'
          product.purchase_price_note = product.purchase_price_note ? product.purchase_price_note + ' ' + note : note
        }
        product.line_total = total
      }
      merged.products.push(product)
      control.sum += rowKopecks(product)
    }
  }
  if (!merged.products.length) return invalidInvoice('Відсутня таблиця товарів.')
  const checked = checkPrintedTotals(controls)
  if (checked.total !== undefined) merged.invoice_total = checked.total
  if (checked.notes.length) merged.total_note = checked.notes.join(' ')
  return merged
}

function parseObjectCandidate(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === 'string') return parseObjectCandidate(parsed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function parseAiJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim()
  if (!text) return null

  const candidates = new Set<string>([text])
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim()
  if (fenced) candidates.add(fenced)

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.add(text.slice(firstBrace, lastBrace + 1))
  }

  for (const candidate of candidates) {
    const parsed = parseObjectCandidate(candidate)
    if (parsed) return parsed
  }
  return null
}
