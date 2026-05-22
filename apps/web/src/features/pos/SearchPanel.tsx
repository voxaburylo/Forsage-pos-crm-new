import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { Search, Plus, MapPin, Link2, Camera, ShoppingCart } from 'lucide-react'
import { productApi } from '@/features/products/productApi'
import { api } from '@/lib/api'
import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { usePOSStore } from '@/stores/posStore'
import { toast } from '@/components/ui/Toast'
import { playSuccessBeep, playWarning, initAudio } from '@/lib/audioService'
import { CameraScanner } from './CameraScanner'

export interface SearchPanelHandle {
  focus: () => void
  clear: () => void
  search: (q: string) => void
}

export const SearchPanel = forwardRef<SearchPanelHandle>((_, ref) => {
  const store = usePOSStore()
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState<Product[]>([])
  const [loading, setLoading]   = useState(false)
  const [analogs, setAnalogs]   = useState<Record<string, Product[]>>({})
  const [analogsLoading, setAnalogsLoading] = useState<string | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const inputRef                = useRef<HTMLInputElement>(null)
  const timer                   = useRef<ReturnType<typeof setTimeout>>()

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    clear: () => {
      setQuery('')
      setResults([])
    },
    search: (q: string) => {
      setQuery(q)
      setResults([])
    },
  }))

  // Auto focus
  useEffect(() => { inputRef.current?.focus() }, [])

  // Debounced search
  useEffect(() => {
    clearTimeout(timer.current)
    if (!query.trim() && !categoryFilter) { setResults([]); return }

    timer.current = setTimeout(async () => {
      setLoading(true)
      try {
        if (categoryFilter) {
          const { data } = await api.get<{ data: Product[] }>(
            `/api/v1/products?search=${encodeURIComponent(query)}&per_page=50`
          )
          setResults((data ?? []).filter((p) => p.category?.name === categoryFilter))
        } else {
          const { data } = await productApi.search(query, 8)
          setResults(data)
        }
      } catch { setResults([]) }
      finally { setLoading(false) }
    }, 200)
  }, [query, categoryFilter])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setQuery(''); setResults([]); return }
    if (e.key === 'Enter' && query.trim()) {
      e.preventDefault()
      const trimmed = query.trim()
      if (/^\d{8,}$/.test(trimmed)) {
        handleBarcodeScan(trimmed)
      } else if (results.length > 0) {
        addToReceipt(results[0])
        setQuery('')
        setResults([])
      }
    }
  }

  async function handleBarcodeScan(code: string) {
    try {
      const res = await api.get<any>(`/api/v1/search/barcode/${code}`)
      const result = typeof res === 'object' && 'data' in res ? (res as any).data : res
      if (result?.type === 'customer' && result?.data) {
        const c = result.data
        store.setCustomer({
          id: c.id, phone: c.phone, name: c.full_name ?? null,
          debtBalance: c.bonus_balance ?? 0, tierDiscountPct: c.price_tier?.discount_pct ?? 0,
          tierName: c.price_tier?.name ?? null,
          vipLevel: c.vip_level ?? 'standard', riskProfile: c.risk_profile ?? 'low',
        })
        toast.success(`Клієнт ${c.full_name ?? c.phone} прив'язаний до чека`)
        playSuccessBeep()
      } else if (result?.type === 'product' && result?.data) {
        addToReceipt(result.data)
      }
      setQuery('')
      setResults([])
    } catch {
      if (results.length > 0) {
        addToReceipt(results[0])
        setQuery('')
        setResults([])
      }
    }
  }

  async function fetchAnalogs(productId: string) {
    if (analogs[productId]) return
    setAnalogsLoading(productId)
    try {
      const { data } = await api.get<{ data: Product[] }>(`/api/v1/products/${productId}/analogs`)
      const analogProducts: Product[] = Array.isArray(data) ? data : (data as any)?.data ?? []
      setAnalogs((prev) => ({ ...prev, [productId]: analogProducts }))
    } catch { setAnalogs((prev) => ({ ...prev, [productId]: [] })) }
    finally { setAnalogsLoading(null) }
  }

  function addToReceipt(p: Product) {
    initAudio()

    const tierPct = store.customer?.tierDiscountPct ?? 0
    const discount = tierPct > 0
      ? Math.round(p.retail_price * tierPct / 100)
      : 0

    const qtyAvailable = p.qty_available ?? p.qty_on_hand
    const existingQty = store.items
      .filter((i) => i.productId === p.id)
      .reduce((s, i) => s + i.qty, 0)
    const newTotalQty = existingQty + 1
    const lowStock = qtyAvailable < newTotalQty

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
      qtyOnHand: p.qty_on_hand,
    })
    inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col h-full bg-[#1A1A1A] p-4">
      {/* Поле пошуку */}
      <div className="relative mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search size={22} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
          <input ref={inputRef} type="text" value={query}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Артикул, назва, штрихкод..."
            className="w-full bg-[#2C2C2C] text-white placeholder-gray-500 pl-12 pr-4 rounded-xl text-lg font-medium border-2 border-gray-700 focus:outline-none focus:border-yellow-400 focus:ring-2 focus:ring-yellow-400/20"
            style={{ minHeight: 56 }}
          />
        </div>
        <button onClick={() => setCameraOpen(true)}
          className="bg-[#2C2C2C] hover:bg-gray-700 active:bg-gray-600 text-white rounded-xl flex items-center justify-center transition-all border-2 border-gray-700 hover:border-yellow-400/50"
          style={{ minWidth: 56, minHeight: 56 }}
          title="Сканувати камерою">
          <Camera size={24} />
        </button>
      </div>

      <CameraScanner open={cameraOpen} onClose={() => setCameraOpen(false)}
        onScan={(code) => { setQuery(code); setCameraOpen(false); setTimeout(() => handleBarcodeScan(code), 100) }} />

      {/* Фільтр категорій */}
      <div className="flex gap-1.5 mb-2 overflow-x-auto pb-1 scrollbar-thin">
        <button onClick={() => setCategoryFilter(null)}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
            !categoryFilter
              ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30'
              : 'bg-gray-800/50 text-gray-400 hover:bg-gray-700/50'
          }`}>
          🏠 Все
        </button>
        <button onClick={() => setCategoryFilter('Кава та напої')}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
            categoryFilter === 'Кава та напої'
              ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30'
              : 'bg-gray-800/50 text-gray-400 hover:bg-gray-700/50'
          }`}>
          ☕ Кава/Напої
        </button>
        <button onClick={() => setCategoryFilter('Снеки та хотдоги')}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
            categoryFilter === 'Снеки та хотдоги'
              ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30'
              : 'bg-gray-800/50 text-gray-400 hover:bg-gray-700/50'
          }`}>
          🌭 Снеки/Хотдоги
        </button>
      </div>

      {/* Результати */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {loading && (
          <p className="text-gray-500 text-sm text-center py-8">Пошук...</p>
        )}

        {!loading && query && results.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-8">Нічого не знайдено</p>
        )}

        {!loading && !query && (
          <p className="text-gray-600 text-sm text-center py-16">
            Введіть артикул або назву товару
          </p>
        )}

        {results.map((p, idx) => {
          const storageBin = p.storage_bin
          const productAnalogs = analogs[p.id] ?? []
          const showAnalogs = (p.qty_available ?? p.qty_on_hand) <= 0
          return (
            <div key={p.id}>
              <button
                onClick={() => { addToReceipt(p); setQuery(''); setResults([]) }}
                className={`w-full text-left p-4 rounded-xl border-2 transition-all active:scale-[0.98] active:bg-gray-700/50 ${
                  idx === 0
                    ? 'bg-[#2C2C2C] border-yellow-400/50 hover:border-yellow-400'
                    : 'bg-[#242424] border-gray-700 hover:border-gray-500'
                }`}
                style={{ minHeight: 80 }}
              >
                <div className="flex items-start justify-between gap-4">
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
              </button>

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
              {productAnalogs.length > 0 && (
                <div className="mx-3 mb-2 p-2 bg-yellow-500/10 border border-yellow-600/30 rounded-xl space-y-1">
                  <p className="text-yellow-400 text-[10px] font-medium">🔗 Доступні аналоги:</p>
                  {productAnalogs.map((a) => (
                    <button key={a.id} onClick={(e) => { e.stopPropagation(); addToReceipt(a); setQuery(''); setResults([]) }}
                      className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-yellow-500/20 transition-colors active:scale-[0.98]"
                      style={{ minHeight: 52 }}>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="text-white text-xs font-medium truncate">{a.name}</p>
                        <p className="text-gray-500 text-[10px]">{a.sku}</p>
                      </div>
                      <div className="text-right shrink-0 ml-2">
                        <p className="text-white text-xs font-semibold">{kopecksToHryvnia(a.retail_price)} ₴</p>
                        <p className={`text-[10px] ${(a.qty_available ?? a.qty_on_hand) > 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {(a.qty_available ?? a.qty_on_hand) > 0 ? `● ${(a.qty_available ?? a.qty_on_hand)}` : '✗ Нема'}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})
