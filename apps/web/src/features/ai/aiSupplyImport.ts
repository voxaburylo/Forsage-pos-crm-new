import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import { readSupplyBlocks } from './aiSupplyBlocks'
import { readSupplySourceChecks, type SupplySourceCheck, type SupplySourceSheet } from './aiSupplySourceChecks'
import { readSupplyNumber as decimal, supplyNumberAliases, assertSupplyLineTotal } from './aiSupplyNumber'
import type { AiPendingAction } from './aiApi'
import { isSupplySummaryLabel, readSupplySummary, assertSupplySummaries, type SupplySummary, type SupplySummaryGroup } from './aiSupplySummary'
import { assertSupplyAnnotation, assertSupplyPriceHeader, assertSupplyQuantityHeader, assertSupplyCurrency, supplyRowUnit } from './aiSupplySourceGuard'

export const MAX_SUPPLY_ROWS = 2000
export const MAX_SUPPLY_TEXT = 1_000_000
export interface AiSupplyRow {
  name: string; source_name?: string; sku?: string; barcode?: string; category_name?: string; brand?: string; unit?: string
  qty: number; purchase_price_uah: number; purchase_price_note?: string
}
// For a foreign-currency source, parsed price values are still in source currency;
// they MUST be converted before constructing an invoice action.
export interface AiSupplyInput { text: string; products: AiSupplyRow[]; categoryCount: number; reviewReason?: string; sourceCurrency?: string; sourceChecks?: SupplySourceCheck[] }
type Column = 'name' | 'sku' | 'barcode' | 'category_name' | 'brand' | 'unit' | 'qty' | 'purchase_price_uah' | 'line_total' | 'currency'
const clean = (v: unknown) => String(v ?? '').replace(/\u00a0/g, ' ').trim()
function field(value: unknown): Column | null {
  const h = clean(value).toLocaleLowerCase('uk-UA').replace(/[._-]+/g, ' ').replace(/\s+/g, ' ')
  if (/^(сума|сумма|сума рядка|сумма строки|line total|amount|total)(?:\s*[,(/]?\s*(?:грн|uah|₴|usd|eur|pln|\$|€)\s*\)?)?$/.test(h)) return 'line_total'
  if (/^(валюта|валюта закупівлі|валюта закупки|currency|purchase currency)$/.test(h)) return 'currency'
  if (/^(штрих\s?код|barcode|ean|ean13|ean 13|шк)$/.test(h)) return 'barcode'
  if (/^(артикул.*|sku|article|код|код товару|код товара|номенклатура код)$/.test(h)) return 'sku'
  if (/^(назва.*|найменування.*|наименование.*|товар|product|description|номенклатура|name)$/.test(h)) return 'name'
  if (/^(кількість.*|к сть|количество.*|кол во|qty|quantity)$/.test(h)) return 'qty'
  if (/^(ціна|цена|price|закуп.*|ціна закуп.*|цена закуп.*|закупівельна.*|purchase.*|cost.*|buy price|ціна за.*|цена за.*)(?:\s*[,()]?.*)?$/.test(h) && !/сум|total|продаж|роздр|рознич|retail|sale|sell/.test(h)) return 'purchase_price_uah'
  if (/^(категор.*|папка|група|группа|category|номенклатура родител.*|батьківська номенклатура)$/.test(h)) return 'category_name'
  if (/^(бренд|brand|виробник|производитель)$/.test(h)) return 'brand'
  if (/^(одиниця.*|од\.? вим.*|ед\.? изм.*|unit)$/.test(h)) return 'unit'
  return null
}



// Printed invoices (including 1C TDSheet) contain totals and signatures after goods.
// A brand such as "Total Quartz" is a product, not a total. Never stop reading at a footer.
function isServiceRow(values: string[], columns: Partial<Record<Column, number>>, location: string): boolean {
  const label = values.find(Boolean) ?? ''
  const normalized = label.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim()
  const summary = isSupplySummaryLabel(label)
  const total = summary || /^(?:сума пдв|сумма ндс|пдв|ндс|без пдв|без ндс|у тому числі пдв|в т\.?\s*ч\.?\s*пдв|в т\.?\s*ч\.?\s*ндс)(?:\s|:|$)/.test(normalized)
  const signature = /^(?:відпустив|відвантажив|отримав|отримувач|отпустил|получил|одержав|підпис|подпись|за довіреністю|по доверенности)(?:\s|:|$)/.test(normalized)
  if (!total && !signature) return false
  const data = (key: Column) => { const index = columns[key]; const value = index === undefined ? '' : values[index]; return value && value !== label ? value : '' }
  // A row with an independent identifier or unit price may still be a real product.
  if (data('sku') || data('barcode')) return false
  if (summary && data('qty') && data('purchase_price_uah')) throw new Error(location + ': рядок схожий і на товар, і на підсумок. Уточніть кількість, закупівлю та суму; рядок не пропущено.')
  if (!summary && data('purchase_price_uah')) return false
  return !signature || !data('qty')
}

