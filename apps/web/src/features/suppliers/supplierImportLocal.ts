import type { DesktopProduct } from '@/lib/desktopBridge'
import { parseLocaleNumber } from '@/lib/parseDecimal'

export type SupplierImportField = 'sku' | 'barcode' | 'brand' | 'name' | 'qty' | 'price'
export type SupplierImportMapping = Record<SupplierImportField, number | null>

export interface SupplierImportRow {
  source_row: number
  sku: string
  barcode: string
  brand: string
  name: string
  qty: string
  price_kopecks: number
}

export interface SupplierImportBuildResult {
  rows: SupplierImportRow[]
  skipped: number
  errors: Array<{ row: number; error: string }>
}

export interface SupplierProductMatchCandidate {
  id: string
  sku: string
  name: string
  barcode?: string | null
  additional_barcodes?: string[] | null
}

export type SupplierProductMatchKind = 'barcode' | 'sku' | 'name'

export interface SupplierProductMatch {
  product: SupplierProductMatchCandidate | null
  kind: SupplierProductMatchKind | null
  error: string | null
}

export const EMPTY_SUPPLIER_IMPORT_MAPPING: SupplierImportMapping = {
  sku: null,
  barcode: null,
  brand: null,
  name: null,
  qty: null,
  price: null,
}

export const SUPPLIER_IMPORT_FIELDS: Array<{ field: SupplierImportField; label: string; required?: boolean }> = [
  { field: 'sku', label: 'Артикул' },
  { field: 'barcode', label: 'Штрихкод' },
  { field: 'brand', label: 'Бренд' },
  { field: 'name', label: 'Назва товару', required: true },
  { field: 'qty', label: 'Кількість' },
  { field: 'price', label: 'Закупка', required: true },
]

export function normalizeSupplierSku(raw: unknown): string {
  return String(raw ?? '').normalize('NFKC').trim().toLocaleUpperCase('uk-UA')
}

export function normalizeSupplierBarcode(raw: unknown): string {
  const compact = String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[\s\u00a0\u202f-]/g, '')
    .replace(',', '.')
  if (/^\d+(?:\.\d+)?e\+\d+$/i.test(compact)) {
    const numeric = Number(compact)
    if (Number.isSafeInteger(numeric)) return String(numeric)
  }
  return compact.replace(/\.0+$/, '')
}

