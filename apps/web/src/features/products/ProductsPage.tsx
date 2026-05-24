import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Package, AlertTriangle, Upload, Download,
  ChevronUp, ChevronDown, ChevronsUpDown, Search,
  Tag, Pencil, Trash2, Check, X, FolderOpen,
} from 'lucide-react'
import { MergeModal } from './MergeModal'
import { ImportModal } from './ImportModal'
import { BulkEditModal } from './BulkEditModal'
import { productApi } from './productApi'
import type { ProductFilters } from './productApi'
import { adminApi } from '@/features/admin/adminApi'
import type { Product, PaginatedProducts } from '@/types/product'
import { kopecksToHryvnia, stockStatus } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Badge, Modal, ConfirmDialog } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { useAuthStore } from '@/stores/authStore'
import { printLabels, DEFAULT_LABEL } from '@/features/labels/LabelDesigner'

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

// ─── Ліва панель категорій ────────────────────────────────────────────────────
function CategorySidebar({
  categories, brands,
  activeCategory, activeBrand,
  onCategory, onBrand,
  onReload, isAdmin,
}: {
  categories: Category[]
  brands: Brand[]
  activeCategory: string
  activeBrand: string
  onCategory: (id: string) => void
  onBrand: (id: string) => void
  onReload: () => void
  isAdmin: boolean
}) {
  const [newCatName, setNewCatName]         = useState('')
  const [addingCat, setAddingCat]           = useState(false)
  const [savingCat, setSavingCat]           = useState(false)
  const [editingId, setEditingId]           = useState<string | null>(null)
  const [editName, setEditName]             = useState('')
  const [showAllBrands, setShowAllBrands]   = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (addingCat) inputRef.current?.focus() }, [addingCat])

  async function handleAddCat() {
    if (!newCatName.trim()) return
    setSavingCat(true)
    try {
      await adminApi.createCategory(newCatName.trim())
      setNewCatName(''); setAddingCat(false)
      onReload(); toast.success('Категорію додано')
    } catch { toast.error('Помилка') }
    finally { setSavingCat(false) }
  }

  async function handleRenameCat(id: string) {
    if (!editName.trim()) return
    try {
      await adminApi.updateCategory(id, editName.trim())
      setEditingId(null)
      onReload(); toast.success('Перейменовано')
    } catch { toast.error('Помилка') }
  }

  async function handleDeleteCat(cat: Category) {
    if (!confirm(`Видалити категорію "${cat.name}"? Товари залишаться без категорії.`)) return
    try {
      await adminApi.deleteCategory(cat.id)
      if (activeCategory === cat.id) onCategory('')
      onReload(); toast.success('Видалено')
    } catch { toast.error('Помилка') }
  }

  const visibleBrands = showAllBrands ? brands : brands.slice(0, 10)

  return (
    <div className="w-52 shrink-0 flex flex-col gap-4 overflow-y-auto pr-1">

      {/* Категорії */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <Tag size={12} /> Категорії
          </span>
          {isAdmin && (
            <div className="flex items-center gap-0.5">
              <button onClick={() => setAddingCat(!addingCat)}
                className="text-yellow-500 hover:text-yellow-600 p-0.5 rounded transition-colors" title="Додати категорію">
                <Plus size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Форма нової категорії */}
        {addingCat && (
          <div className="flex gap-1 mb-2">
            <input ref={inputRef} value={newCatName} onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddCat(); if (e.key === 'Escape') setAddingCat(false) }}
              placeholder="Назва категорії"
              className="flex-1 text-xs border border-yellow-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-yellow-300" />
            <button onClick={handleAddCat} disabled={savingCat}
              className="text-green-600 hover:text-green-700 p-1"><Check size={14} /></button>
            <button onClick={() => { setAddingCat(false); setNewCatName('') }}
              className="text-gray-400 hover:text-gray-600 p-1"><X size={14} /></button>
          </div>
        )}

        {/* Всі товари */}
        <button onClick={() => onCategory('')}
          className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2 mb-0.5 ${
            !activeCategory ? 'bg-yellow-50 text-yellow-700 font-semibold border border-yellow-200' : 'text-gray-600 hover:bg-gray-100'
          }`}>
          <FolderOpen size={14} className="shrink-0" />
          <span className="truncate">Всі товари</span>
        </button>

        {/* Список категорій */}
        <div className="space-y-0.5">
          {categories.map((cat) => (
            <div key={cat.id} className="group relative">
              {editingId === cat.id ? (
                <div className="flex gap-1 py-0.5">
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRenameCat(cat.id); if (e.key === 'Escape') setEditingId(null) }}
                    className="flex-1 text-xs border border-yellow-300 rounded px-2 py-1 focus:outline-none" />
                  <button onClick={() => handleRenameCat(cat.id)} className="text-green-500"><Check size={13} /></button>
                  <button onClick={() => setEditingId(null)} className="text-gray-400"><X size={13} /></button>
                </div>
              ) : (
                /* Використовуємо <div> замість <button> щоб уникнути вкладених <button> — порушення HTML-специфікації */
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onCategory(cat.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onCategory(cat.id) }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2 cursor-pointer ${
                    activeCategory === cat.id ? 'bg-yellow-50 text-yellow-700 font-semibold border border-yellow-200' : 'text-gray-600 hover:bg-gray-100'
                  }`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-300 shrink-0 mt-px" />
                  <span className="flex-1 truncate">{cat.name}</span>
                  {isAdmin && (
                    <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingId(cat.id); setEditName(cat.name) }}
                        className="text-gray-400 hover:text-blue-500 p-0.5 rounded"
                        aria-label="Перейменувати">
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteCat(cat) }}
                        className="text-gray-400 hover:text-red-500 p-0.5 rounded"
                        aria-label="Видалити">
                        <Trash2 size={11} />
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Бренди */}
      {brands.length > 0 && (
        <div>
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Package size={12} /> Бренди
          </p>
          <button onClick={() => onBrand('')}
            className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm transition-colors mb-0.5 ${
              !activeBrand ? 'bg-yellow-50 text-yellow-700 font-semibold border border-yellow-200' : 'text-gray-600 hover:bg-gray-100'
            }`}>
            Всі бренди
          </button>
          <div className="space-y-0.5">
            {visibleBrands.map((b) => (
              <button key={b.id} onClick={() => onBrand(b.id)}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm transition-colors truncate ${
                  activeBrand === b.id ? 'bg-yellow-50 text-yellow-700 font-semibold border border-yellow-200' : 'text-gray-600 hover:bg-gray-100'
                }`}>
                {b.name}
              </button>
            ))}
          </div>
          {brands.length > 10 && (
            <button onClick={() => setShowAllBrands(!showAllBrands)}
              className="text-xs text-blue-500 hover:text-blue-700 mt-1 px-2.5">
              {showAllBrands ? 'Сховати' : `Ще ${brands.length - 10}...`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Головна сторінка ─────────────────────────────────────────────────────────
export default function ProductsPage() {
  const navigate = useNavigate()
  const session  = useAuthStore((s) => s.session)
  const role     = (session?.user?.user_metadata?.role as string) ?? 'cashier'
  const isAdmin  = ['owner', 'admin'].includes(role)
  const isOwner  = role === 'owner'

  const [result, setResult]         = useState<PaginatedProducts | null>(null)
  const [search, setSearch]         = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [lowStock, setLowStock]     = useState(false)
  const [page, setPage]             = useState(1)
  const [loading, setLoading]       = useState(false)
  const [categoryFilter, setCategoryFilter] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [brandFilter, setBrandFilter] = useState('')
  const [brands, setBrands]         = useState<Brand[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen]     = useState(false)
  const [mergeProduct, setMergeProduct] = useState<Product | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [bulkPrintOpen, setBulkPrintOpen] = useState(false)
  const [sort, setSort]             = useState<{ field: SortField; dir: SortDir } | null>(null)

  // Завантаження категорій та брендів
  const loadMeta = useCallback(() => {
    adminApi.listCategories().then((r) => setCategories(r.data)).catch(() => {})
    adminApi.listBrands().then((r) => setBrands(r.data)).catch(() => {})
  }, [])

  useEffect(() => { loadMeta() }, [loadMeta])

  // Debounce пошуку
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350)
    return () => clearTimeout(t)
  }, [search])

  // Завантаження товарів (серверне сортування, крім 'brand' — передається окремо)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const serverSortField = sort?.field !== 'brand' ? sort?.field as ProductFilters['sort_field'] : undefined
      const data = await productApi.list({
        search: debouncedSearch || undefined,
        low_stock: lowStock ? 'true' : undefined,
        category_id: categoryFilter || undefined,
        brand_id: brandFilter || undefined,
        page,
        per_page: 25,
        sort_field: serverSortField,
        sort_dir: sort?.dir,
      })
      setResult(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка завантаження')
    } finally { setLoading(false) }
  }, [debouncedSearch, lowStock, categoryFilter, brandFilter, page, sort])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [debouncedSearch, lowStock, categoryFilter, brandFilter, sort])

  // Клієнтське сортування тільки для поля 'brand' (JOIN-колонку не можна сортувати на сервері)
  const products = useMemo(() => {
    const data = result?.data ?? []
    if (sort?.field !== 'brand') return data
    return [...data].sort((a, b) => {
      const va = a.brand?.name ?? ''
      const vb = b.brand?.name ?? ''
      return sort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
    })
  }, [result, sort])

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
  const totalPages  = result?.pagination.total_pages ?? 1

  return (
    <Layout
      title={`Товари${total ? ` (${total})` : ''}`}
      actions={
        <div className="flex gap-1.5">
          <span className="hidden md:flex gap-1.5">
            <Button variant="secondary" size="sm" icon={<Upload size={13} />} onClick={() => setImportOpen(true)}>Імпорт</Button>
            <Button variant="secondary" size="sm" icon={<Download size={13} />} onClick={handleExport}>Експорт</Button>
            {isOwner && (
              <Button variant="danger-outline" size="sm" icon={<Trash2 size={13} />} onClick={() => navigate('/admin?tab=categories')}>
                Очистити каталог
              </Button>
            )}
          </span>
          <Button size="sm" icon={<Plus size={15} />} onClick={() => navigate('/products/new')}>
            <span className="hidden sm:inline">Новий товар</span>
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

        {/* ── Ліва колонка: категорії + бренди — тільки desktop ── */}
        <div className="hidden md:block">
          <CategorySidebar
            categories={categories}
            brands={brands}
            activeCategory={categoryFilter}
            activeBrand={brandFilter}
            onCategory={(id) => { setCategoryFilter(id); setPage(1) }}
            onBrand={(id) => { setBrandFilter(id); setPage(1) }}
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
            <button onClick={() => { setLowStock(!lowStock); setPage(1) }}
              className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                lowStock ? 'bg-orange-100 border-orange-300 text-orange-700' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
              }`}>
              <AlertTriangle size={14} /> Мало на складі
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

          {/* Таблиця */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-3 py-3 w-10">
                      <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                        className="accent-yellow-500 cursor-pointer" />
                    </th>
                    <SortTh field="sku"          label="Артикул"  className="w-32"         sort={sort} onSort={toggleSort} />
                    <SortTh field="name"         label="Назва"                             sort={sort} onSort={toggleSort} />
                    <SortTh field="brand"        label="Бренд"    className="w-32"         sort={sort} onSort={toggleSort} />
                    <th className="px-3 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide w-24">Місце</th>
                    <SortTh field="retail_price" label="Ціна"    className="w-28 text-right" sort={sort} onSort={toggleSort} />
                    <SortTh field="qty_on_hand"  label="Залишок" className="w-28 text-right" sort={sort} onSort={toggleSort} />
                    <th className="px-3 py-3 w-20 text-center text-xs font-bold text-gray-500 uppercase tracking-wide">Статус</th>
                    <th className="px-3 py-3 w-36" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {loading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="animate-pulse">
                        <td colSpan={9} className="px-3 py-3">
                          <div className="h-4 bg-gray-100 rounded w-full" />
                        </td>
                      </tr>
                    ))
                  ) : products.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-center py-16">
                        <Package size={40} className="mx-auto text-gray-200 mb-3" />
                        <p className="text-gray-400 text-sm">Товарів не знайдено</p>
                        {search && <p className="text-gray-300 text-xs mt-1">Спробуйте інший запит</p>}
                      </td>
                    </tr>
                  ) : products.map((p) => {
                    const stock = stockStatus(p)
                    return (
                      <tr key={p.id}
                        className={`hover:bg-gray-50 transition-colors ${selectedIds.has(p.id) ? 'bg-yellow-50/60' : ''} ${p.is_active === false ? 'opacity-50' : ''}`}>
                        <td className="px-3 py-3 text-center">
                          <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleSelect(p.id)}
                            className="accent-yellow-500 cursor-pointer" />
                        </td>
                        <td className="px-3 py-3">
                          <span className="font-mono text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{p.sku}</span>
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
                          {p.storage_bin
                            ? <span className="text-xs text-gray-500 font-mono bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200">📍 {p.storage_bin}</span>
                            : <span className="text-gray-300 text-xs">—</span>}
                        </td>
                        <td className="px-3 py-3 text-right font-bold text-sm text-gray-800">{kopecksToHryvnia(p.retail_price)} ₴</td>
                        <td className="px-3 py-3 text-right text-sm">
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
                        <td className="px-3 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => navigate(`/products/${p.id}/edit`)}
                              className="text-xs px-2 py-1 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors font-medium">Ред.</button>
                            {isAdmin && (
                              <>
                                <button onClick={() => setMergeProduct(p)}
                                  className="text-xs px-2 py-1 rounded-lg bg-orange-50 text-orange-600 hover:bg-orange-100 transition-colors font-medium">Злити</button>
                                <button onClick={() => askDelete(p)}
                                  className="text-xs px-2 py-1 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors font-medium">Видал.</button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Пагінація */}
            {totalPages > 1 && (
              <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between text-sm text-gray-500 bg-gray-50">
                <span>{total > 0 ? `Показано ${(page-1)*25+1}–${Math.min(page*25, total)} з ${total}` : 'Немає результатів'}</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setPage(1)} disabled={page === 1}
                    className="px-2 py-1 rounded-lg bg-white border border-gray-200 text-xs disabled:opacity-40 hover:bg-gray-100 transition-colors">«</button>
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                    className="px-2 py-1 rounded-lg bg-white border border-gray-200 text-xs disabled:opacity-40 hover:bg-gray-100 transition-colors">‹</button>
                  <span className="px-3 py-1 bg-yellow-400 text-black rounded-lg text-xs font-bold">{page} / {totalPages}</span>
                  <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                    className="px-2 py-1 rounded-lg bg-white border border-gray-200 text-xs disabled:opacity-40 hover:bg-gray-100 transition-colors">›</button>
                  <button onClick={() => setPage(totalPages)} disabled={page === totalPages}
                    className="px-2 py-1 rounded-lg bg-white border border-gray-200 text-xs disabled:opacity-40 hover:bg-gray-100 transition-colors">»</button>
                </div>
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

            <div className="border border-gray-200 rounded-xl overflow-hidden max-h-96 overflow-y-auto">
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

            <div className="flex gap-3 justify-end pt-2 border-t border-gray-100">
              <Button variant="secondary" onClick={() => setBulkPrintOpen(false)}>Скасувати</Button>
              <Button
                disabled={Object.values(bulkQtys).reduce((sum, q) => sum + q, 0) === 0}
                onClick={async () => {
                  try {
                    const settingsRes = await adminApi.getSettings()
                    const settings = settingsRes.data.label_settings || DEFAULT_LABEL
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
    </Layout>
  )
}
