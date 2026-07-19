import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Trash2, Camera, ImagePlus, Clipboard, Loader2, Barcode } from 'lucide-react'
import { ProductPhotoUpload, compressToJpeg, uploadToStorage } from '@/features/products/ProductPhotoUpload'
import { read, utils } from 'xlsx'
import Papa from 'papaparse'
import { supplierApi } from './supplierApi'
import { productApi } from '@/features/products/productApi'
import { pricingApi } from '@/features/admin/pricingApi'
import { adminApi } from '@/features/admin/adminApi'
import type { Product, ProductFormData } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Input, Card, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { shiftApi } from '@/features/pos/shiftApi'
import { formatMoney } from '@/lib/utils'

interface LineItem {
  product_id?: string
  product_name: string
  sku: string
  barcode?: string | null
  qty: number
  purchase_price: number
  retail_price: number
  category_id: string | null
  total: number
  storage_bin?: string | null
  photo_url?: string | null
  is_new?: boolean
}

function normalizeSkuValue(raw: string): string {
  return raw.replace(/[\s\-./_]/g, '').toUpperCase().replace(/^0+/, '') || raw.toUpperCase()
}

function parseDecimalInput(raw: unknown, fallback = 0): number {
  const normalized = String(raw ?? '')
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(',', '.')
  const value = Number.parseFloat(normalized)
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

function kopecksForForm(kopecks: number): string {
  return (Math.max(0, Number(kopecks) || 0) / 100).toFixed(2)
}

function makeDraftItem(overrides: Partial<LineItem> = {}): LineItem {
  return {
    product_name: '',
    sku: '',
    barcode: '',
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

  const [supplierId, setSupplierId] = useState(preSelectedSupplier)
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [items, setItems] = useState<LineItem[]>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(isEdit)
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [productSearch, setProductSearch] = useState('')
  const [productResults, setProductResults] = useState<Product[]>([])

  // Порівняння закупівельних цін постачальників по доданих товарах
  const [supplierPrices, setSupplierPrices] = useState<Record<string, Array<{ supplier_id: string; supplier_name: string; price: number; date: string }>>>({})
  const [quickPercents, setQuickPercents] = useState<number[]>([])
  const [supplierModal, setSupplierModal] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [newSupplierPhone, setNewSupplierPhone] = useState('')
  const [creatingSupplier, setCreatingSupplier] = useState(false)
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([])
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([])
  const [productModal, setProductModal] = useState(false)
  const [newProductName, setNewProductName] = useState('')
  const [newProductSku, setNewProductSku] = useState('')
  const [newProductBarcode, setNewProductBarcode] = useState('')
  const [newProductCategoryId, setNewProductCategoryId] = useState('')
  const [newProductBrandId, setNewProductBrandId] = useState('')
  const [newProductPurchase, setNewProductPurchase] = useState('')
  const [newProductRetail, setNewProductRetail] = useState('')
  const [creatingProduct, setCreatingProduct] = useState(false)
  const [importTab, setImportTab] = useState<'manual' | 'file' | 'clipboard'>('manual')
  const [clipboardText, setClipboardText] = useState('')
  // Оплата постачальнику
  const [paidAmount, setPaidAmount] = useState('')          // гривні (рядок форми)
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'transfer'>('cash')
  const [fundSource, setFundSource] = useState<'cashbox' | 'owner_funds' | 'bank_account' | 'business_card'>('cashbox')
  const [postImmediately, setPostImmediately] = useState(true)  // провести одразу після створення
  const [newProductPhotoUrl, setNewProductPhotoUrl] = useState<string | null>(null)
  const [generatingBarcode, setGeneratingBarcode] = useState(false)
  const [moneyDrafts, setMoneyDrafts] = useState<Record<string, string>>({})

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
    adminApi.listBrands().then((res) => setBrands(res.data)).catch(() => {})
  }, [])

  // Якщо редагування — завантажуємо накладну
  useEffect(() => {
    if (id) {
      supplierApi.getInvoice(id).then((res) => {
        const inv = res.data
        setSupplierId(inv.supplier_id ?? '')
        setInvoiceNumber(inv.invoice_number ?? '')
        setNotes(inv.notes ?? '')
        setItems((inv.items ?? []).map((i) => ({
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
          photo_url: (i.product as any)?.photo_url ?? null,
        })))
      }).catch(() => {
        toast.error('Не вдалось завантажити накладну')
        navigate('/suppliers')
      }).finally(() => setLoading(false))
    }
  }, [id])

  // Дублювання: /suppliers/invoices/new?clone=<id> — копіюємо постачальника й позиції,
  // номер лишаємо порожнім (новий), статус — чернетка.
  const cloneId = searchParams.get('clone')
  useEffect(() => {
    if (id || !cloneId) return
    setLoading(true)
    supplierApi.getInvoice(cloneId).then((res) => {
      const inv = res.data
      setSupplierId(inv.supplier_id ?? '')
      setItems((inv.items ?? []).map((i) => ({
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
        photo_url: (i.product as any)?.photo_url ?? null,
      })))
      toast.success('Накладну скопійовано — вкажіть новий номер і проведіть')
    }).catch(() => toast.error('Не вдалось завантажити накладну для копіювання'))
      .finally(() => setLoading(false))
  }, [cloneId, id])

  // Пошук товарів
  const searchProducts = useCallback(async (q: string) => {
    if (!q.trim()) { setProductResults([]); return }
    try {
      const res = await productApi.list({ search: q, per_page: 10 })
      setProductResults(res.data)
    } catch { setProductResults([]) }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => searchProducts(productSearch), 300)
    return () => clearTimeout(timer)
  }, [productSearch, searchProducts])

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

    const existingResult = productResults[0]
    if (existingResult) {
      addItem(existingResult)
      return
    }

    try {
      const res = await productApi.list({ search: query, per_page: 10 })
      if (res.data[0]) {
        addItem(res.data[0])
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
  const [scanGuide, setScanGuide] = useState(false)

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

  // Сканер = клавіатура: вводить код + Enter. На Enter — перехід на наступний рядок.
  // Наступний порожній шукаємо за фактичним value інпутів (а не за стейтом — уникаємо stale).
  function onBarcodeKeyDown(e: React.KeyboardEvent<HTMLInputElement>, i: number) {
    if (e.key === 'Escape' && scanGuide) {
      e.preventDefault(); setScanGuide(false); barcodeRefs.current[i]?.blur(); return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
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
  async function recalcRetail(onlyIndex?: number, forceUseGrid?: boolean, purchaseOverride?: number) {
    const targets = onlyIndex !== undefined ? [onlyIndex] : items.map((_, i) => i)
    const updates = await Promise.all(targets.map(async (idx) => {
      const it = items[idx]
      const purchasePrice = purchaseOverride !== undefined && onlyIndex !== undefined ? purchaseOverride : it?.purchase_price
      if (!it || !purchasePrice || purchasePrice <= 0) return null
      try {
        const categoryId = forceUseGrid ? undefined : (it.category_id ?? undefined)
        const r = await pricingApi.autoRetail(purchasePrice, categoryId)
        return r.data?.retail_price != null ? { idx, retail: r.data.retail_price } : null
      } catch { return null }
    }))
    const map = new Map(updates.filter(Boolean).map((u) => [u!.idx, u!.retail]))
    if (map.size === 0) {
      if (onlyIndex === undefined) {
        toast.warning(forceUseGrid
          ? 'Сітка націнок не налаштована або не повернула результат'
          : 'Наценки категорій не задані — задайте їх у «Ціноутворення»'
        )
      }
      return
    }
    setItems((prev) => prev.map((it, i) => map.has(i) ? { ...it, retail_price: map.get(i)! } : it))
  }

  // Застосування фіксованої націнки на всю накладну
  function applyBulkQuickPercent(pct: number) {
    if (pct <= 0) return
    setItems((prev) =>
      prev.map((it) => {
        if (it.purchase_price <= 0) return it
        const calculatedRetail = Math.round(it.purchase_price * (1 + pct / 100))
        return { ...it, retail_price: calculatedRetail }
      })
    )
    toast.success(`Встановлено націнку ${pct}% для всіх товарів`)
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

  // addMore=true — «Створити і додати ще»: товар летить у накладну, модалка лишається
  // відкритою з очищеними полями (категорія/бренд зберігаються) — швидке поштучне
  // набивання накладної, особливо з телефона.
  async function handleCreateProduct(addMore = false) {
    if (!newProductName.trim()) { toast.error('Назва обов’язкова'); return }
    if (!newProductSku.trim()) { toast.error('Артикул (SKU) обов’язковий'); return }
    setCreatingProduct(true)
    try {
      const form: ProductFormData = {
        name: newProductName.trim(),
        sku: newProductSku.trim(),
        barcode: newProductBarcode.trim(),
        unit: 'шт',
        purchase_price: kopecksForForm(parseMoneyToKopecks(newProductPurchase)),
        retail_price: kopecksForForm(parseMoneyToKopecks(newProductRetail)),
        qty_on_hand: '0',
        reorder_point: '0',
        notes: '',
        is_active: true,
        storage_bin: '',
        is_favorite: false,
        brand_id: newProductBrandId || '',
        category_id: newProductCategoryId || '',
        photo_url: newProductPhotoUrl,
        specs: {}
      }
      const res = await productApi.create(form, { silent: true })
      toast.success(`Товар "${res.data.name}" додано в накладну`)
      addItem(res.data)
      setNewProductName('')
      setNewProductSku(addMore ? `AUTO-${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10)}` : '')
      setNewProductBarcode('')
      setNewProductPurchase('')
      setNewProductRetail('')
      setNewProductPhotoUrl(null)
      if (!addMore) {
        setProductModal(false)
        setNewProductCategoryId('')
        setNewProductBrandId('')
      }
    } catch (err) {
      // api.ts вже показав toast з текстом сервера (напр. «Артикул вже існує»)
      if (isDuplicateProductError(err)) {
        toast.error(duplicateProductMessage(err, newProductName.trim()))
        return
      }
      if (!(err as any).status) {
        toast.error(err instanceof Error ? err.message : 'Помилка створення товару')
      }
    } finally {
      setCreatingProduct(false)
    }
  }

  function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    
    if (file.name.endsWith('.csv')) {
      Papa.parse(file, {
        header: false,
        skipEmptyLines: true,
        complete: (results: any) => {
          processRawRows(results.data)
        }
      })
    } else {
      const reader = new FileReader()
      reader.onload = (evt) => {
        try {
          const data = new Uint8Array(evt.target?.result as ArrayBuffer)
          const workbook = read(data, { type: 'array' })
          const sheet = workbook.Sheets[workbook.SheetNames[0]]
          const json = utils.sheet_to_json(sheet, { header: 1 }) as any[][]
          processRawRows(json)
        } catch {
          toast.error('Помилка читання Excel файлу')
        }
      }
      reader.readAsArrayBuffer(file)
    }
    e.target.value = '' // Reset
  }

  function processRawRows(rawRows: any[][]) {
    if (!rawRows || rawRows.length === 0) return
    const headers = rawRows[0].map(h => String(h || '').trim().toLowerCase())
    const hasHeader = headers.some(h => /(sku|артикул|код|арт|name|назва|наименование|товар|модель|qty|кол|кільк|количество|purchase|закуп|ціна|цена|вхідна|retail|роздріб|розница|продаж|bin|комірка|ячейка|ящик)/.test(h))
    
    let nameIdx = headers.findIndex(h => /(name|назва|наименование|товар|модель)/.test(h))
    let skuIdx = headers.findIndex(h => /(sku|артикул|код|арт)/.test(h))
    let qtyIdx = headers.findIndex(h => /(qty|кол|кільк|количество)/.test(h))
    let purchaseIdx = headers.findIndex(h => /(purchase|закуп|ціна|цена|вхідна)/.test(h))
    let retailIdx = headers.findIndex(h => /(retail|роздріб|розница|продаж)/.test(h))
    const binIdx = headers.findIndex(h => /(bin|комірка|ячейка|ящик)/.test(h))

    if (nameIdx === -1) nameIdx = 1
    if (skuIdx === -1) skuIdx = 0
    if (qtyIdx === -1) qtyIdx = 2
    if (purchaseIdx === -1) purchaseIdx = 3
    if (retailIdx === -1) retailIdx = 4

    const newItems: LineItem[] = []
    const startRow = hasHeader ? 1 : 0
    
    for (let r = startRow; r < rawRows.length; r++) {
      const row = rawRows[r]
      if (!row || row.length === 0) continue
      const sku = String(row[skuIdx] || '').trim()
      const name = String(row[nameIdx] || '').trim()
      if (!sku && !name) continue

      const qty = parseQty(row[qtyIdx], 1)
      const purchase = parseMoneyToKopecks(row[purchaseIdx])
      const retail = parseMoneyToKopecks(row[retailIdx])
      const bin = binIdx !== -1 ? String(row[binIdx] || '').trim() : null

      newItems.push({
        product_name: name || `Товар (${sku})`,
        sku: sku || `AUTO-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 10)}`,
        qty,
        purchase_price: purchase,
        retail_price: retail,
        category_id: null,
        total: Math.round(qty * purchase),
        storage_bin: bin || null,
        is_new: true,
      })
    }
    
    if (newItems.length > 0) {
      setItems(prev => [...prev, ...newItems])
      toast.success(`Імпортовано ${newItems.length} товарів`)
    } else {
      toast.warning('Не знайдено товарів для імпорту')
    }
  }

  function handleClipboardPaste() {
    if (!clipboardText.trim()) return
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

      newItems.push({
        product_name: name || `Товар (${sku})`,
        sku: sku || `AUTO-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 10)}`,
        qty,
        purchase_price: purchase,
        retail_price: retail,
        category_id: null,
        total: Math.round(qty * purchase),
        storage_bin: bin || null,
        is_new: true,
      })
    })
    
    if (newItems.length > 0) {
      setItems(prev => [...prev, ...newItems])
      toast.success(`Імпортовано ${newItems.length} товарів з буфера`)
      setClipboardText('')
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
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  const total = items.reduce((sum, i) => sum + i.total, 0)

  async function findExistingProductForItem(item: LineItem): Promise<Product | null> {
    const skuTrim = (item.sku || '').trim()
    const barcodeTrim = (item.barcode || '').trim()
    const matches: Product[] = []

    if (skuTrim) {
      const existing = await productApi.list({ search: skuTrim, per_page: 20 })
      const normalizedSku = normalizeSkuValue(skuTrim)
      const match = existing.data.find((p) => normalizeSkuValue(p.sku || '') === normalizedSku)
      if (match) matches.push(match)
    }

    if (barcodeTrim) {
      const existing = await productApi.list({ search: barcodeTrim, per_page: 20 })
      const match = existing.data.find((p) => (p.barcode || '').trim() === barcodeTrim)
      if (match) matches.push(match)
    }

    const uniqueMatches = [...new Map(matches.map((p) => [p.id, p])).values()]
    if (uniqueMatches.length > 1) {
      throw new Error(`У рядку «${item.product_name || skuTrim || barcodeTrim}» артикул і штрихкод належать різним товарам. Перевірте цей рядок.`)
    }
    return uniqueMatches[0] ?? null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (items.length === 0) { toast.error('Додайте хоча б один товар'); return }
    if (!supplierId) { toast.error('Оберіть постачальника'); return }

    setSaving(true)
    try {
      // 1. Create missing products first. Робимо послідовно, щоб два однакові
      // рядки з імпорту/телефона не створювали товар паралельно і не ловили duplicate.
      const productCache = new Map<string, Product>()

      function rememberProduct(product: Product) {
        const sku = (product.sku || '').trim()
        const barcode = (product.barcode || '').trim()
        if (sku) productCache.set(`sku:${normalizeSkuValue(sku)}`, product)
        if (barcode) productCache.set(`barcode:${barcode}`, product)
      }

      function cachedProductForItem(item: LineItem): Product | null {
        const sku = (item.sku || '').trim()
        const barcode = (item.barcode || '').trim()
        return (sku ? productCache.get(`sku:${normalizeSkuValue(sku)}`) : null)
          ?? (barcode ? productCache.get(`barcode:${barcode}`) : null)
          ?? null
      }

      function bindProductToItem(item: LineItem, product: Product): LineItem {
        return {
          ...item,
          product_id: product.id,
          is_new: false,
          sku: product.sku,
          barcode: item.barcode || product.barcode || '',
          product_name: item.product_name || product.name,
          category_id: item.category_id ?? product.category_id ?? null,
          storage_bin: item.storage_bin ?? product.storage_bin ?? null,
          photo_url: item.photo_url ?? product.photo_url ?? null,
        }
      }

      const resolvedItems: LineItem[] = []
      for (const item of items) {
        if (item.product_id && !item.is_new) {
          resolvedItems.push(item)
          continue
        }

        const cached = cachedProductForItem(item)
        if (cached) {
          resolvedItems.push(bindProductToItem(item, cached))
          continue
        }

        // Якщо рядок з телефона повторює вже наявний товар за артикулом або ШК —
        // прив'язуємо його до існуючого товару, а не змушуємо відкривати модалку.
        const match = await findExistingProductForItem(item)
        if (match) {
          rememberProduct(match)
          resolvedItems.push(bindProductToItem(item, match))
          continue
        }

        // Бракує даних — не блокуємо збереження/проведення: підставляємо авто-артикул/назву
        // (товар створюється з плейсхолдером, який можна допиляти пізніше в картці).
        const skuTrim = (item.sku || '').trim()
        const genSku  = skuTrim || `AUTO-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 100)}`
        const genName = (item.product_name || '').trim() || `Товар ${genSku}`

        const form: ProductFormData = {
          name: genName,
          sku: genSku,
          barcode: item.barcode || '',
          unit: 'шт',
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
        const res = await productApi.create(form, { silent: true })
        rememberProduct(res.data)
        resolvedItems.push({ ...item, product_id: res.data.id, is_new: false, sku: genSku, product_name: genName })
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
      if (isEdit) {
        await supplierApi.updateInvoice(id!, { invoice_number: body.invoice_number, notes: body.notes })
        toast.success('Накладну оновлено')
      } else {
        const paidKopecks = parseMoneyToKopecks(paidAmount)
        const shift = paidKopecks > 0 && fundSource === 'cashbox'
          ? await shiftApi.current().catch(() => null)
          : null
        const shiftId = (shift as any)?.data?.id ?? null
        if (paidKopecks > 0 && fundSource === 'cashbox' && !shiftId) {
          toast.error('Щоб платити з каси, спочатку відкрийте касову зміну')
          return
        }
        const created = await supplierApi.createInvoice({
          ...body,
          paid_amount: paidKopecks,
          payment_method: paidKopecks > 0 ? paymentMethod : null,
          fund_source: paidKopecks > 0 ? fundSource : null,
          shift_id: shiftId,
        })

        // Оновлюємо комірки, роздрібні ціни та назву/артикул (якщо міняли в таблиці)
        const results = await Promise.allSettled(
          resolvedItems.map(async (item) => {
            const patch: Partial<ProductFormData> = {
              name: item.product_name,
              sku: item.sku,
              category_id: item.category_id ?? '',
              storage_bin: item.storage_bin ?? '',
            }
            if (item.retail_price > 0) patch.retail_price = kopecksForForm(item.retail_price)
            if (item.photo_url) patch.photo_url = item.photo_url   // фото з накладної → у товар при проведенні
            await productApi.update(item.product_id!, patch)
          })
        )

        // Запис штрихкодів у товари (окремим проходом — щоб конфлікт ШК не зривав
        // оновлення назви/комірки/ціни; бекенд стереже унікальність ШК).
        const barcodeConflicts: string[] = []
        await Promise.all(resolvedItems.map(async (item) => {
          const bc = (item.barcode ?? '').toString().trim()
          if (!item.product_id || !bc) return
          try {
            await productApi.update(item.product_id, { barcode: bc } as Partial<ProductFormData>, { silent: true })
          } catch (err: any) {
            if (err?.status === 409 || /вже у товара/.test(String(err?.message || ''))) {
              barcodeConflicts.push(item.product_name)
            }
          }
        }))
        if (barcodeConflicts.length > 0) {
          toast.warning(`Штрихкод не збережено (вже зайнятий) для: ${barcodeConflicts.join(', ')}`)
        }

        // «Провести одразу» — збільшує залишки на складі без окремого заходу в список
        if (postImmediately && created?.data?.id) {
          try {
            await supplierApi.postInvoice(created.data.id)
            toast.success('Накладну створено і проведено — залишки оновлено')
          } catch {
            toast.warning('Накладну створено, але не вдалось провести — проведіть вручну зі списку')
          }
        } else if (results.some((r) => r.status === 'rejected')) {
          toast.warning('Накладну створено, але не всі комірки/ціни товарів оновились')
        } else {
          toast.success('Накладну створено')
        }
      }
      navigate(`/suppliers/invoices`)
    } catch (err) {
      if (isDuplicateProductError(err)) {
        toast.error(duplicateProductMessage(err))
      } else {
        toast.error(err instanceof Error ? err.message : 'Помилка збереження накладної')
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Layout title="Завантаження..."><div className="text-gray-400 text-sm">Завантаження...</div></Layout>

  return (
    <Layout
      title={isEdit ? 'Редагувати накладну' : 'Нова приходна накладна'}
      onBack={() => navigate('/suppliers/invoices')}
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
                <Input value={productSearch} onChange={(e) => setProductSearch(e.target.value)} onKeyDown={handleProductSearchKeyDown} placeholder="Знайти існуючий товар за назвою, артикулом або штрихкодом..." className="w-full" autoFocus />
                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" onClick={() => addDraftItem()} className="min-h-[44px]">
                    Додати рядок
                  </Button>
                  <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => {
                    setNewProductSku(`AUTO-${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10)}`)
                    setProductModal(true)
                  }}>
                    Картка товару
                  </Button>
                </div>
                <p className="text-xs text-gray-400">У локальній програмі: Enter у пошуку додає перший знайдений товар; Enter у рядку переходить до наступного поля.</p>
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
                <Button type="button" onClick={handleClipboardPaste}>Імпортувати дані</Button>
              </div>
            )}

            {importTab === 'manual' && productResults.length > 0 && (
              <div className="mt-2 max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-sm">
                {productResults.map((p) => (
                  <button key={p.id} type="button" onClick={() => addItem(p)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-yellow-50 flex items-center justify-between">
                    <span>{p.name}</span>
                    <span className="text-gray-400 text-xs">{p.sku} — {formatMoney(p.retail_price)}</span>
                  </button>
                ))}
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
                      onChange={(e) => {
                        const val = e.target.value
                        if (val === 'grid') {
                          recalcRetail(undefined, true)
                        } else if (val.startsWith('pct:')) {
                          const pct = parseFloat(val.split(':')[1])
                          applyBulkQuickPercent(pct)
                        } else if (val === 'manual') {
                          const customPct = prompt('Введіть свій відсоток націнки (%):')
                          if (customPct !== null) {
                            const pct = parseFloat(customPct)
                            if (!isNaN(pct) && pct > 0) {
                              applyBulkQuickPercent(pct)
                            }
                          }
                        }
                        e.target.value = '' // reset select
                      }}
                      className="border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 bg-white"
                    >
                      <option value="">— Застосувати до всіх —</option>
                      <option value="grid">📈 Розрахувати за сіткою</option>
                      {quickPercents.map((pct) => (
                        <option key={pct} value={`pct:${pct}`}>
                          ⚡ {pct}% націнки
                        </option>
                      ))}
                      <option value="manual">✍️ Свій відсоток націнки...</option>
                    </select>
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
                <th className="w-12 px-2 py-2">Фото</th>
                <th className="text-left px-4 py-2">Товар</th>
                <th className="text-left px-2 py-2 w-44">Папка</th>
                <th className="text-left px-2 py-2 w-40">Штрихкод</th>
                <th className="text-left px-2 py-2 w-28">Комірка</th>
                <th className="text-right px-2 py-2 w-16">К-сть</th>
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
                return (
                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
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
                      className="w-full border border-transparent hover:border-gray-200 focus:border-yellow-400 rounded px-2 py-1 text-sm bg-transparent focus:bg-white font-medium" />
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
                        onChange={(e) => updateItem(i, 'barcode', e.target.value)}
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
                      className="w-full text-right border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400" />
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
                    <div className="flex flex-col gap-1 items-end">
                      <input ref={(el) => { retailRefs.current[i] = el }} type="text" inputMode="decimal"
                        value={moneyValue(i, 'retail_price', item.retail_price)}
                      onFocus={(e) => beginMoneyEdit(i, 'retail_price', item.retail_price, e.currentTarget)}
                      onPaste={(e) => { e.preventDefault(); pasteMoney(i, 'retail_price', e.clipboardData.getData('text')) }}
                      onChange={(e) => changeMoney(i, 'retail_price', e.target.value)}
                      onKeyDown={(e) => handleRowFieldKeyDown(e, i, 'retail')}
                        onBlur={() => finishMoneyEdit(i, 'retail_price')}
                        disabled={isEdit}
                        className="w-full text-right border border-gray-200 rounded px-2 py-1 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400 bg-white" />
                      {!isEdit && quickPercents.length > 0 && (
                        <select
                          onChange={(e) => {
                            const val = e.target.value
                            if (val) {
                              applySingleQuickPercent(i, parseFloat(val))
                              e.target.value = ''
                            }
                          }}
                          className="mt-1 border border-gray-200 rounded px-1.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-yellow-400 bg-white w-24"
                        >
                          <option value="">⚡ Швидкий %</option>
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
                <tr><td colSpan={11} className="text-center text-gray-400 text-sm py-6">Позицій немає. Додайте товари.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="font-semibold bg-gray-50">
                <td colSpan={9} className="px-4 py-2 text-right">Всього:</td>
                <td className="px-4 py-2 text-right font-mono">{formatMoney(total)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
          </div>

          {/* Мобільний вигляд позицій — картки замість широкої таблиці */}
          <div className="md:hidden divide-y divide-gray-100">
            {items.map((item, i) => (
              <div key={i} className="p-3 space-y-3">
                <div className="flex items-start gap-2">
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
                      className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400" />
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
                    <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-0.5">Штрихкод</label>
                    <div className="flex gap-1">
                      <input type="text" value={item.barcode ?? ''}
                        onChange={(e) => updateItem(i, 'barcode', e.target.value)}
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
                        className="w-full min-w-0 text-center border border-gray-200 rounded-lg px-1 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50" />
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
                  {!isEdit && quickPercents.length > 0 ? (
                    <select
                      onChange={(e) => {
                        const val = e.target.value
                        if (val) { applySingleQuickPercent(i, parseFloat(val)); e.target.value = '' }
                      }}
                      className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 bg-white">
                      <option value="">Швидкий %</option>
                      {quickPercents.map((pct) => (
                        <option key={pct} value={pct}>{pct}%</option>
                      ))}
                    </select>
                  ) : <span />}
                  <span className="text-sm font-semibold font-mono">Сума: {formatMoney(item.total)}</span>
                </div>
              </div>
            ))}
            {items.length === 0 && (
              <div className="text-center text-gray-400 text-sm py-6">Позицій немає. Натисніть «Додати рядок».</div>
            )}
            {items.length > 0 && (
              <div className="flex items-center justify-between px-3 py-2.5 bg-gray-50 font-semibold text-sm">
                <span>Всього:</span>
                <span className="font-mono">{formatMoney(total)}</span>
              </div>
            )}
          </div>
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
          <Button type="button" variant="outline" onClick={() => navigate('/suppliers/invoices')}>Скасувати</Button>
          {!isEdit && (
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer ml-1">
              <input type="checkbox" checked={postImmediately} onChange={(e) => setPostImmediately(e.target.checked)}
                className="w-4 h-4 accent-yellow-400" />
              Провести одразу (оновити залишки)
            </label>
          )}
        </div>
      </form>

      {/* Швидке створення товару */}
      <Modal open={productModal} onClose={() => setProductModal(false)} title="Швидке створення товару" size="md">
        <div className="flex flex-col md:flex-row gap-6 max-h-[80vh] overflow-y-auto pr-1">
          {/* Фото зліва */}
          <div className="w-full md:w-1/3 flex flex-col items-center gap-2 shrink-0">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider self-start">Зображення товару</label>
            <div className="w-full bg-gray-50 border border-gray-200 rounded-xl p-4 flex flex-col items-center justify-center min-h-[160px]">
              <ProductPhotoUpload
                currentPhotoUrl={newProductPhotoUrl}
                onPhotoUrl={(url) => setNewProductPhotoUrl(url)}
              />
            </div>
          </div>

          {/* Поля форми справа */}
          <div className="flex-1 space-y-4">
            <div>
              <Input label="Назва товару *" value={newProductName} onChange={(e) => setNewProductName(e.target.value)} placeholder="Амортизатор передній..." required />
            </div>
            
            <div className="grid grid-cols-2 gap-3">
              <Input label="Артикул (SKU) *" value={newProductSku} onChange={(e) => setNewProductSku(e.target.value)} required />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Штрих-код</label>
                <div className="flex gap-1.5">
                  <input type="text" value={newProductBarcode} onChange={(e) => setNewProductBarcode(e.target.value)} placeholder="Сканувати..."
                    className="flex-1 min-w-0 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white" />
                  <button type="button" disabled={generatingBarcode}
                    onClick={async () => {
                      setGeneratingBarcode(true)
                      try {
                        const res = await productApi.generateBarcodeOnly()
                        if (res.data?.barcode) {
                          setNewProductBarcode(res.data.barcode)
                        }
                      } catch {
                        toast.error('Помилка генерації штрих-коду')
                      } finally {
                        setGeneratingBarcode(false)
                      }
                    }}
                    className="px-3 py-2 bg-gray-100 hover:bg-gray-200 border border-gray-200 text-sm rounded-lg transition-colors font-medium shrink-0"
                    title="Згенерувати штрих-код">
                    {generatingBarcode ? '...' : '🧬'}
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Категорія</label>
                <select value={newProductCategoryId} onChange={(e) => setNewProductCategoryId(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white">
                  <option value="">— Оберіть категорію —</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Бренд</label>
                <select value={newProductBrandId} onChange={(e) => setNewProductBrandId(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white">
                  <option value="">— Оберіть бренд —</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input label="Закупка, грн" type="text" inputMode="decimal" value={newProductPurchase} onChange={(e) => setNewProductPurchase(e.target.value)} placeholder="0.00" />
              <Input label="Роздріб, грн" type="text" inputMode="decimal" value={newProductRetail} onChange={(e) => setNewProductRetail(e.target.value)} placeholder="0.00" />
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              <Button loading={creatingProduct} onClick={() => handleCreateProduct(true)} className="flex-1 min-w-[45%]">
                ➕ Створити і додати ще
              </Button>
              <Button variant="outline" loading={creatingProduct} onClick={() => handleCreateProduct(false)} className="flex-1 min-w-[45%]">
                Створити і закрити
              </Button>
              <Button variant="secondary" onClick={() => setProductModal(false)} className="w-full sm:w-auto">Скасувати</Button>
            </div>
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
    </Layout>
  )
}