function isAmountInWords(values: string[], afterSummary: boolean): boolean {
  const cells = values.filter(Boolean)
  if (!afterSummary || cells.length !== 1) return false
  const text = cells[0].toLocaleLowerCase('uk-UA')
  return /^(?:нуль|ноль|один|одна|два|дві|две|три|чотири|четыре|п['’ʼ]?ять|пять|шість|шесть|сім|семь|вісім|восемь|дев['’ʼ]?ять|девять|десять|одинадцять|одиннадцать|дванадцять|двенадцать|тринадцять|тринадцать|чотирнадцять|четырнадцать|п['’ʼ]?ятнадцять|пятнадцать|шістнадцять|шестнадцать|сімнадцять|семнадцать|вісімнадцять|восемнадцать|дев['’ʼ]?ятнадцять|девятнадцать|двадцять|двадцать|тридцять|тридцать|сорок|п['’ʼ]?ятдесят|пятьдесят|шістдесят|шестьдесят|сімдесят|семьдесят|вісімдесят|восемьдесят|дев['’ʼ]?яносто|девяносто|сто|двісті|двести|триста|чотириста|четыреста|п['’ʼ]?ятсот|пятьсот|шістсот|шестьсот|сімсот|семьсот|вісімсот|восемьсот|дев['’ʼ]?ятсот|девятьсот|тисяча|тысяча)(?:\s|$)/.test(text)
    && /(?:грив[ен]|долар|доллар|євро|евро|злот|копій|копе|цент)/.test(text)
}

