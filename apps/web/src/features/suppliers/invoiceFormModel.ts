/**
 * Чиста частина форми прихідної накладної: типи, чернетка в localStorage,
 * розбір імпортованого прайсу, округлення роздрібної ціни.
 *
 * Винесено з `InvoiceFormPage.tsx` (2904 рядки) — див. `REFACTOR_PLAN.md`,
 * ітерація 4. Тут немає жодного React-стану: усе, що можна перевірити без
 * браузера, тепер лежить окремо від екрана.
 */
import { parseLocaleNumber } from '@/lib/parseDecimal'
import type { Product, ProductFormData } from '@/types/product'
import type { SupplyInvoice } from '@/types/supplier'
export interface LineItem {
  product_id?: string
  product_name: string
  sku: string
  barcode?: string | null
  unit?: ProductFormData['unit'] | string
  qty: number
  purchase_price: number
  retail_price: number
  category_id: string | null
  total: number
  storage_bin?: string | null
  photo_url?: string | null
  is_new?: boolean
  client_key: string
}
export type InvoicePaymentMethod = 'cash' | 'card' | 'transfer'
export type SupplierPaymentFundSource = 'cashbox' | 'owner_funds' | 'bank_account' | 'business_card'
export type InvoiceFundSource = SupplierPaymentFundSource | 'split_cashbox_owner'

export interface SupplyInvoiceLocalDraft {
  supplierId: string
  invoiceNumber: string
  notes: string
  items: LineItem[]
  paidAmount: string
  cashboxPaidAmount?: string
  payFullNow?: boolean
  paymentMethod: InvoicePaymentMethod
  fundSource: InvoiceFundSource
  postImmediately: boolean
  serverInvoiceId?: string | null
  savedAt: string
}

export function supplyInvoiceDraftKey(scope: string) {
  return 'forsage:supply-invoice:' + scope + ':draft:v2'
}

export function loadSupplyInvoiceDraft(key: string): SupplyInvoiceLocalDraft | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const draft = JSON.parse(raw) as Partial<SupplyInvoiceLocalDraft>
    if (!Array.isArray(draft.items)) return null
    return {
      supplierId: String(draft.supplierId ?? ''),
      invoiceNumber: String(draft.invoiceNumber ?? ''),
      notes: String(draft.notes ?? ''),
      items: draft.items.map((item) => ({
        ...item,
        client_key: item.client_key || makeLineKey(),
        qty: Number(item.qty) || 0,
        purchase_price: Number(item.purchase_price) || 0,
        retail_price: Number(item.retail_price) || 0,
        total: Number(item.total) || 0,
        category_id: item.category_id ?? null,
      })) as LineItem[],
      paidAmount: String(draft.paidAmount ?? ''),
      cashboxPaidAmount: String(draft.cashboxPaidAmount ?? ''),
      payFullNow: draft.payFullNow === true,
      paymentMethod: draft.paymentMethod === 'card' || draft.paymentMethod === 'transfer' ? draft.paymentMethod : 'cash',
      fundSource: draft.fundSource === 'owner_funds' || draft.fundSource === 'bank_account' || draft.fundSource === 'business_card' || draft.fundSource === 'split_cashbox_owner'
        ? draft.fundSource
        : 'cashbox',
      postImmediately: draft.postImmediately !== false,
      serverInvoiceId: typeof draft.serverInvoiceId === 'string' ? draft.serverInvoiceId : null,
      savedAt: String(draft.savedAt ?? new Date().toISOString()),
    }
  } catch {
    return null
  }
}

export function saveSupplyInvoiceDraft(key: string, draft: Omit<SupplyInvoiceLocalDraft, 'savedAt'>) {
  localStorage.setItem(key, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }))
}

export function clearSupplyInvoiceDraft(key: string) {
  localStorage.removeItem(key)
}

export type SupplyInvoiceDraftData = Omit<SupplyInvoiceLocalDraft, 'savedAt'>

export function hasSupplyInvoiceDraftContent(draft: SupplyInvoiceDraftData): boolean {
  return Boolean(
    draft.supplierId || draft.invoiceNumber.trim() || draft.notes.trim() || draft.paidAmount.trim() || draft.items.length > 0,
  )
}

