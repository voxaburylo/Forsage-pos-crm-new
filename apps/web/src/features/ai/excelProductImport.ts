import * as XLSX from 'xlsx'

export interface ExcelImportProduct {
  sku: string
  name: string
  barcode?: string
  category_name?: string
  qty_on_hand: number
  purchase_price_uah?: number
  retail_price_uah?: number
}

export interface ParsedExcelProducts {
  text: string
  products: ExcelImportProduct[]
  skippedRows: number
  categoryCount: number
}

type ColumnKey = 'name' | 'qty' | 'barcode' | 'sku' | 'category' | 'purchase' | 'retail'
type ColumnMap = Partial<Record<ColumnKey, number>>

function text(value: unknown): string {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim()
}

function header(value: unknown): string {
  return text(value).toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ')
}

function classifyHeader(value: unknown): ColumnKey | null {
  const valueText = header(value)
  if (!valueText) return null
  if (valueText.includes('штрихкод') || valueText.includes('штрих-код') || valueText === 'barcode') return 'barcode'
  if (valueText.includes('остаток') || valueText.includes('залишок') || valueText === 'кількість' || valueText === 'количество') return 'qty'
  if (
    valueText.includes('номенклатура.родител')
    || valueText.includes('номенклатура родител')
    || valueText.includes('родительская номенклатура')
    || valueText.includes('батьківська номенклатура')
  ) return 'category'
  if (
    valueText.includes('номенклатура.код')
    || valueText.includes('номенклатура код')
    || valueText === 'код'
    || valueText.includes('артикул')
    || valueText === 'sku'
  ) return 'sku'
  if (valueText.includes('закупоч') || valueText.includes('закупівел') || valueText.includes('закупка')) return 'purchase'
  if (valueText.includes('рознич') || valueText.includes('роздріб') || valueText.includes('продаж')) return 'retail'
  if (
    valueText.includes('ценовая группа')
    || valueText.includes('характеристика номенклатуры')
    || valueText === 'номенклатура'
    || valueText === 'назва'
    || valueText === 'наименование'
  ) return 'name'
  return null
}

function detectColumns(rows: unknown[][]): { headerRow: number; columns: ColumnMap } | null {
  let best: { headerRow: number; columns: ColumnMap; score: number } | null = null
  const scanLimit = Math.min(rows.length, 100)

  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
    const columns: ColumnMap = {}
    rows[rowIndex].forEach((cell, columnIndex) => {
      const key = classifyHeader(cell)
      if (key && columns[key] === undefined) columns[key] = columnIndex
    })
    const score = Object.keys(columns).length
    if (columns.name !== undefined && score >= 2 && (!best || score > best.score)) {
      best = { headerRow: rowIndex, columns, score }
    }
  }

  return best ? { headerRow: best.headerRow, columns: best.columns } : null
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  let normalized = text(value)
    .replace(/[₴грнuahшт\s]/gi, '')
    .replace(/[^\d,.-]/g, '')
  if (!normalized) return undefined

  const comma = normalized.lastIndexOf(',')
  const dot = normalized.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) {
    if (comma > dot) normalized = normalized.replace(/\./g, '').replace(',', '.')
    else normalized = normalized.replace(/,/g, '')
  } else if (comma >= 0) {
    normalized = normalized.replace(',', '.')
  }

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

function valueAt(row: unknown[], index: number | undefined): unknown {
  return index === undefined ? undefined : row[index]
}

function safeGeneratedSku(sheetIndex: number, excelRow: number): string {
  return `XLS-${sheetIndex + 1}-${excelRow}`
}

export function parseProductsWorkbook(buffer: ArrayBuffer): ParsedExcelProducts {
  const workbook = XLSX.read(buffer, { type: 'array', cellText: true, cellNF: true })
  const products: ExcelImportProduct[] = []
  const textParts: string[] = []
  const categories = new Set<string>()
  let skippedRows = 0

  workbook.SheetNames.forEach((sheetName, sheetIndex) => {
    const sheet = workbook.Sheets[sheetName]
    textParts.push(`# Лист: ${sheetName}\n${XLSX.utils.sheet_to_csv(sheet)}`)
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    })
    const detected = detectColumns(rows)
    if (!detected) return

    for (let rowIndex = detected.headerRow + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]
      const name = text(valueAt(row, detected.columns.name))
      const visibleValues = row.map(text).filter(Boolean)
      if (visibleValues.length === 0) continue
      if (!name) {
        skippedRows += 1
        continue
      }

      const barcode = text(valueAt(row, detected.columns.barcode))
      const sourceSku = text(valueAt(row, detected.columns.sku))
      const category = text(valueAt(row, detected.columns.category))
      const qty = number(valueAt(row, detected.columns.qty))
      const purchase = number(valueAt(row, detected.columns.purchase))
      const retail = number(valueAt(row, detected.columns.retail))
      const product: ExcelImportProduct = {
        sku: sourceSku || barcode || safeGeneratedSku(sheetIndex, rowIndex + 1),
        name,
        qty_on_hand: Math.max(0, qty ?? 0),
      }
      if (barcode) product.barcode = barcode
      if (category) {
        product.category_name = category
        categories.add(category.toLocaleLowerCase('uk-UA'))
      }
      if (purchase !== undefined) product.purchase_price_uah = Math.max(0, purchase)
      if (retail !== undefined) product.retail_price_uah = Math.max(0, retail)
      products.push(product)
    }
  })

  return {
    text: textParts.join('\n\n'),
    products,
    skippedRows,
    categoryCount: categories.size,
  }
}
