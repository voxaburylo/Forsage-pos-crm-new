import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Trash2, Camera, ImagePlus, Clipboard, Loader2, Barcode } from 'lucide-react'
import { compressToJpeg, uploadToStorage } from '@/features/products/ProductPhotoUpload'
import { read, utils } from 'xlsx'
import Papa from 'papaparse'
import { supplierApi } from './supplierApi'
import { productApi } from '@/features/products/productApi'
import { pricingApi } from '@/features/admin/pricingApi'
import { adminApi } from '@/features/admin/adminApi'
import type { Product, ProductFormData } from '@/types/product'
import type { SupplyInvoice } from '@/types/supplier'
import { Layout } from '@/components/Layout'
import { Button, Input, Card, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { shiftApi } from '@/features/pos/shiftApi'
import { formatMoney } from '@/lib/utils'
import { parseLocaleNumber } from '@/lib/parseDecimal'
import { desktopBridge, desktopProductToProduct } from '@/lib/desktopBridge'
import { resolveCachedInvoiceProduct } from './invoiceProductCache'

interface LineItem {
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
interface SupplyInvoiceLocalDraft {
  supplierId: string
  invoiceNumber: string
  notes: string
  items: LineItem[]
  paidAmount: string
  paymentMethod: 'cash' | 'card' | 'transfer'
  fundSource: 'cashbox' | 'owner_funds' | 'bank_account' | 'business_card'
  postImmediately: boolean
  serverInvoiceId?: string | null
  savedAt: string
}

function supplyInvoiceDraftKey(scope: string) {
  return 'forsage:supply-invoice:' + scope + ':draft:v2'
}

function loadSupplyInvoiceDraft(key: string): SupplyInvoiceLocalDraft | null {
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
      paymentMethod: draft.paymentMethod === 'card' || draft.paymentMethod === 'transfer' ? draft.paymentMethod : 'cash',
      fundSource: draft.fundSource === 'owner_funds' || draft.fundSource === 'bank_account' || draft.fundSource === 'business_card'
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

function saveSupplyInvoiceDraft(key: string, draft: Omit<SupplyInvoiceLocalDraft, 'savedAt'>) {
  localStorage.setItem(key, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }))
}

function clearSupplyInvoiceDraft(key: string) {
  localStorage.removeItem(key)
}

type SupplyInvoiceDraftData = Omit<SupplyInvoiceLocalDraft, 'savedAt'>

function hasSupplyInvoiceDraftContent(draft: SupplyInvoiceDraftData): boolean {
  return Boolean(
    draft.supplierId || draft.invoiceNumber.trim() || draft.notes.trim() || draft.paidAmount.trim() || draft.items.length > 0,
  )
}

function normalizeSupplyInvoiceDraftItems(items: unknown): LineItem[] {
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

function invoiceItemsToLineItems(inv: SupplyInvoice): LineItem[] {
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

function draftFromServerInvoice(inv: SupplyInvoice): SupplyInvoiceLocalDraft | null {
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
      fundSource: rawPayload.fundSource === 'owner_funds' || rawPayload.fundSource === 'bank_account' || rawPayload.fundSource === 'business_card'
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

function newestSupplyInvoiceDraft(localDraft: SupplyInvoiceLocalDraft | null, serverDraft: SupplyInvoiceLocalDraft | null): SupplyInvoiceLocalDraft | null {
  if (!localDraft) return serverDraft
  if (!serverDraft) return localDraft
  const localTime = Date.parse(localDraft.savedAt || '') || 0
  const serverTime = Date.parse(serverDraft.savedAt || '') || 0
  return serverTime > localTime ? serverDraft : localDraft
}


function persistSupplyInvoiceDraft(key: string, draft: SupplyInvoiceDraftData) {
  const hasDraft = hasSupplyInvoiceDraftContent(draft) || Boolean(draft.serverInvoiceId)
  if (!hasDraft) {
    clearSupplyInvoiceDraft(key)
    return
  }
  saveSupplyInvoiceDraft(key, draft)
}

type InvoiceImportField = 'sku' | 'name' | 'barcode' | 'unit' | 'qty' | 'purchase' | 'retail' | 'storage_bin'
type InvoiceImportMapping = Record<InvoiceImportField, number | null>

const EMPTY_INVOICE_IMPORT_MAPPING: InvoiceImportMapping = {
  sku: null,
  name: null,
  barcode: null,
  unit: null,
  qty: null,
  purchase: null,
  retail: null,
  storage_bin: null,
}

const INVOICE_IMPORT_FIELDS: Array<{ field: InvoiceImportField; label: string; required?: boolean }> = [
  { field: 'sku', label: 'Артикул' },
  { field: 'name', label: 'Назва товару', required: true },
  { field: 'barcode', label: 'Штрихкод' },
  { field: 'unit', label: 'Од. виміру' },
  { field: 'qty', label: 'Кількість' },
  { field: 'purchase', label: 'Закупка', required: true },
  { field: 'retail', label: 'Продаж' },
  { field: 'storage_bin', label: 'Комірка' },
]

function normalizeSkuValue(raw: string): string {
  return raw.trim().toLocaleUpperCase('uk-UA')
}

function normalizeBarcodeValue(raw: unknown): string {
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

function normalizeExactInvoiceProductName(raw: unknown): string {
  return String(raw ?? '')
    .toLocaleLowerCase('uk-UA')
    .replace(/\s+/g, ' ')
    .trim()
}

function findExactProductForQuery(query: string, products: Product[]): Product | null {
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
function parseDecimalInput(raw: unknown, fallback = 0): number {
  const value = parseLocaleNumber(raw)
  return Number.isFinite(value) ? value : fallback
}

function parseMoneyToKopecks(raw: unknown): number {
  const value = parseDecimalInput(raw, 0)
  if (value < 0) return 0
  return Math.round(value * 100)
}

function parseQty(raw: unknown, fallback = 1): number {
  const value = parseDecimalInput(raw, fallback)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function normalizeInvoiceUnit(raw: unknown): ProductFormData['unit'] {
  const text = String(raw ?? '').trim().toLocaleLowerCase('uk-UA')
  if (/^(кг|kg|кілограм|килограмм)/.test(text)) return 'кг'
  if (/^(компл|комплект|комплекты|комплекти|set)/.test(text)) return 'компл'
  if (/^(л|літр|литр|liter)/.test(text)) return 'л'
  if (/^(м|метр|meter)/.test(text)) return 'м'
  return 'шт'
}

function cleanImportCell(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function isLikelyImportJunkRow(row: unknown[]): boolean {
  const cells = row.map(cleanImportCell).filter(Boolean)
  if (cells.length === 0) return true
  const text = cells.join(' ').toLocaleLowerCase('uk-UA')
  if (/^(итого|разом|всього|підсумок|total|сумма|сума)\b/.test(text)) return true
  if (/\b(страница|сторінка|лист|прайс-лист|дата друку)\b/.test(text) && cells.length <= 3) return true
  return false
}

function guessInvoiceImport(rawRows: unknown[][]): { mapping: InvoiceImportMapping; startRow: number; headerRow: number | null } {
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

function buildInvoiceImportItems(rawRows: unknown[][], mapping: InvoiceImportMapping, startRow: number): { items: LineItem[]; skipped: number } {
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
function kopecksForForm(kopecks: number): string {
  return (Math.max(0, Number(kopecks) || 0) / 100).toFixed(2)
}

function makeLineKey(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `line_${Date.now()}_${Math.random().toString(36).slice(2)}`)
}

function makeAutoSku(clientKey: string): string {
  // AUTO-артикул має походити тільки з унікального ключа рядка. Date.now() з
  // коротким random давав однакові артикули кільком рядкам одного імпорту.
  const suffix = clientKey.replace(/[^a-z0-9]/gi, '').toUpperCase()
  return `AUTO-${suffix}`
}

function invoiceImportMatchMessage(error: unknown, item: LineItem): string {
  const rawMessage = error instanceof Error ? error.message.trim() : ''
  if (
    /артикул і штрихкод належать різним товарам/i.test(rawMessage)
    || /повна назва.+збігається з кількома товарами/i.test(rawMessage)
  ) return rawMessage
  const label = item.product_name || item.sku || item.barcode || 'без назви'
  return `Не вдалося зіставити рядок «${label}» з базою. Рядок додано в накладну — перевірте його або виберіть заміну.`
}

class InvoiceImportMatchError extends Error {
  readonly item: LineItem

  constructor(item: LineItem, cause: unknown) {
    super(invoiceImportMatchMessage(cause, item))
    this.name = 'InvoiceImportMatchError'
    this.item = item
  }
}

function makeDraftItem(overrides: Partial<LineItem> = {}): LineItem {
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

function roundRetailBySettings(retail: number, settings: any): number {
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
function retailFromLocalGrid(purchaseKopecks: number, settings: any): number | null {
  if (!Number.isFinite(purchaseKopecks) || purchaseKopecks <= 0) return null
  const rules = Array.isArray(settings?.markup_rules) ? settings.markup_rules : []
  const rule = rules.find((candidate: any) =>
    purchaseKopecks >= Number(candidate.minPrice) && purchaseKopecks < Number(candidate.maxPrice)
  )
  if (!rule) return null
  const retail = Math.round(purchaseKopecks * (1 + Number(rule.markupPct ?? 0) / 100))
  return roundRetailBySettings(retail, settings)
}

function isDuplicateProductError(err: unknown): boolean {
  const anyErr = err as any
  const message = String(anyErr?.message ?? '')
  return anyErr?.code === 'SKU_DUPLICATE'
    || anyErr?.code === 'BARCODE_TAKEN'
    || /артикул.+вже існує/i.test(message)
    || /штрихкод.+вже/i.test(message)
    || /duplicate|unique constraint|already exists/i.test(message)
}

function duplicateProductMessage(err: unknown, itemName?: string): string {
  const message = String((err as any)?.message ?? '')
  const prefix = itemName ? `«${itemName}»: ` : ''
  if (/штрихкод/i.test(message)) return `${prefix}товар з таким штрихкодом вже існує`
  if (/артикул|sku/i.test(message)) return `${prefix}товар з таким артикулом вже існує`
  return `${prefix}такий товар вже існує. Перевірте артикул або штрихкод.`
}

interface RowPhotoCellProps {
  photoUrl: string | null
  productId: string
  onPhotoUpdated: (url: string | null) => void
}

function RowPhotoCell({ photoUrl, productId, onPhotoUpdated }: RowPhotoCellProps) {
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    await uploadPhoto(file)
  }

  // Фото в накладній — ТИМЧАСОВЕ: висить у позиції, а в товар записується лише при
  // збереженні/проведенні накладної. Закрив без проведення → нічого не змінилось/створилось.
  const uploadPhoto = async (file: File | Blob) => {
    setUploading(true)
    try {
      const blob = await compressToJpeg(file)
      const url = await uploadToStorage(blob, productId)
      onPhotoUpdated(url)   // лише в позицію; у товар — при проведенні накладної
      toast.success('Фото додано')
    } catch (err) {
      toast.error('Не вдалося завантажити фото')
    } finally {
      setUploading(false)
    }
  }

  const handlePaste = async () => {
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageType = item.types.find(type => type.startsWith('image/'))
        if (imageType) {
          const blob = await item.getType(imageType)
          await uploadPhoto(blob)
          return
        }
      }
      toast.error('У буфері обміну немає зображення')
    } catch (err) {
      toast.error('Будь ласка, натисніть Ctrl+V при фокусі на кнопці або надайте доступ')
    }
  }

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault()
      await handlePaste()
    }
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Видалити фото?')) return
    setUploading(true)
    try {
      onPhotoUpdated(null)   // прибираємо лише з позиції; товар не чіпаємо до проведення
      toast.success('Фото видалено')
    } catch {
      toast.error('Помилка видалення')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="relative w-10 h-10 group bg-gray-50 rounded-lg overflow-hidden flex items-center justify-center border border-gray-200 shrink-0">
      {uploading ? (
        <Loader2 size={16} className="animate-spin text-gray-400" />
      ) : photoUrl ? (
        <>
          <img src={photoUrl} alt="Product" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-1 text-white hover:text-yellow-400"
              title="Змінити фото"
            >
              <Camera size={12} />
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="p-1 text-red-400 hover:text-red-500"
              title="Видалити"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center w-full h-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={handleKeyDown}
            className="w-full h-full flex flex-col items-center justify-center"
            title="Завантажити або вставити (Ctrl+V)"
          >
            <ImagePlus size={16} />
            <span className="text-[7px] mt-0.5 font-bold uppercase tracking-wider">Додати</span>
          </button>
          <button
            type="button"
            onClick={handlePaste}
            className="absolute bottom-0.5 right-0.5 p-0.5 bg-white/80 rounded border border-gray-200 hover:bg-white text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Вставити з буфера"
          >
            <Clipboard size={8} />
          </button>
        </div>
      )}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/*"
        capture="environment"
        className="hidden"
      />
    </div>
  )
}

export default function InvoiceFormPage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const isEdit = Boolean(id)
  const preSelectedSupplier = searchParams.get('supplier_id') ?? ''
  const cloneId = searchParams.get('clone')
  const invoiceDraftKey = useMemo(() => {
    if (isEdit && id) return supplyInvoiceDraftKey('edit-' + id)
    if (cloneId) return supplyInvoiceDraftKey('clone-' + cloneId)
    return supplyInvoiceDraftKey('new')
  }, [cloneId, id, isEdit])
  const invoiceDraftReadyRef = useRef(false)
  const invoiceSubmitRef = useRef(false)
  const invoiceDraftPersistenceDisabledRef = useRef(false)
  const serverDraftIdRef = useRef<string | null>(isEdit && id ? id : null)

  const [supplierId, setSupplierId] = useState(preSelectedSupplier)
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [items, setItems] = useState<LineItem[]>([])
  const [serverDraftId, setServerDraftId] = useState<string | null>(isEdit && id ? id : null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(isEdit)
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [productSearch, setProductSearch] = useState('')
  const [productResults, setProductResults] = useState<Product[]>([])
  const [problemLineKey, setProblemLineKey] = useState<string | null>(null)

  // Порівняння закупівельних цін постачальників по доданих товарах
  const [supplierPrices, setSupplierPrices] = useState<Record<string, Array<{ supplier_id: string; supplier_name: string; price: number; date: string }>>>({})
  const [quickPercents, setQuickPercents] = useState<number[]>([])
  const [supplierModal, setSupplierModal] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [newSupplierPhone, setNewSupplierPhone] = useState('')
  const [creatingSupplier, setCreatingSupplier] = useState(false)
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([])
  const [importTab, setImportTab] = useState<'manual' | 'file' | 'clipboard'>('manual')
  const [clipboardText, setClipboardText] = useState('')
  const [invoiceImportModal, setInvoiceImportModal] = useState(false)
  const [invoiceImportRows, setInvoiceImportRows] = useState<unknown[][]>([])
  const [invoiceImportFileName, setInvoiceImportFileName] = useState('')
  const [invoiceImportMapping, setInvoiceImportMapping] = useState<InvoiceImportMapping>({ ...EMPTY_INVOICE_IMPORT_MAPPING })
  const [invoiceImportStartRow, setInvoiceImportStartRow] = useState(1)
  const [invoiceImportHeaderRow, setInvoiceImportHeaderRow] = useState<number | null>(null)
  const [resolvingImportedProducts, setResolvingImportedProducts] = useState(false)
  const [bulkMarkupSelection, setBulkMarkupSelection] = useState('')
  const [customPctOpen, setCustomPctOpen] = useState(false)
  const [customPctValue, setCustomPctValue] = useState('')
  const [selectedLineKeys, setSelectedLineKeys] = useState<string[]>([])
  const [bulkCategoryId, setBulkCategoryId] = useState('')
  // Оплата постачальнику
  const [paidAmount, setPaidAmount] = useState('')          // гривні (рядок форми)
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'transfer'>('cash')
  const [fundSource, setFundSource] = useState<'cashbox' | 'owner_funds' | 'bank_account' | 'business_card'>('cashbox')
  const [postImmediately, setPostImmediately] = useState(true)  // провести одразу після створення
  const [moneyDrafts, setMoneyDrafts] = useState<Record<string, string>>({})
  const itemsRef = useRef(items)
  const invoiceDraftSnapshotRef = useRef<SupplyInvoiceDraftData>({
    supplierId,
    invoiceNumber,
    notes,
    items,
    paidAmount,
    paymentMethod,
    fundSource,
    postImmediately,
    serverInvoiceId: serverDraftId,
  })

  useEffect(() => {
    itemsRef.current = items
    invoiceDraftSnapshotRef.current = {
      supplierId,
      invoiceNumber,
      notes,
      items,
      paidAmount,
      paymentMethod,
      fundSource,
      postImmediately,
      serverInvoiceId: serverDraftIdRef.current,
    }
  }, [supplierId, invoiceNumber, notes, items, paidAmount, paymentMethod, fundSource, postImmediately, serverDraftId])

  function applySupplyInvoiceDraft(draft: SupplyInvoiceLocalDraft, fallbackSupplier = preSelectedSupplier) {
    setSupplierId(draft.supplierId || fallbackSupplier)
    setInvoiceNumber(draft.invoiceNumber)
    setNotes(draft.notes)
    setItems(draft.items)
    setPaidAmount(draft.paidAmount)
    setPaymentMethod(draft.paymentMethod)
    setFundSource(draft.fundSource)
    setPostImmediately(draft.postImmediately)
    const draftId = draft.serverInvoiceId || (isEdit && id ? id : null)
    serverDraftIdRef.current = draftId
    setServerDraftId(draftId)
  }

  useEffect(() => {
    const draftId = isEdit && id ? id : serverDraftId
    serverDraftIdRef.current = draftId
  }, [id, isEdit, serverDraftId])

  useEffect(() => {
    if (isEdit || cloneId) return
    invoiceDraftReadyRef.current = false
    let cancelled = false
    let readyTimer: number | null = null
    const markReady = () => {
      readyTimer = window.setTimeout(() => { invoiceDraftReadyRef.current = true }, 0)
    }
    const localDraft = loadSupplyInvoiceDraft(invoiceDraftKey)
    if (localDraft) {
      applySupplyInvoiceDraft(localDraft, preSelectedSupplier)
      toast.success('Чернетку накладної відновлено')
    }
    if (desktopBridge()) {
      markReady()
      return () => {
        cancelled = true
        if (readyTimer != null) window.clearTimeout(readyTimer)
      }
    }

    const serverId = localDraft?.serverInvoiceId
    if (serverId) {
      supplierApi.getInvoice(serverId).then((res) => {
        if (cancelled) return
        const serverDraft = draftFromServerInvoice(res.data)
        const draft = newestSupplyInvoiceDraft(localDraft, serverDraft)
        if (draft) applySupplyInvoiceDraft(draft, preSelectedSupplier)
      }).catch(() => {})
        .finally(() => { if (!cancelled) markReady() })
    } else if (!localDraft) {
      supplierApi.getLatestInvoiceDraft().then((res) => {
        if (cancelled || !res.data) return
        const serverDraft = draftFromServerInvoice(res.data)
        if (serverDraft) {
          applySupplyInvoiceDraft(serverDraft, preSelectedSupplier)
          persistSupplyInvoiceDraft(invoiceDraftKey, serverDraft)
          toast.success('Серверну чернетку накладної відновлено')
        }
      }).catch(() => {})
        .finally(() => { if (!cancelled) markReady() })
    } else {
      markReady()
    }
    return () => {
      cancelled = true
      if (readyTimer != null) window.clearTimeout(readyTimer)
    }
  }, [cloneId, invoiceDraftKey, isEdit, preSelectedSupplier])

  useEffect(() => {
    if (!invoiceDraftReadyRef.current || invoiceDraftPersistenceDisabledRef.current) return
    const timer = window.setTimeout(() => {
      persistSupplyInvoiceDraft(invoiceDraftKey, invoiceDraftSnapshotRef.current)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [invoiceDraftKey, supplierId, invoiceNumber, notes, items, paidAmount, paymentMethod, fundSource, postImmediately, serverDraftId])

  useEffect(() => {
    if (!invoiceDraftReadyRef.current || invoiceDraftPersistenceDisabledRef.current) return
    if (desktopBridge()) return
    const draft = invoiceDraftSnapshotRef.current
    if (!hasSupplyInvoiceDraftContent(draft)) return
    const timer = window.setTimeout(async () => {
      const current = invoiceDraftSnapshotRef.current
      if (!hasSupplyInvoiceDraftContent(current) || invoiceDraftPersistenceDisabledRef.current) return
      try {
        const res = await supplierApi.saveInvoiceDraft({
          invoice_id: serverDraftIdRef.current,
          supplier_id: current.supplierId || null,
          invoice_number: current.invoiceNumber.trim() || null,
          notes: current.notes.trim() || null,
          total: current.items.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.total ?? 0))), 0),
          draft_payload: current as unknown as Record<string, unknown>,
        })
        const savedId = res.data?.id
        if (savedId && savedId !== serverDraftIdRef.current) {
          serverDraftIdRef.current = savedId
          setServerDraftId(savedId)
          persistSupplyInvoiceDraft(invoiceDraftKey, { ...current, serverInvoiceId: savedId })
        }
      } catch {
        // Локальна чернетка вже збережена. Якщо сервер тимчасово недоступний,
        // наступна зміна рядка повторить фонове збереження.
      }
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [invoiceDraftKey, supplierId, invoiceNumber, notes, items, paidAmount, paymentMethod, fundSource, postImmediately, serverDraftId])

  useEffect(() => {
    const flushDraft = () => {
      if (!invoiceDraftReadyRef.current || invoiceDraftPersistenceDisabledRef.current) return
      persistSupplyInvoiceDraft(invoiceDraftKey, invoiceDraftSnapshotRef.current)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushDraft()
    }

    window.addEventListener('pagehide', flushDraft)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flushDraft)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      flushDraft()
    }
  }, [invoiceDraftKey])

  const invoiceImportPreview = useMemo(
    () => buildInvoiceImportItems(invoiceImportRows, invoiceImportMapping, invoiceImportStartRow),
    [invoiceImportRows, invoiceImportMapping, invoiceImportStartRow],
  )
  const invoiceImportColumnCount = useMemo(
    () => Math.max(0, ...invoiceImportRows.slice(0, 20).map((row) => row.length)),
    [invoiceImportRows],
  )

  function moneyKey(index: number, field: 'purchase_price' | 'retail_price') {
    return `${index}:${field}`
  }

  function moneyValue(index: number, field: 'purchase_price' | 'retail_price', kopecks: number) {
    return moneyDrafts[moneyKey(index, field)] ?? kopecksForForm(kopecks)
  }

  function beginMoneyEdit(index: number, field: 'purchase_price' | 'retail_price', kopecks: number, target: HTMLInputElement) {
    setMoneyDrafts((prev) => ({ ...prev, [moneyKey(index, field)]: kopecksForForm(kopecks) }))
    window.setTimeout(() => target.select(), 0)
  }

  function changeMoney(index: number, field: 'purchase_price' | 'retail_price', raw: string) {
    setMoneyDrafts((prev) => ({ ...prev, [moneyKey(index, field)]: raw }))
    updateItem(index, field, parseMoneyToKopecks(raw))
  }

  function pasteMoney(index: number, field: 'purchase_price' | 'retail_price', raw: string) {
    const kopecks = parseMoneyToKopecks(raw)
    const normalized = kopecksForForm(kopecks)
    setMoneyDrafts((prev) => ({ ...prev, [moneyKey(index, field)]: normalized }))
    updateItem(index, field, kopecks)
  }

  function finishMoneyEdit(index: number, field: 'purchase_price' | 'retail_price') {
    const key = moneyKey(index, field)
    setMoneyDrafts((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    if (field === 'purchase_price' && !isEdit) {
      const draftValue = moneyDrafts[key]
      const purchaseForRecalc = draftValue !== undefined ? parseMoneyToKopecks(draftValue) : items[index]?.purchase_price
      void recalcRetail(index, false, purchaseForRecalc)
    }
  }

  // Завантажуємо постачальників
  useEffect(() => {
    supplierApi.list({ per_page: 200 }).then((r) => setSuppliers(r.data)).catch(() => {})
    adminApi.getSettings().then((res) => setQuickPercents(res.data.quick_percents || [])).catch(() => {})
    adminApi.listCategories().then((res) => setCategories(res.data)).catch(() => {})
  }, [])

  // Якщо редагування — завантажуємо накладну
  useEffect(() => {
    if (id) {
      invoiceDraftReadyRef.current = false
      supplierApi.getInvoice(id).then((res) => {
        const inv = res.data
        const serverDraft = draftFromServerInvoice(inv)
        const localDraft = loadSupplyInvoiceDraft(invoiceDraftKey)
        const draft = newestSupplyInvoiceDraft(localDraft, serverDraft)
        serverDraftIdRef.current = id
        setServerDraftId(id)
        if (draft) {
          applySupplyInvoiceDraft({ ...draft, serverInvoiceId: id }, inv.supplier_id ?? '')
          toast.success('Чернетку накладної відновлено')
        } else {
          setSupplierId(inv.supplier_id ?? '')
          setInvoiceNumber(inv.invoice_number ?? '')
          setNotes(inv.notes ?? '')
          setItems(invoiceItemsToLineItems(inv))
        }
      }).catch(() => {
        toast.error('Не вдалось завантажити накладну')
        navigate('/suppliers')
      }).finally(() => {
        setLoading(false)
        invoiceDraftReadyRef.current = true
      })
    }
  }, [id, invoiceDraftKey])

  // Дублювання: /suppliers/invoices/new?clone=<id> — копіюємо постачальника й позиції,
  // номер лишаємо порожнім (новий), статус — чернетка.
  useEffect(() => {
    if (id || !cloneId) return
    setLoading(true)
    invoiceDraftReadyRef.current = false
    supplierApi.getInvoice(cloneId).then((res) => {
      const inv = res.data
      const serverDraft = draftFromServerInvoice(inv)
      const loadedItems = serverDraft?.items ?? invoiceItemsToLineItems(inv)
      const draft = loadSupplyInvoiceDraft(invoiceDraftKey)
      if (draft) {
        applySupplyInvoiceDraft(draft, inv.supplier_id ?? '')
        toast.success('Чернетку накладної відновлено')
      } else {
        serverDraftIdRef.current = null
        setServerDraftId(null)
        setSupplierId(inv.supplier_id ?? '')
        setInvoiceNumber('')
        setNotes('')
        setItems(loadedItems.map((item) => ({ ...item, client_key: makeLineKey() })))
        toast.success('Накладну скопійовано — вкажіть новий номер і проведіть')
      }
    }).catch(() => toast.error('Не вдалось завантажити накладну для копіювання'))
      .finally(() => {
        setLoading(false)
        invoiceDraftReadyRef.current = true
      })
  }, [cloneId, id, invoiceDraftKey])

  // Пошук товарів. Ігноруємо запізнілу відповідь попереднього запиту,
  // щоб старі підказки не поверталися після зміни або очищення поля.
  useEffect(() => {
    const query = productSearch.trim()
    if (!query) {
      setProductResults([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const res = await productApi.search(query, 200)
        if (!cancelled) setProductResults(res.data)
      } catch {
        if (!cancelled) setProductResults([])
      }
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [productSearch])
  async function handleProductSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setProductSearch('')
      setProductResults([])
      return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
    const query = productSearch.trim()
    if (!query) {
      addDraftItem()
      return
    }

    const existingResult = findExactProductForQuery(query, productResults)
    if (existingResult) {
      addItem(existingResult)
      return
    }

    try {
      const res = await productApi.search(query, 200)
      const exactResult = findExactProductForQuery(query, res.data)
      if (exactResult) {
        addItem(exactResult)
        return
      }
    } catch {
      // якщо пошук не відповів — все одно дамо створити рядок вручну нижче
    }

    const looksLikeBarcode = /^\d{6,}$/.test(query)
    addDraftItem(looksLikeBarcode ? { barcode: query } : { product_name: query }, looksLikeBarcode ? 'name' : 'sku')
  }
  // Швидке сканування штрихкодів: реф на кожен інпут ШК + режим-гід «по черзі»
  const barcodeRefs = useRef<(HTMLInputElement | null)[]>([])
  const barcodeLookupTimers = useRef<Record<string, number>>({})
  const [scanGuide, setScanGuide] = useState(false)

  useEffect(() => () => {
    for (const timer of Object.values(barcodeLookupTimers.current)) window.clearTimeout(timer)
    barcodeLookupTimers.current = {}
  }, [])

  type RowField = 'name' | 'sku' | 'barcode' | 'qty' | 'purchase' | 'retail'
  const rowNameRefs = useRef<(HTMLInputElement | null)[]>([])
  const skuRefs = useRef<(HTMLInputElement | null)[]>([])
  const qtyRefs = useRef<(HTMLInputElement | null)[]>([])
  const purchaseRefs = useRef<(HTMLInputElement | null)[]>([])
  const retailRefs = useRef<(HTMLInputElement | null)[]>([])

  function refsForField(field: RowField) {
    if (field === 'name') return rowNameRefs
    if (field === 'sku') return skuRefs
    if (field === 'barcode') return barcodeRefs
    if (field === 'qty') return qtyRefs
    if (field === 'purchase') return purchaseRefs
    return retailRefs
  }

  function focusRowField(index: number, field: RowField = 'name') {
    window.setTimeout(() => {
      const el = refsForField(field).current[index]
      if (el) { el.focus(); el.select() }
    }, 0)
  }

  function raiseInvoiceLineProblem(rowKey: string, message: string, _fallbackItem?: LineItem, field: RowField = 'sku') {
    setProblemLineKey(rowKey)
    toast.error(message)
    window.setTimeout(() => {
      const index = itemsRef.current.findIndex((candidate) => candidate.client_key === rowKey)
      if (index >= 0) {
        const el = refsForField(field).current[index] ?? rowNameRefs.current[index]
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        focusRowField(index, field)
      }
    }, 0)
  }

  function makeInvoiceLineProblemError() {
    const err = new Error('INVOICE_LINE_PROBLEM')
    err.name = 'InvoiceLineProblem'
    return err
  }

  function handleRowFieldKeyDown(e: React.KeyboardEvent<HTMLInputElement>, index: number, field: RowField) {
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    const order: RowField[] = ['name', 'sku', 'barcode', 'qty', 'purchase', 'retail']
    const pos = order.indexOf(field)
    if (pos >= 0 && pos < order.length - 1) {
      focusRowField(index, order[pos + 1])
      return
    }
    if (!isEdit && index >= items.length - 1) {
      addDraftItem()
    } else {
      focusRowField(index + 1, 'name')
    }
  }

  function focusBarcodeRow(idx: number) {
    const el = barcodeRefs.current[idx]
    if (el) { el.focus(); el.select() }
  }

  // Старт гіда: фокус на перший рядок без ШК (або перший)
  function startScanGuide() {
    if (items.length === 0) { toast.error('Спочатку додайте товари'); return }
    const firstEmpty = items.findIndex((it) => !it.barcode)
    if (firstEmpty === -1) { toast.success('Усі позиції вже мають штрихкод'); return }
    setScanGuide(true)
    focusBarcodeRow(firstEmpty)
  }

  function handleBarcodeInputChange(index: number, rawBarcode: string) {
    updateItem(index, 'barcode', rawBarcode)
    const code = normalizeBarcodeValue(rawBarcode)
    const item = items[index]
    if (!item || code.length < 6) return
    const key = item.client_key
    const existingTimer = barcodeLookupTimers.current[key]
    if (existingTimer) window.clearTimeout(existingTimer)
    barcodeLookupTimers.current[key] = window.setTimeout(() => {
      void bindRowToExistingProductByBarcode(key, code, false)
    }, 250)
  }

  async function bindRowToExistingProductByBarcode(rowKey: string, rawBarcode?: string, showMiss = false) {
    const current = items.find((candidate) => candidate.client_key === rowKey)
    if (!current) return
    const code = normalizeBarcodeValue(rawBarcode ?? current.barcode)
    if (code.length < 6) return
    const pendingTimer = barcodeLookupTimers.current[rowKey]
    if (pendingTimer) {
      window.clearTimeout(pendingTimer)
      delete barcodeLookupTimers.current[rowKey]
    }
    try {
      const match = await findExistingProductForItem({ ...current, barcode: code })
      if (!match) {
        if (showMiss) toast.warning('Товар з таким штрихкодом не знайдено в базі')
        return
      }
      if (current.product_id === match.id && !current.is_new && normalizeBarcodeValue(current.barcode) === code) return
      setItems((prev) => prev.map((item) => {
        if (item.client_key !== rowKey) return item
        if (normalizeBarcodeValue(item.barcode) !== code) return item
        return bindExistingProductToItem({ ...item, barcode: code }, match)
      }))
      toast.success(`Підтягнуто з бази: ${match.name}`)
    } catch (err) {
      toast.error((err as any)?.message || 'Не вдалося підтягнути товар з бази')
    }
  }
  // Сканер = клавіатура: вводить код + Enter. На Enter — перехід на наступний рядок.
  // Наступний порожній шукаємо за фактичним value інпутів (а не за стейтом — уникаємо stale).
  function onBarcodeKeyDown(e: React.KeyboardEvent<HTMLInputElement>, i: number) {
    if (e.key === 'Escape' && scanGuide) {
      e.preventDefault(); setScanGuide(false); barcodeRefs.current[i]?.blur(); return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
    void bindRowToExistingProductByBarcode(items[i]?.client_key ?? '', e.currentTarget.value, false)
    let next = -1
    for (let k = i + 1; k < barcodeRefs.current.length; k++) {
      if (!barcodeRefs.current[k]?.value) { next = k; break }
    }
    if (next === -1) {
      if (scanGuide) { setScanGuide(false); toast.success('Штрихкоди прописано') }
      barcodeRefs.current[i]?.blur()
    } else {
      focusBarcodeRow(next)
    }
  }

  // Згенерувати унікальний штрихкод прямо в рядку накладної (як у картці товару)
  async function generateBarcodeForRow(i: number) {
    try {
      const r = await productApi.generateBarcodeOnly()
      if (r.data?.barcode) updateItem(i, 'barcode', r.data.barcode)
    } catch {
      toast.error('Не вдалося згенерувати штрихкод')
    }
  }

  function addItem(product: Product, focusField: RowField = 'purchase') {
    const existingIndex = items.findIndex((i) => i.product_id === product.id)
    if (existingIndex !== -1) {
      setItems((prev) => prev.map((it, idx) => idx === existingIndex ? { ...it, qty: it.qty + 1, total: Math.round((it.qty + 1) * it.purchase_price) } : it))
      setProductSearch('')
      setProductResults([])
      focusRowField(existingIndex, 'qty')
      toast.success('Товар вже був у накладній — кількість збільшено на 1')
      return
    }
    const nextIndex = items.length
    setItems((prev) => [...prev, {
      client_key: makeLineKey(),
      product_id: product.id,
      product_name: product.name,
      qty: 1,
      purchase_price: product.purchase_price,
      retail_price: product.retail_price,
      category_id: product.category_id ?? null,
      total: product.purchase_price,
      storage_bin: product.storage_bin,
      photo_url: product.photo_url ?? null,
      sku: product.sku,
      barcode: product.barcode ?? '',
      unit: normalizeInvoiceUnit(product.unit),
    }])
    focusRowField(nextIndex, focusField)
    setProductSearch('')
    setProductResults([])


    // Підтягуємо порівняння цін постачальників (закупник бачить «у кого дешевше»)
    productApi.getSupplierPrices(product.id)
      .then((r) => setSupplierPrices((prev) => ({ ...prev, [product.id]: r.data ?? [] })))
      .catch(() => {})
  }

  function addDraftItem(overrides: Partial<LineItem> = {}, focusField: RowField = 'name') {
    const nextIndex = items.length
    setItems((prev) => [...prev, makeDraftItem(overrides)])
    setProductSearch('')
    setProductResults([])
    focusRowField(nextIndex, focusField)
  }

  function updateItem(index: number, field: keyof LineItem, value: string | number) {
    setItems((prev) => {
      const next = [...prev]
      const item = { ...next[index] }
      if (problemLineKey === item.client_key) setProblemLineKey(null)
      if (field === 'qty') {
        const qty = parseDecimalInput(value, 0)
        item.qty = qty > 0 ? qty : 0
        item.total = Math.round(item.qty * item.purchase_price)
      } else if (field === 'purchase_price') {
        item.purchase_price = Number(value) || 0
        item.total = Math.round(item.qty * item.purchase_price)
      } else if (field === 'retail_price') {
        item.retail_price = Number(value) || 0
      } else {
        (item as any)[field] = value
      }
      next[index] = item
      return next
    })
  }

  // Сетка цен (ORD P2): авто-розрахунок роздрібної з закупівельної по наценці категорії або сітці
  async function recalcRetail(onlyIndex?: number | number[], forceUseGrid?: boolean, purchaseOverride?: number) {
    const isSingle = typeof onlyIndex === 'number'
    const targets = Array.isArray(onlyIndex) ? onlyIndex : isSingle ? [onlyIndex] : items.map((_, i) => i)
    const localSettings = forceUseGrid
      ? await adminApi.getSettings().then((res) => res.data as any).catch(() => null)
      : null

    const updates = await Promise.all(targets.map(async (idx) => {
      const it = items[idx]
      const purchasePrice = purchaseOverride !== undefined && isSingle ? purchaseOverride : it?.purchase_price
      if (!it || !purchasePrice || purchasePrice <= 0) return null

      if (forceUseGrid && localSettings) {
        const localRetail = retailFromLocalGrid(purchasePrice, localSettings)
        if (localRetail != null) return { idx, retail: localRetail }
        return null
      }

      try {
        const categoryId = forceUseGrid ? undefined : (it.category_id ?? undefined)
        const r = await pricingApi.autoRetail(purchasePrice, categoryId)
        return r.data?.retail_price != null ? { idx, retail: r.data.retail_price } : null
      } catch { return null }
    }))

    const validUpdates = updates.filter((u): u is { idx: number; retail: number } => u !== null)
    const map = new Map(validUpdates.map((u) => [u.idx, u.retail]))
    if (map.size === 0) {
      if (!isSingle) {
        toast.warning(forceUseGrid
          ? 'Не вдалося розрахувати за сіткою: перевірте правила націнки і закупівельні ціни'
          : 'Наценки категорій не задані — задайте їх у «Ціноутворення»'
        )
      }
      return
    }
    setItems((prev) => prev.map((it, i) => map.has(i) ? { ...it, retail_price: map.get(i)! } : it))
    if (!isSingle) {
      toast.success(forceUseGrid
        ? `За сіткою перераховано ${map.size} позицій`
        : `Роздрібні ціни перераховано для ${map.size} позицій`
      )
    }
  }
  function applyCustomPct() {
    const pct = parseFloat(String(customPctValue).replace(',', '.'))
    if (!Number.isFinite(pct) || pct <= 0) {
      toast.error('Вкажіть відсоток числом більше нуля')
      return
    }
    setCustomPctOpen(false)
    applyBulkQuickPercent(pct)
  }

  // Групова націнка: до вибраних галочками (якщо є) або до всіх; галочки після — знімаються.
  function applyBulkQuickPercent(pct: number) {
    if (pct <= 0) return
    const scope = selectedLineKeys.length ? new Set(selectedLineKeys) : null
    setItems((prev) =>
      prev.map((it) => {
        if (scope && !scope.has(it.client_key)) return it
        if (it.purchase_price <= 0) return it
        return { ...it, retail_price: Math.round(it.purchase_price * (1 + pct / 100)) }
      })
    )
    setSelectedLineKeys([])
    toast.success(`Націнку ${pct}% застосовано ${scope ? 'до вибраних' : 'до всіх товарів'}`)
  }

  function applySingleQuickPercent(index: number, pct: number) {
    if (pct <= 0) return
    setItems((prev) => {
      const next = [...prev]
      const it = { ...next[index] }
      if (it.purchase_price > 0) {
        it.retail_price = Math.round(it.purchase_price * (1 + pct / 100))
      }
      next[index] = it
      return next
    })
  }

  function openInvoiceImportPreview(rawRows: unknown[][], fileName = '') {
    const rows = (rawRows ?? [])
      .map((row) => Array.isArray(row) ? row : [])
      .filter((row) => row.some((cell) => cleanImportCell(cell)))
    if (rows.length === 0) {
      toast.warning('У файлі не знайдено рядків для імпорту')
      return
    }
    const detected = guessInvoiceImport(rows)
    setInvoiceImportRows(rows)
    setInvoiceImportFileName(fileName)
    setInvoiceImportMapping(detected.mapping)
    setInvoiceImportStartRow(detected.startRow)
    setInvoiceImportHeaderRow(detected.headerRow)
    setInvoiceImportModal(true)
  }

  function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.name.toLowerCase().endsWith('.csv')) {
      Papa.parse(file, {
        header: false,
        skipEmptyLines: false,
        complete: (results: any) => openInvoiceImportPreview(results.data, file.name),
        error: () => toast.error('Помилка читання CSV файлу'),
      })
    } else {
      const reader = new FileReader()
      reader.onload = (evt) => {
        try {
          const data = new Uint8Array(evt.target?.result as ArrayBuffer)
          const workbook = read(data, { type: 'array', cellText: true, cellNF: true })
          const sheet = workbook.Sheets[workbook.SheetNames[0]]
          const json = utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as unknown[][]
          openInvoiceImportPreview(json, file.name)
        } catch {
          toast.error('Помилка читання Excel файлу')
        }
      }
      reader.readAsArrayBuffer(file)
    }
    e.target.value = ''
  }

  async function confirmInvoiceImport() {
    if (resolvingImportedProducts) return
    if (invoiceImportMapping.name == null && invoiceImportMapping.sku == null && invoiceImportMapping.barcode == null) {
      toast.error('Вкажіть хоча б колонку назви, артикула або штрихкоду')
      return
    }
    if (invoiceImportMapping.purchase == null) {
      toast.error('Вкажіть колонку закупочної ціни — без неї накладна може затягнути зайві рядки')
      return
    }
    if (invoiceImportPreview.items.length === 0) {
      toast.warning('Після фільтрації не залишилось товарних рядків. Перевірте рядок початку і колонки.')
      return
    }
    const importItems = invoiceImportPreview.items
    setResolvingImportedProducts(true)
    try {
      const resolved = await resolveExistingProductsForItems(importItems)
      appendLineItems(resolved.items)
      toast.success(`Імпортовано ${resolved.items.length} товарів${resolved.matched ? `, знайдено в базі ${resolved.matched}` : ''}${invoiceImportPreview.skipped ? `, пропущено ${invoiceImportPreview.skipped} зайвих рядків` : ''}`)
    } catch (error) {
      const matchError = error instanceof InvoiceImportMatchError
        ? error
        : new InvoiceImportMatchError(importItems[0], error)
      appendLineItems(importItems)
      raiseInvoiceLineProblem(matchError.item.client_key, matchError.message, matchError.item)
    } finally {
      setResolvingImportedProducts(false)
      setInvoiceImportModal(false)
      setInvoiceImportRows([])
      setInvoiceImportFileName('')
    }
  }
  async function handleClipboardPaste() {
    if (!clipboardText.trim() || resolvingImportedProducts) return
    const lines = clipboardText.split('\n').filter(line => line.trim())
    const newItems: LineItem[] = []
    
    lines.forEach(line => {
      const cols = line.split('\t')
      if (cols.length < 2) return
      
      const sku = cols[0]?.trim() || ''
      const name = cols[1]?.trim() || ''
      if (!sku && !name) return
      
      const qty = parseQty(cols[2], 1)
      const purchase = parseMoneyToKopecks(cols[3])
      const retail = parseMoneyToKopecks(cols[4])
      const bin = cols[5]?.trim() || null

      const clientKey = makeLineKey()
      newItems.push({
        client_key: clientKey,
        product_name: name || `Товар (${sku})`,
        sku: sku || makeAutoSku(clientKey),
        qty,
        purchase_price: purchase,
        retail_price: retail,
        category_id: null,
        unit: 'шт',
        total: Math.round(qty * purchase),
        storage_bin: bin || null,
        is_new: true,
      })
    })
    
    if (newItems.length > 0) {
      setResolvingImportedProducts(true)
      try {
        const resolved = await resolveExistingProductsForItems(newItems)
        appendLineItems(resolved.items)
        toast.success(`Імпортовано ${resolved.items.length} товарів з буфера${resolved.matched ? `, знайдено в базі ${resolved.matched}` : ''}`)
      } catch (error) {
        const matchError = error instanceof InvoiceImportMatchError
          ? error
          : new InvoiceImportMatchError(newItems[0], error)
        appendLineItems(newItems)
        raiseInvoiceLineProblem(matchError.item.client_key, matchError.message, matchError.item)
      } finally {
        setResolvingImportedProducts(false)
        setClipboardText('')
      }
    } else {
      toast.error('Не вдалося розпарсити буфер. Скопіюйте таблицю з Excel.')
    }
  }

  async function handleCreateSupplier() {
    if (!newSupplierName.trim()) {
      toast.error('Назва постачальника обов’язкова')
      return
    }
    setCreatingSupplier(true)
    try {
      const res = await supplierApi.create({
        name: newSupplierName.trim(),
        phone: newSupplierPhone.trim() || null
      })
      toast.success('Постачальника створено')
      const newSup = res.data
      setSuppliers((prev) => [...prev, newSup])
      setSupplierId(newSup.id)
      setSupplierModal(false)
      setNewSupplierName('')
      setNewSupplierPhone('')
    } catch (err) {
      toast.error('Помилка створення постачальника')
    } finally {
      setCreatingSupplier(false)
    }
  }

  function removeItem(index: number) {
    setMoneyDrafts({})
    const key = items[index]?.client_key
    if (key) setSelectedLineKeys((prev) => prev.filter((k) => k !== key))
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  function toggleLineSelection(key: string, checked: boolean) {
    setSelectedLineKeys((prev) => checked ? Array.from(new Set([...prev, key])) : prev.filter((k) => k !== key))
  }

  function toggleAllLineSelection(checked: boolean) {
    setSelectedLineKeys(checked ? items.map((item) => item.client_key) : [])
  }

  function selectedIndices(): number[] {
    const set = new Set(selectedLineKeys)
    return items.map((it, i) => (set.has(it.client_key) ? i : -1)).filter((i) => i >= 0)
  }

  function applyBulkCategory() {
    if (selectedLineKeys.length === 0) { toast.warning('Виберіть товари галочками'); return }
    if (!bulkCategoryId) { toast.warning('Виберіть категорію'); return }
    const selected = new Set(selectedLineKeys)
    setItems((prev) => prev.map((item) => selected.has(item.client_key) ? { ...item, category_id: bulkCategoryId } : item))
    toast.success(`Категорію встановлено для ${selected.size} товарів`)
    setSelectedLineKeys([]) // галочки знімаються автоматично після застосування
  }

  function appendLineItems(newItems: LineItem[]) {
    setItems((prev) => {
      const next = [...prev]
      for (const incoming of newItems) {
        const existingIndex = incoming.product_id
          ? next.findIndex((item) => item.product_id === incoming.product_id)
          : -1
        if (existingIndex >= 0) {
          const current = next[existingIndex]
          const qty = current.qty + incoming.qty
          const purchase = incoming.purchase_price > 0 ? incoming.purchase_price : current.purchase_price
          next[existingIndex] = {
            ...current,
            ...incoming,
            client_key: current.client_key,
            qty,
            purchase_price: purchase,
            retail_price: incoming.retail_price > 0 ? incoming.retail_price : current.retail_price,
            total: Math.round(qty * purchase),
          }
        } else {
          next.push(incoming)
        }
      }
      return next
    })
  }

  const total = items.reduce((sum, i) => sum + i.total, 0)

  function bindExistingProductToItem(item: LineItem, product: Product): LineItem {
    const purchase = item.purchase_price > 0 ? item.purchase_price : product.purchase_price
    const retail = item.retail_price > 0 ? item.retail_price : product.retail_price
    return {
      ...item,
      product_id: product.id,
      is_new: false,
      sku: product.sku,
      barcode: product.barcode || item.barcode || '',
      product_name: product.name || item.product_name,
      category_id: item.category_id ?? product.category_id ?? null,
      storage_bin: item.storage_bin ?? product.storage_bin ?? null,
      photo_url: item.photo_url ?? product.photo_url ?? null,
      unit: normalizeInvoiceUnit(product.unit || item.unit),
      purchase_price: purchase,
      retail_price: retail,
      total: Math.round(item.qty * purchase),
    }
  }

  async function resolveExistingProductsForItems(rawItems: LineItem[]): Promise<{ items: LineItem[]; matched: number }> {
    const cache = new Map<string, Product>()
    const remember = (product: Product) => {
      const sku = (product.sku || '').trim()
      const barcode = normalizeBarcodeValue(product.barcode)
      if (sku) cache.set(`sku:${normalizeSkuValue(sku)}`, product)
      if (barcode) cache.set(`barcode:${barcode}`, product)
      for (const extra of product.additional_barcodes ?? []) {
        const normalizedExtra = normalizeBarcodeValue(extra)
        if (normalizedExtra) cache.set(`barcode:${normalizedExtra}`, product)
      }
    }
    const fromCache = (item: LineItem) => {
      const sku = (item.sku || '').trim()
      const barcode = normalizeBarcodeValue(item.barcode)
      return resolveCachedInvoiceProduct(
        cache,
        sku ? normalizeSkuValue(sku) : null,
        barcode,
        item.product_name,
      )
    }
    const result: LineItem[] = []
    let matched = 0
    const batchSize = 8
    for (let offset = 0; offset < rawItems.length; offset += batchSize) {
      const batch = rawItems.slice(offset, offset + batchSize)
      const products = await Promise.all(batch.map(async (item) => {
        try {
          const cached = fromCache(item)
          return cached ?? await findExistingProductForItem(item)
        } catch (error) {
          throw new InvoiceImportMatchError(item, error)
        }
      }))
      for (let index = 0; index < batch.length; index += 1) {
        const item = batch[index]
        const product = products[index]
        if (product) {
          remember(product)
          matched += 1
          result.push(bindExistingProductToItem(item, product))
        } else {
          result.push(item)
        }
      }
    }
    return { items: result, matched }
  }

  async function findExistingProductForItem(item: LineItem): Promise<Product | null> {
    const skuTrim = (item.sku || '').trim()
    const barcodeTrim = normalizeBarcodeValue(item.barcode)
    const nameTrim = (item.product_name || '').trim()
    const matches: Product[] = []

    const pushMatch = (product: Product | null | undefined) => {
      if (product && !matches.some((candidate) => candidate.id === product.id)) matches.push(product)
    }

    const resolveIdentifierMatch = (): Product | null => {
      const unique = [...new Map(matches.map((product) => [product.id, product])).values()]
      if (unique.length > 1) {
        throw new Error(`У рядку «${item.product_name || skuTrim || barcodeTrim}» артикул і штрихкод належать різним товарам. Перевірте цей рядок.`)
      }
      return unique[0] ?? null
    }

    const localCatalog = desktopBridge()?.catalog
    if (localCatalog) {
      const [localByBarcode, localBySku] = await Promise.all([
        barcodeTrim ? localCatalog.findByBarcode(barcodeTrim) : Promise.resolve(null),
        skuTrim && localCatalog.findBySku ? localCatalog.findBySku(skuTrim) : Promise.resolve(null),
      ])
      if (localByBarcode) pushMatch(desktopProductToProduct(localByBarcode))
      if (localBySku) pushMatch(desktopProductToProduct(localBySku))
      const identifierMatch = resolveIdentifierMatch()
      if (identifierMatch) return identifierMatch
    } else {
      const [skuResult, barcodeResult] = await Promise.all([
        skuTrim ? productApi.search(skuTrim, 200) : Promise.resolve(null),
        barcodeTrim ? productApi.search(barcodeTrim, 200) : Promise.resolve(null),
      ])
      const normalizedSku = normalizeSkuValue(skuTrim)
      for (const product of skuResult?.data ?? []) {
        if (normalizeSkuValue(product.sku || '') === normalizedSku) pushMatch(product)
      }
      for (const product of barcodeResult?.data ?? []) {
        const primary = normalizeBarcodeValue(product.barcode)
        const additional = Array.isArray(product.additional_barcodes)
          ? product.additional_barcodes.map(normalizeBarcodeValue)
          : []
        if (primary === barcodeTrim || additional.includes(barcodeTrim)) pushMatch(product)
      }
      const identifierMatch = resolveIdentifierMatch()
      if (identifierMatch) return identifierMatch
    }

    if (nameTrim.length >= 2) {
      const existing = await productApi.search(nameTrim, 200)
      const exactName = normalizeExactInvoiceProductName(nameTrim)
      const exactMatches = existing.data.filter(
        (product) => normalizeExactInvoiceProductName(product.name) === exactName,
      )
      const uniqueExactMatches = [...new Map(exactMatches.map((product) => [product.id, product])).values()]
      if (uniqueExactMatches.length === 1) return uniqueExactMatches[0]
      if (uniqueExactMatches.length > 1) {
        throw new Error(`Повна назва «${nameTrim}» збігається з кількома товарами. Виберіть правильний товар вручну.`)
      }
    }

    return null
  }
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (items.length === 0) { toast.error('Додайте хоча б один товар'); return }
    if (!supplierId) { toast.error('Оберіть постачальника'); return }
    if (invoiceSubmitRef.current) return

    invoiceSubmitRef.current = true
    setSaving(true)
    try {
      // Перевіряємо касову зміну до створення нових карток товарів. Інакше при
      // відмові оплати накладна не створювалась, а її товари вже лишались у базі.
      const paidKopecks = !isEdit ? parseMoneyToKopecks(paidAmount) : 0
      const shift = !isEdit && paidKopecks > 0 && fundSource === 'cashbox'
        ? await shiftApi.current().catch(() => null)
        : null
      const shiftId = (shift as any)?.data?.id ?? null
      if (!isEdit && paidKopecks > 0 && fundSource === 'cashbox' && !shiftId) {
        toast.error('Щоб платити з каси, спочатку відкрийте касову зміну')
        return
      }

      // 1. Create missing products first. Робимо послідовно, щоб два однакові
      // рядки з імпорту/телефона не створювали товар паралельно і не ловили duplicate.
      const productCache = new Map<string, Product>()

      const rememberProduct = (product: Product) => {
        const sku = (product.sku || '').trim()
        const barcode = normalizeBarcodeValue(product.barcode)
        if (sku) productCache.set(`sku:${normalizeSkuValue(sku)}`, product)
        if (barcode) productCache.set(`barcode:${barcode}`, product)
        for (const extra of product.additional_barcodes ?? []) {
          const normalizedExtra = normalizeBarcodeValue(extra)
          if (normalizedExtra) productCache.set(`barcode:${normalizedExtra}`, product)
        }
      }

      const cachedProductForItem = (item: LineItem): Product | null => {
        const sku = (item.sku || '').trim()
        const barcode = normalizeBarcodeValue(item.barcode)
        return resolveCachedInvoiceProduct(
          productCache,
          sku ? normalizeSkuValue(sku) : null,
          barcode,
          item.product_name,
        )
      }
      const bindProductToItem = (item: LineItem, product: Product): LineItem => {
        return bindExistingProductToItem(item, product)
      }

      const resolvedItems: LineItem[] = []
      for (const item of items) {
        // Перед проведенням ще раз шукаємо точний збіг у базі за артикулом/ШК.
        // Якщо постачальник прислав рядок з уже існуючим артикулом — приймаємо товар
        // на існуючу картку, а не створюємо дубль і не блокуємо накладну.
        let exactMatch: Product | null = null
        try {
          exactMatch = await findExistingProductForItem(item)
        } catch (lineErr) {
          const message = lineErr instanceof Error ? lineErr.message : 'У цьому рядку конфлікт артикула або штрихкоду'
          raiseInvoiceLineProblem(item.client_key, message)
          throw makeInvoiceLineProblemError()
        }
        if (exactMatch) {
          rememberProduct(exactMatch)
          const boundItem = bindProductToItem(item, exactMatch)
          // Для вже прив'язаного рядка не стираємо дані, які користувач щойно
          // відредагував у накладній. Для нового імпортованого рядка картка з
          // бази, як і раніше, лишається авторитетною.
          if (item.product_id === exactMatch.id && !item.is_new) {
            boundItem.product_name = item.product_name.trim() || exactMatch.name
            if (item.sku.trim()) boundItem.sku = item.sku.trim()
            if (normalizeBarcodeValue(item.barcode)) boundItem.barcode = normalizeBarcodeValue(item.barcode)
          }
          resolvedItems.push(boundItem)
          continue
        }

        if (item.product_id && !item.is_new) {
          resolvedItems.push(item)
          continue
        }

        let cached: Product | null = null
        try {
          cached = cachedProductForItem(item)
        } catch (lineErr) {
          const message = lineErr instanceof Error ? lineErr.message : 'У цьому рядку конфлікт артикула або штрихкоду'
          raiseInvoiceLineProblem(item.client_key, message)
          throw makeInvoiceLineProblemError()
        }
        if (cached) {
          resolvedItems.push(bindProductToItem(item, cached))
          continue
        }

        // Бракує даних — не блокуємо збереження/проведення: підставляємо авто-артикул/назву
        // (товар створюється з плейсхолдером, який можна допиляти пізніше в картці).
        const skuTrim = (item.sku || '').trim()
        const genSku = skuTrim || makeAutoSku(item.client_key)
        const genName = (item.product_name || '').trim() || `Товар ${genSku}`

        const form: ProductFormData = {
          name: genName,
          sku: genSku,
          barcode: item.barcode || '',
          unit: normalizeInvoiceUnit(item.unit),
          purchase_price: kopecksForForm(item.purchase_price),
          retail_price: kopecksForForm(item.retail_price),
          qty_on_hand: '0',
          reorder_point: '0',
          notes: '',
          is_active: true,
          storage_bin: item.storage_bin ?? '',
          is_favorite: false,
          brand_id: '',
          category_id: item.category_id ?? '',
          photo_url: item.photo_url || null,
          specs: {}
        }
        try {
          const res = await productApi.create(form, { silent: true, reuseExistingSku: true })
          rememberProduct(res.data)
          resolvedItems.push(bindProductToItem(item, res.data))
        } catch (createErr) {
          if (!isDuplicateProductError(createErr)) throw createErr
          const duplicateMatch = await findExistingProductForItem({ ...item, sku: genSku, product_name: genName })
          if (!duplicateMatch) {
            raiseInvoiceLineProblem(item.client_key, duplicateProductMessage(createErr, item.product_name || genSku))
            throw makeInvoiceLineProblemError()
          }
          rememberProduct(duplicateMatch)
          resolvedItems.push(bindProductToItem(item, duplicateMatch))
        }
      }

      // Зберігаємо відредаговані дані карток ДО створення накладної. Так помилка
      // артикула/штрихкоду не губиться після створення документа і касир може
      // одразу виправити або замінити саме проблемний рядок без дубля накладної.
      if (!isEdit) {
        const productUpdateResults = await Promise.allSettled(
          resolvedItems.map(async (item) => {
            const patch: Partial<ProductFormData> = {
              name: item.product_name,
              category_id: item.category_id ?? '',
              storage_bin: item.storage_bin ?? '',
              is_active: true,
            }
            const sku = item.sku.trim()
            const barcode = normalizeBarcodeValue(item.barcode)
            if (sku) patch.sku = sku
            if (barcode) patch.barcode = barcode
            if (item.retail_price > 0) patch.retail_price = kopecksForForm(item.retail_price)
            if (item.photo_url) patch.photo_url = item.photo_url
            await productApi.update(item.product_id!, patch, { silent: true })
          }),
        )
        const failedIndex = productUpdateResults.findIndex((result) => result.status === 'rejected')
        if (failedIndex >= 0) {
          const failedItem = resolvedItems[failedIndex]
          const failedResult = productUpdateResults[failedIndex] as PromiseRejectedResult
          const rawMessage = failedResult.reason instanceof Error ? failedResult.reason.message : ''
          const field: RowField = /штрихкод|barcode/i.test(rawMessage) ? 'barcode' : 'sku'
          const message = isDuplicateProductError(failedResult.reason)
            ? duplicateProductMessage(failedResult.reason, failedItem.product_name)
            : /foreign key/i.test(rawMessage)
              ? `«${failedItem.product_name}»: не вдалося зберегти картку через некоректну категорію. Виберіть категорію ще раз.`
              : `«${failedItem.product_name}»: не вдалося зберегти артикул, штрихкод або інші дані товару. Перевірте рядок і повторіть.`
          itemsRef.current = resolvedItems
          setItems(resolvedItems)
          raiseInvoiceLineProblem(failedItem.client_key, message, failedItem, field)
          throw makeInvoiceLineProblemError()
        }
      }

      const body = {
        supplier_id: supplierId,
        invoice_number: invoiceNumber.trim() || null,
        notes: notes.trim() || null,
        items: resolvedItems.map((i) => ({
          product_id: i.product_id!,
          qty: i.qty,
          purchase_price: i.purchase_price,
          total: i.total,
        })),
      }
      const existingDraftId = isEdit ? id! : serverDraftIdRef.current
      if (existingDraftId) {
        const updated = await supplierApi.updateInvoice(existingDraftId, { ...body, draft_payload: null })
        const invoiceId = updated.data.id

        if (!isEdit && paidKopecks > 0) {
          await supplierApi.payInvoice(invoiceId, {
            amount: paidKopecks,
            payment_method: paymentMethod,
            fund_source: fundSource,
            shift_id: shiftId,
            note: 'Оплата під час створення накладної',
          })
        }

        if (!isEdit && postImmediately) {
          try {
            await supplierApi.postInvoice(invoiceId)
            toast.success('Накладну створено і проведено — залишки оновлено')
          } catch {
            toast.warning('Накладну збережено, але не вдалось провести — проведіть вручну зі списку')
          }
        } else {
          toast.success(isEdit ? 'Накладну оновлено' : 'Накладну створено')
        }
      } else {
        const created = await supplierApi.createInvoice({
          ...body,
          paid_amount: paidKopecks,
          payment_method: paidKopecks > 0 ? paymentMethod : null,
          fund_source: paidKopecks > 0 ? fundSource : null,
          shift_id: shiftId,
        })

        // «Провести одразу» — збільшує залишки на складі без окремого заходу в список
        if (postImmediately && created?.data?.id) {
          try {
            await supplierApi.postInvoice(created.data.id)
            toast.success('Накладну створено і проведено — залишки оновлено')
          } catch {
            toast.warning('Накладну створено, але не вдалось провести — проведіть вручну зі списку')
          }
        } else {
          toast.success('Накладну створено')
        }
      }
      invoiceDraftPersistenceDisabledRef.current = true
      clearSupplyInvoiceDraft(invoiceDraftKey)
      navigate(`/suppliers/invoices`)
    } catch (err) {
      if ((err as Error)?.name === 'InvoiceLineProblem') {
        return
      }
      if (isDuplicateProductError(err)) {
        toast.error(duplicateProductMessage(err))
      } else {
        toast.error(err instanceof Error ? err.message : 'Помилка збереження накладної')
      }
    } finally {
      invoiceSubmitRef.current = false
      setSaving(false)
    }
  }

  function closeInvoiceForm() {
    // Раніше «Назад» СТИРАВ чернетку — тому випадковий вихід губив усю роботу.
    // Тепер чернетку НЕ чистимо: вона лишається і відновиться при наступному
    // відкритті. Якщо накладна не порожня — питаємо підтвердження.
    const hasContent = items.length > 0 || invoiceNumber.trim().length > 0 || notes.trim().length > 0
    if (hasContent && !confirm('Вийти з накладної?\n\nНезбережена накладна лишиться чернеткою і відновиться тут або з іншого пристрою.')) return
    navigate('/suppliers/invoices')
  }

  if (loading) return <Layout title="Завантаження..."><div className="text-gray-400 text-sm">Завантаження...</div></Layout>

  return (
    <Layout
      title={isEdit ? 'Редагувати накладну' : 'Нова приходна накладна'}
      onBack={closeInvoiceForm}
    >
      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Card>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Постачальник *</label>
                <div className="flex gap-2">
                  <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                    disabled={isEdit}>
                    <option value="">— Оберіть —</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {!isEdit && (
                    <button type="button" onClick={() => setSupplierModal(true)}
                      className="px-3.5 py-2 bg-yellow-500 hover:bg-yellow-600 text-white font-bold text-sm rounded-lg transition-colors"
                      title="Швидке створення постачальника">
                      +
                    </button>
                  )}
                </div>
              </div>
              <Input label="№ накладної" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="Номер від постачальника" />
            </div>
          </Card>
          <Card>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Нотатки</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                rows={4} placeholder="Коментар до накладної..." />
            </div>
          </Card>
        </div>

        {/* Спосіб додавання товарів */}
        {!isEdit && (
          <Card className="mb-6">
            <div className="grid grid-cols-3 gap-1.5 border-b border-gray-100 pb-3 mb-4">
              <button type="button" onClick={() => setImportTab('manual')}
                className={`px-2 py-2 text-xs font-semibold rounded-lg transition-colors ${importTab === 'manual' ? 'bg-yellow-400 text-black' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}>
                Швидко
              </button>
              <button type="button" onClick={() => setImportTab('file')}
                className={`px-2 py-2 text-xs font-semibold rounded-lg transition-colors ${importTab === 'file' ? 'bg-yellow-400 text-black' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}>
                Excel
              </button>
              <button type="button" onClick={() => setImportTab('clipboard')}
                className={`px-2 py-2 text-xs font-semibold rounded-lg transition-colors ${importTab === 'clipboard' ? 'bg-yellow-400 text-black' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}>
                Буфер
              </button>
            </div>

            {importTab === 'manual' && (
              <div className="space-y-2">
                <Input value={productSearch} onChange={(e) => setProductSearch(e.target.value)} onKeyDown={handleProductSearchKeyDown} placeholder="Знайти існуючий товар за назвою, артикулом або штрихкодом..." className="w-full" />
                <p className="text-xs text-gray-400">Enter додає існуючий товар лише за точним штрихкодом, артикулом або точною назвою. Якщо точного збігу немає — створюється новий рядок.</p>
              </div>
            )}

            {importTab === 'file' && (
              <div className="border border-dashed border-gray-200 rounded-xl p-6 text-center hover:bg-gray-50/50 transition-colors">
                <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileImport} id="file-import" className="hidden" />
                <label htmlFor="file-import" className="cursor-pointer flex flex-col items-center justify-center gap-2">
                  <span className="p-3 bg-yellow-100 text-yellow-700 rounded-full">📁</span>
                  <span className="font-semibold text-sm text-gray-700">Оберіть Excel (.xlsx) або CSV файл</span>
                  <span className="text-xs text-gray-400">Можна з заголовками або без них: SKU/Артикул, Назва, Кількість, Закупка...</span>
                </label>
              </div>
            )}

            {importTab === 'clipboard' && (
              <div className="space-y-3">
                <textarea value={clipboardText} onChange={(e) => setClipboardText(e.target.value)} rows={4}
                  placeholder="Вставте скопійовану таблицю з Excel/Google Sheets сюди. Колонка 1: Артикул, Колонка 2: Назва, Колонка 3: К-сть, Колонка 4: Закупка..."
                  className="w-full border border-gray-200 rounded-lg p-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-yellow-400 resize-none" />
                <Button type="button" onClick={handleClipboardPaste} loading={resolvingImportedProducts} disabled={resolvingImportedProducts}>
                  Імпортувати дані
                </Button>
              </div>
            )}

            {importTab === 'manual' && productResults.length > 0 && (
              <div className="mt-2 max-h-96 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-sm">
                {productResults.map((p) => (
                  <button key={p.id} type="button" onClick={() => addItem(p)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-yellow-50 flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="shrink-0 text-gray-400 text-xs font-mono">{p.sku} — {formatMoney(p.retail_price)}</span>
                  </button>
                ))}
                {productResults.length >= 50 && (
                  <p className="px-3 py-1.5 text-center text-[11px] text-gray-400 border-t border-gray-100">
                    Показано перші 50 — уточніть запит, якщо не знайшли
                  </p>
                )}
              </div>
            )}
          </Card>
        )}

        {/* Позиції */}
        <Card padding="none" className="mb-6">
          <div className="px-4 py-3 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <span className="text-sm font-semibold text-gray-800 shrink-0">Позиції ({items.length})</span>
            {!isEdit && (
              <div className="flex flex-wrap items-center gap-2">
                {items.length > 0 && (
                  <div className="flex items-center gap-2 mr-auto flex-wrap bg-gray-50 border border-gray-200 rounded-xl px-2.5 py-1.5">
                    <span className="text-xs text-gray-500 font-medium">Групова націнка:</span>
                    <select
                      value={bulkMarkupSelection}
                      onChange={(e) => {
                        const val = e.target.value
                        setBulkMarkupSelection(val)
                        if (val === 'grid') {
                          const idxs = selectedLineKeys.length ? selectedIndices() : undefined
                          recalcRetail(idxs, true)
                          setSelectedLineKeys([])
                        } else if (val.startsWith('pct:')) {
                          const pct = parseFloat(val.split(':')[1])
                          applyBulkQuickPercent(pct)
                        } else if (val === 'manual') {
                          // Власна модалка: Electron не реалізує window.prompt(),
                          // і на касі цей пункт просто нічого не робив.
                          setCustomPctValue('')
                          setCustomPctOpen(true)
                        }
                      }}
                      className="border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 bg-white"
                    >
                      <option value="">Націнка…</option>
                      <option value="grid">За таблицею</option>
                      {quickPercents.map((pct) => (
                        <option key={pct} value={`pct:${pct}`}>{pct}%</option>
                      ))}
                      <option value="manual">Свій відсоток…</option>
                    </select>
                  </div>
                )}
                {items.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap bg-blue-50 border border-blue-100 rounded-xl px-2.5 py-1.5">
                    <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={items.length > 0 && selectedLineKeys.length === items.length}
                        onChange={(e) => toggleAllLineSelection(e.target.checked)}
                        className="w-4 h-4 accent-yellow-400"
                      />
                      Всі
                    </label>
                    <span className="text-xs text-blue-700 font-medium">Категорія для вибраних ({selectedLineKeys.length}):</span>
                    <select
                      value={bulkCategoryId}
                      onChange={(e) => setBulkCategoryId(e.target.value)}
                      className="border border-blue-100 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 bg-white min-w-[160px]"
                    >
                      <option value="">Вибрати категорію</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button type="button" onClick={applyBulkCategory} className="px-2.5 py-1 rounded bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700">
                      Застосувати
                    </button>
                  </div>
                )}
                
              </div>
            )}
            {isEdit && (
              <span className="text-xs text-gray-400 italic">Позиції не змінюються при редагуванні</span>
            )}
          </div>



          {!isEdit && items.length > 0 && (
            <div className="flex items-center gap-2 mb-2">
              <button type="button" onClick={startScanGuide}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${scanGuide ? 'bg-yellow-400 text-black' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                ▶ Прописати ШК по черзі
              </button>
              {scanGuide
                ? <span className="text-xs text-gray-500">Скануйте — фокус сам переходить на наступний рядок без ШК. Esc — вийти.</span>
                : <span className="text-xs text-gray-400">Помаранчеві поля — без штрихкоду</span>}
            </div>
          )}

          <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
                <th className="w-10 px-2 py-2 text-center">✓</th>
                <th className="w-12 px-2 py-2">Фото</th>
                <th className="text-left px-4 py-2">Товар</th>
                <th className="text-left px-2 py-2 w-44">Папка</th>
                <th className="text-left px-2 py-2 w-40">Штрихкод</th>
                <th className="text-left px-2 py-2 w-28">Комірка</th>
                <th className="text-right px-2 py-2 w-20">К-сть</th>
                <th className="text-left px-2 py-2 w-24">Од.</th>
                <th className="text-right px-2 py-2 w-24">Закупка, грн</th>
                <th className="text-right px-2 py-2 w-24 text-right">Націнка</th>
                <th className="text-right px-2 py-2 w-28">Розн. ціна, грн</th>
                <th className="text-right px-4 py-2 w-24">Сума</th>
                <th className="w-10 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => {
                const prices = item.product_id ? (supplierPrices[item.product_id] ?? []) : []
                const best = prices[0]
                const cheaperElsewhere = best && supplierId && best.supplier_id !== supplierId && best.price < item.purchase_price
                const hasProblem = problemLineKey === item.client_key
                return (
                <tr key={item.client_key} className={hasProblem ? 'border-b border-red-200 bg-red-50/80 ring-2 ring-red-200' : 'border-b border-gray-50 hover:bg-gray-50/50'}>
                  <td className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={selectedLineKeys.includes(item.client_key)}
                      onChange={(e) => toggleLineSelection(item.client_key, e.target.checked)}
                      disabled={isEdit}
                      className="w-4 h-4 accent-yellow-400"
                    />
                  </td>
                  <td className="px-2 py-2 w-12 text-center">
                    <RowPhotoCell
                      photoUrl={item.photo_url ?? null}
                      productId={item.product_id || 'new_' + i}
                      onPhotoUpdated={(newUrl) => {
                        setItems((prev) => prev.map((it, idx) => idx === i ? { ...it, photo_url: newUrl } : it))
                      }}
                    />
                  </td>
                  <td className="px-4 py-2 font-medium min-w-[200px]">
                    <input ref={(el) => { rowNameRefs.current[i] = el }} type="text" value={item.product_name}
                      onChange={(e) => updateItem(i, 'product_name', e.target.value)}
                      onKeyDown={(e) => handleRowFieldKeyDown(e, i, 'name')}
                      disabled={isEdit}
                      placeholder="Назва товару"
                      className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-medium outline-none hover:border-gray-200 focus:border-yellow-400 focus:bg-white focus:ring-2 focus:ring-yellow-100 disabled:bg-gray-50 disabled:text-gray-400" />
                    {problemLineKey === item.client_key && (
                      <div className="mt-1 rounded-lg border border-red-200 bg-red-100 px-2 py-1 text-[11px] font-semibold text-red-700">
                        Проблемний рядок: змініть артикул, або видаліть рядок і додайте товар через пошук.
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-1 px-2 text-xs">
                      <span className="text-gray-400 font-semibold uppercase text-[10px]">SKU:</span>
                      <input ref={(el) => { skuRefs.current[i] = el }} type="text" value={item.sku}
                        onChange={(e) => updateItem(i, 'sku', e.target.value)}
                        onKeyDown={(e) => handleRowFieldKeyDown(e, i, 'sku')}
                        disabled={isEdit}
                        placeholder="Артикул"
                        className="w-32 border border-transparent hover:border-gray-200 focus:border-yellow-400 rounded px-1.5 py-0.5 text-xs bg-transparent focus:bg-white font-mono" />
                    </div>
                    {best && (
                      <div className={`text-[11px] mt-0.5 font-normal ${cheaperElsewhere ? 'text-orange-600 font-semibold' : 'text-gray-400'}`}
                        title={prices.slice(0, 5).map((p: any) => `${p.supplier_name}: ${(p.price / 100).toFixed(2)} грн`).join('\n')}>
                        🏷 найдешевше: {(best.price / 100).toFixed(2)} грн — {best.supplier_name}
                        {cheaperElsewhere && ` (дешевше за поточну на ${((item.purchase_price - best.price) / 100).toFixed(2)} грн)`}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <select
                      value={item.category_id ?? ''}
                      onChange={(e) => updateItem(i, 'category_id', e.target.value)}
                      disabled={isEdit}
                      title="Папка/категорія товару"
                      className="w-40 border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400 bg-white"
                    >
                      <option value="">Без папки</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1">
                      <input
                        ref={(el) => { barcodeRefs.current[i] = el }}
                        type="text" value={item.barcode ?? ''}
                        onChange={(e) => handleBarcodeInputChange(i, e.target.value)}
                        onBlur={(e) => { void bindRowToExistingProductByBarcode(item.client_key, e.currentTarget.value, false) }}
                        onKeyDown={(e) => scanGuide ? onBarcodeKeyDown(e, i) : handleRowFieldKeyDown(e, i, 'barcode')}
                        disabled={isEdit}
                        placeholder="скан / ввід"
                        autoComplete="off"
                        className={`w-28 border rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400 ${item.barcode ? 'border-gray-200' : 'border-orange-300 bg-orange-50'}`} />
                      <button type="button" disabled={isEdit} onClick={() => generateBarcodeForRow(i)}
                        title="Згенерувати штрихкод"
                        className="shrink-0 p-1.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40">
                        <Barcode size={14} />
                      </button>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <input type="text" value={item.storage_bin ?? ''}
                      onChange={(e) => updateItem(i, 'storage_bin', e.target.value)}
                      disabled={isEdit}
                      placeholder="Немає"
                      className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400" />
                  </td>
                  <td className="px-2 py-2">
                    <input ref={(el) => { qtyRefs.current[i] = el }} type="number" step="1" min="0" value={item.qty}
                      onChange={(e) => updateItem(i, 'qty', e.target.value)}
                      onKeyDown={(e) => handleRowFieldKeyDown(e, i, 'qty')}
                      disabled={isEdit}
                      className="w-full min-w-[72px] text-right border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400" />
                  </td>
                  <td className="px-2 py-2">
                    <select
                      value={normalizeInvoiceUnit(item.unit)}
                      onChange={(e) => updateItem(i, 'unit', e.target.value)}
                      disabled={isEdit}
                      className="w-20 border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400 bg-white"
                    >
                      <option value="шт">шт</option>
                      <option value="кг">кг</option>
                      <option value="компл">компл</option>
                      <option value="л">л</option>
                      <option value="м">м</option>
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <input ref={(el) => { purchaseRefs.current[i] = el }} type="text" inputMode="decimal"
                      value={moneyValue(i, 'purchase_price', item.purchase_price)}
                      onFocus={(e) => beginMoneyEdit(i, 'purchase_price', item.purchase_price, e.currentTarget)}
                      onPaste={(e) => { e.preventDefault(); pasteMoney(i, 'purchase_price', e.clipboardData.getData('text')) }}
                      onChange={(e) => changeMoney(i, 'purchase_price', e.target.value)}
                      onKeyDown={(e) => handleRowFieldKeyDown(e, i, 'purchase')}
                      onBlur={() => finishMoneyEdit(i, 'purchase_price')}
                      disabled={isEdit}
                      className="w-full text-right border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400" />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <input
                        type="number"
                        min="-100"
                        value={item.purchase_price > 0 ? Math.round((item.retail_price / item.purchase_price - 1) * 100) : 0}
                        onChange={(e) => {
                          const pct = Number(e.target.value) || 0
                          const retail = Math.round(item.purchase_price * (1 + pct / 100))
                          updateItem(i, 'retail_price', retail)
                        }}
                        disabled={isEdit || item.purchase_price <= 0}
                        placeholder="0"
                        className="w-16 text-right border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400 bg-white"
                      />
                      <span className="text-gray-400 text-xs font-semibold">%</span>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <input ref={(el) => { retailRefs.current[i] = el }} type="text" inputMode="decimal"
                        value={moneyValue(i, 'retail_price', item.retail_price)}
                        onFocus={(e) => beginMoneyEdit(i, 'retail_price', item.retail_price, e.currentTarget)}
                        onPaste={(e) => { e.preventDefault(); pasteMoney(i, 'retail_price', e.clipboardData.getData('text')) }}
                        onChange={(e) => changeMoney(i, 'retail_price', e.target.value)}
                        onKeyDown={(e) => handleRowFieldKeyDown(e, i, 'retail')}
                        onBlur={() => finishMoneyEdit(i, 'retail_price')}
                        disabled={isEdit}
                        className="w-full min-w-[80px] text-right border border-gray-200 rounded px-2 py-1 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400 bg-white" />
                      {!isEdit && (
                        <select
                          value=""
                          title="Націнка: за таблицею або швидкий відсоток"
                          onChange={(e) => {
                            const val = e.target.value
                            if (val === 'grid') recalcRetail(i, true)
                            else if (val) applySingleQuickPercent(i, parseFloat(val))
                            e.target.value = ''
                          }}
                          className="shrink-0 border border-gray-200 rounded px-1 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-yellow-400"
                        >
                          <option value="">▾</option>
                          <option value="grid">За таблицею</option>
                          {quickPercents.map((pct) => (
                            <option key={pct} value={pct}>{pct}%</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{formatMoney(item.total)}</td>
                  <td className="px-2 py-2">
                    {!isEdit && (
                      <button type="button" onClick={() => removeItem(i)}
                        className="text-red-300 hover:text-red-500 p-1"><Trash2 size={14} /></button>
                    )}
                  </td>
                </tr>
                )
              })}
              {items.length === 0 && (
                <tr><td colSpan={13} className="text-center text-gray-400 text-sm py-6">Позицій немає. Додайте товари.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="font-semibold bg-gray-50">
                <td colSpan={11} className="px-4 py-2 text-right">Всього:</td>
                <td className="px-4 py-2 text-right font-mono">{formatMoney(total)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
          </div>

          {/* Мобільний вигляд позицій — картки замість широкої таблиці */}
          <div className="md:hidden divide-y divide-gray-100">
            {items.map((item, i) => {
              const hasProblem = problemLineKey === item.client_key
              return (
              <div key={item.client_key} className={hasProblem ? 'p-3 space-y-3 bg-red-50 ring-2 ring-red-200' : 'p-3 space-y-3'}>
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selectedLineKeys.includes(item.client_key)}
                    onChange={(e) => toggleLineSelection(item.client_key, e.target.checked)}
                    disabled={isEdit}
                    className="mt-3 w-4 h-4 accent-yellow-400"
                  />
                  <RowPhotoCell
                    photoUrl={item.photo_url ?? null}
                    productId={item.product_id || 'new_' + i}
                    onPhotoUpdated={(newUrl) => {
                      setItems((prev) => prev.map((it, idx) => idx === i ? { ...it, photo_url: newUrl } : it))
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-0.5">Назва</label>
                    <input type="text" value={item.product_name}
                      onChange={(e) => updateItem(i, 'product_name', e.target.value)}
                      disabled={isEdit}
                      placeholder="Назва товару"
                      className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm font-medium outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400" />
                    {problemLineKey === item.client_key && (
                      <div className="mt-1 rounded-lg border border-red-200 bg-red-100 px-2 py-1 text-[11px] font-semibold text-red-700">
                        Проблемний рядок: змініть артикул, або видаліть рядок і додайте товар через пошук.
                      </div>
                    )}
                  </div>
                  {!isEdit && (
                    <button type="button" onClick={() => removeItem(i)}
                      className="shrink-0 p-2 text-red-300 hover:text-red-500" aria-label="Видалити рядок"><Trash2 size={16} /></button>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-2">
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-0.5">Артикул</label>
                    <input type="text" value={item.sku}
                      onChange={(e) => updateItem(i, 'sku', e.target.value)}
                      disabled={isEdit}
                      placeholder="Артикул"
                      className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-0.5">Папка</label>
                    <select
                      value={item.category_id ?? ''}
                      onChange={(e) => updateItem(i, 'category_id', e.target.value)}
                      disabled={isEdit}
                      className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400 bg-white"
                    >
                      <option value="">Без папки</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-0.5">Од. виміру</label>
                    <select
                      value={normalizeInvoiceUnit(item.unit)}
                      onChange={(e) => updateItem(i, 'unit', e.target.value)}
                      disabled={isEdit}
                      className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400 bg-white"
                    >
                      <option value="шт">шт</option>
                      <option value="кг">кг</option>
                      <option value="компл">компл</option>
                      <option value="л">л</option>
                      <option value="м">м</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-0.5">Штрихкод</label>
                    <div className="flex gap-1">
                      <input type="text" value={item.barcode ?? ''}
                        onChange={(e) => handleBarcodeInputChange(i, e.target.value)}
                        onBlur={(e) => { void bindRowToExistingProductByBarcode(item.client_key, e.currentTarget.value, false) }}
                        disabled={isEdit}
                        placeholder="Сканувати або вписати"
                        autoComplete="off"
                        className={`flex-1 min-w-0 border rounded-lg px-2.5 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400 ${item.barcode ? 'border-gray-200' : 'border-orange-300 bg-orange-50'}`} />
                      <button type="button" disabled={isEdit} onClick={() => generateBarcodeForRow(i)}
                        title="Згенерувати штрихкод"
                        className="shrink-0 px-3 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-40">
                        <Barcode size={15} />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-0.5">К-сть</label>
                    <div className="flex items-center gap-1">
                      <button type="button" disabled={isEdit || item.qty <= 1}
                        onClick={() => updateItem(i, 'qty', Math.max(1, item.qty - 1))}
                        className="shrink-0 w-9 h-10 rounded-lg border border-gray-200 text-gray-600 font-bold disabled:opacity-40">−</button>
                      <input type="number" step="1" min="0" value={item.qty}
                        onChange={(e) => updateItem(i, 'qty', e.target.value)}
                        disabled={isEdit}
                        className="w-full min-w-[64px] text-center border border-gray-200 rounded-lg px-2 py-2 text-base focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50" />
                      <button type="button" disabled={isEdit}
                        onClick={() => updateItem(i, 'qty', item.qty + 1)}
                        className="shrink-0 w-9 h-10 rounded-lg border border-gray-200 text-gray-600 font-bold disabled:opacity-40">+</button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-0.5">Націнка %</label>
                    <input type="number" min="-100"
                      value={item.purchase_price > 0 ? Math.round((item.retail_price / item.purchase_price - 1) * 100) : 0}
                      onChange={(e) => {
                        const pct = Number(e.target.value) || 0
                        const retail = Math.round(item.purchase_price * (1 + pct / 100))
                        updateItem(i, 'retail_price', retail)
                      }}
                      disabled={isEdit || item.purchase_price <= 0}
                      className="w-full text-right border border-gray-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-0.5">Закупка, грн</label>
                    <input type="text" inputMode="decimal"
                      value={moneyValue(i, 'purchase_price', item.purchase_price)}
                      onFocus={(e) => beginMoneyEdit(i, 'purchase_price', item.purchase_price, e.currentTarget)}
                      onPaste={(e) => { e.preventDefault(); pasteMoney(i, 'purchase_price', e.clipboardData.getData('text')) }}
                      onChange={(e) => changeMoney(i, 'purchase_price', e.target.value)}
                      onBlur={() => finishMoneyEdit(i, 'purchase_price')}
                      disabled={isEdit}
                      className="w-full text-right border border-gray-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-0.5">Продаж, грн</label>
                    <input type="text" inputMode="decimal"
                      value={moneyValue(i, 'retail_price', item.retail_price)}
                      onFocus={(e) => beginMoneyEdit(i, 'retail_price', item.retail_price, e.currentTarget)}
                      onPaste={(e) => { e.preventDefault(); pasteMoney(i, 'retail_price', e.clipboardData.getData('text')) }}
                      onChange={(e) => changeMoney(i, 'retail_price', e.target.value)}
                      onBlur={() => finishMoneyEdit(i, 'retail_price')}
                      disabled={isEdit}
                      className="w-full text-right border border-gray-200 rounded-lg px-2 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50" />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-2.5 py-2">
                  {!isEdit ? (
                    <select
                      value=""
                      onChange={(e) => {
                        const val = e.target.value
                        if (val === 'grid') recalcRetail(i, true)
                        else if (val) applySingleQuickPercent(i, parseFloat(val))
                        e.target.value = ''
                      }}
                      className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 bg-white">
                      <option value="">Націнка ▾</option>
                      <option value="grid">За таблицею</option>
                      {quickPercents.map((pct) => (
                        <option key={pct} value={pct}>{pct}%</option>
                      ))}
                    </select>
                  ) : <span />}
                  <span className="text-sm font-semibold font-mono">Сума: {formatMoney(item.total)}</span>
                </div>
              </div>
              )
            })}
            {items.length === 0 && (
              <div className="text-center text-gray-400 text-sm py-6">Позицій немає. Додайте перший рядок кнопкою нижче.</div>
            )}
            {items.length > 0 && (
              <div className="flex items-center justify-between px-3 py-2.5 bg-gray-50 font-semibold text-sm">
                <span>Всього:</span>
                <span className="font-mono">{formatMoney(total)}</span>
              </div>
            )}
          </div>

          {!isEdit && (
            <div className="p-3 border-t border-gray-100 bg-white">
              <Button type="button" onClick={() => addDraftItem()} className="w-full min-h-[48px]">
                + Новий рядок
              </Button>
            </div>
          )}
        </Card>

        {/* Оплата постачальнику (тільки при створенні) */}
        {!isEdit && (
          <Card className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-bold text-gray-800">💵 Оплата постачальнику</span>
              <span className="text-xs text-gray-400">скільки заплатили зараз — решта піде в борг</span>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-44">
                <label className="block text-xs font-medium text-gray-500 mb-1">Сума оплати, грн</label>
                <input
                  type="text" inputMode="decimal"
                  value={paidAmount}
                  onPaste={(e) => { e.preventDefault(); setPaidAmount(kopecksForForm(parseMoneyToKopecks(e.clipboardData.getData('text')))) }}
                  onChange={(e) => setPaidAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-semibold text-right focus:outline-none focus:ring-2 focus:ring-yellow-400"
                />
              </div>
              <div className="w-36">
                <label className="block text-xs font-medium text-gray-500 mb-1">Спосіб</label>
                <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as 'cash' | 'card' | 'transfer')}
                  className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400">
                  <option value="cash">Готівка</option>
                  <option value="card">Картка</option>
                  <option value="transfer">Переказ</option>
                </select>
              </div>
              <div className="w-52">
                <label className="block text-xs font-medium text-gray-500 mb-1">Звідки гроші</label>
                <select value={fundSource} onChange={(e) => setFundSource(e.target.value as typeof fundSource)}
                  className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400">
                  <option value="cashbox">З каси магазину</option>
                  <option value="owner_funds">Власні кошти власника</option>
                  <option value="bank_account">Розрахунковий рахунок</option>
                  <option value="business_card">Картка підприємства</option>
                </select>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setPaidAmount((total / 100).toFixed(2))}>
                Оплатити повністю
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setPaidAmount('0')}>
                Без оплати (в борг)
              </Button>
            </div>
            {(() => {
              const paid = parseMoneyToKopecks(paidAmount)
              const debt = Math.max(0, total - Math.min(paid, total))
              if (debt > 0) return (
                <p className="text-xs text-orange-600 font-semibold mt-2.5">
                  Залишок боргу постачальнику: {formatMoney(debt)}
                </p>
              )
              if (total > 0) return <p className="text-xs text-green-600 font-semibold mt-2.5">Оплачено повністю — боргу немає</p>
              return null
            })()}
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? 'Збереження...' : isEdit ? 'Оновити' : postImmediately ? 'Створити і провести' : 'Створити чернетку'}
          </Button>
          <Button type="button" variant="outline" onClick={closeInvoiceForm}>Скасувати</Button>
          {!isEdit && (
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer ml-1">
              <input type="checkbox" checked={postImmediately} onChange={(e) => setPostImmediately(e.target.checked)}
                className="w-4 h-4 accent-yellow-400" />
              Провести одразу (оновити залишки)
            </label>
          )}
        </div>
      </form>

      {/* Попередній перегляд Excel перед додаванням у накладну */}
      <Modal open={invoiceImportModal} onClose={() => setInvoiceImportModal(false)} title="Перевірка Excel перед імпортом" size="xl">
        <div className="space-y-4 max-h-[78vh] overflow-y-auto pr-1">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Спочатку перевірте, з якого рядка починаються товари і які колонки за що відповідають. Зайві шапки, підсумки і порожні групи не будуть додані.
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Файл</label>
              <div className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 truncate">{invoiceImportFileName || 'Excel / CSV'}</div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Почати імпорт з рядка</label>
              <input
                type="number"
                min={1}
                max={Math.max(1, invoiceImportRows.length)}
                value={invoiceImportStartRow + 1}
                onChange={(e) => setInvoiceImportStartRow(Math.max(0, (parseInt(e.target.value) || 1) - 1))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
              />
              {invoiceImportHeaderRow != null && <p className="text-[11px] text-gray-400 mt-1">Заголовки схожі на рядок {invoiceImportHeaderRow + 1}</p>}
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Результат</label>
              <div className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50">
                Додасться: <b>{invoiceImportPreview.items.length}</b>, пропущено: <b>{invoiceImportPreview.skipped}</b>
              </div>
            </div>
          </div>

          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5">
              <div>
                <span className="text-sm font-semibold text-gray-700">Сопоставлення колонок</span>
                <p className="text-xs text-gray-400 mt-0.5">Виберіть тип прямо над потрібним стовпчиком. Натисніть номер рядка зліва, щоб почати імпорт з нього.</p>
              </div>
              <span className="text-xs text-gray-400">Сірі рядки вище старту не імпортуються</span>
            </div>
            <div className="overflow-auto max-h-[420px]">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 z-10 bg-white shadow-sm">
                  <tr>
                    <th className="sticky left-0 z-20 bg-white border-r border-gray-200 px-2 py-2 min-w-[74px] text-left">
                      <div className="text-[10px] font-bold text-gray-400 uppercase">Рядок</div>
                      <div className="text-[11px] text-gray-500 mt-1">Старт</div>
                    </th>
                    {Array.from({ length: invoiceImportColumnCount }).map((_, cellIndex) => {
                      const selectedField = INVOICE_IMPORT_FIELDS.find(({ field }) => invoiceImportMapping[field] === cellIndex)?.field ?? ''
                      const selected = Boolean(selectedField)
                      return (
                        <th key={cellIndex} className={'border-r border-gray-100 px-2 py-2 min-w-[150px] max-w-[240px] text-left align-top ' + (selected ? 'bg-yellow-100/80' : 'bg-white')}>
                          <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">Колонка {cellIndex + 1}</div>
                          <select
                            value={selectedField}
                            onChange={(e) => {
                              const nextField = e.target.value as InvoiceImportField | ''
                              setInvoiceImportMapping((prev) => {
                                const next = { ...prev }
                                ;(Object.keys(next) as InvoiceImportField[]).forEach((field) => {
                                  if (next[field] === cellIndex) next[field] = null
                                })
                                if (nextField) next[nextField] = cellIndex
                                return next
                              })
                            }}
                            className={'w-full border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-yellow-400 ' + (selected ? 'border-yellow-300 bg-yellow-50 font-semibold text-gray-900' : 'border-gray-200 bg-white text-gray-600')}
                          >
                            <option value="">Не імпорт.</option>
                            {INVOICE_IMPORT_FIELDS.map(({ field, label, required }) => (
                              <option key={field} value={field}>{label}{required ? ' *' : ''}</option>
                            ))}
                          </select>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {invoiceImportRows.slice(0, 30).map((row, rowIndex) => {
                    const isBeforeStart = rowIndex < invoiceImportStartRow
                    const isStart = rowIndex === invoiceImportStartRow
                    return (
                      <tr key={rowIndex} className={isBeforeStart ? 'bg-gray-50 text-gray-400' : 'bg-white'}>
                        <td className="sticky left-0 z-[5] bg-inherit border-r border-gray-200 px-2 py-1 font-mono text-gray-500">
                          <button
                            type="button"
                            onClick={() => setInvoiceImportStartRow(rowIndex)}
                            title="Почати імпорт з цього рядка"
                            className={'w-full rounded-md px-2 py-1 text-left text-xs font-semibold hover:bg-yellow-100 ' + (isStart ? 'bg-yellow-400 text-black' : '')}
                          >
                            {rowIndex + 1}{isStart ? ' старт' : ''}
                          </button>
                        </td>
                        {Array.from({ length: invoiceImportColumnCount }).map((_, cellIndex) => {
                          const selectedField = INVOICE_IMPORT_FIELDS.find(({ field }) => invoiceImportMapping[field] === cellIndex)
                          return (
                            <td key={cellIndex} className={'border-b border-gray-50 px-2 py-1 min-w-[150px] max-w-[240px] truncate ' + (selectedField ? 'bg-yellow-50 text-gray-900 font-medium' : '')} title={cleanImportCell(row[cellIndex])}>
                              {cleanImportCell(row[cellIndex])}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-gray-100">
            <Button type="button" variant="secondary" onClick={() => setInvoiceImportModal(false)}>Скасувати</Button>
            <Button
              type="button"
              onClick={confirmInvoiceImport}
              loading={resolvingImportedProducts}
              disabled={invoiceImportPreview.items.length === 0 || resolvingImportedProducts}
            >
              Додати {invoiceImportPreview.items.length} позицій у накладну
            </Button>
          </div>
        </div>
      </Modal>
      {/* Швидке створення постачальника */}
      <Modal open={supplierModal} onClose={() => setSupplierModal(false)} title="Швидке створення постачальника" size="sm">
        <div className="space-y-4">
          <Input label="Назва постачальника *" value={newSupplierName} onChange={(e) => setNewSupplierName(e.target.value)} placeholder="ТОВ Запчастини..." required />
          <Input label="Телефон" value={newSupplierPhone} onChange={(e) => setNewSupplierPhone(e.target.value)} placeholder="+380..." />
          <div className="flex gap-3">
            <Button loading={creatingSupplier} onClick={handleCreateSupplier} className="flex-1">
              Створити
            </Button>
            <Button variant="secondary" onClick={() => setSupplierModal(false)}>Скасувати</Button>
          </div>
        </div>
      </Modal>

      <Modal open={customPctOpen} onClose={() => setCustomPctOpen(false)} title="Своя націнка" size="sm">
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Відсоток націнки, %</label>
            <Input value={customPctValue} autoFocus inputMode="decimal" placeholder="Напр. 35"
              onChange={(e) => setCustomPctValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyCustomPct() }} />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setCustomPctOpen(false)}>Скасувати</Button>
            <Button onClick={applyCustomPct}>Застосувати до всіх</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}
