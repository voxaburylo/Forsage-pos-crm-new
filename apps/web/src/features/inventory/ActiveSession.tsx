import { useEffect, useMemo, useRef, useState, memo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle, Camera, CheckCircle, ChevronDown, Copy, PackageCheck,
  Plus, Printer, Search, Trash2,
} from 'lucide-react'
import { pricingApi } from '@/features/admin/pricingApi'
import { adminApi } from '@/features/admin/adminApi'
import { productApi } from '@/features/products/productApi'
import { inventoryApi } from '@/features/inventory/inventoryApi'
import { loadProductLabelSettings, printLabels } from '@/features/labels/LabelDesigner'
import { Layout } from '@/components/Layout'
import { Badge, Button, Card, Input, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { playErrorTone, playSuccessBeep, initAudio } from '@/lib/audioService'
import { CameraScanner } from '@/features/pos/CameraScanner'
import { usePOSBarcodeScanner } from '@/features/pos/usePOSBarcodeScanner'
import { useAuthStore } from '@/stores/authStore'
import { formatMoney } from '@/lib/utils'
import { desktopBridge } from '@/lib/desktopBridge'
import { hasSuspiciousInventorySku, inventoryQuickCreateSeed } from './inventoryQuickCreate'
import { InventoryPager } from './InventoryPager'
import { inventoryPage, INVENTORY_PAGE_SIZE } from './inventoryPaging'
import { InventoryReadGuard, inventoryHasPendingWrites, updateScanSummary } from './inventoryScanState'
import { InventoryWriteQueue } from './inventoryWriteQueue'

interface ProductInfo {
  id: string
  sku: string
  name: string
  barcode: string | null
  unit: string
  qty_on_hand?: number
  retail_price: number
  purchase_price?: number
  storage_bin?: string | null
  inventory_item?: {
    id: string
    expected_stock: number
    counted_stock: number
    price_checked: boolean
    observed_retail_price: number | null
  } | null
}

interface InventoryItem {
  id: string
  product_id: string
  expected_stock: number
  counted_stock: number
  price_checked: boolean
  observed_retail_price: number | null
  updated_at: string
  first_counted_at: string | null
  product: ProductInfo | null
}

const EMPTY_INVENTORY_ITEMS: InventoryItem[] = []

interface CountEntry {
  id: string
  product_id: string
  qty: number
  price_checked: boolean
  observed_retail_price: number | null
  created_at: string
  product: ProductInfo | null
}

interface Summary {
  total_products: number
  counted_products: number
  matching_products: number
  discrepancy_products: number
  price_checked_products: number
  price_mismatch_products: number
  participants: number
  total_expected_units: number
  total_counted_units: number
}

interface SessionData {
  id: string
  name: string
  status: 'draft' | 'in_progress' | 'completed'
  items: InventoryItem[]
  price_issues: Array<{
    id: string
    product_id: string
    observed_retail_price: number
    product: ProductInfo | null
  }>
  my_entries: CountEntry[]
  summary: Summary
}

const INVENTORY_READ_TIMEOUT_MS = 10_000
const INVENTORY_WRITE_TIMEOUT_MS = 15_000
const INVENTORY_COMPLETE_TIMEOUT_MS = 120_000

const emptyQuickProduct = {
  sku: '',
  name: '',
  barcode: '',
  qty: '1',
  unit: 'шт',
  purchase_price: '',
  retail_price: '',
  storage_bin: '',
  category_id: '',
}

type InventoryQuickProductDraft = typeof emptyQuickProduct

interface InventoryLocalDraft {
  query: string
  selected: ProductInfo | null
  qty: string
  quickCreateOpen: boolean
  quickProduct: InventoryQuickProductDraft
  priceStatus: 'unchecked' | 'match' | 'mismatch'
  observedPrice: string
  applyNewPrice: boolean
  savedAt: string
}

type InventoryDraftPayload = Omit<InventoryLocalDraft, 'savedAt'>

function inventoryDraftKey(sessionId: string) {
  return `forsage:inventory:${sessionId}:active-draft:v1`
}

function loadInventoryLocalDraft(sessionId: string): InventoryLocalDraft | null {
  try {
    const raw = localStorage.getItem(inventoryDraftKey(sessionId))
    if (!raw) return null
    const draft = JSON.parse(raw) as Partial<InventoryLocalDraft>
    return {
      query: String(draft.query ?? ''),
      selected: draft.selected ?? null,
      qty: String(draft.qty ?? '1'),
      quickCreateOpen: draft.quickCreateOpen === true,
      quickProduct: { ...emptyQuickProduct, ...(draft.quickProduct ?? {}) },
      priceStatus: draft.priceStatus === 'match' || draft.priceStatus === 'mismatch' ? draft.priceStatus : 'unchecked',
      observedPrice: String(draft.observedPrice ?? ''),
      applyNewPrice: draft.applyNewPrice !== false,
      savedAt: String(draft.savedAt ?? new Date().toISOString()),
    }
  } catch {
    return null
  }
}

function saveInventoryLocalDraft(sessionId: string, draft: InventoryDraftPayload) {
  try {
    localStorage.setItem(inventoryDraftKey(sessionId), JSON.stringify({ ...draft, savedAt: new Date().toISOString() }))
  } catch {
    // Перехід між сторінками не повинен падати, якщо сховище браузера недоступне або переповнене.
  }
}

function clearInventoryLocalDraft(sessionId: string) {
  try {
    localStorage.removeItem(inventoryDraftKey(sessionId))
  } catch {
    // У приватному режимі/при блокуванні сховища очищення може бути недоступним.
  }
}
function persistInventoryLocalDraft(sessionId: string, draft: InventoryDraftPayload) {
  const quickChanged = JSON.stringify(draft.quickProduct) !== JSON.stringify(emptyQuickProduct)
  const hasDraft = Boolean(
    draft.query.trim() || draft.selected || draft.qty !== '1' || draft.quickCreateOpen || quickChanged ||
    draft.priceStatus !== 'unchecked' || draft.observedPrice.trim() || draft.applyNewPrice !== true,
  )
  if (!hasDraft) {
    clearInventoryLocalDraft(sessionId)
    return
  }
  saveInventoryLocalDraft(sessionId, draft)
}


function normalizeScanCode(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127 && !/\s/.test(character)
    })
    .join('')
    .trim()
}

function isNotFoundError(error: unknown): boolean {
  if ((error as any)?.status === 404) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /не\s*знайден|не\s*найден|not\s*found/i.test(message)
}

