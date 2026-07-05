import { useState, useRef, useEffect, forwardRef, useImperativeHandle, memo } from 'react'
import { Search, Plus, MapPin, Link2, Camera, ShoppingCart, WifiOff, Database } from 'lucide-react'
import { supplierImportsApi } from '@/features/suppliers/supplierImportsApi'
import { api } from '@/lib/api'
import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { usePOSStore } from '@/stores/posStore'
import { toast } from '@/components/ui/Toast'
import { playSuccessBeep, playWarning, initAudio, playErrorTone } from '@/lib/audioService'
import { CameraScanner } from './CameraScanner'
import { findProductByScanOffline, getCachedCategories, getCachedProductsForScan, searchCustomersOffline, searchProductsOffline } from '@/lib/offlineDB'
import { useServerStatus } from '@/hooks/useServerStatus'
import { useAuthStore } from '@/stores/authStore'
function saveRecentItem(key: string, value: string) {
  if (!value) return
  try {
    const raw = localStorage.getItem(key)
    const items: string[] = raw ? JSON.parse(raw) : []
    const next = [value, ...items.filter(i => i !== value)].slice(0, 5)
    localStorage.setItem(key, JSON.stringify(next))
  } catch (err) {
    console.error('Failed to save to localStorage:', err)
  }
}

