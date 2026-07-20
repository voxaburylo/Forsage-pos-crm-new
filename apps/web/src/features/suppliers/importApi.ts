import { api } from '@/lib/api'
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
  items: ImportItem[]
  supplier_id?: string | null
  invoice_number?: string | null
  notes?: string | null
  create_missing?: boolean
  update_retail?: boolean
  mode?: 'replace' | 'add'
}

const normalizeArticle = (raw: string) =>
  raw.replace(/[\s\-./_]/g, '').toUpperCase().replace(/^0+/, '') || raw.toUpperCase()

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

function detectDelimiter(line: string): string {
  return ['\t', ';', ','].reduce((best, candidate) =>
    line.split(candidate).length >= line.split(best).length ? candidate : best)
}
const parseNumber = (raw: string) =>
  Number.parseFloat(raw.replace(/,/g, '.').replace(/[^\d.]/g, ''))

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
    const parsedQty = body.mapping.qty == null ? 1 : (rawQty ? parseNumber(rawQty) : 0)
    const rawRetail = read('retail_price')
    const parsedRetail = rawRetail ? parseNumber(rawRetail) : Number.NaN
    const warnings = priceReview
      ? [rawPrice ? 'Ціну не розпізнано ("' + rawPrice + '") — додано з ціною 0' : 'Ціна відсутня — додано з ціною 0']
      : []
    items.push({
      row, sku, name,
      qty: Number.isNaN(parsedQty) || parsedQty < 0 ? 0 : parsedQty,
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
  const bySku = new Map(products.filter((p) => p.sku).map((p) => [normalizeArticle(p.sku), p]))
  const byBarcode = new Map(products.filter((p) => p.barcode)
    .map((p) => [normalizeBarcode(p.barcode), p] as const))
  const byName = new Map(products.filter((p) => p.name)
    .map((p) => [p.name.trim().toLocaleLowerCase('uk-UA'), p]))
  const items = parsed.items.map((item): ImportItem => {
    let product = item.sku ? bySku.get(normalizeArticle(item.sku)) : undefined
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
      return { ...item, warnings: [...warnings, 'Новий товар (не знайдено в локальній базі)'] }
    }
    return {
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
    }
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

function retailFromSettings(price: number, settings: any): number {
  const rules = Array.isArray(settings?.markup_rules) ? settings.markup_rules : []
  const rule = rules.find((candidate: any) =>
    price >= Number(candidate.minPrice) && price < Number(candidate.maxPrice))
  const result = Math.round(price * (1 + Number(rule?.markupPct ?? 30) / 100))
  if (settings?.price_rounding_enabled !== true) return result
  const step = Math.max(1, Number(settings.price_rounding_step) || 100)
  const scaled = result / step
  const rounded = settings.price_rounding_dir === 'up' ? Math.ceil(scaled)
    : settings.price_rounding_dir === 'down' ? Math.floor(scaled) : Math.round(scaled)
  return rounded * step
}

function productSpecs(product: DesktopProduct): Record<string, string> {
  try {
    const value = JSON.parse(product.specs_json ?? '{}')
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

function existingPayload(product: DesktopProduct, changes: Record<string, unknown>) {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    barcode: product.barcode,
    brand_id: product.brand_id ?? null,
    category_id: product.category_id ?? null,
    unit: product.unit,
    purchase_price: product.purchase_price,
    retail_price: product.retail_price,
    qty_on_hand: Number(product.qty_on_hand),
    reorder_point: Number(product.reorder_point ?? 0),
    notes: product.notes ?? null,
    storage_bin: product.storage_bin,
    is_active: product.is_active === 1,
    is_service: product.is_service === 1,
    is_favorite: product.is_favorite === 1,
    photo_url: product.photo_url ?? null,
    specs: productSpecs(product),
    ...changes,
  }
}

async function localConfirm(body: ConfirmBody):
Promise<{ data: SupplyInvoice | { created: number; updated: number; errors: number } }> {
  const bridge = desktopBridge()
  const save = bridge?.catalog.saveProduct
  if (!bridge || !save) throw new Error('Локальна база недоступна')
  const current = await allLocalProducts()
  const products = new Map(current.map((product) => [product.id, product]))
  const categories = await bridge.catalog.listCategories?.() ?? []
  const categoryIds = new Map(categories.map((category) =>
    [category.name.trim().toLocaleLowerCase('uk-UA'), category.id]))
  for (const item of body.items) {
    const name = item.category_name?.trim()
    const key = name?.toLocaleLowerCase('uk-UA')
    if (name && key && !categoryIds.has(key) && bridge.catalog.createCategory) {
      const category = await bridge.catalog.createCategory(name)
      categoryIds.set(key, category.id)
    }
  }
  const settings = await bridge.catalog.getSettings?.() ?? {}
  const invoiceItems: Array<{ product_id: string; qty: number; purchase_price: number; total: number }> = []
  let created = 0
  let updated = 0
  let errors = 0
  for (const item of body.items) {
    let product = item.product_id ? products.get(item.product_id) : undefined
    if (!product && !body.create_missing) { errors += 1; continue }
    const categoryId = item.category_name
      ? categoryIds.get(item.category_name.trim().toLocaleLowerCase('uk-UA')) ?? null
      : product?.category_id ?? null
    const retail = item.retail_price ?? retailFromSettings(item.price, settings)
    if (!product) {
      product = await save({
        id: crypto.randomUUID(),
        sku: item.sku ? normalizeArticle(item.sku) : 'IMP-' + Date.now() + '-' + item.row,
        name: item.name,
        barcode: item.barcode || null,
        category_id: categoryId,
        unit: 'шт',
        purchase_price: item.price,
        retail_price: retail,
        qty_on_hand: body.supplier_id ? 0 : item.qty,
        reorder_point: 0,
        storage_bin: item.storage_bin || null,
        is_active: true,
      })
      products.set(product.id, product)
      created += 1
    } else if (!body.supplier_id) {
      const nextQty = body.mode === 'add' ? Number(product.qty_on_hand) + item.qty : item.qty
      product = await save(existingPayload(product, {
        sku: item.sku ? normalizeArticle(item.sku) : product.sku,
        name: item.name || product.name,
        barcode: item.barcode || product.barcode,
        category_id: categoryId,
        purchase_price: item.price,
        retail_price: body.update_retail === false ? product.retail_price : retail,
        qty_on_hand: nextQty,
        storage_bin: item.storage_bin || product.storage_bin,
      }))
      products.set(product.id, product)
      updated += 1
    } else if (categoryId && categoryId !== product.category_id) {
      product = await save(existingPayload(product, { category_id: categoryId }))
      products.set(product.id, product)
    }
    if (body.supplier_id) {
      invoiceItems.push({
        product_id: product.id,
        qty: item.qty,
        purchase_price: item.price,
        total: Math.round(item.qty * item.price),
      })
    }
  }
  if (body.supplier_id) {
    if (!invoiceItems.length) throw new Error('Немає товарів для створення накладної')
    const invoice = await bridge.supply?.createInvoice({
      supplier_id: body.supplier_id,
      invoice_number: body.invoice_number ?? null,
      notes: body.notes ?? null,
      items: invoiceItems,
    })
    if (!invoice) throw new Error('Не вдалося створити локальну накладну')
    return { data: invoice as SupplyInvoice }
  }
  return { data: { created, updated, errors } }
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
    return api.post<ParseResult>('/api/v1/import/parse', body)
  },
  preview: async (body: PreviewBody) => {
    if (desktopBridge()?.catalog.listProducts) return localPreview(body)
    return api.post<ParseResult>('/api/v1/import/preview', body)
  },
  confirm: async (body: ConfirmBody): Promise<{ data: any }> => {
    if (desktopBridge()?.catalog.saveProduct) return localConfirm(body)
    return api.post<{ data: SupplyInvoice }>('/api/v1/import/confirm', body)
  },
}
