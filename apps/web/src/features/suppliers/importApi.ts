import { api } from '@/lib/api'
import { durableImport } from '@/lib/durableImport'
import { useAuthStore } from '@/stores/authStore'
import { parseLocaleNumber } from '@/lib/parseDecimal'
import { desktopBridge, type DesktopProduct } from '@/lib/desktopBridge'
import type { SupplyInvoice } from '@/types/supplier'
import type { ParsedItem } from '@crm-forsage/shared'

export interface ImportItem extends ParsedItem {
  category_name?: string | null
  price_review?: boolean
  old_price?: number | null
  old_qty?: number | null
  old_retail_price?: number | null
}
export interface PreviewConflict { row: number; sku?: string; name?: string; reason: string }
export interface ParseResult {
  supplier_id: string | null | undefined
  items: ImportItem[]
  total_items: number
  matched_count: number
  new_count: number
  conflicts: PreviewConflict[]
  summary: { toCreate: number; toUpdate: number; conflicts: number }
}
interface ColumnMap {
  sku?: number | null
  name?: number | null
  category?: number | null
  qty?: number | null
  price?: number | null
  retail_price?: number | null
  barcode?: number | null
  storage_bin?: number | null
}
interface PreviewBody {
  text: string
  mapping: ColumnMap
  supplier_id?: string | null
}
interface ConfirmBody {
  client_identity?: string
  items: ImportItem[]
  supplier_id?: string | null
  invoice_number?: string | null
  notes?: string | null
  create_missing?: boolean
  update_retail?: boolean
  mode?: 'replace' | 'add'
}

const normalizeArticle = (raw: string) =>
  raw.trim().normalize('NFKC').toUpperCase()

function normalizeBarcode(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const compact = raw.replace(/\s+/g, '').replace(',', '.')
  if (/^\d+\.0+$/.test(compact)) return compact.replace(/\.0+$/, '')
  if (/^\d+(?:\.\d+)?e\+\d+$/i.test(compact)) {
    const numeric = Number(compact)
    if (Number.isSafeInteger(numeric)) return String(numeric)
  }
  return compact
}

export function parseImportQuantity(raw: string): number {
  const text = raw.trim().replace(/[\s\u00a0]/g, '')
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(text)) return Number.NaN
  return Number(text.replace(',', '.'))
}

function detectDelimiter(line: string): string {
  return ['\t', ';', ','].reduce((best, candidate) =>
    line.split(candidate).length >= line.split(best).length ? candidate : best)
}
const parseNumber = (raw: string) => parseLocaleNumber(raw)

