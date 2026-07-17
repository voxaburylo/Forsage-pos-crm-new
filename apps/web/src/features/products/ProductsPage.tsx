import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Package, AlertTriangle, Upload, Download,
  ChevronUp, ChevronDown, ChevronsUpDown, Search,
  Trash2, Eye, GitMerge, ExternalLink, Copy, FileText,
} from 'lucide-react'
import { MergeModal } from './MergeModal'
import { CategorySidebar } from './CategorySidebar'
import { ImportModal } from './ImportModal'
import { BulkEditModal } from './BulkEditModal'
import { productApi } from './productApi'
import type { ProductFilters } from './productApi'
import { adminApi } from '@/features/admin/adminApi'
import type { Product, PaginatedProducts } from '@/types/product'
import { kopecksToHryvnia, stockStatus } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Badge, Modal, ConfirmDialog, Drawer, SplitButton } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { useAuthStore } from '@/stores/authStore'
import { getCachedBrands, getCachedCategories, listProductsOffline } from '@/lib/offlineDB'
import { desktopBridge, desktopProductToProduct } from '@/lib/desktopBridge'
import {
  printLabels,
  DEFAULT_LABEL,
  PRODUCT_LABEL_PRESET_OPTIONS,
  PRODUCT_LABEL_PRESET_STORAGE_KEY,
  resolveProductLabelSettings,
  type ProductLabelPresetKey,
} from '@/features/labels/LabelDesigner'

// ─── Типи ────────────────────────────────────────────────────────────────────
interface Category { id: string; name: string; sort_order: number }
interface Brand    { id: string; name: string }
type SortField = 'sku' | 'name' | 'retail_price' | 'qty_on_hand' | 'brand'
type SortDir   = 'asc' | 'desc'

const STATUS_COLOR: Record<string, 'green' | 'orange' | 'red'> = { ok: 'green', low: 'orange', out: 'red' }
const STATUS_LABEL = { ok: 'Є', low: 'Мало', out: 'Нема' }

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

// ─── Іконка сортування ───────────────────────────────────────────────────────
function SortIcon({ field, sort }: { field: SortField; sort: { field: SortField; dir: SortDir } | null }) {
  if (sort?.field !== field) return <ChevronsUpDown size={13} className="text-gray-300 ml-1" />
  return sort.dir === 'asc'
    ? <ChevronUp size={13} className="text-yellow-500 ml-1" />
    : <ChevronDown size={13} className="text-yellow-500 ml-1" />
}

// ─── Заголовок колонки з сортуванням ─────────────────────────────────────────
function SortTh({ field, label, className, sort, onSort }: {
  field: SortField; label: string; className?: string
  sort: { field: SortField; dir: SortDir } | null
  onSort: (f: SortField) => void
}) {
  return (
    <th
      className={`px-3 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide cursor-pointer select-none hover:text-gray-700 ${className ?? ''}`}
      onClick={() => onSort(field)}
    >
      <span className="flex items-center gap-0.5">{label}<SortIcon field={field} sort={sort} /></span>
    </th>
  )
}

// ─── Головна сторінка ─────────────────────────────────────────────────────────
const PRODUCTS_PER_PAGE = 100