interface ParsedRows { products: AiSupplyRow[] | null; reviewReason?: string; currencyText?: string; summaries?: SupplySummary[] }
function parseRows(rows: unknown[][], sheet: string, rawRows = rows, rowOffset = 0): ParsedRows {
  let headerRow = -1, columns: Partial<Record<Column, number>> = {}
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const found: Partial<Record<Column, number>> = {}
    const duplicates = new Set<Column>()
    rows[i].forEach((v, index) => { const key = field(v); if (!key) return; if (found[key] !== undefined) duplicates.add(key); else found[key] = index })
    if (found.name !== undefined && found.qty !== undefined && found.purchase_price_uah !== undefined) {
      if (duplicates.size) throw new Error(`«${sheet}»: кілька колонок одного типу. Залиште одну назву, кількість отриманого товару та закупівельну ціну за одиницю; артикул і штрихкод — в окремих колонках.`)
      headerRow = i; columns = found; break
    }
  }
  if (headerRow < 0) {
    const summaries: SupplySummary[] = []
    for (const [index, row] of rows.entries()) {
      if (!row.some(value => clean(value))) continue
      const summary = readSupplySummary(row, 0, `«${sheet}», рядок ${rowOffset + index + 1}`, { rawValues: rawRows[index] })
      // Only explicitly document-wide totals may occupy a separate summary sheet.
      if (!summary || summary.kind !== 'document' || (summary.amount === undefined && summary.positions === undefined)) return { products: null }
      summaries.push(summary)
    }
    return summaries.length ? { products: [], summaries, currencyText: rows.map(row=>row.map(clean).join(' ')).join('\n') } : { products: null }
  }
  const products: AiSupplyRow[] = []
  const summaries: SupplySummary[] = []
  const headers = rows[headerRow]
  const headerLocation = `«${sheet}», рядок ${rowOffset + headerRow + 1}`
  assertSupplyPriceHeader(headers[columns.purchase_price_uah!], headerLocation)
  assertSupplyQuantityHeader(headers[columns.qty!], headerLocation)
  const preHeaderCurrency: string[] = []
  for (const [index, row] of rows.slice(0,headerRow).entries()) {
    const currencyIndex = row.findIndex(cell => /^(?:валюта|currency)\s*:?$/i.test(clean(cell)))
    if (currencyIndex >= 0) assertSupplyCurrency(row.slice(currencyIndex+1).map(clean).filter(Boolean).join(' '), headerLocation)
    const summary = readSupplySummary(row, 0, `«${sheet}», рядок ${rowOffset + index + 1}`, { rawValues: rawRows[index] })
    if (summary) {
      if (summary.kind !== 'document' && summary.kind !== 'brought')
        throw Error(summary.location + ': уточніть підсумок перед таблицею: «Разом за накладною» або «Перенос з попередньої сторінки».')
      summaries.push(summary)
    }
    if (summary || row.some(cell => /валют|currency/i.test(clean(cell)))) preHeaderCurrency.push(row.map(clean).join(' '))
  }
  const currencyLines = [headers[columns.purchase_price_uah!], columns.line_total === undefined ? '' : headers[columns.line_total],
    ...preHeaderCurrency].map(value => 'Ціна: ' + clean(value))
  const annotations = headers.flatMap((header,index) => field(header) ? [] : [{ header, index }])
  let afterSummary = false
  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i], values = row.map(clean)
    if (!values.some(Boolean)) continue
    if (values.every((v, index) => !v || v === clean(rows[headerRow][index]))) continue
    const location = `«${sheet}», рядок ${rowOffset + i + 1}`
    if (isServiceRow(values, columns, location)) {
      const label = values.find(Boolean) ?? ''
      const summary = readSupplySummary(row, products.length, location, { quantityColumn: columns.qty, rawValues: rawRows[i] })
      if (summary) summaries.push(summary)
      else assertSupplyAnnotation(label, values.filter(value => value && value !== label).join(' ') || label, location, headers[columns.purchase_price_uah!])
      currencyLines.push(values.join(' ')); afterSummary = true; continue
    }
    if (isAmountInWords(values, afterSummary)) continue
    const name = values[columns.name!]
    if (!values[columns.qty!] && !values[columns.purchase_price_uah!]) {
      const label = values.find(Boolean) ?? ''
      assertSupplyAnnotation(label, values.filter(value => value && value !== label).join(' ') || label, location, headers[columns.purchase_price_uah!])
    }
    if (!name || (!values[columns.qty!] && !values[columns.purchase_price_uah!]) || values.slice(rows[headerRow].length).some(Boolean)) {
      return { products: null, reviewReason: `${location}: нестандартний рядок або оформлення накладної. Потрібен AI-розбір усього файлу — жоден рядок не пропущено.` }
    }
    for (const { header, index } of annotations) assertSupplyAnnotation(header, row[index], location, headers[columns.purchase_price_uah!])
    const numericValue = (column: number) => typeof rawRows[i]?.[column] === 'number' ? rawRows[i][column] : row[column]
    if (columns.currency !== undefined && values[columns.currency]) {
      assertSupplyCurrency(values[columns.currency], location)
      currencyLines.push('Валюта: ' + values[columns.currency])
    }
    currencyLines.push('Ціна: ' + values[columns.purchase_price_uah!])
    const rawPrice = numericValue(columns.purchase_price_uah!)
    const price = typeof rawPrice === 'string' ? rawPrice.replace(/\s*(?:USD|EUR|PLN|\$|€)\s*$/i, '') : rawPrice
    const product: AiSupplyRow = { name, qty: decimal(numericValue(columns.qty!), 'qty', location), purchase_price_uah: decimal(price, 'price', location) }
    for (const key of ['sku', 'barcode', 'category_name', 'brand', 'unit'] as const) {
      const index = columns[key], value = index === undefined ? '' : clean(row[index])
      if (value) product[key] = value
    }
    const unit = supplyRowUnit(headers[columns.qty!], row[columns.qty!], headers[columns.purchase_price_uah!], product.unit, location)
    if (unit) product.unit = unit
    if (columns.line_total !== undefined && values[columns.line_total]) {
      currencyLines.push('Сума: ' + values[columns.line_total])
      const rawTotal = numericValue(columns.line_total)
      const total = typeof rawTotal === 'string' ? rawTotal.replace(/\s*(?:USD|EUR|PLN|\$|€)\s*$/i, '') : rawTotal
      assertSupplyLineTotal(product.qty, product.purchase_price_uah, total, location)
    }
    products.push(product)
    afterSummary = false
    if (products.length > MAX_SUPPLY_ROWS) throw new Error(`За один раз можна розібрати до ${MAX_SUPPLY_ROWS} позицій. Розділіть файл.`)
  }
  return { products, summaries, currencyText: currencyLines.join('\n') }
}