export default function ActiveSession() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const authSession = useAuthStore((state) => state.session)
  const role = (authSession?.user?.app_metadata?.role as string) ?? 'cashier'
  // Завершення ревізії дозволено власнику, адміністратору та касиру.
  // Сервер і локальний IPC мають ті самі права; не залишаємо касира
  // учасником без кнопки завершення.
  const canComplete = ['owner', 'admin', 'cashier'].includes(role)
  const desktopRuntime = Boolean(desktopBridge())

  const [session, setSession] = useState<SessionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ProductInfo[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<ProductInfo | null>(null)
  const [qty, setQty] = useState('1')
  const [quickCreateOpen, setQuickCreateOpen] = useState(false)
  const [quickProduct, setQuickProduct] = useState(emptyQuickProduct)
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([])
  const [creatingProduct, setCreatingProduct] = useState(false)
  const [priceStatus, setPriceStatus] = useState<'unchecked' | 'match' | 'mismatch'>('unchecked')
  const [observedPrice, setObservedPrice] = useState('')
  const [applyNewPrice, setApplyNewPrice] = useState(true)
  // Завершення ревізії та масова націнка — власні модалки замість prompt/confirm
  const [completeOpen, setCompleteOpen] = useState(false)
  const [pctOpen, setPctOpen] = useState(false)
  const [pctValue, setPctValue] = useState('10')
  const [applyingPriceId, setApplyingPriceId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [pendingRowWrites, setPendingRowWrites] = useState(0)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [showRecent, setShowRecent] = useState(true)
  const [countedPage, setCountedPage] = useState(0)
  const [pricePage, setPricePage] = useState(0)
  // Швидкі відсотки націнки з налаштувань — для випадачки біля ціни в рядку.
  const [quickPercents, setQuickPercents] = useState<number[]>([])
  useEffect(() => {
    adminApi.getSettings()
      .then((r) => setQuickPercents(Array.isArray(r.data.quick_percents) ? r.data.quick_percents.filter((n) => Number(n) > 0) : []))
      .catch(() => {})
    adminApi.listCategories()
      .then((r) => setCategories((r.data ?? []).map((category: any) => ({ id: String(category.id), name: String(category.name ?? '') })).filter((category) => category.id && category.name)))
      .catch(() => {})
  }, [])
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pendingRowWritesRef = useRef(0)
  // Редагування цін товару прямо в сесії (без окремого вікна)
  // Касир також має право виправляти закупівельну та роздрібну ціну під час ревізії. Всі шляхи (web, IPC, сервер) це дозволяють.
  const canEditPrice = ['owner', 'admin', 'manager', 'cashier', 'storekeeper'].includes(role)
  const [editRetail, setEditRetail] = useState('')
  const [editPurchase, setEditPurchase] = useState('')
  const [savingPrice, setSavingPrice] = useState(false)
  // Масові операції над вибраними товарами
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [massBusy, setMassBusy] = useState(false)
  const [printingLabels, setPrintingLabels] = useState<string | null>(null)
  const [labelRows, setLabelRows] = useState<InventoryItem[] | null>(null)
  const [labelQtys, setLabelQtys] = useState<Record<string, number>>({})
  const scanQueue = useRef<Array<{ code: string; qty: number }>>([])
  const scanQueueRunning = useRef(false)
  const completingRef = useRef(false)
  const scanFailuresRef = useRef(0)
  const writeFailuresRef = useRef(0)
  const writeQueueRef = useRef(new InventoryWriteQueue())
  const flushingInputRef = useRef(false)
  const refreshAfterWritesRef = useRef(false)
  const sessionReadGuard = useRef(new InventoryReadGuard())
  const inventoryDraftReadyRef = useRef(false)
  const inventoryDraftPersistenceDisabledRef = useRef(false)
  const inventoryCompletedRef = useRef(false)
  const inventoryDraftSnapshotRef = useRef<InventoryDraftPayload>({
    query: '',
    selected: null,
    qty: '1',
    quickCreateOpen: false,
    quickProduct: emptyQuickProduct,
    priceStatus: 'unchecked',
    observedPrice: '',
    applyNewPrice: true,
  })

  async function trackRowWrite<T>(work: () => Promise<T>, acceptedScan = false): Promise<T> {
    if (inventoryCompletedRef.current || (completingRef.current && !flushingInputRef.current && !acceptedScan)) {
      throw new Error('Ревізія завершується. Дочекайтеся завершення операції.')
    }
    sessionReadGuard.current.invalidate()
    pendingRowWritesRef.current += 1
    setPendingRowWrites(pendingRowWritesRef.current)
    try {
      return await writeQueueRef.current.run(work)
    } catch (error) {
      writeFailuresRef.current += 1
      throw error
    } finally {
      sessionReadGuard.current.invalidate()
      pendingRowWritesRef.current = Math.max(0, pendingRowWritesRef.current - 1)
      setPendingRowWrites(pendingRowWritesRef.current)
      if (pendingRowWritesRef.current === 0 && refreshAfterWritesRef.current) {
        refreshAfterWritesRef.current = false
        void load(true)
      }
    }
  }

  async function waitForPendingRowWrites(): Promise<void> {
    const deadline = Date.now() + INVENTORY_WRITE_TIMEOUT_MS
    while (inventoryHasPendingWrites(pendingRowWritesRef.current, scanQueueRunning.current, scanQueue.current.length)) {
      if (Date.now() >= deadline) {
        throw new Error('Не всі зміни кількості встигли зберегтися. Перевірте рядки та повторіть завершення ревізії.')
      }
      await new Promise<void>((resolve) => { window.setTimeout(resolve, 50) })
    }
  }

  const isCurrentSessionCompleted = Boolean(session && session.id === id && session.status === 'completed')

  useEffect(() => {
    inventoryDraftSnapshotRef.current = {
      query,
      selected,
      qty,
      quickCreateOpen,
      quickProduct,
      priceStatus,
      observedPrice,
      applyNewPrice,
    }
  }, [query, selected, qty, quickCreateOpen, quickProduct, priceStatus, observedPrice, applyNewPrice])

  useEffect(() => {
    inventoryCompletedRef.current = isCurrentSessionCompleted
  }, [isCurrentSessionCompleted])
  const sessionItems = session?.items ?? EMPTY_INVENTORY_ITEMS
  // Порядок додавання: останній пробитий зверху. Сортуємо за часом ПЕРШОГО
  // підрахунку, а не updated_at — інакше редагування старого товару підкидало
  // його вгору. updated_at лишаємо запасним ключем для старих даних без поля.
  const countedRows = useMemo(
    () => [...sessionItems]
      .sort((a, b) =>
        (b.first_counted_at ?? b.updated_at ?? '').localeCompare(a.first_counted_at ?? a.updated_at ?? '')),
    [sessionItems],
  )
  const countedWindow = inventoryPage(countedRows.length, countedPage)
  const priceWindow = inventoryPage(session?.price_issues.length ?? 0, pricePage)
  useEffect(() => { setCountedPage(0); setPricePage(0) }, [id])

  useEffect(() => {
    inventoryDraftReadyRef.current = false
    inventoryDraftPersistenceDisabledRef.current = false
    if (!id) return
    const draft = loadInventoryLocalDraft(id)
    if (draft) {
      setQuery(draft.query)
      setSelected(draft.selected)
      setQty(draft.qty)
      setQuickCreateOpen(draft.quickCreateOpen)
      setQuickProduct(draft.quickProduct)
      setPriceStatus(draft.priceStatus)
      setObservedPrice(draft.observedPrice)
      setApplyNewPrice(draft.applyNewPrice)
    }
    const timer = window.setTimeout(() => { inventoryDraftReadyRef.current = true }, 0)
    return () => window.clearTimeout(timer)
  }, [id])

  useEffect(() => {
    if (!id || !inventoryDraftReadyRef.current) return
    if (session && session.id === id && session.status === 'completed') {
      clearInventoryLocalDraft(id)
      return
    }
    const timer = window.setTimeout(() => {
      if (inventoryDraftPersistenceDisabledRef.current) return
      persistInventoryLocalDraft(id, inventoryDraftSnapshotRef.current)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [id, session?.id, session?.status, query, selected, qty, quickCreateOpen, quickProduct, priceStatus, observedPrice, applyNewPrice])

  useEffect(() => {
    if (!id) return

    const flush = () => {
      if (!inventoryDraftReadyRef.current || inventoryDraftPersistenceDisabledRef.current) return
      if (inventoryCompletedRef.current) {
        clearInventoryLocalDraft(id)
        return
      }
      persistInventoryLocalDraft(id, inventoryDraftSnapshotRef.current)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }

    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      flush()
    }
  }, [id])
  function money2(kopecks: number | undefined | null): string {
    return ((Number(kopecks) || 0) / 100).toFixed(2)
  }

  function kopecksFromInput(value: string): number | null {
    const parsed = Number(String(value).replace(',', '.'))
    if (!Number.isFinite(parsed) || parsed < 0) return null
    return Math.round(parsed * 100)
  }

  function openQuickCreate(seed = query) {
    const code = seed.trim()
    const initial = inventoryQuickCreateSeed(code)
    setSelected(null)
    setSearchResults([])
    setQuickCreateOpen(true)
    setQuickProduct({
      ...emptyQuickProduct,
      ...initial,
    })
  }

  function updateQuickProduct(patch: Partial<typeof emptyQuickProduct>) {
    setQuickProduct((prev) => ({ ...prev, ...patch }))
  }

  function labelCopiesForItem(item: InventoryItem): number {
    return Math.max(1, Math.min(999, Math.ceil(Number(item.counted_stock) || 0)))
  }

  async function printInventoryLabels(item?: InventoryItem) {
    if (!id) return
    const busyKey = item?.id ?? 'all'
    setPrintingLabels(busyKey)
    try {
      let sourceRows = item ? [item] : countedRows
      if (!item) {
        const response = await inventoryApi.getLabels(id, { silent: true, timeoutMs: INVENTORY_READ_TIMEOUT_MS }) as { data: InventoryItem[] }
        sourceRows = response.data
      }
      const rows = sourceRows.filter((row) => row.product && (row.counted_stock ?? 0) > 0)
      if (rows.length === 0) {
        toast.error('Немає товарів для друку етикеток')
        return
      }
      setLabelRows(rows)
      setLabelQtys(Object.fromEntries(rows.map((row) => [row.id, labelCopiesForItem(row)])))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося підготувати етикетки')
    } finally {
      setPrintingLabels(null)
    }
  }

  function setInventoryLabelQty(itemId: string, value: number) {
    const qty = Number.isFinite(value) ? Math.max(0, Math.min(9999, Math.floor(value))) : 0
    setLabelQtys((prev) => ({ ...prev, [itemId]: qty }))
  }

  function closeInventoryLabelModal() {
    setLabelRows(null)
    setLabelQtys({})
  }

  async function confirmInventoryLabelPrint() {
    if (!labelRows?.length) return
    const items = labelRows.flatMap((row) => {
      const count = labelQtys[row.id] ?? 0
      if (!row.product || count <= 0) return []
      return Array(count).fill(row.product)
    })
    if (items.length === 0) {
      toast.error('Вкажіть кількість етикеток')
      return
    }
    setPrintingLabels('confirm')
    try {
      const settings = await loadProductLabelSettings()
      await printLabels(settings as any, items as any, false)
      toast.success(`Відправлено етикеток: ${items.length}`)
      closeInventoryLabelModal()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося надрукувати етикетки')
    } finally {
      setPrintingLabels(null)
    }
  }
  async function savePrice() {
    if (!selected || !canEditPrice) return
    const retail = Math.round(parseFloat(String(editRetail).replace(',', '.')) * 100)
    const purchase = Math.round(parseFloat(String(editPurchase).replace(',', '.')) * 100)
    if (!Number.isFinite(retail) || retail < 0) { toast.error('Некоректна ціна продажу'); return }
    if (!Number.isFinite(purchase) || purchase < 0) { toast.error('Некоректна закупівельна ціна'); return }
    setSavingPrice(true)
    try {
      await trackRowWrite(async () => {
        await productApi.update(selected.id, { retail_price: money2(retail), purchase_price: money2(purchase) } as any, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
        toast.success('Ціни товару оновлено')
        setSelected((cur) => cur ? { ...cur, retail_price: retail, purchase_price: purchase } : cur)
        playSuccessBeep()
        load(true)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося оновити ціни')
    } finally {
      setSavingPrice(false)
    }
  }

  // Порахувати роздрібну з націнки: швидкий % від закупки або за матрицею націнок.
  async function applyMarkupToEdit(kind: 'percent' | 'table', pct?: number) {
    const purchase = Math.round(parseFloat(String(editPurchase).replace(',', '.')) * 100)
    if (!Number.isFinite(purchase) || purchase <= 0) { toast.error('Спершу вкажіть закупівельну ціну'); return }
    if (kind === 'percent' && pct != null) {
      setEditRetail(money2(Math.round(purchase * (1 + pct / 100))))
      return
    }
    try {
      const { data } = await pricingApi.autoRetail(purchase)
      if (data?.retail_price) setEditRetail(money2(data.retail_price))
      else toast.error('Матриця націнок не налаштована для цього діапазону')
    } catch {
      toast.error('Не вдалося порахувати за таблицею')
    }
  }

  function toggleSelectId(productId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(productId)) next.delete(productId); else next.add(productId)
      return next
    })
  }

  function toggleSelectAllCounted(checked: boolean) {
    if (!checked) { setSelectedIds(new Set()); return }
    setSelectedIds(new Set(countedRows.map((r) => r.product?.id).filter((x): x is string => !!x)))
  }

  // Скан/вибір товару → одразу додаємо рядок (+1), без картки й підтверджень.
  async function addProduct(product: ProductInfo) {
    if (!id) return
    initAudio()
    try {
      await trackRowWrite(async () => {
        // Швидкий скан рахує ЛИШЕ кількість, ціну не перевіряє — інакше статистика
        // «Ціну перевірено» роздувалась до всіх порахованих і не відповідала дійсності.
        const response = await inventoryApi.scan(id, { product_id: product.id, qty: 1 }, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS }) as { data: { item: InventoryItem } }
        const updatedItem = response.data.item
        mergeFastScannedItem(updatedItem)
        const counted = Number(updatedItem?.counted_stock ?? 1)
        if (updatedItem?.id) {
          setShowRecent(true)
          setHighlightedItemId(updatedItem.id)
        }
        toast.success(product.name + ' × ' + (Number.isFinite(counted) ? counted : 1))
        playSuccessBeep()
        setQuickCreateOpen(false)
        setQuery(''); setSearchResults([])
        window.setTimeout(() => inputRef.current?.focus(), 0)
      })
    } catch (error) {
      playErrorTone()
      toast.error(error instanceof Error ? error.message : 'Не вдалося додати товар')
    }
  }

  // Встановити абсолютну кількість рядка (редагування прямо в рядку).
  async function setItemQty(item: InventoryItem, value: string) {
    if (!id) return
    const qty = Number(String(value).replace(',', '.'))
    if (!Number.isFinite(qty) || qty < 0) { toast.error('Некоректна кількість'); return }
    try {
      await trackRowWrite(async function () {
        await inventoryApi.setItemQty(id, item.id, qty, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
      })
      load(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося змінити кількість')
    }
  }

  async function removeItem(item: InventoryItem) {
    if (!id) return
    try {
      await trackRowWrite(async () => {
        await inventoryApi.removeItem(id, item.id, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (item.product?.id) next.delete(item.product.id)
          return next
        })
        toast.success('Товар прибрано з ревізії')
        load(true)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося прибрати товар')
    }
  }

  // Встановити роздрібну ціну товару прямо з рядка.
  async function setItemRetail(item: InventoryItem, value: string) {
    if (!item.product || !canEditPrice) return
    const product = item.product
    const retail = kopecksFromInput(value)
    if (retail === null) { toast.error('Некоректна ціна'); return }
    try {
      await trackRowWrite(async () => {
        await productApi.update(product.id, { retail_price: money2(retail) } as any, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
        load(true)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося змінити ціну')
    }
  }

  // Встановити закупівельну ціну товару прямо з рядка.
  async function setItemPurchase(item: InventoryItem, value: string) {
    if (!item.product || !canEditPrice) return
    const product = item.product
    const purchase = kopecksFromInput(value)
    if (purchase === null) { toast.error('Некоректна закупівельна ціна'); return }
    try {
      await trackRowWrite(async () => {
        await productApi.update(product.id, { purchase_price: money2(purchase) } as any, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
        load(true)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося змінити закупку')
    }
  }

  async function updateItemProduct(item: InventoryItem, patch: Partial<Pick<ProductInfo, 'sku' | 'name'>>) {
    if (!item.product || !canEditPrice) return
    const product = item.product
    const payload: Partial<Pick<ProductInfo, 'sku' | 'name'>> = {}
    if (patch.sku !== undefined) {
      const sku = patch.sku.trim()
      if (!sku) { toast.error('Артикул не може бути порожнім'); return }
      payload.sku = sku
    }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (name.length < 2) { toast.error('Назва товару закоротка'); return }
      payload.name = name
    }
    if (Object.keys(payload).length === 0) return
    try {
      await trackRowWrite(async () => {
        const response = await productApi.update(product.id, payload as any, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS }) as { data: ProductInfo }
        setSelected((cur) => cur?.id === product?.id ? { ...cur, ...response.data } : cur)
        toast.success('Товар оновлено')
        load(true)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося оновити товар')
      load(true)
    }
  }

  async function setItemSku(item: InventoryItem, value: string) {
    await updateItemProduct(item, { sku: value })
  }

  async function setItemName(item: InventoryItem, value: string) {
    await updateItemProduct(item, { name: value })
  }

  // Націнка на рядок: швидкий % від закупки або за матрицею націнок.
  async function applyRowMarkup(item: InventoryItem, kind: 'percent' | 'table', pct?: number) {
    if (!item.product || !canEditPrice) return
    const product = item.product
    const purchase = product.purchase_price ?? 0
    if (purchase <= 0) { toast.error('У товару нема закупівельної ціни'); return }
    let retail: number
    if (kind === 'percent' && pct != null) {
      retail = Math.round(purchase * (1 + pct / 100))
    } else {
      try {
        const { data } = await pricingApi.autoRetail(purchase)
        if (!data?.retail_price) { toast.error('Матриця націнок не налаштована для цієї закупки'); return }
        retail = data.retail_price
      } catch { toast.error('Не вдалося порахувати за таблицею'); return }
    }
    try {
      await trackRowWrite(async () => {
        await productApi.update(product.id, { retail_price: money2(retail) } as any, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
        load(true)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка націнки')
    }
  }

  async function applyMassPrice(action: { type: 'percent' | 'amount' | 'markup' | 'markup_table'; value: number }) {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) { toast.error('Виберіть товари'); return }
    const rows = countedRows.filter((row) => row.product && ids.includes(row.product.id))
    if (rows.length === 0) { toast.error('Вибрані товари не знайдено в ревізії'); return }
    setMassBusy(true)
    try {
      await trackRowWrite(async () => {
        let updated = 0
        for (const row of rows) {
          const product = row.product!
          const purchase = Number(product.purchase_price ?? 0)
          const currentRetail = Number(product.retail_price ?? 0)
          let nextRetail: number | null = null
          if (action.type === 'percent') nextRetail = Math.round(currentRetail * (1 + action.value / 100))
          else if (action.type === 'amount') nextRetail = currentRetail + Math.round(action.value)
          else if (action.type === 'markup') nextRetail = Math.round(purchase * (1 + action.value / 100))
          else if (action.type === 'markup_table') {
            const { data } = await pricingApi.autoRetail(purchase)
            nextRetail = Number(data?.retail_price ?? 0)
          }
          if (nextRetail === null || !Number.isFinite(nextRetail) || nextRetail < 0) continue
          await productApi.update(product.id, { retail_price: money2(nextRetail) } as any, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
          updated += 1
        }
        toast.success(`Оновлено ${updated} товар(ів)`)
        setSelectedIds(new Set())
        load(true)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося оновити масово')
    } finally {
      setMassBusy(false)
    }
  }

  async function load(silent = false) {
    if (!id) return
    if (pendingRowWritesRef.current > 0) { refreshAfterWritesRef.current = true; return }
    const readToken = sessionReadGuard.current.begin()
    if (!silent) setLoading(true)
    try {
      const { data } = await inventoryApi.getSession(id, { silent: true, timeoutMs: INVENTORY_READ_TIMEOUT_MS }) as { data: SessionData }
      if (sessionReadGuard.current.isCurrent(readToken) && pendingRowWritesRef.current === 0) setSession(data)
    } catch (error) {
      if (!silent && sessionReadGuard.current.isCurrent(readToken)) {
        toast.error(error instanceof Error ? error.message : 'Не вдалося завантажити ревізію')
        navigate('/inventory')
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => { load(); return () => sessionReadGuard.current.invalidate() }, [id])

  useEffect(() => {
    if (!highlightedItemId || !showRecent) return
    const index = countedRows.findIndex(item => item.id === highlightedItemId)
    const targetPage = index < 0 ? countedPage : Math.floor(index / INVENTORY_PAGE_SIZE)
    if (targetPage !== countedPage) { setCountedPage(targetPage); return }
    const timer = window.setTimeout(() => {
      document.getElementById(`inventory-row-${highlightedItemId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      window.setTimeout(() => inputRef.current?.focus(), 250)
    }, 80)
    const clearTimer = window.setTimeout(() => setHighlightedItemId(null), 2200)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(clearTimer)
    }
  }, [highlightedItemId, showRecent, countedPage, countedRows])
  useEffect(() => {
    if (!session || session.status !== 'in_progress' || desktopRuntime) return
    const timer = window.setInterval(() => load(true), 8_000)
    return () => window.clearInterval(timer)
  }, [id, session?.status, desktopRuntime])

  useEffect(() => {
    const value = query.trim()
    if (selected || value.length < 2 || /^\d{6,}$/.test(value)) {
      setSearchResults([])
      setSearching(false)
      return
    }

    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        const { data } = await productApi.search(value, 12, {
          silent: true,
          timeoutMs: INVENTORY_READ_TIMEOUT_MS,
        })
        if (!cancelled) setSearchResults(data as ProductInfo[])
      } catch {
        if (!cancelled) setSearchResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, selected])

  const progress = useMemo(() => {
    const summary = session?.summary
    if (!summary?.total_products) return 0
    return Math.round(summary.counted_products / summary.total_products * 100)
  }, [session?.summary])

  // Рядки списку — товари, які вже додали (пораховані), найновіші зверху.
  const totalLabelCopies = useMemo(() => {
    const loadedCopies = countedRows.filter((item) => item.counted_stock > 0).reduce((sum, item) => sum + labelCopiesForItem(item), 0)
    const summaryCopies = Math.ceil(Number(session?.summary?.total_counted_units) || 0)
    return Math.max(loadedCopies, summaryCopies)
  }, [countedRows, session?.summary?.total_counted_units])

  function mergeFastScannedItem(item: InventoryItem) {
    sessionReadGuard.current.invalidate()
    setSession((current) => {
      if (!current || current.id !== id) return current
      const previous = current.items.find((row) => row.id === item.id)
      const nextItems = [item, ...current.items.filter((row) => row.id !== item.id)]
      const nextSummary = current.summary
        ? updateScanSummary(current.summary, previous, item)
        : current.summary
      const priceIssues = current.price_issues.filter(issue => issue.id !== item.id)
      if (item.product && item.observed_retail_price !== null && item.observed_retail_price !== item.product.retail_price) {
        priceIssues.unshift({ id: item.id, product_id: item.product_id, observed_retail_price: item.observed_retail_price, product: item.product })
      }
      return { ...current, items: nextItems, summary: nextSummary, price_issues: priceIssues }
    })
  }

  function queueInventoryScan(code: string) {
    if (completingRef.current || inventoryCompletedRef.current) {
      playErrorTone()
      toast.error('Ревізія завершується. Нові сканування не приймаються.')
      return
    }
    const normalizedCode = normalizeScanCode(code)
    if (!normalizedCode) return
    const tail = scanQueue.current[scanQueue.current.length - 1]
    if (tail?.code === normalizedCode) tail.qty += 1
    else scanQueue.current.push({ code: normalizedCode, qty: 1 })
    void drainInventoryScanQueue()
  }

  async function drainInventoryScanQueue() {
    if (scanQueueRunning.current) return
    scanQueueRunning.current = true
    try {
      while (scanQueue.current.length > 0) {
        const pending = scanQueue.current.shift()
        if (pending) await scanCodeFast(pending.code, { fromHardware: true, qty: pending.qty })
      }
    } finally {
      scanQueueRunning.current = false
      if (scanQueue.current.length > 0) void drainInventoryScanQueue()
    }
  }

  async function scanCodeFast(code: string, options: { fromCamera?: boolean; fromHardware?: boolean; qty?: number } = {}) {
    if (!id) return
    if (completingRef.current && !options.fromHardware) { toast.error('Дочекайтеся завершення ревізії'); return }
    const normalizedCode = normalizeScanCode(code)
    if (!normalizedCode) return
    initAudio()
    try {
      const response = await trackRowWrite(() => inventoryApi.scan(id, { barcode: normalizedCode, qty: options.qty ?? 1 }, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS }), true) as { data: { item: InventoryItem } }
      const item = response.data.item
      mergeFastScannedItem(item)
      setShowRecent(true)
      setHighlightedItemId(item.id)
      toast.success((item.product?.name ?? 'Товар') + ' × ' + (Number(item.counted_stock) || 1))
      playSuccessBeep()
      setQuickCreateOpen(false)
      setSelected(null)
      setSearchResults([])
      setQuery('')
      window.setTimeout(() => inputRef.current?.focus(), 0)
    } catch (error) {
      playErrorTone()
      scanFailuresRef.current += 1
      if (isNotFoundError(error) && canEditPrice) {
        if (options.fromCamera) setCameraOpen(false)
        toast.error('Товар не знайдено — можна створити його тут')
        openQuickCreate(normalizedCode)
      } else {
        toast.error(error instanceof Error ? error.message : 'Товар не знайдено')
      }
      inputRef.current?.focus()
    }
  }


  async function resolveCode(code: string, options: { fromCamera?: boolean; fromHardware?: boolean } = {}) {
    if (!id || !code.trim()) return
    setSearching(true)
    initAudio()
    try {
      const { data } = await inventoryApi.findProduct(id, { code: code.trim() }, { silent: true, timeoutMs: INVENTORY_READ_TIMEOUT_MS }) as { data: ProductInfo }
      await addProduct(data)
    } catch (error) {
      playErrorTone()
      if (isNotFoundError(error) && canEditPrice) {
        if (options.fromCamera) setCameraOpen(false)
        toast.error('Товар не знайдено — можна створити його тут')
        openQuickCreate(code)
      } else {
        toast.error(error instanceof Error ? error.message : 'Товар не знайдено')
      }
      inputRef.current?.focus()
    } finally {
      setSearching(false)
    }
  }

  usePOSBarcodeScanner({
    onScan: (code) => {
      if (session?.status !== 'in_progress' || cameraOpen) return
      setQuery(normalizeScanCode(code))
      queueInventoryScan(code)
    },
  })

  async function submitSearch(event: React.FormEvent) {
    event.preventDefault()
    if (searchResults[0]) await addProduct(searchResults[0])
    else await resolveCode(query)
  }

  async function saveCount() {
    if (!id || !selected) return
    const parsedQty = Number(String(qty).replace(',', '.'))
    if (!Number.isFinite(parsedQty) || parsedQty < 0) {
      toast.error('Кількість не може бути від’ємною')
      return
    }
    let observedKopecks: number | null = null
    if (priceStatus === 'unchecked') {
      toast.error('Перевірте ціну: збігається вона чи ні')
      return
    }
    if (priceStatus === 'mismatch') {
      const parsedPrice = Number(String(observedPrice).replace(',', '.'))
      if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
        toast.error('Вкажіть фактичну ціну з цінника')
        return
      }
      observedKopecks = Math.round(parsedPrice * 100)
    }

    setSaving(true)
    try {
      await trackRowWrite(async () => {
        const willApplyPrice = priceStatus === 'mismatch' && applyNewPrice && canEditPrice && observedKopecks != null
        const response = await inventoryApi.count(id, {
          product_id: selected.id,
          qty: parsedQty,
          // Keep the observed discrepancy until applying the price actually succeeds.
          price_checked: priceStatus === 'match',
          observed_retail_price: observedKopecks,
        }, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
        let freshSession = response.session
        if (willApplyPrice) {
          try {
            const applied = await inventoryApi.applyPrice(id, { product_id: selected.id, retail_price: observedKopecks! }, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
            freshSession = applied.session
            toast.success(`Ціну змінено: ${selected.name} → ${formatMoney(observedKopecks!)}`)
          } catch (error) {
            writeFailuresRef.current += 1
            toast.error(error instanceof Error ? error.message : 'Кількість збережено, але ціну оновити не вдалося')
          }
        }
        setSession(freshSession)
        toast.success(`Додано ${parsedQty} ${selected.unit ?? 'шт'} · ${selected.name}`)
        playSuccessBeep()
        setSelected(null)
        setQty('1')
        setPriceStatus('unchecked')
        setObservedPrice('')
        if (id) clearInventoryLocalDraft(id)
        inputRef.current?.focus()
      })
    } catch (error) {
      playErrorTone()
      toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти підрахунок')
    } finally {
      setSaving(false)
    }
  }

  async function handleQuickGenBarcode() {
    try {
      const { data } = await productApi.generateBarcodeOnly()
      updateQuickProduct({ barcode: data.barcode })
      toast.success('Штрихкод згенеровано')
    } catch {
      toast.error('Не вдалося згенерувати штрихкод')
    }
  }

  async function createProductFromInventory() {
    if (!id) return
    const draft = quickProduct
    const sku = draft.sku.trim()
    const name = draft.name.trim()
    const countedQty = Number(String(draft.qty).replace(',', '.'))
    if (!sku) { toast.error('Вкажіть артикул або код'); return }
    if (name.length < 2) { toast.error('Вкажіть назву товару'); return }
    if (hasSuspiciousInventorySku(sku, name)) {
      toast.error('Схоже, назва товару потрапила в поле артикулу. Перенесіть опис у поле «Назва», а в артикулі залиште лише код.')
      return
    }
    if (!Number.isFinite(countedQty) || countedQty <= 0) { toast.error('Кількість має бути більше 0'); return }
    setCreatingProduct(true)
    try {
      await trackRowWrite(async () => {
        const created = await productApi.create({
          sku,
          name,
          barcode: draft.barcode.trim(),
          brand_id: '',
          category_id: draft.category_id || '',
          unit: (draft.unit as any) || 'шт',
          purchase_price: draft.purchase_price,
          retail_price: draft.retail_price,
          qty_on_hand: '0',
          reorder_point: '0',
          notes: 'Створено під час інвентаризації',
          is_active: true,
          is_service: false,
          storage_bin: draft.storage_bin.trim(),
          is_favorite: false,
          photo_url: null,
          specs: {},
          requires_core_return: false,
          core_deposit_amount: '',
        }, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
        const response = await inventoryApi.count(id, { product_id: created.data.id, qty: countedQty, price_checked: true, observed_retail_price: null }, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
        setSession(response.session)
        setQuickProduct(emptyQuickProduct)
        setQuickCreateOpen(false)
        setQuery('')
        toast.success(`Створено і додано: ${name} × ${countedQty}`)
        playSuccessBeep()
        if (id) clearInventoryLocalDraft(id)
        inputRef.current?.focus()
      })
    } catch (error) {
      playErrorTone()
      toast.error(error instanceof Error ? error.message : 'Не вдалося створити товар')
    } finally {
      setCreatingProduct(false)
    }
  }

  // Швидка зміна ціни зі списку розбіжностей: ставимо в програму ціну з цінника
  async function applyIssuePrice(issue: SessionData['price_issues'][number]) {
    if (!id || !issue.product?.id) return
    const product = issue.product
    setApplyingPriceId(product.id)
    try {
      await trackRowWrite(async () => {
        const response = await inventoryApi.applyPrice(id, { product_id: product.id, retail_price: issue.observed_retail_price }, { silent: true, timeoutMs: INVENTORY_WRITE_TIMEOUT_MS })
        setSession(response.session)
        toast.success(`Ціну змінено: ${product.name} → ${formatMoney(issue.observed_retail_price)}`)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося змінити ціну')
    } finally {
      setApplyingPriceId(null)
    }
  }

  function applyPctFromModal() {
    const n = Number(String(pctValue).replace(',', '.'))
    if (!Number.isFinite(n)) {
      toast.error('Вкажіть відсоток числом')
      return
    }
    setPctOpen(false)
    applyMassPrice({ type: 'percent', value: n })
  }

  // Нативні prompt()/confirm() тут використовувати НЕ можна: Electron
  // (десктоп-каса) prompt() не реалізує — кнопка «Завершити» просто мовчала.
  function openCompleteConfirm() {
    if (!session || !canComplete) return
    setCompleteOpen(true)
  }

  async function completeSession() {
    if (!id || !session || !canComplete || completingRef.current) return
    completingRef.current = true
    const scanFailuresBefore = scanFailuresRef.current
    const writeFailuresBefore = writeFailuresRef.current
    setCompleting(true)
    toast.success('Застосовую залишки ревізії...')
    try {
      const activeElement = document.activeElement
      flushingInputRef.current = true
      try { if (activeElement instanceof HTMLElement) activeElement.blur() }
      finally { flushingInputRef.current = false }
      await waitForPendingRowWrites()
      if (scanFailuresRef.current !== scanFailuresBefore) throw new Error('Не всі сканування збережено. Перевірте повідомлення та товари перед завершенням ревізії.')
      if (writeFailuresRef.current !== writeFailuresBefore) throw new Error('Не всі правки збережено. Виправте помилку перед завершенням ревізії.')
      const response = await inventoryApi.complete(id, { silent: true, timeoutMs: INVENTORY_COMPLETE_TIMEOUT_MS })
      const updated = Number((response.data as any)?.items_updated ?? 0)
      setCompleteOpen(false)
      toast.success(`Ревізію завершено. Оновлено ${Number.isFinite(updated) ? updated : 0} товарів.`)
      inventoryDraftPersistenceDisabledRef.current = true
      inventoryCompletedRef.current = true
      clearInventoryLocalDraft(id)
      navigate('/inventory')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося завершити ревізію')
      load(true)
    } finally {
      completingRef.current = false
      setCompleting(false)
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(window.location.href)
    toast.success('Посилання для працівників скопійовано')
  }

  if (loading) {
    return <Layout title="Ревізія"><div className="py-12 text-center text-sm text-gray-400">Завантаження...</div></Layout>
  }
  if (!session) return null
  const isActive = session.status === 'in_progress'

  return (
    <Layout title={`Ревізія: ${session.name}`} onBack={() => navigate('/inventory')}>
      <div className="mx-auto max-w-5xl space-y-4 pb-24">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Badge color={session.status === 'completed' ? 'green' : session.status === 'draft' ? 'yellow' : 'blue'}>
                  {session.status === 'completed' ? 'Завершена' : session.status === 'draft' ? 'Чернетка' : 'Спільний підрахунок'}
                </Badge>
                {isActive && !desktopRuntime && <span className="text-xs text-gray-500">Оновлення кожні 8 секунд</span>}
              </div>
              <p className="mt-2 text-sm text-gray-600">
                Пораховано товарів: <strong>{session.summary.counted_products}</strong> із {session.summary.total_products}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">Учасників: {session.summary.participants ?? 0}</p>
            </div>
            <Button size="sm" variant="outline" icon={<Copy size={14} />} onClick={copyLink}>
              Посилання працівникам
            </Button>
          </div>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full rounded-full bg-yellow-400 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-xs text-gray-500">
            <span>{progress}% каталогу</span>
            <span>Ціну перевірено: {session.summary.price_checked_products}</span>
          </div>
          {(session.summary.price_mismatch_products ?? 0) > 0 && (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-red-600">
              <AlertTriangle size={13} /> Не збігається цін: {session.summary.price_mismatch_products}
            </p>
          )}
        </Card>

        {isActive && (
          <Card>
            <p className="mb-2 text-sm font-semibold text-gray-900">Знайти товар</p>
            <form onSubmit={submitSearch} className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setSelected(null); setQuickCreateOpen(false) }}
                  placeholder="Назва, VIN/артикул або штрихкод"
                  autoFocus
                  className="w-full rounded-xl border-2 border-yellow-400 bg-white py-3.5 pl-10 pr-3 text-base outline-none focus:border-yellow-500"
                />
                {searchResults.length > 0 && (
                  <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl">
                    {searchResults.map((product) => (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => addProduct(product)}
                        className="flex w-full items-center justify-between gap-3 border-b border-gray-100 px-3 py-3 text-left last:border-0 hover:bg-yellow-50"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-gray-900">{product.name}</p>
                          <p className="font-mono text-xs text-gray-500">{product.sku} {product.barcode ? `· ${product.barcode}` : ''}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-bold">{formatMoney(product.retail_price)}</p>
                          <p className="text-xs text-gray-500">{product.qty_on_hand ?? 0} {product.unit}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                className="flex w-13 shrink-0 items-center justify-center rounded-xl border border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200"
                aria-label="Сканувати камерою"
              >
                <Camera size={23} />
              </button>
              <Button type="submit" loading={searching} className="hidden sm:flex">Знайти</Button>
            </form>
            {canEditPrice && query.trim().length >= 2 && searchResults.length === 0 && !searching && (
              <button
                type="button"
                onClick={() => openQuickCreate(query)}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-yellow-400 bg-yellow-50 px-3 py-2.5 text-sm font-semibold text-yellow-900 hover:bg-yellow-100"
              >
                <Plus size={16} /> Не знайшли? Створити товар тут
              </button>
            )}
          </Card>
        )}

        {canEditPrice && quickCreateOpen && isActive && (
          <Card>
            <div className="mb-3">
              <p className="text-base font-bold text-gray-900">Новий товар у ревізії</p>
              <p className="text-xs text-gray-500">Заповніть мінімум — товар одразу створиться і додасться в цей підрахунок.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-500">Код / VIN / артикул</label>
                <input value={quickProduct.sku} onChange={(event) => updateQuickProduct({ sku: event.target.value })}
                  className="w-full rounded-xl border border-gray-300 px-3 py-3 text-base font-semibold outline-none focus:border-yellow-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-500">Штрихкод</label>
                <div className="flex gap-2">
                  <input value={quickProduct.barcode} onChange={(event) => updateQuickProduct({ barcode: event.target.value })}
                    inputMode="numeric"
                    className="min-w-0 flex-1 rounded-xl border border-gray-300 px-3 py-3 font-mono text-base outline-none focus:border-yellow-500" />
                  <Button type="button" variant="secondary" onClick={handleQuickGenBarcode} className="shrink-0">Генерувати</Button>
                </div>
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-semibold text-gray-500">Назва</label>
                <input value={quickProduct.name} onChange={(event) => updateQuickProduct({ name: event.target.value })}
                  placeholder="Наприклад: Фільтр масляний..."
                  className="w-full rounded-xl border-2 border-yellow-400 px-3 py-3 text-base font-semibold outline-none focus:border-yellow-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-500">Факт / од. виміру</label>
                <div className="flex gap-2">
                  <input type="number" min="1" step="1" inputMode="numeric" value={quickProduct.qty}
                    onChange={(event) => updateQuickProduct({ qty: event.target.value })}
                    className="min-w-0 flex-1 rounded-xl border border-gray-300 px-3 py-3 text-center text-xl font-bold outline-none focus:border-yellow-500" />
                  <select value={quickProduct.unit} onChange={(event) => updateQuickProduct({ unit: event.target.value })}
                    className="shrink-0 rounded-xl border border-gray-300 bg-white px-2 text-base outline-none focus:border-yellow-500">
                    {['шт', 'кг', 'л', 'м', 'компл'].map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-500">Комірка</label>
                <input value={quickProduct.storage_bin} onChange={(event) => updateQuickProduct({ storage_bin: event.target.value })}
                  placeholder="Полиця / ячейка"
                  className="w-full rounded-xl border border-gray-300 px-3 py-3 text-base outline-none focus:border-yellow-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-500">Папка</label>
                <select value={quickProduct.category_id} onChange={(event) => updateQuickProduct({ category_id: event.target.value })}
                  className="w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-base outline-none focus:border-yellow-500">
                  <option value="">Без папки</option>
                  {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-500">Закупка, ₴</label>
                <input type="number" min="0" step="1" inputMode="decimal" value={quickProduct.purchase_price}
                  onChange={(event) => updateQuickProduct({ purchase_price: event.target.value })}
                  className="w-full rounded-xl border border-gray-300 px-3 py-3 text-base font-semibold outline-none focus:border-yellow-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-500">Продаж, ₴</label>
                <input type="number" min="0" step="1" inputMode="decimal" value={quickProduct.retail_price}
                  onChange={(event) => updateQuickProduct({ retail_price: event.target.value })}
                  className="w-full rounded-xl border border-gray-300 px-3 py-3 text-base font-bold outline-none focus:border-yellow-500" />
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button onClick={createProductFromInventory} loading={creatingProduct} className="flex-1" icon={<PackageCheck size={17} />}>
                Створити і додати
              </Button>
              <Button variant="outline" onClick={() => setQuickCreateOpen(false)}>
                Скасувати
              </Button>
            </div>
          </Card>
        )}

        {selected && isActive && (
          <Card>
            <div className="border-b border-gray-100 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-gray-900">{selected.name}</h2>
                  <p className="mt-1 font-mono text-xs text-gray-500">
                    {selected.sku}{selected.barcode ? ` · ${selected.barcode}` : ''}
                  </p>
                  {selected.storage_bin && <p className="mt-1 text-xs text-blue-600">Комірка: {selected.storage_bin}</p>}
                </div>
                <button onClick={() => setSelected(null)} className="text-sm text-gray-400 hover:text-gray-700">Закрити</button>
              </div>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-5">
              <div className="rounded-xl bg-gray-50 p-3 sm:col-span-2">
                <p className="text-xs text-gray-500">Штрихкод</p>
                <p className="mt-1 truncate font-mono text-base font-bold text-gray-900 select-all">
                  {selected.barcode || 'не задано'}
                </p>
              </div>
              <div className="rounded-xl bg-gray-50 p-3">
                <p className="text-xs text-gray-500">У програмі на старті</p>
                <p className="mt-1 text-lg font-bold">{selected.inventory_item?.expected_stock ?? selected.qty_on_hand ?? 0} {selected.unit}</p>
              </div>
              <div className="rounded-xl bg-blue-50 p-3">
                <p className="text-xs text-blue-600">Вже пораховано всіма</p>
                <p className="mt-1 text-lg font-bold text-blue-800">{selected.inventory_item?.counted_stock ?? 0} {selected.unit}</p>
              </div>
              <div className="rounded-xl bg-yellow-50 p-3">
                <p className="text-xs text-yellow-700">Закупка / продаж</p>
                <p className="mt-1 text-sm font-semibold text-yellow-900">{formatMoney(selected.purchase_price ?? 0)}</p>
                <p className="text-lg font-bold text-yellow-950">{formatMoney(selected.retail_price)}</p>
              </div>
            </div>
            {(selected.inventory_item?.counted_stock ?? 0) > 0 && (
              <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Цей товар уже рахували. Додавайте кількість лише якщо це інша коробка, полиця або залишок, який ще не врахували.
              </div>
            )}

            <div className="mt-4">
              <label className="mb-1 block text-sm font-semibold text-gray-800">
                Скільки ви порахували у своїй коробці / на своїй полиці
              </label>
              <input
                id="inventory-qty"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={qty}
                onChange={(event) => setQty(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') saveCount() }}
                className="w-full rounded-xl border-2 border-yellow-400 px-4 py-4 text-center text-3xl font-bold outline-none focus:border-yellow-500"
              />
              <div className="mt-2 grid grid-cols-4 gap-2">
                {[1, 2, 5, 10].map((value) => (
                  <button key={value} type="button" onClick={() => setQty(String(value))}
                    className="rounded-lg bg-gray-100 py-2 text-sm font-semibold hover:bg-gray-200">
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-gray-200 p-3">
              <p className="text-sm font-semibold text-gray-800">
                Ціна на товарі / ціннику збігається з {formatMoney(selected.retail_price)}?
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setPriceStatus('match'); setObservedPrice('') }}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                    priceStatus === 'match'
                      ? 'border-green-500 bg-green-50 text-green-700'
                      : 'border-gray-200 bg-white text-gray-600'
                  }`}>
                  ✓ Так, збігається
                </button>
                <button type="button" onClick={() => setPriceStatus('mismatch')}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                    priceStatus === 'mismatch'
                      ? 'border-red-500 bg-red-50 text-red-700'
                      : 'border-gray-200 bg-white text-gray-600'
                  }`}>
                  Ні, інша ціна
                </button>
              </div>
              {priceStatus === 'mismatch' && (
                <div className="mt-3">
                  <label className="mb-1 block text-xs text-red-600">Яка ціна вказана фактично, ₴</label>
                  <input type="number" min="0" step="1" inputMode="decimal" value={observedPrice}
                    onChange={(event) => setObservedPrice(event.target.value)}
                    className="w-full rounded-lg border border-red-300 px-3 py-2 text-lg font-bold outline-none focus:border-red-500" />
                  {canEditPrice && (
                    <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800">
                      <input
                        type="checkbox"
                        checked={applyNewPrice}
                        onChange={(event) => setApplyNewPrice(event.target.checked)}
                        className="rounded text-green-600 focus:ring-green-500"
                      />
                      💾 Одразу змінити ціну в програмі на цю
                    </label>
                  )}
                  {!canEditPrice && (
                    <p className="mt-2 text-xs text-gray-500">Розбіжність побачить власник і вирішить, яка ціна правильна.</p>
                  )}
                </div>
              )}
            </div>

            {canEditPrice && (
              <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50/40 p-3">
                <p className="mb-2 text-sm font-semibold text-blue-900">Виправити ціни товару (тут, без окремого вікна)</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">Закупівельна, ₴</label>
                    <input type="number" min="0" step="1" inputMode="decimal" value={editPurchase}
                      onChange={(event) => setEditPurchase(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base font-semibold outline-none focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">Продажу, ₴</label>
                    <input type="number" min="0" step="1" inputMode="decimal" value={editRetail}
                      onChange={(event) => setEditRetail(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base font-bold outline-none focus:border-blue-500" />
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-gray-500">Націнка:</span>
                  {[20, 30, 50, 100].map((p) => (
                    <button key={p} type="button" onClick={() => applyMarkupToEdit('percent', p)}
                      className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-100">+{p}%</button>
                  ))}
                  <button type="button" onClick={() => applyMarkupToEdit('table')}
                    className="rounded-lg border border-blue-300 bg-white px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100">По таблиці</button>
                </div>
                <Button variant="outline" size="sm" onClick={savePrice} loading={savingPrice} className="mt-2 w-full">
                  Зберегти ціни товару
                </Button>
              </div>
            )}

            <Button onClick={saveCount} loading={saving} className="mt-4 w-full" icon={<PackageCheck size={17} />}>
              Додати мій підрахунок
            </Button>
          </Card>
        )}

        {labelRows && (
          <Modal open onClose={closeInventoryLabelModal} title="Друк етикеток ревізії" size="md">
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                Перед друком можна змінити кількість етикеток. За замовчуванням — фактична кількість з ревізії.
              </p>
              <div className="max-h-96 overflow-y-auto rounded-xl border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Товар</th>
                      <th className="w-28 px-3 py-2 text-center font-medium">Етикеток</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {labelRows.map((row) => (
                      <tr key={row.id}>
                        <td className="px-3 py-2">
                          <p className="font-semibold text-gray-900">{row.product?.name ?? 'Товар'}</p>
                          <p className="font-mono text-xs text-gray-500">{row.product?.sku} · факт: {row.counted_stock}</p>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min={0}
                            max={9999}
                            step={1}
                            inputMode="numeric"
                            value={labelQtys[row.id] ?? 0}
                            onChange={(event) => setInventoryLabelQty(row.id, Number(event.target.value))}
                            className="w-full rounded-lg border border-gray-300 px-2 py-1 text-center font-semibold outline-none focus:border-yellow-500"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 text-sm">
                <span className="text-gray-500">Всього етикеток</span>
                <strong className="text-gray-900">{Object.values(labelQtys).reduce((sum, qty) => sum + qty, 0)}</strong>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button variant="secondary" onClick={closeInventoryLabelModal} className="w-full sm:w-auto">Скасувати</Button>
                <Button
                  onClick={confirmInventoryLabelPrint}
                  loading={printingLabels === 'confirm'}
                  disabled={Object.values(labelQtys).reduce((sum, qty) => sum + qty, 0) === 0}
                  className="w-full sm:w-auto"
                >
                  Друкувати
                </Button>
              </div>
            </div>
          </Modal>
        )}
        <CameraScanner
          open={cameraOpen}
          continuous
          onClose={() => setCameraOpen(false)}
          onScan={(code) => {
            setQuery(normalizeScanCode(code))
            scanCodeFast(code, { fromCamera: true })
          }}
        />
<Card padding="none">
          <div className="flex items-center gap-2 px-4 py-3">
            {canEditPrice && isActive && countedRows.length > 0 && (
              <input
                type="checkbox"
                aria-label="Вибрати всі"
                title="Вибрати всі"
                checked={countedRows.every((r) => r.product?.id && selectedIds.has(r.product.id))}
                onChange={(e) => toggleSelectAllCounted(e.target.checked)}
                className="h-4 w-4 shrink-0 rounded border-gray-300"
              />
            )}
            <button onClick={() => setShowRecent(!showRecent)}
              className="flex min-w-0 flex-1 items-center justify-between text-left">
              <span className="truncate font-semibold text-gray-900">Додані товари ({countedRows.length})</span>
              <ChevronDown size={17} className={showRecent ? 'rotate-180 shrink-0' : 'shrink-0'} />
            </button>
            {countedRows.length > 0 && (
              <button
                type="button"
                disabled={printingLabels === 'all'}
                onClick={() => printInventoryLabels()}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-yellow-300 bg-yellow-50 px-2.5 py-1.5 text-xs font-semibold text-yellow-900 hover:bg-yellow-100 disabled:opacity-50"
              >
                <Printer size={14} /> {printingLabels === 'all' ? 'Друк...' : `Етикетки всі (${totalLabelCopies})`}
              </button>
            )}
          </div>

          {canEditPrice && isActive && selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-yellow-50 px-4 py-2.5">
              <span className="text-xs font-semibold text-gray-700">Вибрано: {selectedIds.size}</span>
              <span className="text-xs text-gray-500">Масова націнка:</span>
              {[30, 50, 100].map((p) => (
                <button key={p} type="button" disabled={massBusy}
                  onClick={() => applyMassPrice({ type: 'markup', value: p })}
                  className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">+{p}%</button>
              ))}
              <button type="button" disabled={massBusy}
                onClick={() => applyMassPrice({ type: 'markup_table', value: 30 })}
                className="rounded-lg border border-blue-300 bg-white px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50">По таблиці</button>
              <button type="button" disabled={massBusy}
                onClick={() => { setPctValue('10'); setPctOpen(true) }}
                className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">Ціна +%</button>
              <button type="button" onClick={() => setSelectedIds(new Set())}
                className="ml-auto text-xs text-gray-500 hover:text-gray-800">Зняти вибір</button>
            </div>
          )}
          {showRecent && (
            <div className="divide-y divide-gray-100 border-t border-gray-100">
              {countedRows.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400">
                  Скануйте штрихкод або знайдіть товар — він з'явиться тут рядком.
                </p>
              ) : countedRows.slice(countedWindow.start, countedWindow.end).map((item) => (
                <InventoryRow
                  key={item.id}
                  item={item}
                  isActive={isActive}
                  canEditPrice={canEditPrice}
                  selected={item.product?.id ? selectedIds.has(item.product.id) : false}
                  onToggleSelect={() => item.product?.id && toggleSelectId(item.product.id)}
                  onSetQty={(value) => setItemQty(item, value)}
                  onSetSku={(value) => setItemSku(item, value)}
                  onSetName={(value) => setItemName(item, value)}
                  onSetPurchase={(value) => setItemPurchase(item, value)}
                  onSetRetail={(value) => setItemRetail(item, value)}
                  onMarkup={(kind, pct) => applyRowMarkup(item, kind, pct)}
                  quickPercents={quickPercents}
                  onPrintLabel={() => printInventoryLabels(item)}
                  labelPrinting={printingLabels === item.id}
                  highlighted={highlightedItemId === item.id}
                  onRemove={() => removeItem(item)}
                />
              ))}
              <InventoryPager total={countedRows.length} page={countedPage} onChange={setCountedPage} />
            </div>
          )}
        </Card>

        {session.price_issues.length > 0 && (
          <Card padding="none">
            <div className="border-b border-red-100 bg-red-50 px-4 py-3">
              <p className="flex items-center gap-2 font-semibold text-red-800">
                <AlertTriangle size={16} /> Ціни не збігаються ({session.price_issues.length})
              </p>
            </div>
            <div className="divide-y divide-gray-100">
              {session.price_issues.slice(priceWindow.start, priceWindow.end).map((issue) => (
                <div key={issue.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-900">{issue.product?.name ?? 'Товар'}</p>
                    <p className="font-mono text-xs text-gray-500">{issue.product?.sku}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs text-gray-500">У програмі: {formatMoney(issue.product?.retail_price ?? 0)}</p>
                    <p className="font-bold text-red-600">На ціннику: {formatMoney(issue.observed_retail_price)}</p>
                    <div className="mt-1.5 flex items-center justify-end gap-2">
                      {canEditPrice && issue.product?.id && (
                        <button
                          type="button"
                          disabled={applyingPriceId === issue.product.id}
                          onClick={() => applyIssuePrice(issue)}
                          className="rounded-lg bg-green-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          {applyingPriceId === issue.product.id ? 'Зберігаю...' : `Змінити на ${formatMoney(issue.observed_retail_price)}`}
                        </button>
                      )}
                      {canComplete && issue.product?.id && (
                        <button
                          type="button"
                          onClick={() => window.open(`/products/${issue.product!.id}/edit`, '_blank', 'noopener,noreferrer')}
                          className="text-xs font-semibold text-blue-600 hover:underline"
                        >
                          Картка
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {session.price_issues.length > INVENTORY_PAGE_SIZE && <InventoryPager total={session.price_issues.length} page={pricePage} onChange={setPricePage} />}

        {isActive && canComplete && (
          <div className="space-y-2">
            <div className="flex justify-end">
              <Button onClick={openCompleteConfirm} loading={completing} icon={<CheckCircle size={16} />}>
                {completing ? 'Застосовую залишки...' : pendingRowWrites ? 'Зберігаю правки рядків...' : 'Завершити та застосувати залишки'}
              </Button>
            </div>
            {completing && (
              <p className="text-right text-xs font-medium text-blue-700">
                Йде запис залишків у склад. Не закривайте сторінку.
              </p>
            )}
          </div>
        )}
        {isActive && !canComplete && (
          <p className="text-center text-xs text-gray-500">Завершує ревізію власник, адміністратор або касир.</p>
        )}
      </div>

      <Modal open={completeOpen} onClose={() => setCompleteOpen(false)} title="Завершити ревізію" size="md">
        {(() => {
          const counted = session.summary.counted_products ?? 0
          const missing = Math.max(0, (session.summary.total_products ?? 0) - counted)
          const priceIssues = session.summary.price_mismatch_products ?? 0
          // Список змін залишків: було (облік) → стане (факт). Зменшення — зверху й червоним,
          // щоб одразу побачити помилки (напр. «було 24 → стане 1») ДО застосування.
          const changes = session.items
            .map((it) => ({ name: it.product?.name ?? it.product?.sku ?? '—', was: it.expected_stock, now: it.counted_stock }))
            .sort((a, b) => (a.now - a.was) - (b.now - b.was))
          const decreases = changes.filter((c) => c.now < c.was).length
          return (
            <div className="space-y-4">
              {/* Завершення застосовує залишки ЛИШЕ для порахованих товарів.
                  Непораховані НЕ обнуляються (перевірено на всіх шляхах завершення). */}
              <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900 space-y-1">
                <p>Буде застосовано фактичні залишки для <strong>{counted}</strong> порахованих товарів.</p>
                {missing > 0 && (
                  <p>Решта <strong>{missing}</strong> товарів <strong>не зміняться</strong> — залишки без змін.</p>
                )}
                {priceIssues > 0 && (
                  <p className="flex items-center gap-1.5 pt-1 font-semibold text-red-700">
                    <AlertTriangle size={14} /> Розбіжностей цін: {priceIssues}.
                  </p>
                )}
              </div>

              {changes.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Зміни залишків: {changes.length}{decreases > 0 ? ` · зменшень: ${decreases}` : ''}
                  </p>
                  <div className="max-h-64 divide-y divide-gray-50 overflow-y-auto rounded-lg border border-gray-100">
                    {changes.map((c, i) => {
                      const down = c.now < c.was
                      const up = c.now > c.was
                      return (
                        <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-sm">
                          <span className="min-w-0 flex-1 truncate text-gray-800">{c.name}</span>
                          <span className={`shrink-0 font-mono font-semibold ${down ? 'text-red-600' : up ? 'text-green-600' : 'text-gray-400'}`}>
                            {c.was} → {c.now}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  {decreases > 0 && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-red-600">
                      <AlertTriangle size={13} /> Червоним — залишок зменшиться. Перевірте, чи це правильно.
                    </p>
                  )}
                </div>
              )}

              <p className="text-sm text-gray-600">Застосувати ці зміни й завершити ревізію?</p>
              <div className="flex gap-2 justify-end">
                <Button variant="secondary" onClick={() => setCompleteOpen(false)}>Ні</Button>
                <Button onClick={completeSession} loading={completing} icon={<CheckCircle size={16} />}>
                  Так, завершити
                </Button>
              </div>
            </div>
          )
        })()}
      </Modal>

      <Modal open={pctOpen} onClose={() => setPctOpen(false)} title="Підняти ціну продажу" size="sm">
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Підняти ціну продажу на, %</label>
            <Input value={pctValue} autoFocus inputMode="decimal"
              onChange={(e) => setPctValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyPctFromModal() }} />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setPctOpen(false)}>Скасувати</Button>
            <Button onClick={applyPctFromModal}>Застосувати</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}

// Один рядок товару в ревізії: кількість і ціна редагуються прямо тут.
// Поля неконтрольовані (defaultValue + key) — зберігаються на blur/Enter і
// не збивають фокус при фоновому оновленні кожні 8с.
function InventoryRowBase({
  item, isActive, canEditPrice, selected,
  onToggleSelect, onSetQty, onSetSku, onSetName, onSetPurchase, onSetRetail, onMarkup, quickPercents, onPrintLabel, labelPrinting, highlighted, onRemove,
}: {
  item: InventoryItem
  isActive: boolean
  canEditPrice: boolean
  selected: boolean
  onToggleSelect: () => void
  onSetQty: (value: string) => void
  onSetSku: (value: string) => void
  onSetName: (value: string) => void
  onSetPurchase: (value: string) => void
  onSetRetail: (value: string) => void
  onMarkup: (kind: 'percent' | 'table', pct?: number) => void
  quickPercents: number[]
  onPrintLabel: () => void
  labelPrinting: boolean
  highlighted: boolean
  onRemove: () => void
}) {
  const retailStr = ((item.product?.retail_price ?? 0) / 100).toFixed(2)
  const purchaseStr = ((item.product?.purchase_price ?? 0) / 100).toFixed(2)
  const product = item.product
  const unit = product?.unit ?? 'шт'
  const barcode = product?.barcode || 'без штрихкоду'
  return (
    <div id={`inventory-row-${item.id}`} className={`grid grid-cols-1 gap-2 px-3 py-2.5 text-sm transition-all duration-500 lg:grid-cols-[minmax(260px,1fr)_92px_104px_104px_92px_auto] lg:items-center lg:gap-3 ${highlighted ? 'bg-yellow-100 ring-2 ring-yellow-400 shadow-[0_0_0_3px_rgba(250,204,21,0.18)]' : 'bg-white'}`}>
      <div className="flex min-w-0 items-start gap-2">
        {canEditPrice && isActive && (
          <input type="checkbox" aria-label="Вибрати" checked={selected} onChange={onToggleSelect}
            className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300" />
        )}
        <div className="min-w-0 flex-1">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-400">Назва</span>
          {canEditPrice && product ? (
            <textarea
              key={`name-${product.name}`}
              defaultValue={product.name}
              disabled={!isActive}
              rows={2}
              title={product.name}
              onBlur={(event) => onSetName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  ;(event.target as HTMLTextAreaElement).blur()
                }
              }}
              className="w-full resize-y rounded-lg border border-gray-200 px-2 py-1.5 text-sm font-semibold leading-snug text-gray-900 outline-none focus:border-yellow-500 disabled:bg-gray-50"
            />
          ) : (
            <p className="whitespace-normal break-words font-medium text-gray-900" title={product?.name}>{product?.name ?? 'Товар'}</p>
          )}
          <div className="mt-1 grid min-w-0 gap-1 text-xs text-gray-600 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-2">
            <span className="flex min-w-0 items-center gap-1">
              <span className="font-sans font-semibold uppercase tracking-wide text-gray-400">Арт.</span>
              {canEditPrice && product ? (
                <input
                  key={`sku-${product.sku}`}
                  defaultValue={product.sku}
                  disabled={!isActive}
                  onBlur={(event) => onSetSku(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
                  className="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 font-mono text-xs text-gray-900 outline-none focus:border-yellow-500 disabled:bg-gray-50"
                />
              ) : (
                <span className="min-w-0 break-all font-mono text-gray-800">{product?.sku || 'без SKU'}</span>
              )}
            </span>
            <span className="select-all break-all font-mono text-gray-500">{barcode}</span>
            {product?.storage_bin && <span className="font-semibold text-blue-600 sm:col-span-2">{product.storage_bin}</span>}
          </div>
        </div>
      </div>
      <div>
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-gray-400">Було</span>
        <span className="font-semibold text-gray-800">{item.expected_stock} {unit}</span>
      </div>
      <div>
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-gray-400">Закупка</span>
        {canEditPrice ? (
          <input key={`b-${product?.purchase_price}`} type="number" min="0" step="1" inputMode="decimal"
            defaultValue={purchaseStr} disabled={!isActive}
            onBlur={(event) => onSetPurchase(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
            className="mt-0.5 w-24 rounded-lg border border-gray-300 px-2 py-1 text-right font-semibold outline-none focus:border-blue-500" />
        ) : (
          <span className="font-semibold text-gray-800">{formatMoney(product?.purchase_price ?? 0)}</span>
        )}
      </div>
      <div>
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-gray-400">Продаж</span>
        {canEditPrice ? (
          <input key={`p-${product?.retail_price}`} type="number" min="0" step="1" inputMode="decimal"
            defaultValue={retailStr} disabled={!isActive}
            onBlur={(event) => onSetRetail(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
            className="mt-0.5 w-24 rounded-lg border border-gray-300 px-2 py-1 text-right font-semibold outline-none focus:border-blue-500" />
        ) : (
          <span className="font-semibold text-gray-800">{formatMoney(product?.retail_price ?? 0)}</span>
        )}
      </div>
      <div>
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-gray-400">Факт</span>
        <input key={`q-${item.counted_stock}`} type="number" min="0" step="1" inputMode="numeric"
          defaultValue={String(item.counted_stock)} disabled={!isActive}
          onBlur={(event) => onSetQty(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
          className="mt-0.5 w-20 rounded-lg border border-yellow-300 px-2 py-1 text-center font-bold outline-none focus:border-yellow-500" />
      </div>
      <div className="flex items-center gap-1.5 lg:justify-end">
        {canEditPrice && isActive && (
          <select
            value=""
            title="Розрахувати ціну: за таблицею націнки або швидкий відсоток"
            onChange={(e) => {
              const v = e.target.value
              if (v === 'table') onMarkup('table')
              else if (v) onMarkup('percent', parseFloat(v))
              e.target.value = ''
            }}
            className="w-14 shrink-0 rounded border border-gray-200 bg-white px-1 py-1 text-center text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-yellow-400"
          >
            <option value="">%▾</option>
            <option value="table">За таблицею</option>
            {quickPercents.map((p) => <option key={p} value={p}>{p}%</option>)}
          </select>
        )}
        {product && (
          <button type="button" onClick={onPrintLabel} disabled={labelPrinting} aria-label="Надрукувати етикетки"
            className="rounded-lg bg-yellow-50 p-1.5 text-yellow-700 hover:bg-yellow-100 disabled:opacity-50"><Printer size={14} /></button>
        )}
        {isActive && (
          <button type="button" onClick={onRemove} aria-label="Прибрати"
            className="rounded-lg bg-red-50 p-1.5 text-red-600 hover:bg-red-100"><Trash2 size={14} /></button>
        )}
      </div>
    </div>
  )
}

// Мемоізуємо рядок ревізії: інакше кожне натискання клавіші в батьківському
// компоненті (напр. у вікні створення товару) перемальовувало ВСІ рядки й ввід
// «залипав». Порівнюємо лише значущі поля; функції-обробники ігноруємо — вони
// логічно стабільні (closure над item + стабільними сеттерами стану).
const InventoryRow = memo(InventoryRowBase, (prev, next) =>
  prev.item === next.item &&
  prev.isActive === next.isActive &&
  prev.canEditPrice === next.canEditPrice &&
  prev.selected === next.selected &&
  prev.labelPrinting === next.labelPrinting &&
  prev.highlighted === next.highlighted &&
  prev.quickPercents === next.quickPercents,
)