function getRecentItems(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function findExactScannedProduct(products: any[], code: string): Product | undefined {
  const normalized = code.toLocaleLowerCase('uk-UA').replace(/[\s\-./_]/g, '')
  return products.find((product) => {
    const barcodes = [
      product.barcode,
      ...(Array.isArray(product.additional_barcodes) ? product.additional_barcodes : []),
    ].filter(Boolean).map(String)
    const normalizedSku = String(product.sku ?? '')
      .toLocaleLowerCase('uk-UA')
      .replace(/[\s\-./_]/g, '')
    return barcodes.includes(code) || normalizedSku === normalized
  }) as Product | undefined
}

function addProductToScanIndex(index: Map<string, Product>, product: Product) {
  const barcodes = [
    product.barcode,
    ...(Array.isArray(product.additional_barcodes) ? product.additional_barcodes : []),
  ].filter(Boolean).map((value) => String(value).replace(/[\u0000-\u001f\u007f\s]/g, ''))
  for (const barcode of barcodes) index.set(`barcode:${barcode}`, product)
  const sku = String(product.sku ?? '').replace(/[\s\-./_]/g, '').toUpperCase()
  if (sku) index.set(`sku:${sku}`, product)
}

function findProductInScanIndex(index: Map<string, Product>, code: string): Product | undefined {
  const normalizedSku = code.replace(/[\s\-./_]/g, '').toUpperCase()
  return index.get(`barcode:${code}`) ?? index.get(`sku:${normalizedSku}`)
}


export interface SearchPanelHandle {
  focus: () => void
  clear: () => void
  search: (q: string) => void
  appendSearchText: (text: string) => void
  backspaceSearch: () => void
  openCamera: () => void
  scanBarcode: (code: string) => void
}

const SearchPanelComponent = forwardRef<SearchPanelHandle>((_, ref) => {
  const serverOnline = useServerStatus()
  const scopeKey = useAuthStore((state) => state.session?.user?.id ?? '')
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState<Product[]>([])
  const [supplierResults, setSupplierResults] = useState<any[]>([])
  const [loading, setLoading]   = useState(false)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [analogs, setAnalogs]   = useState<Record<string, { analogs: Product[]; grouped: Record<string, Product[]> }>>({})
  const [analogsLoading, setAnalogsLoading] = useState<string | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [zoomedPhoto, setZoomedPhoto] = useState<string | null>(null)
  const [pricingModalItem, setPricingModalItem] = useState<any | null>(null)
  const [pricingRetailPrice, setPricingRetailPrice] = useState<string>('')
  const [offlineStockVersion, setOfflineStockVersion] = useState(0)
  const inputRef                = useRef<HTMLInputElement>(null)
  const timer                   = useRef<ReturnType<typeof setTimeout>>()
  const searchEpoch             = useRef(0)
  const scanQueue               = useRef<string[]>([])
  const scanQueueRunning        = useRef(false)
  const scanProductIndex        = useRef<Map<string, Product>>(new Map())

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    clear: () => {
      setQuery('')
      setResults([])
      setSupplierResults([])
    },
    search: (q: string) => {
      setQuery(q)
      setResults([])
      setSupplierResults([])
    },
    appendSearchText: (text: string) => {
      setQuery((current) => current + text)
    },
    backspaceSearch: () => {
      setQuery((current) => current.slice(0, -1))
    },
    openCamera: () => setCameraOpen(true),
    scanBarcode: (code: string) => queueBarcodeScan(code),
  }))

  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    let cancelled = false

    const rebuildScanIndex = async () => {
      const products = await getCachedProductsForScan(scopeKey).catch(() => [])
      if (cancelled) return
      const index = new Map<string, Product>()
      for (const product of products as Product[]) {
        addProductToScanIndex(index, product)
      }
      scanProductIndex.current = index
    }

    void rebuildScanIndex()
    window.addEventListener('forsage:offline-products-refreshed', rebuildScanIndex)
    return () => {
      cancelled = true
      window.removeEventListener('forsage:offline-products-refreshed', rebuildScanIndex)
    }
  }, [scopeKey])

  useEffect(() => {
    const refresh = () => setOfflineStockVersion((version) => version + 1)
    window.addEventListener('forsage:offline-stock-updated', refresh)
    return () => window.removeEventListener('forsage:offline-stock-updated', refresh)
  }, [])

  // Load categories dynamically
  useEffect(() => {
    if (serverOnline) {
      api.get<{ data: { id: string; name: string }[] }>('/api/v1/admin/categories', { silent: true })
        .then((res) => setCategories(res.data ?? []))
        .catch(() => {})
    } else if (scopeKey) {
      getCachedCategories(scopeKey).then(setCategories).catch(() => setCategories([]))
    }
  }, [serverOnline, scopeKey])

  // Debounced search
  useEffect(() => {
    clearTimeout(timer.current)
    const epoch = ++searchEpoch.current

    timer.current = setTimeout(async () => {
      setLoading(true)
      try {
        // Офлайн-режим: шукаємо в IndexedDB
        if (!serverOnline) {
          const offlineResults = await searchProductsOffline(query.trim(), 20, scopeKey, categoryFilter)
          if (epoch !== searchEpoch.current) return
          setResults(offlineResults as Product[])
          setSupplierResults([])
          setLoading(false)
          return
        }

        if (categoryFilter) {
          // Fetch products with large limit and filter by category name
          const { data } = await api.get<{ data: Product[] }>(
            `/api/v1/products?search=${encodeURIComponent(query)}&per_page=100`,
            { silent: true },
          )
          if (epoch !== searchEpoch.current) return
          setResults((data ?? []).filter((p) => p.category?.name === categoryFilter))
          setSupplierResults([])
        } else if (query.trim()) {
          const { data } = await api.get<{ data: { warehouse: Product[], supplier_catalog: any[] } }>(
            `/api/v1/search/hybrid?q=${encodeURIComponent(query)}&limit=10`,
            { silent: true },
          )
          if (epoch !== searchEpoch.current) return
          setResults(data?.warehouse || [])
          setSupplierResults(data?.supplier_catalog || [])
        } else {
          // If query is empty and no category filter, load first page of active products
          const res = await api.get<{ data: Product[] }>(
            '/api/v1/products?per_page=50&is_active=true',
            { silent: true },
          )
          if (epoch !== searchEpoch.current) return
          setResults(res.data ?? [])
          setSupplierResults([])
        }
      } catch {
        const offlineResults = await searchProductsOffline(query.trim(), 20, scopeKey, categoryFilter).catch(() => [])
        if (epoch !== searchEpoch.current) return
        setResults(offlineResults as Product[])
        setSupplierResults([])
      } finally { 
        if (epoch === searchEpoch.current) setLoading(false)
      }
    }, 200)
    return () => clearTimeout(timer.current)
  }, [query, categoryFilter, serverOnline, scopeKey, offlineStockVersion])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setQuery('')
      setResults([])
      setSupplierResults([])
      inputRef.current?.blur()
    }
  }

  function queueBarcodeScan(code: string) {
    const normalizedCode = code.replace(/[\u0000-\u001f\u007f\s]/g, '').trim()
    if (!normalizedCode) return
    const immediateProduct = findProductInScanIndex(scanProductIndex.current, normalizedCode)
    if (immediateProduct) {
      addToReceipt(immediateProduct)
      saveRecentItem('recent_scans', normalizedCode)
      return
    }
    scanQueue.current.push(normalizedCode)
    void drainBarcodeQueue()
  }

  async function drainBarcodeQueue() {
    if (scanQueueRunning.current) return
    scanQueueRunning.current = true
    try {
      while (scanQueue.current.length > 0) {
        const code = scanQueue.current.shift()
        if (code) await handleBarcodeScan(code)
      }
    } finally {
      scanQueueRunning.current = false
      // Скан міг потрапити між останньою перевіркою length та finally.
      if (scanQueue.current.length > 0) void drainBarcodeQueue()
    }
  }

  async function handleBarcodeScan(code: string) {
    const normalizedCode = code.replace(/[\u0000-\u001f\u007f\s]/g, '').trim()
    if (!normalizedCode) return
    // Сканер і видимий пошук — незалежні канали. Тут навмисно не змінюємо
    // query/loading/results і не скасовуємо ручний текстовий пошук.

    // Звичайні товари беремо з локального індексу PWA за кілька мілісекунд.
    // Мережа потрібна лише для нового/не кешованого коду або картки клієнта.
    const memoryProduct = findProductInScanIndex(scanProductIndex.current, normalizedCode)
    const cachedProduct = memoryProduct
      ?? await findProductByScanOffline(normalizedCode, scopeKey).catch(() => null)
    if (cachedProduct) {
      addToReceipt(cachedProduct as Product)
      saveRecentItem('recent_scans', normalizedCode)
      return
    }

    if (!serverOnline) {
      const customers = await searchCustomersOffline(normalizedCode, 1, scopeKey)
      const customer = customers[0]
      if (customer) {
        const store = usePOSStore.getState()
        store.setCustomer({
          id: customer.id,
          phone: customer.phone,
          name: customer.full_name ?? null,
          debtBalance: customer.debt_balance ?? 0,
          tierDiscountPct: customer.price_tier?.discount_pct ?? customer.discount_pct ?? 0,
          tierName: customer.price_tier?.name ?? null,
          vipLevel: customer.vip_level ?? 'standard',
          riskProfile: customer.risk_profile ?? 'low',
        })
        store.setAutomaticDiscountPct(customer.price_tier?.discount_pct ?? customer.discount_pct ?? 0)
        toast.success(`Клієнт ${customer.full_name ?? customer.phone} прив'язаний до чека`)
        saveRecentItem('recent_scans', normalizedCode)
        playSuccessBeep()
      } else {
        playErrorTone()
        toast.error('Штрих-код не знайдено в офлайн-кеші')
      }
      return
    }
    try {
      const res = await api.get<any>(
        `/api/v1/search/barcode/${encodeURIComponent(normalizedCode)}`,
        { silent: true, timeoutMs: 5_000 },
      )
      const result = typeof res === 'object' && 'data' in res ? (res as any).data : res
      if (result?.type === 'customer' && result?.data) {
        const c = result.data
        const store = usePOSStore.getState()
        store.setCustomer({
          id: c.id, phone: c.phone, name: c.full_name ?? null,
          debtBalance: c.debt_balance ?? 0, tierDiscountPct: c.price_tier?.discount_pct ?? 0,
          tierName: c.price_tier?.name ?? null,
          vipLevel: c.vip_level ?? 'standard', riskProfile: c.risk_profile ?? 'low',
        })
        store.setAutomaticDiscountPct(c.price_tier?.discount_pct ?? 0)
        toast.success(`Клієнт ${c.full_name ?? c.phone} прив'язаний до чека`)
        saveRecentItem('recent_scans', normalizedCode)
        playSuccessBeep()
      } else if (result?.type === 'product' && result?.data) {
        addProductToScanIndex(scanProductIndex.current, result.data as Product)
        addToReceipt(result.data)
        saveRecentItem('recent_scans', normalizedCode)
      } else {
        playErrorTone()
        toast.error('Штрих-код не знайдено в базі')
      }
    } catch {
      const offlineResults = await searchProductsOffline(normalizedCode, 20, scopeKey).catch(() => [])
      // Штрихкод має збігатися точно. Ніколи не додаємо перший текстовий
      // результат: при швидкому скануванні це збільшувало кількість попереднього товару.
      const fallback = findExactScannedProduct(offlineResults, normalizedCode)
      if (fallback) {
        addToReceipt(fallback as Product)
      } else {
        playErrorTone()
        toast.error('Товар або клієнт не знайдено')
      }
    }
  }

  async function fetchAnalogs(productId: string) {
    if (analogs[productId]) return
    setAnalogsLoading(productId)
    try {
      const { data } = await api.get<any>(`/api/v1/products/${productId}/analogs`)
      const list: Product[] = Array.isArray(data) ? data : data?.analogs ?? data?.data ?? []
      const grouped: Record<string, Product[]> = data?.grouped ?? { standard: list }
      setAnalogs((prev) => ({ ...prev, [productId]: { analogs: list, grouped } }))
    } catch { setAnalogs((prev) => ({ ...prev, [productId]: { analogs: [], grouped: {} } })) }
    finally { setAnalogsLoading(null) }
  }

  function addToReceipt(p: Product) {
    initAudio()
    const store = usePOSStore.getState()

    const tierPct = store.automaticDiscountPct
    const discount = tierPct > 0
      ? Math.round(p.retail_price * tierPct / 100)
      : 0

    const qtyAvailable = p.qty_available ?? p.qty_on_hand
    const existingQty = store.items
      .filter((i) => i.productId === p.id)
      .reduce((s, i) => s + i.qty, 0)
    const newTotalQty = existingQty + 1
    const lowStock = !p.is_service && qtyAvailable < newTotalQty

    if (lowStock) {
      if (qtyAvailable <= 0) {
        toast.warning('Недостатньо на складі: ' + p.name + ' (немає в наявності)')
      } else {
        toast.warning('Недостатньо на складі: ' + p.name + ' (доступно ' + qtyAvailable + ' ' + p.unit + ')')
      }
      playWarning()
    } else {
      playSuccessBeep()
    }

    store.addItem({
      productId: p.id,
      sku:       p.sku,
      name:      p.name,
      unit:      p.unit,
      qty:       1,
      unitPrice: p.retail_price,
      discount,
      discountPct: tierPct > 0 ? tierPct : undefined,
      qtyOnHand: qtyAvailable,
      requiresCoreReturn: p.requires_core_return,
      coreDepositAmount: p.core_deposit_amount,
    })
    // Після вибору товару клавіатура знову належить сканеру.
    inputRef.current?.blur()
  }

  function openPricingModal(sItem: any) {
    const purchase = sItem.price_kopecks / 100
    const val = Math.round(purchase * 1.3)
    setPricingRetailPrice(String(val))
    setPricingModalItem(sItem)
  }

  async function handleImportConfirm() {
    if (!pricingModalItem) return
    const retailVal = parseFloat(pricingRetailPrice)
    if (isNaN(retailVal) || retailVal <= 0) {
      toast.error('Будь ласка, введіть коректну ціну')
      return
    }

    setImportingId(pricingModalItem.id)
    try {
      const res = await supplierImportsApi.importOnDemand({
        sku: pricingModalItem.sku,
        brand: pricingModalItem.brand || '',
        name: pricingModalItem.name,
        supplier_id: pricingModalItem.supplier?.id || null,
        purchase_price: pricingModalItem.price_kopecks,
        retail_price: Math.round(retailVal * 100)
      })
      if (res.data) {
        addToReceipt(res.data)
        setQuery('')
        setResults([])
        setSupplierResults([])
        setPricingModalItem(null)
      }
    } catch (err: any) {
      toast.error(err.message || 'Не вдалося імпортувати товар')
    } finally {
      setImportingId(null)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-[#1A1A1A] p-3 md:p-4">
      {/* Офлайн-індикатор */}
      {!serverOnline && (
        <div className="mb-2 px-3 py-1.5 bg-red-900/30 rounded-lg flex items-center gap-2 text-red-300 text-xs">
          <WifiOff size={12} /> Офлайн — пошук по кешу
        </div>
      )}

      {/* Поле пошуку */}
      <div className="relative mb-3 flex gap-2 shrink-0">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 md:size-[20px] size-[18px]" />
          <input ref={inputRef} type="text" value={query} data-pos-search="true"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Натисніть тут для пошуку товару"
            className={`w-full bg-[#2C2C2C] text-white placeholder-gray-500 pl-10 pr-4 rounded-xl text-sm md:text-base font-medium border-2 focus:outline-none focus:ring-2 focus:ring-yellow-400/20 md:min-h-[50px] min-h-[44px] ${
              serverOnline ? 'border-gray-700 focus:border-yellow-400' : 'border-red-700/50 focus:border-red-400'
            }`}
          />
        </div>
        <button onClick={() => setCameraOpen(true)}
          className="bg-[#2C2C2C] hover:bg-gray-700 active:bg-gray-600 text-white rounded-xl flex items-center justify-center transition-all border-2 border-gray-700 hover:border-yellow-400/50 md:w-[50px] md:h-[50px] w-[44px] h-[44px] shrink-0"
          title="Сканувати камерою (F8)">
          <Camera size={20} />
        </button>
      </div>

      <CameraScanner open={cameraOpen} onClose={() => setCameraOpen(false)}
        onScan={(code) => { setCameraOpen(false); queueBarcodeScan(code) }} />

      {/* Нещодавні скани */}
      {query === '' && getRecentItems('recent_scans').length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3 px-1 items-center shrink-0">
          <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Нещодавні скани:</span>
          {getRecentItems('recent_scans').map(code => (
            <button
              key={code}
              type="button"
              onClick={() => { queueBarcodeScan(code) }}
              className="text-[10px] bg-[#2C2C2C] hover:bg-[#3C3C3C] text-gray-300 border border-gray-700 px-2.5 py-1 rounded-full transition font-mono"
            >
              {code}
            </button>
          ))}
        </div>
      )}

      {/* Фільтр категорій */}
      <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1.5 scrollbar-none shrink-0">
        <button onClick={() => setCategoryFilter(null)}
          className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap transition-all border ${
            !categoryFilter
              ? 'bg-yellow-500 text-black border-yellow-500'
              : 'bg-gray-800/60 text-gray-400 border-gray-700/50 hover:bg-gray-700/50'
          }`}>
          🏠 Все
        </button>
        {categories.map((cat) => {
          const isActive = categoryFilter === cat.name
          return (
            <button key={cat.id} onClick={() => setCategoryFilter(isActive ? null : cat.name)}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap transition-all border ${
                isActive
                  ? 'bg-yellow-500 text-black border-yellow-500'
                  : 'bg-gray-800/60 text-gray-400 border-gray-700/50 hover:bg-gray-700/50'
              }`}>
              {cat.name}
            </button>
          )
        })}
      </div>

      {/* Результати */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden space-y-4 pr-0.5 scrollbar-thin">
        {loading && (
          <p className="text-gray-500 text-sm text-center py-8">Пошук...</p>
        )}

        {!loading && results.length === 0 && supplierResults.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-8">Нічого не знайдено</p>
        )}

        {/* Секція: На нашому складі */}
        {results.length > 0 && (
          <div className="space-y-2">
            {query.trim() && (
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-1">
                📦 На нашому складі ({results.length})
              </p>
            )}
            {results.map((p, idx) => {
              const storageBin = p.storage_bin
              const productAnalogsData = analogs[p.id]
              const productAnalogs = productAnalogsData?.analogs ?? []
              const groupedAnalogs = productAnalogsData?.grouped ?? {}
              const showAnalogs = !p.is_service && (p.qty_available ?? p.qty_on_hand) <= 0
              return (
                <div key={p.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => { addToReceipt(p); setQuery(''); setResults([]); setSupplierResults([]) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addToReceipt(p); setQuery(''); setResults([]); setSupplierResults([]) } }}
                    className={`block w-full text-left p-4 rounded-xl border-2 transition-all cursor-pointer active:scale-[0.98] active:bg-gray-700/50 ${
                      idx === 0
                        ? 'bg-[#2C2C2C] border-yellow-400/50 hover:border-yellow-400'
                        : 'bg-[#242424] border-gray-700 hover:border-gray-500'
                    }`}
                    style={{ minHeight: 80 }}
                  >
                    <div className="flex items-start justify-between gap-4">
                      {p.photo_url && (
                        <div className="shrink-0 relative self-center" onClick={(e) => e.stopPropagation()}>
                          <img
                            src={p.photo_url}
                            alt={p.name}
                            onClick={() => setZoomedPhoto(p.photo_url)}
                            className="w-12 h-12 md:w-14 md:h-14 rounded-lg object-cover border border-gray-700 cursor-zoom-in hover:border-yellow-400 transition-all hover:scale-105 active:scale-95 shadow-sm"
                          />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-mono text-yellow-400 text-xs">{p.sku}</span>
                          {p.category?.name === 'Кава та напої' && <span className="text-xs">☕</span>}
                          {p.category?.name === 'Снеки та хотдоги' && <span className="text-xs">🌭</span>}
                        </div>
                        <p className="text-white text-sm font-medium leading-tight line-clamp-2">{p.name}</p>
                        {p.brand && <p className="text-gray-500 text-xs mt-0.5">{p.brand.name}</p>}
                        {storageBin && (
                          <p className="flex items-center gap-1 text-gray-500 text-xs mt-1">
                            <MapPin size={12} />
                            {storageBin}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-white font-bold text-xl">{kopecksToHryvnia(p.retail_price)} ₴</p>
                        {p.is_service ? (
                          <p className="text-xs mt-0.5 text-blue-400 flex items-center gap-1 justify-end">
                            <ShoppingCart size={12} /> ∞ сервіс
                          </p>
                        ) : (
                          <>
                            <p className={`text-xs mt-0.5 flex items-center gap-1 justify-end ${
                              (p.qty_available ?? p.qty_on_hand) <= 0 ? 'text-red-400' :
                              (p.qty_available ?? p.qty_on_hand) <= p.reorder_point ? 'text-orange-400' : 'text-green-400'
                            }`}>
                              <ShoppingCart size={12} />
                              {(p.qty_available ?? p.qty_on_hand) <= 0 ? '✗ Нема' : `● ${(p.qty_available ?? p.qty_on_hand)} ${p.unit}`}
                            </p>
                            {p.qty_reserved !== undefined && p.qty_reserved > 0 && (
                              <p className="text-gray-400 text-[10px] mt-0.5 font-medium">
                                резерв: {p.qty_reserved} {p.unit} (фіз: {p.qty_on_hand})
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {idx === 0 && (
                      <div className="flex items-center gap-1 mt-2 text-yellow-400/60 text-xs">
                        <Plus size={12} />
                        <span>Enter щоб додати</span>
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-1.5">
                      <button onClick={(e) => { e.stopPropagation(); fetchAnalogs(p.id) }}
                        className="text-gray-500 hover:text-yellow-400 text-xs flex items-center gap-1 transition-colors px-2 py-1.5 rounded-lg hover:bg-gray-700 touch-target">
                        <Link2 size={12} /> Аналоги
                      </button>
                    </div>
                  </div>

                  {/* Аналоги для товарів без залишку */}
                  {showAnalogs && analogsLoading !== p.id && productAnalogs.length === 0 && (
                    <div className="ml-4 mt-1 mb-2">
                      <button onClick={() => fetchAnalogs(p.id)}
                        className="text-orange-400 text-xs flex items-center gap-1 hover:text-orange-300 transition-colors touch-target px-3 py-2 rounded-lg">
                        ⚠️ Немає в наявності — шукати аналоги
                      </button>
                    </div>
                  )}
                  {analogsLoading === p.id && (
                    <p className="text-gray-500 text-xs text-center py-2">Пошук аналогів...</p>
                  )}
                  {productAnalogsData && Object.keys(groupedAnalogs).length > 0 && productAnalogs.length > 0 && (
                    <div className="mx-3 mb-3 p-3 bg-[#161616]/60 border border-gray-800 rounded-xl space-y-3">
                      <p className="text-yellow-400 text-[10px] font-bold uppercase tracking-wider">🔗 Аналоги та кроси:</p>
                      {Object.entries(groupedAnalogs).map(([tier, items]) => {
                        const typedItems = items as Product[]
                        if (!typedItems || typedItems.length === 0) return null
                        
                        const tierTitle = 
                          tier === 'original' ? '🏭 Оригінал' :
                          tier === 'premium' ? '⭐ Premium' :
                          tier === 'standard' ? '✅ Standard' : '💵 Budget'

                        const tierColor =
                          tier === 'original' ? 'text-blue-400 border-blue-900/30 bg-blue-950/20' :
                          tier === 'premium' ? 'text-yellow-400 border-yellow-950/30 bg-yellow-950/20' :
                          tier === 'standard' ? 'text-gray-300 border-gray-800 bg-gray-900/30' : 'text-emerald-400 border-emerald-950/30 bg-emerald-950/20'

                        return (
                          <div key={tier} className="space-y-1.5">
                            <div className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${tierColor} inline-block`}>
                              {tierTitle}
                            </div>
                            <div className="space-y-1 pl-1">
                              {typedItems.map((a) => (
                                <button key={a.id} onClick={(e) => { e.stopPropagation(); addToReceipt(a); setQuery(''); setResults([]); setSupplierResults([]) }}
                                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-yellow-500/10 transition-colors active:scale-[0.98] border border-gray-800/45 hover:border-yellow-500/30 bg-gray-950/20"
                                  style={{ minHeight: 48 }}>
                                  {a.photo_url && (
                                    <div className="shrink-0 mr-2" onClick={(e) => e.stopPropagation()}>
                                      <img
                                        src={a.photo_url}
                                        alt={a.name}
                                        onClick={() => setZoomedPhoto(a.photo_url)}
                                        className="w-8 h-8 rounded-md object-cover border border-gray-800 cursor-zoom-in hover:scale-105 active:scale-95"
                                      />
                                    </div>
                                  )}
                                  <div className="flex-1 min-w-0 text-left">
                                    <p className="text-white text-xs font-medium truncate">{a.name}</p>
                                    <p className="text-gray-500 text-[10px]">{a.sku} {a.brand && `• ${a.brand.name}`}</p>
                                  </div>
                                  <div className="text-right shrink-0 ml-2">
                                    <p className="text-white text-xs font-semibold">{kopecksToHryvnia(a.retail_price)} ₴</p>
                                    <p className={`text-xs ${(a.qty_available ?? a.qty_on_hand) > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                      {(a.qty_available ?? a.qty_on_hand) > 0 ? `● ${(a.qty_available ?? a.qty_on_hand)}` : '✗ Нема'}
                                    </p>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Секція: У прайсах постачальників */}
        {!loading && supplierResults.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-gray-800/60">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-1 flex items-center gap-1.5">
              <Database size={12} className="text-yellow-400" />
              <span>🚚 У прайсах постачальників ({supplierResults.length})</span>
            </p>
            {supplierResults.map((sItem) => {
              const isImporting = importingId === sItem.id
              return (
                <button
                  key={sItem.id}
                  onClick={() => openPricingModal(sItem)}
                  disabled={isImporting}
                  className="w-full text-left bg-[#242424] hover:bg-gray-800 border border-gray-700/50 rounded-xl p-4 flex items-center justify-between transition-all active:scale-[0.98] disabled:opacity-50"
                  style={{ minHeight: 80 }}
                >
                  <div className="flex-1 min-w-0 pr-4">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-yellow-500 text-xs font-semibold">{sItem.sku}</span>
                      {sItem.brand && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 font-medium">
                          {sItem.brand}
                        </span>
                      )}
                    </div>
                    <p className="text-white text-sm font-medium leading-tight line-clamp-2">{sItem.name}</p>
                    <p className="text-gray-500 text-xs mt-1">
                      Постачальник: {sItem.supplier?.name || '—'} {sItem.warehouse_name ? `(${sItem.warehouse_name})` : ''} • Кількість: {sItem.qty || '0'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-white font-bold text-xl">
                      {(sItem.price_kopecks / 100).toFixed(2)} ₴
                    </p>
                    <span className="text-[10px] text-yellow-400/80 block mt-1.5 font-medium">
                      {isImporting ? 'Імпорт...' : '➕ Замовити'}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Модальне вікно встановлення ціни для замовного товару */}
      {pricingModalItem && (
        <div className="fixed inset-0 z-[160] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#242424] border border-gray-800 rounded-2xl max-w-md w-full p-6 shadow-2xl animate-scale-up">
            <h3 className="text-white text-lg font-bold mb-2">💰 Ціноутворення та імпорт</h3>
            <p className="text-gray-400 text-xs mb-4">
              Вкажіть роздрібну ціну для товару: <strong className="text-yellow-400">{pricingModalItem.name}</strong> ({pricingModalItem.sku})
            </p>

            <div className="space-y-4">
              <div>
                <span className="block text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-1">Ціна закупівлі</span>
                <div className="text-white text-lg font-semibold bg-[#1A1A1A] px-3 py-2 rounded-lg border border-gray-800/80">
                  {(pricingModalItem.price_kopecks / 100).toFixed(2)} ₴
                </div>
              </div>

              <div>
                <label className="block text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-1">
                  Ціна продажу (роздрібна), ₴
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={pricingRetailPrice}
                  onChange={(e) => setPricingRetailPrice(e.target.value)}
                  className="w-full bg-[#1A1A1A] border border-gray-700 focus:border-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-400 text-white rounded-lg px-3 py-2 text-lg font-bold transition"
                  placeholder="0.00"
                  autoFocus
                />
              </div>

              {/* Швидкі націнки */}
              <div>
                <span className="block text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-1.5">
                  Швидка націнка
                </span>
                <div className="flex flex-wrap gap-2">
                  {[10, 20, 30, 40, 50].map((pct) => {
                    const purchase = pricingModalItem.price_kopecks / 100
                    const val = Math.round(purchase * (1 + pct / 100))
                    return (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => setPricingRetailPrice(String(val))}
                        className="text-[10px] font-semibold bg-[#2C2C2C] hover:bg-yellow-500 hover:text-black border border-gray-700 px-2.5 py-1.5 rounded-lg text-gray-300 transition active:scale-95"
                      >
                        +{pct}% ({val} ₴)
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Інформація про маржу */}
              {(() => {
                const retail = parseFloat(pricingRetailPrice)
                const purchase = pricingModalItem.price_kopecks / 100
                if (!isNaN(retail) && retail > 0) {
                  const profit = retail - purchase
                  const pct = purchase > 0 ? (profit / purchase) * 100 : 0
                  return (
                    <div className="bg-[#2C2C2C]/50 border border-gray-800 rounded-xl p-3 flex justify-between text-xs">
                      <span className="text-gray-400">Чистий прибуток:</span>
                      <span className={`font-bold ${profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {profit.toFixed(2)} ₴ ({pct.toFixed(0)}%)
                      </span>
                    </div>
                  )
                }
                return null
              })()}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setPricingModalItem(null)}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-white font-semibold py-2 rounded-xl transition text-sm active:scale-95"
                >
                  Скасувати
                </button>
                <button
                  type="button"
                  onClick={handleImportConfirm}
                  disabled={importingId === pricingModalItem.id}
                  className="flex-1 bg-yellow-500 hover:bg-yellow-400 text-black font-semibold py-2 rounded-xl transition text-sm active:scale-95 disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {importingId === pricingModalItem.id ? (
                    <>
                      <span>Імпорт...</span>
                    </>
                  ) : (
                    <>
                      <span>Імпортувати</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Лайтбокс для збільшення фотографії (ненав'язливий і простий) */}
      {zoomedPhoto && (
        <div 
          className="fixed inset-0 z-[150] bg-black/90 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setZoomedPhoto(null)}
        >
          <div className="relative max-w-full max-h-full flex items-center justify-center">
            <img 
              src={zoomedPhoto} 
              alt="Збільшене зображення товару" 
              className="max-w-[90vw] max-h-[85vh] rounded-2xl border border-gray-800 shadow-2xl object-contain animate-slide-up"
            />
            <button 
              onClick={() => setZoomedPhoto(null)}
              className="absolute -top-12 right-0 text-white/70 hover:text-white bg-gray-800/60 hover:bg-gray-700/80 w-10 h-10 rounded-full flex items-center justify-center text-xl transition-all"
            >
              &times;
            </button>
          </div>
        </div>
      )}
    </div>
  )
})

SearchPanelComponent.displayName = 'SearchPanel'

// Зміни корзини не повинні перемальовувати великий каталог результатів.
export const SearchPanel = memo(SearchPanelComponent)