function result(text: string, products: AiSupplyRow[], reviewReason?: string, currencyText = text, summaryGroups: SupplySummaryGroup[] = []): AiSupplyInput {
  if (!text.trim()) throw new Error('Таблиця порожня')
  if (text.length > MAX_SUPPLY_TEXT || products.length > MAX_SUPPLY_ROWS) throw new Error(`Таблиця завелика. Розділіть її на частини до ${MAX_SUPPLY_ROWS} позицій.`)
  const currencies = new Set<string>()
  for (const line of currencyText.split(/\r?\n/)) {
    if (!/(?:валют|currency|ціна|цена|price|закуп|сума|суму|сумм|разом|всього|усього|итого|total)/i.test(line)) continue
    if (/\bUAH\b|₴|грн|грив/i.test(line)) currencies.add('UAH')
    if (/\bUSD\b|\$|долар|доллар/i.test(line)) currencies.add('USD')
    if (/\bEUR\b|€|євро|евро/i.test(line)) currencies.add('EUR')
    if (/\bPLN\b|злот/i.test(line)) currencies.add('PLN')
  }
  if (currencies.size > 1) throw new Error('У накладній кілька валют. Розділіть товари за валютою, щоб не змішати закупівельні ціни.')
  assertSupplySummaries(summaryGroups)
  const sourceCurrency = [...currencies].find(currency => currency !== 'UAH')
  return { text, products, categoryCount: new Set(products.map(p => p.category_name).filter(Boolean)).size, ...(reviewReason ? { reviewReason } : {}), ...(sourceCurrency ? { sourceCurrency } : {}) }
}

export function readSupplyExchangeRate(text: string): number {
  const value = text.trim().replace(',', '.')
  const rate = Number(value)
  if (!/^\d+(?:\.\d{1,6})?$/.test(value) || !Number.isFinite(rate) || rate <= 0 || rate > 100000) throw new Error('Вкажіть курс: скільки гривень за 1 одиницю валюти накладної.')
  return rate
}

export function convertSupplyPrices(products: AiSupplyRow[], rate: number): AiSupplyRow[] {
  readSupplyExchangeRate(String(rate))
  const scaledRate = BigInt(Math.round(rate * 1_000_000))
  return products.map(product => {
    const cents = (BigInt(Math.round(product.purchase_price_uah * 100)) * scaledRate + 500_000n) / 1_000_000n
    if (cents > 2_147_483_647n) throw new Error('Ціна після перерахунку завелика. Перевірте курс.')
    return { ...product, purchase_price_uah: Number(cents) / 100 }
  })
}

export function parseSupplyText(text: string): AiSupplyInput {
  if (text.length > MAX_SUPPLY_TEXT) throw new Error('Текст завеликий — розділіть його на частини')
  const normalized = text.replace(/^\uFEFF/, '')
  const blocks = readSupplyBlocks(normalized)
  if (blocks) {
    const products = normalizeSupplyRows(blocks.rows)
    return result(normalized, products, undefined, blocks.currencyText, [{ products, summaries: blocks.summaries }])
  }
  const parsed = Papa.parse<string[]>(normalized, { delimiter: normalized.includes('\t') ? '\t' : '' })
  if (parsed.errors.some(error => error.code !== 'UndetectableDelimiter')) throw new Error('Не вдалося прочитати межі колонок. Перевірте лапки й розділювачі в таблиці.')
  const rows = parseRows(parsed.data, 'Буфер / текст')
  const parsedInput = result(normalized, rows.products ?? [], rows.reviewReason, rows.currencyText ?? normalized, rows.products ? [{ products: rows.products, summaries: rows.summaries ?? [] }] : [])
  if (rows.products === null) parsedInput.sourceChecks = readSupplySourceChecks([{ name:'Буфер / текст', rows:parsed.data, text:normalized }])
  return parsedInput
}