export function normalizeSupplyInvoiceDraftItems(items: unknown): LineItem[] {
  return (Array.isArray(items) ? items : []).map((raw) => {
    const item = raw as Partial<LineItem>
    const qty = Number(item.qty) || 0
    const purchase = Number(item.purchase_price) || 0
    return {
      ...item,
      client_key: item.client_key || makeLineKey(),
      product_id: item.product_id || undefined,
      product_name: String(item.product_name ?? ''),
      sku: String(item.sku ?? ''),
      barcode: item.barcode ?? '',
      unit: normalizeInvoiceUnit(item.unit),
      qty,
      purchase_price: purchase,
      retail_price: Number(item.retail_price) || 0,
      category_id: item.category_id ?? null,
      total: Number(item.total) || Math.round(qty * purchase),
      storage_bin: item.storage_bin ?? null,
      photo_url: item.photo_url ?? null,
      is_new: item.is_new === true,
    } as LineItem
  })
}

export function invoiceItemsToLineItems(inv: SupplyInvoice): LineItem[] {
  return (inv.items ?? []).map((i) => ({
    client_key: makeLineKey(),
    product_id: i.product_id,
    product_name: i.product?.name ?? 'Товар #' + i.product_id.slice(0, 8),
    qty: i.qty,
    purchase_price: i.purchase_price,
    retail_price: i.product?.retail_price ?? 0,
    category_id: (i.product as any)?.category_id ?? null,
    total: i.total,
    storage_bin: i.product?.storage_bin ?? null,
    sku: i.product?.sku ?? '',
    barcode: (i.product as any)?.barcode ?? '',
    unit: normalizeInvoiceUnit((i.product as any)?.unit),
    photo_url: (i.product as any)?.photo_url ?? null,
  }))
}

export function draftFromServerInvoice(inv: SupplyInvoice): SupplyInvoiceLocalDraft | null {
  const rawPayload = inv.draft_payload as Partial<SupplyInvoiceLocalDraft> | null | undefined
  const payloadHasItems = Array.isArray(rawPayload?.items)
  const savedAt = String(inv.draft_saved_at ?? rawPayload?.savedAt ?? inv.updated_at ?? new Date().toISOString())
  if (rawPayload && payloadHasItems) {
    return {
      supplierId: String(rawPayload.supplierId ?? inv.supplier_id ?? ''),
      invoiceNumber: String(rawPayload.invoiceNumber ?? inv.invoice_number ?? ''),
      notes: String(rawPayload.notes ?? inv.notes ?? ''),
      items: normalizeSupplyInvoiceDraftItems(rawPayload.items),
      paidAmount: String(rawPayload.paidAmount ?? ''),
      paymentMethod: rawPayload.paymentMethod === 'card' || rawPayload.paymentMethod === 'transfer' ? rawPayload.paymentMethod : 'cash',
      fundSource: rawPayload.fundSource === 'owner_funds' || rawPayload.fundSource === 'bank_account' || rawPayload.fundSource === 'business_card' || rawPayload.fundSource === 'split_cashbox_owner'
        ? rawPayload.fundSource
        : 'cashbox',
      postImmediately: rawPayload.postImmediately !== false,
      serverInvoiceId: inv.id,
      savedAt,
    }
  }
  if (inv.status === 'draft' && (inv.items?.length ?? 0) > 0) {
    return {
      supplierId: inv.supplier_id ?? '',
      invoiceNumber: inv.invoice_number ?? '',
      notes: inv.notes ?? '',
      items: invoiceItemsToLineItems(inv),
      paidAmount: inv.paid_amount ? kopecksForForm(inv.paid_amount) : '',
      paymentMethod: inv.payment_method === 'card' || inv.payment_method === 'transfer' ? inv.payment_method : 'cash',
      fundSource: 'cashbox',
      postImmediately: false,
      serverInvoiceId: inv.id,
      savedAt,
    }
  }
  return null
}

export function newestSupplyInvoiceDraft(localDraft: SupplyInvoiceLocalDraft | null, serverDraft: SupplyInvoiceLocalDraft | null): SupplyInvoiceLocalDraft | null {
  if (!localDraft) return serverDraft
  if (!serverDraft) return localDraft
  const localTime = Date.parse(localDraft.savedAt || '') || 0
  const serverTime = Date.parse(serverDraft.savedAt || '') || 0
  return serverTime > localTime ? serverDraft : localDraft
}