export function normalizeSupplierProductName(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('uk-UA')
    .replace(/ё/g, 'е')
    .replace(/ґ/g, 'г')
    .replace(/ї/g, 'и')
    .replace(/і/g, 'и')
    .replace(/є/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function cleanSupplierImportCell(raw: unknown): string {
  return String(raw ?? '').replace(/[\s\u00a0\u202f]+/g, ' ').trim()
}

function parseDecimal(raw: unknown): number | null {
  const value = parseLocaleNumber(cleanSupplierImportCell(raw))
  return Number.isFinite(value) ? value : null
}

function isJunkRow(row: unknown[]): boolean {
  const cells = row.map(cleanSupplierImportCell).filter(Boolean)
  if (cells.length === 0) return true
  const text = cells.join(' ').toLocaleLowerCase('uk-UA')
  return /^(итого|разом|всього|підсумок|total|сумма|сума)\b/.test(text)
    || (/\b(страница|сторінка|лист|прайс-лист|дата друку)\b/.test(text) && cells.length <= 3)
}

export function guessSupplierImportMapping(rawRows: unknown[][]): {
  mapping: SupplierImportMapping
  startRow: number
  headerRow: number | null
} {
  let bestMapping: SupplierImportMapping | null = null
  let bestRow = -1
  let bestScore = -1

  rawRows.slice(0, Math.min(rawRows.length, 25)).forEach((row, rowIndex) => {
    const mapping: SupplierImportMapping = { ...EMPTY_SUPPLIER_IMPORT_MAPPING }
    let score = 0
    row.forEach((cell, index) => {
      const header = cleanSupplierImportCell(cell).toLocaleLowerCase('uk-UA')
      if (!header) return
      if (mapping.barcode == null && /штрих.?код|barcode|ean|шк\b/.test(header)) { mapping.barcode = index; score += 3 }
      else if (mapping.sku == null && /артикул|sku|article|код товар|код$|^код\b|номенклатура.*код/.test(header)) { mapping.sku = index; score += 2 }
      else if (mapping.name == null && /назв|наймен|наимен|товар|product|description|номенклатур|модель/.test(header) && !/код|родител|батьк/.test(header)) { mapping.name = index; score += 3 }
      else if (mapping.qty == null && /кільк|к-сть|кол-во|количество|qty|quantity|остаток|залиш/.test(header)) { mapping.qty = index; score += 2 }
      else if (mapping.price == null && /закуп|вхідн|собіварт|цін|цен|price|cost|вартість|purchase/.test(header)) { mapping.price = index; score += 3 }
      else if (mapping.brand == null && /бренд|виробн|производ|brand|manufacturer|mfr/.test(header)) { mapping.brand = index; score += 1 }
    })
    if (score > bestScore) {
      bestMapping = mapping
      bestRow = rowIndex
      bestScore = score
    }
  })

  if (bestMapping && bestScore >= 4) {
    return { mapping: bestMapping, startRow: bestRow + 1, headerRow: bestRow }
  }
  return {
    mapping: { sku: 0, barcode: null, brand: null, name: 1, qty: 2, price: 3 },
    startRow: 0,
    headerRow: null,
  }
}

export function buildSupplierImportRows(
  rawRows: unknown[][],
  mapping: SupplierImportMapping,
  startRow: number,
): SupplierImportBuildResult {
  const rows: SupplierImportRow[] = []
  const errors: Array<{ row: number; error: string }> = []
  let skipped = 0
  const safeStart = Math.max(0, Math.min(Number.isFinite(startRow) ? startRow : 0, rawRows.length))

  for (let index = safeStart; index < rawRows.length; index += 1) {
    const rawRow = rawRows[index] ?? []
    if (isJunkRow(rawRow)) { skipped += 1; continue }
    const read = (field: SupplierImportField) => mapping[field] == null
      ? ''
      : cleanSupplierImportCell(rawRow[mapping[field] as number])
    const sku = read('sku')
    const barcode = normalizeSupplierBarcode(read('barcode'))
    const name = read('name')
    const sourceRow = index + 1

    if (!sku && !barcode && !name) { skipped += 1; continue }
    if (!name) {
      errors.push({ row: sourceRow, error: 'Відсутня назва товару' })
      continue
    }

    const rawPrice = read('price')
    const price = mapping.price == null ? null : parseDecimal(rawPrice)
    if (price == null || price < 0) {
      errors.push({ row: sourceRow, error: `Невірна закупівельна ціна: «${rawPrice || 'порожньо'}»` })
      continue
    }

    const rawQty = read('qty')
    const qty = mapping.qty == null ? 0 : parseDecimal(rawQty)
    rows.push({
      source_row: sourceRow,
      sku,
      barcode,
      brand: read('brand'),
      name,
      qty: String(qty != null && qty >= 0 ? qty : 0),
      price_kopecks: Math.round(price * 100),
    })
  }

  return { rows, skipped, errors }
}

function pushIndex(map: Map<string, SupplierProductMatchCandidate[]>, key: string, product: SupplierProductMatchCandidate): void {
  if (!key) return
  const existing = map.get(key) ?? []
  if (!existing.some((candidate) => candidate.id === product.id)) existing.push(product)
  map.set(key, existing)
}

export interface SupplierProductMatchIndex {
  barcode: Map<string, SupplierProductMatchCandidate[]>
  sku: Map<string, SupplierProductMatchCandidate[]>
  name: Map<string, SupplierProductMatchCandidate[]>
}

export function buildSupplierProductMatchIndex(
  products: SupplierProductMatchCandidate[],
): SupplierProductMatchIndex {
  const index: SupplierProductMatchIndex = {
    barcode: new Map(),
    sku: new Map(),
    name: new Map(),
  }
  for (const product of products) {
    pushIndex(index.sku, normalizeSupplierSku(product.sku), product)
    pushIndex(index.name, normalizeSupplierProductName(product.name), product)
    for (const barcode of [product.barcode, ...(product.additional_barcodes ?? [])]) {
      pushIndex(index.barcode, normalizeSupplierBarcode(barcode), product)
    }
  }
  return index
}

function uniqueCandidates(candidates: SupplierProductMatchCandidate[]): SupplierProductMatchCandidate[] {
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]
}

export function matchSupplierImportRow(
  row: Pick<SupplierImportRow, 'sku' | 'barcode' | 'name'>,
  index: SupplierProductMatchIndex,
): SupplierProductMatch {
  const barcodeKey = normalizeSupplierBarcode(row.barcode)
  const skuKey = normalizeSupplierSku(row.sku)
  const nameKey = normalizeSupplierProductName(row.name)
  const barcodeMatches = barcodeKey ? uniqueCandidates(index.barcode.get(barcodeKey) ?? []) : []
  const skuMatches = skuKey ? uniqueCandidates(index.sku.get(skuKey) ?? []) : []

  if (barcodeMatches.length > 1) {
    return { product: null, kind: null, error: `Штрихкод «${row.barcode}» належить кільком товарам. Потрібне ручне виправлення.` }
  }
  if (skuMatches.length > 1) {
    return { product: null, kind: null, error: `Артикул «${row.sku}» належить кільком товарам. Потрібне ручне виправлення.` }
  }
  if (barcodeMatches.length === 1 && skuMatches.length === 1 && barcodeMatches[0].id !== skuMatches[0].id) {
    return { product: null, kind: null, error: `Штрихкод і артикул рядка «${row.name}» належать різним товарам.` }
  }
  if (barcodeMatches.length === 1) return { product: barcodeMatches[0], kind: 'barcode', error: null }
  if (skuMatches.length === 1) return { product: skuMatches[0], kind: 'sku', error: null }

  const nameMatches = nameKey ? uniqueCandidates(index.name.get(nameKey) ?? []) : []
  if (nameMatches.length > 1) {
    return { product: null, kind: null, error: `Повна назва «${row.name}» збігається з кількома товарами. Вкажіть точний штрихкод або артикул.` }
  }
  if (nameMatches.length === 1) return { product: nameMatches[0], kind: 'name', error: null }
  return { product: null, kind: null, error: null }
}

export function desktopProductsWithBarcodes(
  products: DesktopProduct[],
  barcodes: Array<{ product_id: string; barcode: string }>,
): SupplierProductMatchCandidate[] {
  const extras = new Map<string, string[]>()
  for (const row of barcodes) {
    const values = extras.get(row.product_id) ?? []
    if (!values.includes(row.barcode)) values.push(row.barcode)
    extras.set(row.product_id, values)
  }
  return products.map((product) => ({
    id: product.id,
    sku: product.sku,
    name: product.name,
    barcode: product.barcode,
    additional_barcodes: extras.get(product.id) ?? [],
  }))
}