export default function ProductsPage() {
  const navigate = useNavigate()
  const session  = useAuthStore((s) => s.session)
  const role     = (session?.user?.user_metadata?.role as string) ?? 'cashier'
  const scopeKey = session?.user?.id ?? ''
  const isAdmin  = ['owner', 'admin'].includes(role)

  const [result, setResult]         = useState<PaginatedProducts | null>(null)
  const [search, setSearch]         = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [lowStock, setLowStock]     = useState(false)
  // Контрольні фільтри власника: мінусові залишки / товари без ціни
  const [stockFilter, setStockFilter] = useState<'' | 'negative' | 'no_price'>('')
  const [page, setPage]             = useState(1)
  // Нескінченний скрол: накопичуємо сторінки по 100 (ключ = номер сторінки),
  // щоб при докручуванні донизу дозавантажувати наступні 100, а не гортати сторінками.
  const [pages, setPages]           = useState<Record<number, Product[]>>({})
  const loadMoreRef                 = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading]       = useState(false)
  const [categoryFilter, setCategoryFilter] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [brandFilter, setBrandFilter] = useState('')
  const [brands, setBrands]         = useState<Brand[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen]     = useState(false)
  const [mergeProduct, setMergeProduct] = useState<Product | null>(null)
  const [quickView, setQuickView] = useState<Product | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [bulkPrintOpen, setBulkPrintOpen] = useState(false)
  const [printLabelPreset, setPrintLabelPreset] = useState<ProductLabelPresetKey>(() => {
    const saved = localStorage.getItem(PRODUCT_LABEL_PRESET_STORAGE_KEY)
    return PRODUCT_LABEL_PRESET_OPTIONS.some((option) => option.value === saved)
      ? saved as ProductLabelPresetKey
      : 'compact_product_4025'
  })
  const [sort, setSort]             = useState<{ field: SortField; dir: SortDir } | null>(null)
  // Інлайн-редагування ціни прямо у списку (без переходу в картку)
  const [editPriceId, setEditPriceId] = useState<string | null>(null)
  const [priceDraft, setPriceDraft]   = useState('')
  const [savingPrice, setSavingPrice] = useState(false)
  const [editBinId, setEditBinId]     = useState<string | null>(null)
  const [binDraft, setBinDraft]       = useState('')
  const [savingBin, setSavingBin]     = useState(false)

  function copyBarcode(barcode: string) {
    navigator.clipboard.writeText(barcode)
      .then(() => toast.success('Штрихкод скопійовано'))
      .catch(() => {})
  }

  function startEditPrice(p: Product) {
    setEditPriceId(p.id)
    setPriceDraft(kopecksToHryvnia(p.retail_price))
  }

  async function saveEditPrice(p: Product) {
    const val = parseFloat(priceDraft.replace(',', '.'))
    if (isNaN(val) || val < 0) { toast.error('Невірна ціна'); setEditPriceId(null); return }
    if (kopecksToHryvnia(p.retail_price) === priceDraft.trim()) { setEditPriceId(null); return }
    setSavingPrice(true)
    try {
      await productApi.update(p.id, { retail_price: String(val) })
      // оновлюємо локально, без перезавантаження списку
      setResult((prev) => prev ? { ...prev, data: prev.data.map((x) => x.id === p.id ? { ...x, retail_price: Math.round(val * 100) } : x) } : prev)
      toast.success('Ціну оновлено')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка збереження')
    } finally {
      setSavingPrice(false)
      setEditPriceId(null)
    }
  }

  // Інлайн-редагування комірки (місця зберігання) прямо у списку
  async function saveEditBin(p: Product) {
    const val = binDraft.trim()
    if ((p.storage_bin ?? '') === val) { setEditBinId(null); return }
    setSavingBin(true)
    try {
      await productApi.update(p.id, { storage_bin: val })
      setResult((prev) => prev ? { ...prev, data: prev.data.map((x) => x.id === p.id ? { ...x, storage_bin: val } : x) } : prev)
      toast.success('Комірку оновлено')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка збереження')
    } finally {
      setSavingBin(false)
      setEditBinId(null)
    }
  }

  // Завантаження категорій та брендів
  const loadMeta = useCallback(async () => {
    if (scopeKey) {
      const [cachedCategories, cachedBrands] = await Promise.all([
        getCachedCategories(scopeKey).catch(() => []),
        getCachedBrands(scopeKey).catch(() => []),
      ])
      if (cachedCategories.length) setCategories(cachedCategories)
      if (cachedBrands.length) setBrands(cachedBrands)
    }
    adminApi.listCategories().then((r) => setCategories(r.data)).catch(() => {})
    adminApi.listBrands().then((r) => setBrands(r.data)).catch(() => {})
  }, [scopeKey])

  useEffect(() => { loadMeta() }, [loadMeta])

  // Debounce пошуку
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350)
    return () => clearTimeout(t)
  }, [search])

  // Завантаження товарів (серверне сортування, крім 'brand' — передається окремо).
  // Пише результат сторінки в мапу pages, щоб накопичувати для нескінченного скролу.
  const load = useCallback(async () => {
    setLoading(true)
    const canUseDesktopCatalog =
      page === 1
      && !lowStock
      && !stockFilter
      && !categoryFilter
      && !brandFilter
      && (!sort || sort.field === 'name')
    const desktopCatalog = canUseDesktopCatalog ? desktopBridge()?.catalog : null
    if (desktopCatalog) {
      try {
        const desktopProducts = (debouncedSearch
          ? await desktopCatalog.searchProducts(debouncedSearch, PRODUCTS_PER_PAGE)
          : await desktopCatalog.listPopular(PRODUCTS_PER_PAGE)
        ).map(desktopProductToProduct)
        setResult({
          data: desktopProducts,
          pagination: {
            page: 1,
            per_page: PRODUCTS_PER_PAGE,
            total: desktopProducts.length,
            total_pages: 1,
          },
        })
        setPages({ 1: desktopProducts })
        setLoading(false)
      } catch {
        // Якщо desktop SQLite ще не готовий, продовжуємо стандартний шлях:
        // IndexedDB → сервер.
      }
    }
    const local = await listProductsOffline({
      search: debouncedSearch || undefined,
      lowStock,
      stockFilter,
      categoryId: categoryFilter || undefined,
      brandId: brandFilter || undefined,
      page,
      perPage: PRODUCTS_PER_PAGE,
      sortField: sort?.field,
      sortDir: sort?.dir,
      scopeKey,
    }).catch(() => null)
    if (local?.data.length || local?.pagination.total) {
      setResult(local as PaginatedProducts)
      setPages((prev) => ({ ...prev, [page]: local!.data }))
      setLoading(false)
    }
    try {
      const serverSortField = sort?.field !== 'brand' ? sort?.field as ProductFilters['sort_field'] : undefined
      const data = await productApi.list({
        search: debouncedSearch || undefined,
        low_stock: lowStock ? 'true' : undefined,
        stock_filter: stockFilter || undefined,
        category_id: categoryFilter || undefined,
        brand_id: brandFilter || undefined,
        page,
        per_page: PRODUCTS_PER_PAGE,
        sort_field: serverSortField,
        sort_dir: sort?.dir,
      })
      setResult(data)
      setPages((prev) => ({ ...prev, [page]: data.data }))
    } catch (e) {
      if (!local?.data.length) toast.error(e instanceof Error ? e.message : 'Помилка завантаження')
    } finally { setLoading(false) }
  }, [debouncedSearch, lowStock, stockFilter, categoryFilter, brandFilter, page, sort, scopeKey])

  useEffect(() => { load() }, [load])
  // Зміна фільтрів/пошуку/сортування — починаємо накопичення заново з 1-ї сторінки
  useEffect(() => { setPage(1); setPages({}) }, [debouncedSearch, lowStock, stockFilter, categoryFilter, brandFilter, sort])

  // Накопичені товари з усіх завантажених сторінок (нескінченний скрол), без дублів
  const accumulated = useMemo(() => {
    const seen = new Set<string>()
    const out: Product[] = []
    for (const key of Object.keys(pages).map(Number).sort((a, b) => a - b)) {
      for (const p of pages[key]) {
        if (!seen.has(p.id)) { seen.add(p.id); out.push(p) }
      }
    }
    return out
  }, [pages])

  // Клієнтське сортування тільки для поля 'brand' (JOIN-колонку не можна сортувати на сервері)
  const products = useMemo(() => {
    const data = accumulated
    if (sort?.field !== 'brand') return data
    return [...data].sort((a, b) => {
      const va = a.brand?.name ?? ''
      const vb = b.brand?.name ?? ''
      return sort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
    })
  }, [accumulated, sort])

  const totalCount = result?.pagination.total ?? 0
  const hasMore = accumulated.length < totalCount

  // Автопідвантаження наступних 100 при докручуванні донизу
  useEffect(() => {
    const node = loadMoreRef.current
    if (!node || !hasMore) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loading && hasMore) {
        setPage((p) => p + 1)
      }
    }, { rootMargin: '400px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loading])

  function toggleSort(field: SortField) {
    setSort((prev) => {
      if (prev?.field !== field) return { field, dir: 'asc' }
      if (prev.dir === 'asc') return { field, dir: 'desc' }
      return null
    })
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const n = new Set(prev)
      if (n.has(id)) {
        n.delete(id)
      } else {
        n.add(id)
      }
      return n
    })
  }

  function toggleSelectAll() {
    const ids = result?.data ?? []
    setSelectedIds(selectedIds.size === ids.length ? new Set() : new Set(ids.map((p) => p.id)))
  }

  const selectedProducts = useMemo(() => {
    return products.filter((p) => selectedIds.has(p.id))
  }, [products, selectedIds])

  const [bulkQtys, setBulkQtys] = useState<Record<string, number>>({})

  useEffect(() => {
    if (bulkPrintOpen) {
      const initial: Record<string, number> = {}
      selectedProducts.forEach((p) => {
        initial[p.id] = 1
      })
      setBulkQtys(initial)
    }
  }, [bulkPrintOpen, selectedProducts])

  async function handleExport() {
    try {
      const { supabase } = await import('@/lib/supabase')
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? ''
      const res = await fetch(`${API_URL}/api/v1/products/export`, { headers: { Authorization: `Bearer ${token}` } })
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = 'products.csv'; a.click()
      URL.revokeObjectURL(url)
    } catch { toast.error('Помилка експорту') }
  }

  // Підтвердження видалення (одиничного або масового)
  const [confirmState, setConfirmState] = useState<
    | null
    | { title: string; message: React.ReactNode; onConfirm: () => Promise<void> }
  >(null)

  function askDelete(product: Product) {
    setConfirmState({
      title: 'Видалити товар',
      message: <>Видалити товар <strong>{product.name}</strong>?</>,
      onConfirm: async () => {
        try { await productApi.delete(product.id); toast.success('Видалено'); load() }
        catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
      },
    })
  }

  function askBulkDelete() {
    const n = selectedIds.size
    setConfirmState({
      title: `Видалити ${n} товарів`,
      message: 'Цю дію не можна скасувати.',
      onConfirm: async () => {
        let done = 0; let failed = 0
        for (const id of selectedIds) {
          try { await productApi.delete(id); done++ }
          catch { failed++ }
        }
        if (done > 0) toast.success(`Видалено ${done} товарів${failed > 0 ? `, помилок: ${failed}` : ''}`)
        else toast.error('Не вдалося видалити')
        setSelectedIds(new Set())
        load()
      },
    })
  }

  const allSelected = !!result?.data.length && selectedIds.size === result.data.length
  const total       = result?.pagination.total ?? 0

  return (
    <Layout
      title={`Товари${total ? ` (${total})` : ''}`}
      actions={
        <div className="flex gap-1.5">
          <span className="hidden md:flex gap-1.5">
            <Button variant="secondary" size="sm" icon={<Upload size={13} />} onClick={() => setImportOpen(true)}>Імпорт каталогу</Button>
            <Button variant="secondary" size="sm" icon={<Download size={13} />} onClick={handleExport}>Експорт</Button>
          </span>
          {['owner', 'admin', 'manager', 'storekeeper'].includes(role) && (
            <Button variant="secondary" size="sm" icon={<FileText size={13} />} onClick={() => navigate('/suppliers/invoices/new')} title="Створити прихідну накладну">
              Прихід
            </Button>
          )}
          <Button size="sm" icon={<Plus size={15} />} onClick={() => navigate('/products/new')} title="Створити одну картку товару">
            Товар
          </Button>
        </div>
      }
    >
      {/* Мобільні фільтр-чіпи (категорії) — тільки на телефоні */}
      {categories.length > 0 && (
        <div className="flex md:hidden gap-1.5 mb-3 overflow-x-auto pb-1">
          <button
            onClick={() => { setCategoryFilter(''); setPage(1) }}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              !categoryFilter ? 'bg-yellow-400 text-black' : 'bg-gray-100 text-gray-600'
            }`}
          >
            Всі
          </button>
          {categories.map((cat) => (
            <button key={cat.id}
              onClick={() => { setCategoryFilter(cat.id); setPage(1) }}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                categoryFilter === cat.id ? 'bg-yellow-400 text-black' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-5 min-h-0">

        {/* ── Ліва колонка: категорії — тільки desktop ── */}
        <div className="hidden md:block sticky top-16 self-start">
          <CategorySidebar
            categories={categories}
            activeCategory={categoryFilter}
            onCategory={(id) => { setCategoryFilter(id); setPage(1) }}
            onReload={loadMeta}
            isAdmin={isAdmin}
          />
        </div>

        {/* ── Права частина: пошук + таблиця ── */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">

          {/* Панель пошуку */}
          <div className="flex gap-2 items-center">
            <div className="relative flex-1 min-w-0">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Пошук за артикулом, назвою, штрихкодом... (oem: для OEM)"
                className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:border-transparent bg-white"
              />
            </div>
            <select
              value={brandFilter}
              onChange={(e) => { setBrandFilter(e.target.value); setPage(1) }}
              aria-label="Фільтр за брендом"
              className="px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 text-gray-700 cursor-pointer"
            >
              <option value="">Всі бренди</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <button onClick={() => { setLowStock(!lowStock); setPage(1) }}
              className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                lowStock ? 'bg-orange-100 border-orange-300 text-orange-700' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
              }`}>
              <AlertTriangle size={14} /> Мало на складі
            </button>
            <button onClick={() => { setStockFilter(stockFilter === 'negative' ? '' : 'negative'); setPage(1) }}
              title="Товари, що пішли в мінус через продаж при нульовому залишку — вирівняйте ревізією"
              className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                stockFilter === 'negative' ? 'bg-red-100 border-red-300 text-red-700' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
              }`}>
              − Мінуси
            </button>
            <button onClick={() => { setStockFilter(stockFilter === 'no_price' ? '' : 'no_price'); setPage(1) }}
              title="Товари з роздрібною ціною 0 грн (ціну не розпізнано при імпорті) — впишіть ціну"
              className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                stockFilter === 'no_price' ? 'bg-amber-100 border-amber-300 text-amber-700' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
              }`}>
              ₴0 Без ціни
            </button>
          </div>

          {/* Bulk toolbar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center justify-between px-4 py-2 bg-yellow-50 border border-yellow-200 rounded-xl">
              <span className="text-sm text-yellow-800 font-medium">Вибрано {selectedIds.size} товарів</span>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setBulkOpen(true)}>✏️ Редагувати</Button>
                <Button size="sm" variant="secondary" onClick={() => setBulkPrintOpen(true)}>🏷️ Друк етикеток</Button>
                {isAdmin && (
                  <Button size="sm" variant="secondary"
                    onClick={askBulkDelete}
                    className="!text-red-600 !border-red-200 hover:!bg-red-50">
                    🗑 Видалити
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => setSelectedIds(new Set())}>✕</Button>
              </div>
            </div>
          )}

          {/* Список */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
            <div className="md:hidden divide-y divide-gray-100">
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="p-3 animate-pulse">
                    <div className="h-4 bg-gray-100 rounded w-3/4 mb-3" />
                    <div className="h-3 bg-gray-100 rounded w-1/2 mb-2" />
                    <div className="h-10 bg-gray-100 rounded" />
                  </div>
                ))
              ) : products.length === 0 ? (
                <div className="text-center py-12">
                  <Package size={36} className="mx-auto text-gray-200 mb-3" />
                  <p className="text-gray-400 text-sm">Товарів не знайдено</p>
                  {search && <p className="text-gray-300 text-xs mt-1">Спробуйте інший запит</p>}
                </div>
              ) : products.map((p) => {
                const stock = stockStatus(p)
                const barcodes = [...new Set([
                  p.barcode,
                  ...(Array.isArray(p.additional_barcodes) ? p.additional_barcodes : []),
                ].filter((value): value is string => Boolean(value)))]
                return (
                  <div key={p.id} className={`p-3 ${selectedIds.has(p.id) ? 'bg-yellow-50/60' : 'bg-white'} ${p.is_active === false ? 'opacity-60' : ''}`}>
                    <div className="flex items-start gap-3">
                      <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleSelect(p.id)}
                        aria-label={`Обрати товар ${p.name}`}
                        className="mt-1 accent-yellow-500 shrink-0" />
                      {p.photo_url ? (
                        <img src={p.photo_url} alt="" className="w-12 h-12 object-cover rounded-lg border border-gray-200 shrink-0" />
                      ) : (
                        <div className="w-12 h-12 bg-gray-100 rounded-lg shrink-0 flex items-center justify-center text-gray-300">
                          <Package size={18} />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <button onClick={() => navigate(`/products/${p.id}`)}
                          className="block w-full text-left text-[15px] font-semibold leading-snug text-gray-900 break-words hover:text-yellow-700">
                          {p.name}
                        </button>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-[11px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">{p.sku}</span>
                          {p.category && <span className="text-[11px] text-gray-400">{p.category.name}</span>}
                          {p.brand?.name && <span className="text-[11px] text-gray-400">{p.brand.name}</span>}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div className="rounded-lg bg-gray-50 border border-gray-100 px-2.5 py-2">
                        <p className="text-[10px] uppercase font-semibold text-gray-400 mb-0.5">Ціна</p>
                        <p className="font-bold text-gray-900 nums-tabular">{kopecksToHryvnia(p.retail_price)} ₴</p>
                      </div>
                      <div className="rounded-lg bg-gray-50 border border-gray-100 px-2.5 py-2 text-right">
                        <p className="text-[10px] uppercase font-semibold text-gray-400 mb-0.5">Залишок</p>
                        <p className={stock === 'out' ? 'text-red-500 font-bold nums-tabular' : stock === 'low' ? 'text-orange-600 font-bold nums-tabular' : 'text-gray-900 font-bold nums-tabular'}>
                          {p.qty_available ?? p.qty_on_hand} {p.unit}
                        </p>
                        {p.qty_reserved !== undefined && p.qty_reserved > 0 && (
                          <p className="text-[10px] text-gray-400 mt-0.5">резерв: {p.qty_reserved}</p>
                        )}
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {barcodes.length > 0 ? barcodes.slice(0, 2).map((barcode) => (
                        <button key={barcode} type="button" onClick={() => copyBarcode(barcode)}
                          className="min-w-0 inline-flex max-w-full items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 font-mono text-[11px] font-semibold text-gray-600">
                          <span className="truncate">{barcode}</span>
                          <Copy size={10} className="shrink-0 opacity-40" />
                        </button>
                      )) : <span className="text-xs text-gray-300">Штрихкоду немає</span>}
                      {p.storage_bin && <span className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-md px-2 py-1">{p.storage_bin}</span>}
                      <Badge color={STATUS_COLOR[stock]}>{STATUS_LABEL[stock]}</Badge>
                    </div>

                    <div className="mt-3 flex gap-2">
                      <Button size="sm" className="flex-1" onClick={() => navigate(`/products/${p.id}/edit`)}>Редагувати</Button>
                      <Button size="sm" variant="secondary" className="flex-1" onClick={() => setQuickView(p)}>Перегляд</Button>
                      {isAdmin && (
                        <Button size="sm" variant="danger-outline" onClick={() => askDelete(p)} aria-label={`Видалити ${p.name}`}>
                          <Trash2 size={13} />
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead className="sticky top-0 z-20 bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-3 py-3 w-10">
                      <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                        aria-label="Обрати всі товари"
                        className="accent-yellow-500 cursor-pointer" />
                    </th>
                    <SortTh field="sku"          label="Артикул"  className="w-32"         sort={sort} onSort={toggleSort} />
                    <th className="w-40 px-3 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">Штрихкод</th>
                    <SortTh field="name"         label="Назва"                             sort={sort} onSort={toggleSort} />
                    <SortTh field="brand"        label="Бренд"    className="w-32"         sort={sort} onSort={toggleSort} />
                    <th className="px-3 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide w-24">Місце</th>
                    <SortTh field="retail_price" label="Ціна"    className="w-28 text-right" sort={sort} onSort={toggleSort} />
                    <SortTh field="qty_on_hand"  label="Залишок" className="w-28 text-right" sort={sort} onSort={toggleSort} />
                    <th className="px-3 py-3 w-20 text-center text-xs font-bold text-gray-500 uppercase tracking-wide">Статус</th>
                    <th className="px-3 py-3 w-44 sticky right-0 bg-gray-50 z-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {loading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="animate-pulse">
                        <td colSpan={10} className="px-3 py-3">
                          <div className="h-4 bg-gray-100 rounded w-full" />
                        </td>
                      </tr>
                    ))
                  ) : products.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="text-center py-16">
                        <Package size={40} className="mx-auto text-gray-200 mb-3" />
                        <p className="text-gray-400 text-sm">Товарів не знайдено</p>
                        {search && <p className="text-gray-300 text-xs mt-1">Спробуйте інший запит</p>}
                      </td>
                    </tr>
                  ) : products.map((p) => {
                    const stock = stockStatus(p)
                    const barcodes = [...new Set([
                      p.barcode,
                      ...(Array.isArray(p.additional_barcodes) ? p.additional_barcodes : []),
                    ].filter((value): value is string => Boolean(value)))]
                    return (
                      <tr key={p.id}
                        className={`group hover:bg-gray-50 transition-colors ${selectedIds.has(p.id) ? 'bg-yellow-50/60' : ''} ${p.is_active === false ? 'opacity-50' : ''}`}>
                        <td className="px-3 py-3 text-center">
                          <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleSelect(p.id)}
                            aria-label={`Обрати товар ${p.name}`}
                            className="accent-yellow-500 cursor-pointer" />
                        </td>
                        <td className="px-3 py-3">
                          <span className="font-mono text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{p.sku}</span>
                        </td>
                        <td className="px-3 py-3">
                          {barcodes.length > 0 ? (
                            <div className="flex max-w-44 flex-wrap gap-1">
                              {barcodes.slice(0, 2).map((barcode) => (
                                <button
                                  key={barcode}
                                  type="button"
                                  onClick={() => copyBarcode(barcode)}
                                  title="Клік — копіювати штрихкод"
                                  className="inline-flex max-w-40 items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-xs font-semibold text-gray-700 hover:border-yellow-300 hover:bg-yellow-50"
                                >
                                  <span className="truncate">{barcode}</span>
                                  <Copy size={11} className="shrink-0 opacity-40" />
                                </button>
                              ))}
                              {barcodes.length > 2 && (
                                <span className="px-1 text-[10px] text-gray-400">+{barcodes.length - 2}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            {p.photo_url ? (
                              <img src={p.photo_url} alt=""
                                className="w-9 h-9 object-cover rounded-lg border border-gray-200 shrink-0" />
                            ) : (
                              <div className="w-9 h-9 bg-gray-100 rounded-lg shrink-0 flex items-center justify-center text-gray-300">
                                <Package size={16} />
                              </div>
                            )}
                            <div>
                              <button onClick={() => navigate(`/products/${p.id}`)}
                                className="font-medium text-gray-900 hover:text-yellow-700 text-left transition-colors text-sm leading-snug">
                                {p.name}
                              </button>
                              {p.category && (
                                <p className="text-xs text-gray-400 mt-0.5">{p.category.name}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-sm text-gray-500">{p.brand?.name ?? '—'}</td>
                        <td className="px-3 py-3">
                          {editBinId === p.id ? (
                            <input
                              type="text" autoFocus
                              value={binDraft}
                              disabled={savingBin}
                              onChange={(e) => setBinDraft(e.target.value)}
                              onBlur={() => saveEditBin(p)}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveEditBin(p); if (e.key === 'Escape') setEditBinId(null) }}
                              placeholder="A-12"
                              className="w-20 border border-yellow-400 rounded px-1.5 py-0.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-yellow-400"
                            />
                          ) : (
                            <button onClick={() => { setEditBinId(p.id); setBinDraft(p.storage_bin ?? '') }} title="Клік — змінити комірку"
                              className="hover:bg-yellow-50 rounded transition-colors cursor-text">
                              {p.storage_bin
                                ? <span className="text-xs text-gray-500 font-mono bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200">📍 {p.storage_bin}</span>
                                : <span className="text-gray-300 text-xs px-1.5 py-0.5">+ комірка</span>}
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right font-bold text-sm text-gray-800 nums-tabular">
                          {editPriceId === p.id ? (
                            <input
                              type="number" min="0" step="0.01" autoFocus
                              value={priceDraft}
                              disabled={savingPrice}
                              onChange={(e) => setPriceDraft(e.target.value)}
                              onBlur={() => saveEditPrice(p)}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveEditPrice(p); if (e.key === 'Escape') setEditPriceId(null) }}
                              className="w-24 border border-yellow-400 rounded px-1.5 py-0.5 text-right text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                            />
                          ) : (
                            <button onClick={() => startEditPrice(p)} title="Клік — змінити ціну"
                              className="hover:bg-yellow-50 rounded px-1.5 py-0.5 transition-colors cursor-text">
                              {kopecksToHryvnia(p.retail_price)} ₴
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right text-sm nums-tabular">
                          <div className="flex flex-col items-end">
                            <div className="flex items-center gap-1">
                              {stock === 'low' && <AlertTriangle size={12} className="text-orange-500 shrink-0" />}
                              <span className={stock === 'out' ? 'text-red-500 font-semibold' : stock === 'low' ? 'text-orange-600 font-semibold' : 'text-gray-700 font-medium'}>
                                {p.qty_available ?? p.qty_on_hand} {p.unit}
                              </span>
                            </div>
                            {p.qty_reserved !== undefined && p.qty_reserved > 0 && (
                              <span className="text-[10px] text-gray-400 font-normal mt-0.5 whitespace-nowrap" title={`Фізично на складі: ${p.qty_on_hand} ${p.unit}`}>
                                резерв: {p.qty_reserved} (фіз: {p.qty_on_hand})
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-center">
                          <Badge color={STATUS_COLOR[stock]}>{STATUS_LABEL[stock]}</Badge>
                        </td>
                        <td className="px-3 py-3 sticky right-0 z-10 bg-white group-hover:bg-gray-50 border-l border-gray-100">
                          <div className="flex items-center justify-end whitespace-nowrap">
                            {isAdmin ? (
                              <SplitButton
                                size="sm"
                                primaryLabel="Ред."
                                onPrimary={() => navigate(`/products/${p.id}/edit`)}
                                actions={[
                                  { label: 'Швидкий перегляд', icon: <Eye size={14} />, onClick: () => setQuickView(p) },
                                  { label: 'Дублювати', icon: <Copy size={14} />, onClick: () => navigate(`/products/new?clone=${p.id}`) },
                                  { label: 'Злити дублі', icon: <GitMerge size={14} />, onClick: () => setMergeProduct(p) },
                                  { label: 'Видалити', icon: <Trash2 size={14} />, danger: true, onClick: () => askDelete(p) },
                                ]}
                              />
                            ) : (
                              <button onClick={() => navigate(`/products/${p.id}/edit`)}
                                className="text-xs px-2 py-1 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors font-medium">Ред.</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Нескінченний скрол: сентинел + лічильник */}
            <div ref={loadMoreRef} />
            {totalCount > 0 && (
              <div className="border-t border-gray-100 px-4 py-3 text-center text-sm text-gray-500 bg-gray-50">
                {hasMore
                  ? (loading ? 'Завантаження...' : `Показано ${accumulated.length} з ${totalCount} — прокрутіть, щоб більше`)
                  : `Показано всі ${totalCount}`}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Модалки */}
      {mergeProduct && (
        <MergeModal product={mergeProduct} onClose={() => setMergeProduct(null)}
          onMerged={() => { setMergeProduct(null); load() }} />
      )}
      {importOpen && (
        <ImportModal onClose={() => setImportOpen(false)} onImported={() => { setImportOpen(false); load() }} />
      )}
      {bulkOpen && (
        <BulkEditModal open={bulkOpen} productIds={Array.from(selectedIds)}
          onClose={() => setBulkOpen(false)}
          onUpdated={() => { setBulkOpen(false); setSelectedIds(new Set()); load() }} />
      )}
      {bulkPrintOpen && (
        <Modal
          open={bulkPrintOpen}
          onClose={() => setBulkPrintOpen(false)}
          title="Друк етикеток для вибраних товарів"
          size="md"
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              Вкажіть кількість копій етикеток для кожного обраного товару. Якщо вказати 0, етикетка для цього товару не друкуватиметься.
            </p>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Розмір етикетки</label>
              <select
                value={printLabelPreset}
                onChange={(e) => {
                  const value = e.target.value as ProductLabelPresetKey
                  setPrintLabelPreset(value)
                  localStorage.setItem(PRODUCT_LABEL_PRESET_STORAGE_KEY, value)
                }}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
              >
                {PRODUCT_LABEL_PRESET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <div className="border border-gray-200 rounded-xl overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs text-gray-500 font-medium">Товар</th>
                    <th className="px-3 py-2 text-center text-xs text-gray-500 font-medium w-24">Кількість</th>
                    <th className="px-4 py-2 text-right text-xs text-gray-500 font-medium w-28">Ціна</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {selectedProducts.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-2">
                        <p className="font-medium text-gray-900 text-sm">{p.name}</p>
                        <p className="text-xs text-gray-400">{p.sku}</p>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          max={999}
                          value={bulkQtys[p.id] ?? 0}
                          onChange={(e) => {
                            const val = Math.max(0, parseInt(e.target.value) || 0)
                            setBulkQtys((prev) => ({ ...prev, [p.id]: val }))
                          }}
                          className="w-full text-center border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
                        />
                      </td>
                      <td className="px-4 py-2 text-right font-medium text-gray-700">
                        {kopecksToHryvnia(p.retail_price)} ₴
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 sm:justify-end pt-2 border-t border-gray-100">
              <Button variant="secondary" onClick={() => setBulkPrintOpen(false)} className="w-full sm:w-auto">Скасувати</Button>
              <Button
                className="w-full sm:w-auto"
                disabled={Object.values(bulkQtys).reduce((sum, q) => sum + q, 0) === 0}
                onClick={async () => {
                  try {
                    const settingsRes = await adminApi.getSettings()
                    const savedSettings = settingsRes.data.label_settings || DEFAULT_LABEL
                    const settings = resolveProductLabelSettings(savedSettings, printLabelPreset)
                    const items = selectedProducts.flatMap((p) => {
                      const qty = bulkQtys[p.id] ?? 0
                      return Array(qty).fill(p)
                    })
                    printLabels(settings as any, items, false)
                    setBulkPrintOpen(false)
                    setSelectedIds(new Set())
                  } catch {
                    toast.error('Помилка друку')
                  }
                }}
              >
                Друкувати ({Object.values(bulkQtys).reduce((sum, q) => sum + q, 0)} шт)
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={confirmState !== null}
        onClose={() => setConfirmState(null)}
        onConfirm={() => confirmState?.onConfirm() ?? Promise.resolve()}
        title={confirmState?.title ?? ''}
        message={confirmState?.message}
        confirmLabel="Видалити"
        danger
      />

      {/* Швидкий перегляд товару — бічна панель, список лишається видимим */}
      <Drawer
        open={quickView !== null}
        onClose={() => setQuickView(null)}
        title={quickView?.name}
        footer={quickView && (
          <div className="flex gap-2">
            <Button className="flex-1" icon={<ExternalLink size={15} />}
              onClick={() => navigate(`/products/${quickView.id}`)}>Відкрити повністю</Button>
            <Button variant="outline" onClick={() => navigate(`/products/${quickView.id}/edit`)}>Редагувати</Button>
          </div>
        )}
      >
        {quickView && (
          <div className="space-y-4">
            {quickView.photo_url && (
              <img src={quickView.photo_url} alt={quickView.name} className="w-full h-44 object-contain rounded-xl bg-gray-50 border border-gray-100" />
            )}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Info label="Артикул" value={quickView.sku} mono />
              <Info label="Штрихкод" value={quickView.barcode || '—'} mono />
              <Info label="Бренд" value={quickView.brand?.name || '—'} />
              <Info label="Категорія" value={quickView.category?.name || '—'} />
              <Info label="Комірка" value={quickView.storage_bin || '—'} mono />
              <Info label="Од." value={quickView.unit} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-0.5">Роздрібна ціна</p>
                <p className="text-xl font-bold text-gray-900 nums-tabular">{kopecksToHryvnia(quickView.retail_price)} ₴</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-0.5">Залишок</p>
                <p className="text-xl font-bold text-gray-900 nums-tabular">{quickView.qty_available ?? quickView.qty_on_hand} {quickView.unit}</p>
              </div>
            </div>
            {quickView.notes && <p className="text-sm text-gray-500 border-t border-gray-100 pt-3">{quickView.notes}</p>}
          </div>
        )}
      </Drawer>
    </Layout>
  )
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
      <p className={`text-gray-800 ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  )
}