export function persistSupplyInvoiceDraft(key: string, draft: SupplyInvoiceDraftData) {
  const hasDraft = hasSupplyInvoiceDraftContent(draft) || Boolean(draft.serverInvoiceId)
  if (!hasDraft) {
    clearSupplyInvoiceDraft(key)
    return
  }
  saveSupplyInvoiceDraft(key, draft)
}

export type InvoiceImportField = 'sku' | 'name' | 'barcode' | 'unit' | 'qty' | 'purchase' | 'retail' | 'storage_bin'
export type InvoiceImportMapping = Record<InvoiceImportField, number | null>

export const EMPTY_INVOICE_IMPORT_MAPPING: InvoiceImportMapping = {
  sku: null,
  name: null,
  barcode: null,
  unit: null,
  qty: null,
  purchase: null,
  retail: null,
  storage_bin: null,
}

export const INVOICE_IMPORT_FIELDS: Array<{ field: InvoiceImportField; label: string; required?: boolean }> = [
  { field: 'sku', label: 'Артикул' },
  { field: 'name', label: 'Назва товару', required: true },
  { field: 'barcode', label: 'Штрихкод' },
  { field: 'unit', label: 'Од. виміру' },
  { field: 'qty', label: 'Кількість' },
  { field: 'purchase', label: 'Закупка', required: true },
  { field: 'retail', label: 'Продаж' },
  { field: 'storage_bin', label: 'Комірка' },
]

export function normalizeSkuValue(raw: string): string {
  return raw.trim().toLocaleUpperCase('uk-UA')
}

export function normalizeBarcodeValue(raw: unknown): string {
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

export function normalizeExactInvoiceProductName(raw: unknown): string {
  return String(raw ?? '')
    .toLocaleLowerCase('uk-UA')
    .replace(/\s+/g, ' ')
    .trim()
}

export function findExactProductForQuery(query: string, products: Product[]): Product | null {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) return null

  const normalizedSku = normalizeSkuValue(trimmedQuery)
  const normalizedBarcode = normalizeBarcodeValue(trimmedQuery)
  const identifierMatches = products.filter((product) => {
    const skuMatches = Boolean(product.sku?.trim()) && normalizeSkuValue(product.sku) === normalizedSku
    const barcodes = [product.barcode, ...(product.additional_barcodes ?? [])]
      .map(normalizeBarcodeValue)
      .filter(Boolean)
    return skuMatches || Boolean(normalizedBarcode && barcodes.includes(normalizedBarcode))
  })
  const uniqueIdentifierMatches = [...new Map(identifierMatches.map((product) => [product.id, product])).values()]
  if (uniqueIdentifierMatches.length === 1) return uniqueIdentifierMatches[0]
  if (uniqueIdentifierMatches.length > 1) return null

  const normalizedName = normalizeExactInvoiceProductName(trimmedQuery)
  const nameMatches = products.filter((product) => normalizeExactInvoiceProductName(product.name) === normalizedName)
  const uniqueNameMatches = [...new Map(nameMatches.map((product) => [product.id, product])).values()]
  return uniqueNameMatches.length === 1 ? uniqueNameMatches[0] : null
}
export function parseDecimalInput(raw: unknown, fallback = 0): number {
  const value = parseLocaleNumber(raw)
  return Number.isFinite(value) ? value : fallback
}

export function parseMoneyToKopecks(raw: unknown): number {
  const value = parseDecimalInput(raw, 0)
  if (value < 0) return 0
  return Math.round(value * 100)
}