export function parseSupplyWorkbook(buffer: ArrayBuffer): AiSupplyInput {
  const workbook = XLSX.read(buffer, { type: 'array', cellText: true, cellNF: true })
  const products: AiSupplyRow[] = [], texts: string[] = [], currencyTexts: string[] = []
  const summaryGroups: SupplySummaryGroup[] = []
  const sourceSheets: SupplySourceSheet[] = []
  let complete = true
  let reviewReason: string | undefined
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet['!ref']) continue
    const range = XLSX.utils.decode_range(sheet['!ref'])
    if (range.e.r > 10000 || range.e.c > 100) throw new Error(`Аркуш «${sheetName}» завеликий. Залиште тільки таблицю товарів.`)
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith('!')) continue
      // Some 1C exports mark empty styled/merged cells as type e without an error value.
      const hasValue = cell?.v !== undefined && cell?.v !== null
      if ((cell?.t === 'e' && (hasValue || cell.f)) || (cell?.f && !hasValue)) throw new Error(`Аркуш «${sheetName}», ${address}: клітинка або формула не має коректного збереженого результату. Перерахуйте й збережіть файл в Excel; значення не підставлено.`)
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true })
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '', blankrows: true })
    if (!rows.some(row => row.some(v => clean(v)))) continue
    const csv = XLSX.utils.sheet_to_csv(sheet)
    texts.push(`# Лист: ${sheetName}\n${csv}`)
    sourceSheets.push({ name:sheetName, rows, rawRows, rowOffset:range.s.r })
    const parsed = parseRows(rows, sheetName, rawRows, range.s.r)
    if (parsed.products === null) complete = false
    else {
      products.push(...parsed.products)
      summaryGroups.push({ products: parsed.products, summaries: parsed.summaries ?? [] })
    }
    currencyTexts.push(parsed.currencyText ?? csv)
    reviewReason ??= parsed.reviewReason
    if (products.length > MAX_SUPPLY_ROWS) throw new Error(`За один раз можна розібрати до ${MAX_SUPPLY_ROWS} позицій. Розділіть файл.`)
  }
  // An unrecognized second sheet must not silently disappear from the document.
  const parsedInput = result(texts.join('\n\n'), complete ? products : [], reviewReason, currencyTexts.join('\n'), complete ? summaryGroups : [])
  if (!complete) parsedInput.sourceChecks = readSupplySourceChecks(sourceSheets)
  return parsedInput
}

export function supplyImportAction(products: AiSupplyRow[], source: string): AiPendingAction {
  return {
    id: `supply-table-${crypto.randomUUID()}`, tool: 'create_supply_invoice_bulk', title: 'Перевірте товари для приходу', changes: [], count: products.length,
    columns: ['Артикул', 'Назва', 'Кількість', 'Закупка', 'Штрихкод', 'Папка'],
    items: products.map(p => ({ 'Артикул': p.sku || '—', 'Назва': p.name, 'Кількість': String(p.qty), 'Закупка': `${p.purchase_price_uah.toFixed(2)} грн`, 'Штрихкод': p.barcode || '—', 'Папка': p.category_name || 'Автоматично / перевірити' })),
    payload: { products, notes: `Розібрано в AI-помічнику: ${source}. Перевірте нові товари та проскануйте штрихкоди. Ціна продажу — за таблицею націнок.` + products.flatMap((p,index) => p.purchase_price_note ? [`\n${index+1}. ${p.name}: ${p.purchase_price_note}`] : []).join('') },
  }
}

/** AI output gets the same strict review as spreadsheet input; no guessed defaults. */
export function normalizeSupplyRows(value: unknown): AiSupplyRow[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SUPPLY_ROWS) throw new Error('AI не повернув коректну таблицю товарів. Уточніть назви, кількість і закупівельні ціни.')
  return value.map((raw, index) => {
    const location = `Рядок ${index + 1}`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${location}: некоректні дані товару`)
    const rawName = raw.name ?? raw.title ?? raw.description
    if (typeof rawName !== 'string') throw new Error(`${location}: некоректна назва товару`)
    const name = clean(rawName)
    if (!name) throw new Error(`${location}: немає назви товару`)
    const result: AiSupplyRow = { name,
      qty: supplyNumberAliases(raw, ['qty','quantity','qty_on_hand'], 'qty', location),
      purchase_price_uah: supplyNumberAliases(raw, ['purchase_price_uah','purchase_price','cost_price'], 'price', location),
    }
    for (const [key, val] of Object.entries({ sku: raw.sku ?? raw.article ?? raw.part_number ?? raw.oem_number,
      barcode: raw.barcode ?? raw.ean, category_name: raw.category_name ?? raw.category ?? raw.folder_name,
      brand: raw.brand_name ?? raw.brand, unit: raw.unit, source_name: raw.source_name, purchase_price_note: raw.purchase_price_note })) {
      if (val !== undefined && val !== null && typeof val !== 'string') throw new Error(`${location}: поле «${key}» має бути текстом, без підміни значення.`)
      if (clean(val)) Object.assign(result, { [key]: clean(val) })
    }
    const unit = supplyRowUnit('', raw.qty ?? raw.quantity ?? raw.qty_on_hand, '', result.unit, location)
    if (unit) result.unit = unit
    for (const key of ['line_total', 'total_price', 'purchase_total_uah']) {
      if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') assertSupplyLineTotal(result.qty, result.purchase_price_uah, raw[key], location)
    }
    return result
  })
}