function hasHeader(line: string, separator: string, mapping: PreviewBody['mapping']): boolean {
  const cells = line.split(separator).map((cell) => cell.trim().replace(/^["']|["']$/g, ''))
  const qty = mapping.qty == null ? null : parseNumber(cells[mapping.qty] ?? '')
  const price = mapping.price == null ? null : parseNumber(cells[mapping.price] ?? '')
  const name = mapping.name == null ? '' : cells[mapping.name] ?? ''
  return (qty !== null && Number.isNaN(qty))
    || (price !== null && Number.isNaN(price))
    || /назв|товар|наймен|name|product|description/i.test(name)
}

function parseLines(body: PreviewBody): { items: ImportItem[]; conflicts: PreviewConflict[] } {
  const lines = body.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n').filter((line) => line.trim())
  if (!lines.length) throw new Error('Файл порожній')
  const separator = detectDelimiter(lines[0])
  const start = hasHeader(lines[0], separator, body.mapping) ? 1 : 0
  const items: ImportItem[] = []
  const conflicts: PreviewConflict[] = []
  const seenSkus = new Set<string>()
  const seenBarcodes = new Set<string>()
  for (let index = start; index < lines.length; index += 1) {
    const cells = lines[index].split(separator).map((cell) => cell.trim().replace(/^["']|["']$/g, ''))
    const read = (key: keyof ColumnMap) => body.mapping[key] == null
      ? '' : (cells[body.mapping[key] as number] ?? '').trim()
    const row = index + 1
    const name = read('name')
    const sku = read('sku')
    const barcode = normalizeBarcode(read('barcode'))
    if (!name) {
      conflicts.push({ row, sku, reason: 'Відсутня назва товару' })
      continue
    }
    const skuKey = sku ? normalizeArticle(sku) : ''
    if (skuKey && seenSkus.has(skuKey)) {
      conflicts.push({ row, sku, name, reason: 'Дублікат артикулу в імпортованому файлі' })
      continue
    }
    if (barcode && seenBarcodes.has(barcode)) {
      conflicts.push({ row, sku, name, reason: 'Дублікат штрихкоду в імпортованому файлі' })
      continue
    }
    if (skuKey) seenSkus.add(skuKey)
    if (barcode) seenBarcodes.add(barcode)
    const rawPrice = read('price')
    const parsedPrice = parseNumber(rawPrice)
    const priceReview = Number.isNaN(parsedPrice) || parsedPrice < 0
    const rawQty = read('qty')
    const parsedQty = body.mapping.qty == null ? 1 : parseImportQuantity(rawQty)
    if (!Number.isFinite(parsedQty) || parsedQty < 0) {
      conflicts.push({ row, sku, name, reason: 'Некоректна кількість: ' + (rawQty || '(порожньо)') })
      continue
    }
    const rawRetail = read('retail_price')
    const parsedRetail = rawRetail ? parseNumber(rawRetail) : Number.NaN
    const warnings = priceReview
      ? [rawPrice ? 'Ціну не розпізнано ("' + rawPrice + '") — додано з ціною 0' : 'Ціна відсутня — додано з ціною 0']
      : []
    items.push({
      row, sku, name,
      qty: parsedQty,
      price: priceReview ? 0 : Math.round(parsedPrice * 100),
      retail_price: Number.isNaN(parsedRetail) || parsedRetail < 0 ? null : Math.round(parsedRetail * 100),
      barcode,
      storage_bin: read('storage_bin') || null,
      category_name: read('category') || null,
      matched: false,
      product_id: null,
      match_quality: 'new',
      warnings,
      price_review: priceReview || undefined,
    })
  }
  if (!items.length) throw new Error('Не знайдено жодного рядка з товарами. Перевірте формат файлу.')
  return { items, conflicts }
}

async function allLocalProducts(): Promise<DesktopProduct[]> {
  const list = desktopBridge()?.catalog.listProducts
  if (!list) return []
  const products: DesktopProduct[] = []
  for (let offset = 0; ; offset += 500) {
    const page = await list({ limit: 500, offset })
    products.push(...page.data)
    if (products.length >= page.total || page.data.length === 0) break
  }
  return products
}

async function localPreview(body: PreviewBody): Promise<ParseResult> {
  const parsed = parseLines(body)
  const products = await allLocalProducts()
  const productById = new Map(products.map((p) => [p.id, p]))
  const bySku = new Map(products.filter((p) => p.sku).map((p) => [normalizeArticle(p.sku), p]))
  const byBarcode = new Map(products.filter((p) => p.barcode)
    .map((p) => [normalizeBarcode(p.barcode), p] as const))
  const aliases = await desktopBridge()?.catalog.listProductBarcodes?.() ?? []
  for (const alias of aliases) {
    const normalized = normalizeBarcode(alias.barcode)
    const product = productById.get(alias.product_id)
    if (normalized && product && !byBarcode.has(normalized)) byBarcode.set(normalized, product)
  }
  const byName = new Map(products.filter((p) => p.name)
    .map((p) => [p.name.trim().toLocaleLowerCase('uk-UA'), p]))
  const keyCounts = new Map<string, number>()
  for (const p of products) for (const key of ['sku:' + normalizeArticle(p.sku ?? ''), 'name:' + p.name.trim().toLocaleLowerCase('uk-UA')]) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
  const ambiguous = (key: string, field: 'sku' | 'name') => (keyCounts.get(field + ':' + key) ?? 0) > 1
  const items = parsed.items.flatMap((item): ImportItem[] => {
    let product = item.sku ? bySku.get(normalizeArticle(item.sku)) : undefined
    const barcodeProduct = item.barcode ? byBarcode.get(normalizeBarcode(item.barcode)) : undefined
    if ((product && barcodeProduct && product.id !== barcodeProduct.id) || (item.sku && ambiguous(normalizeArticle(item.sku), 'sku'))
      || (!product && !barcodeProduct && ambiguous(item.name.trim().toLocaleLowerCase('uk-UA'), 'name'))) {
      parsed.conflicts.push({ row: item.row, sku: item.sku, name: item.name, reason: 'Неоднозначний збіг або артикул і штрихкод належать різним товарам' })
      return []
    }
    let quality: 'exact' | 'fuzzy' | 'new' = product ? 'exact' : 'new'
    const warnings = [...(item.warnings ?? [])]
    if (!product && item.barcode) {
      product = byBarcode.get(normalizeBarcode(item.barcode))
      if (product) { quality = 'exact'; warnings.push('Збіг за штрихкодом') }
    }
    if (!product) {
      product = byName.get(item.name.trim().toLocaleLowerCase('uk-UA'))
      if (product) {
        quality = 'fuzzy'
        warnings.push('Знайдено за назвою (артикул/штрихкод не збігається)')
      }
    }
    if (!product) {
      return [{ ...item, warnings: [...warnings, 'Новий товар (не знайдено в локальній базі)'] }]
    }
    return [{
      ...item,
      sku: item.sku || product.sku,
      barcode: item.barcode || product.barcode,
      storage_bin: item.storage_bin || product.storage_bin,
      matched: true,
      product_id: product.id,
      match_quality: quality,
      warnings,
      old_price: product.purchase_price,
      old_qty: product.qty_on_hand,
      old_retail_price: product.retail_price,
    }]
  })
  const matched = items.filter((item) => item.matched).length
  return {
    supplier_id: body.supplier_id,
    items,
    total_items: items.length,
    matched_count: matched,
    new_count: items.length - matched,
    conflicts: parsed.conflicts,
    summary: { toCreate: items.length - matched, toUpdate: matched, conflicts: parsed.conflicts.length },
  }
}

async function localConfirm(body: ConfirmBody): Promise<{ data: any }> {
  const apply = desktopBridge()?.catalog.applyBatch
  if (!apply) throw new Error('Для безпечного імпорту запустіть оновлену локальну програму')
  return durableImport('catalog-import:' + useAuthStore.getState().session?.user.id, body.client_identity ?? JSON.stringify(body), body,
    (operation_id, payload) => apply({ operation_id, kind: 'import', payload }))
}

function guessMapping(text: string): PreviewBody['mapping'] {
  const first = text.replace(/\r\n/g, '\n').split('\n').find((line) => line.trim()) ?? ''
  const cells = first.split(detectDelimiter(first)).map((cell) => cell.trim().toLowerCase())
  const mapping: PreviewBody['mapping'] = {}
  cells.forEach((cell, index) => {
    if (/артикул|sku|код|article/i.test(cell)) mapping.sku = index
    else if (/назв|товар|наймен|name|product|description/i.test(cell)) mapping.name = index
    else if (/кільк|к-сть|qty|кол-во|quantity|залиш/i.test(cell)) mapping.qty = index
    else if (/цін|price|cost|вартість|purchase/i.test(cell)) mapping.price = index
  })
  if (mapping.name == null) throw new Error('Не вдалося визначити колонку назви товару')
  return mapping
}

export const importApi = {
  parse: async (body: { text: string; supplier_id?: string | null }) => {
    if (desktopBridge()?.catalog.listProducts) {
      return localPreview({ ...body, mapping: guessMapping(body.text) })
    }
    return api.post<ParseResult>('/api/v1/import/parse', body, undefined, { timeoutMs: 180_000 })
  },
  preview: async (body: PreviewBody) => {
    if (desktopBridge()?.catalog.listProducts) return localPreview(body)
    return api.post<ParseResult>('/api/v1/import/preview', body, undefined, { timeoutMs: 180_000 })
  },
  confirm: async (body: ConfirmBody): Promise<{ data: any }> => {
    if (desktopBridge()?.catalog.saveProduct) return localConfirm(body)
    return api.post<{ data: SupplyInvoice }>('/api/v1/import/confirm', body, undefined, { timeoutMs: 180_000 })
  },
}