export function parseQty(raw: unknown, fallback = 1): number {
  const value = parseDecimalInput(raw, fallback)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function normalizeInvoiceUnit(raw: unknown): ProductFormData['unit'] {
  const text = String(raw ?? '').trim().toLocaleLowerCase('uk-UA')
  if (/^(кг|kg|кілограм|килограмм)/.test(text)) return 'кг'
  if (/^(компл|комплект|комплекты|комплекти|set)/.test(text)) return 'компл'
  if (/^(л|літр|литр|liter)/.test(text)) return 'л'
  if (/^(м|метр|meter)/.test(text)) return 'м'
  return 'шт'
}

export function cleanImportCell(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function isLikelyImportJunkRow(row: unknown[]): boolean {
  const cells = row.map(cleanImportCell).filter(Boolean)
  if (cells.length === 0) return true
  const text = cells.join(' ').toLocaleLowerCase('uk-UA')
  if (/^(итого|разом|всього|підсумок|total|сумма|сума)\b/.test(text)) return true
  if (/\b(страница|сторінка|лист|прайс-лист|дата друку)\b/.test(text) && cells.length <= 3) return true
  return false
}

export function guessInvoiceImport(rawRows: unknown[][]): { mapping: InvoiceImportMapping; startRow: number; headerRow: number | null } {
 let bestMapping: InvoiceImportMapping | null = null
 let bestRow = -1
 let bestScore = -1
  const rowsToCheck = rawRows.slice(0, Math.min(rawRows.length, 25))
  rowsToCheck.forEach((row, rowIndex) => {
    const mapping: InvoiceImportMapping = { ...EMPTY_INVOICE_IMPORT_MAPPING }
    let score = 0
    row.forEach((cell, index) => {
      const h = cleanImportCell(cell).toLocaleLowerCase('uk-UA')
      if (!h) return
      if (mapping.barcode == null && /штрих.?код|barcode|ean|шк\b/.test(h)) { mapping.barcode = index; score += 3 }
      else if (mapping.sku == null && /артикул|sku|article|код товар|код$|^код\b|номенклатура.*код/.test(h)) { mapping.sku = index; score += 2 }
      else if (mapping.name == null && /назв|наймен|наимен|товар|product|description|номенклатур|модель/.test(h) && !/код|родител|батьк/.test(h)) { mapping.name = index; score += 3 }
      else if (mapping.unit == null && /од.?\s*вим|ед.?\s*изм|единиц|одиниц|unit|шт|штук|кг|компл/.test(h)) { mapping.unit = index; score += 2 }
      else if (mapping.qty == null && /кільк|к-сть|кол-во|количество|qty|quantity|остаток|залиш/.test(h)) { mapping.qty = index; score += 2 }
      else if (mapping.purchase == null && /закуп|вхідн|собіварт|цена закуп|закупоч|purchase|buy|cost/.test(h)) { mapping.purchase = index; score += 3 }
      else if (mapping.retail == null && /роздріб|розница|продаж|ціна продаж|цена продаж|retail|sale/.test(h)) { mapping.retail = index; score += 2 }
      else if (mapping.storage_bin == null && /комір|ячей|ящик|місце|склад|bin|cell|storage/.test(h)) { mapping.storage_bin = index; score += 1 }
    })
 if (score > bestScore) {
 bestMapping = mapping
 bestRow = rowIndex
 bestScore = score
 }
  })

 if (bestMapping && bestScore >= 4) return { mapping: bestMapping, startRow: bestRow + 1, headerRow: bestRow }
  return {
    mapping: { sku: 0, name: 1, barcode: null, unit: null, qty: 2, purchase: 3, retail: 4, storage_bin: null },
    startRow: 0,
    headerRow: null,
  }
}

export function buildInvoiceImportItems(rawRows: unknown[][], mapping: InvoiceImportMapping, startRow: number): { items: LineItem[]; skipped: number } {
  const items: LineItem[] = []
  let skipped = 0
  const safeStart = Math.max(0, Math.min(startRow || 0, rawRows.length))
  for (let r = safeStart; r < rawRows.length; r++) {
    const row = rawRows[r] ?? []
    if (isLikelyImportJunkRow(row)) { skipped += 1; continue }
    const read = (field: InvoiceImportField) => mapping[field] == null ? '' : cleanImportCell(row[mapping[field] as number])
    const sku = read('sku')
    const name = read('name')
    const barcode = read('barcode')
    const unit = normalizeInvoiceUnit(read('unit'))
    const qty = mapping.qty == null ? 1 : parseQty(read('qty'), 1)
    const purchase = mapping.purchase == null ? 0 : parseMoneyToKopecks(read('purchase'))
    const retail = mapping.retail == null ? 0 : parseMoneyToKopecks(read('retail'))
    const bin = read('storage_bin') || null
    if (!sku && !name && !barcode) { skipped += 1; continue }
    if (!sku && !barcode && purchase <= 0 && retail <= 0) { skipped += 1; continue }
    const lowerName = name.toLocaleLowerCase('uk-UA')
    if (/^(назв|наймен|наимен|товар|номенклатур|итого|разом|всього|total)/.test(lowerName)) { skipped += 1; continue }
    const clientKey = makeLineKey()
    items.push({
      client_key: clientKey,
      product_name: name || `Товар (${sku || barcode})`,
      sku: sku || makeAutoSku(clientKey),
      barcode: barcode || '',
      unit,
      qty,
      purchase_price: purchase,
      retail_price: retail,
      category_id: null,
      total: Math.round(qty * purchase),
      storage_bin: bin,
      is_new: true,
    })
  }
  return { items, skipped }
}
export function kopecksForForm(kopecks: number): string {
  return (Math.max(0, Number(kopecks) || 0) / 100).toFixed(2)
}

export function makeLineKey(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `line_${Date.now()}_${Math.random().toString(36).slice(2)}`)
}

export function makeAutoSku(clientKey: string): string {
  // AUTO-артикул має походити тільки з унікального ключа рядка. Date.now() з
  // коротким random давав однакові артикули кільком рядкам одного імпорту.
  const suffix = clientKey.replace(/[^a-z0-9]/gi, '').toUpperCase()
  return `AUTO-${suffix}`
}

export function invoiceImportMatchMessage(error: unknown, item: LineItem): string {
  const rawMessage = error instanceof Error ? error.message.trim() : ''
  if (
    /артикул і штрихкод належать різним товарам/i.test(rawMessage)
    || /повна назва.+збігається з кількома товарами/i.test(rawMessage)
  ) return rawMessage
  const label = item.product_name || item.sku || item.barcode || 'без назви'
  return `Не вдалося зіставити рядок «${label}» з базою. Рядок додано в накладну — перевірте його або виберіть заміну.`
}

export class InvoiceImportMatchError extends Error {
  readonly item: LineItem

  constructor(item: LineItem, cause: unknown) {
    super(invoiceImportMatchMessage(cause, item))
    this.name = 'InvoiceImportMatchError'
    this.item = item
  }
}

export function makeDraftItem(overrides: Partial<LineItem> = {}): LineItem {
  return {
    client_key: makeLineKey(),
    product_name: '',
    sku: '',
    barcode: '',
    unit: 'шт',
    qty: 1,
    purchase_price: 0,
    retail_price: 0,
    category_id: null,
    total: 0,
    storage_bin: null,
    photo_url: null,
    is_new: true,
    ...overrides,
  }
}

export function roundRetailBySettings(retail: number, settings: any): number {
  if (!Number.isFinite(retail) || retail <= 0) return 0
  // Сітка націнки не повинна давати копійки. Якщо в налаштуваннях увімкнено
  // округлення — беремо його крок: 0.5 / 1 / 5 / 10 грн. Якщо вимкнено або
  // налаштування недоступні — округлюємо до 1 грн, щоб ціна була чистою.
  const rawStep = settings?.price_rounding_enabled === true ? Number(settings.price_rounding_step) : 100
  const step = Math.max(50, Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 100)
  const scaled = retail / step
  if (settings?.price_rounding_dir === 'up') return Math.ceil(scaled) * step
  if (settings?.price_rounding_dir === 'down') return Math.floor(scaled) * step
  return Math.round(scaled) * step
}
export function retailFromLocalGrid(purchaseKopecks: number, settings: any): number | null {
  if (!Number.isFinite(purchaseKopecks) || purchaseKopecks <= 0) return null
  const rules = Array.isArray(settings?.markup_rules) ? settings.markup_rules : []
  const rule = rules.find((candidate: any) =>
    purchaseKopecks >= Number(candidate.minPrice) && purchaseKopecks < Number(candidate.maxPrice)
  )
  if (!rule) return null
  const retail = Math.round(purchaseKopecks * (1 + Number(rule.markupPct ?? 0) / 100))
  return roundRetailBySettings(retail, settings)
}

export function isDuplicateProductError(err: unknown): boolean {
  const anyErr = err as any
  const message = String(anyErr?.message ?? '')
  return anyErr?.code === 'SKU_DUPLICATE'
    || anyErr?.code === 'BARCODE_TAKEN'
    || /артикул.+вже існує/i.test(message)
    || /штрихкод.+вже/i.test(message)
    || /duplicate|unique constraint|already exists/i.test(message)
}

export function duplicateProductMessage(err: unknown, itemName?: string): string {
  const message = String((err as any)?.message ?? '')
  const prefix = itemName ? `«${itemName}»: ` : ''
  if (/штрихкод/i.test(message)) return `${prefix}товар з таким штрихкодом вже існує`
  if (/артикул|sku/i.test(message)) return `${prefix}товар з таким артикулом вже існує`
  return `${prefix}такий товар вже існує. Перевірте артикул або штрихкод.`
}

