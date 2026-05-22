import { useState, useEffect } from 'react'
import { Star } from 'lucide-react'
import { productApi } from '@/features/products/productApi'
import { api } from '@/lib/api'
import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { usePOSStore } from '@/stores/posStore'
import { playSuccessBeep, initAudio } from '@/lib/audioService'

interface Category {
  id: string
  name: string
}

interface Props {
  onSearch: (query: string) => void
}

// Кольори для тайлів — темні насичені відтінки як у реальних касах
const TILE_COLORS = [
  '#1B4F72', // синій
  '#145A32', // зелений
  '#6E2F1A', // коричнево-червоний
  '#4A235A', // фіолетовий
  '#1A3A5C', // темно-синій
  '#1D4F3A', // темно-зелений
  '#5D2E0C', // помаранчево-коричневий
  '#2C2E6B', // індиго
]

export function DashboardPanel({ onSearch }: Props) {
  const store = usePOSStore()
  const [favorites, setFavorites] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const [prodRes, catRes] = await Promise.all([
          productApi.list({ is_active: 'true', per_page: 100 }),
          api.get<{ data: Category[] }>('/api/v1/admin/categories'),
        ])
        setFavorites(prodRes.data.filter((p: any) => p.is_favorite).slice(0, 12))
        setCategories(catRes.data.slice(0, 10))
      } catch {
        /* ignore */
      }
      finally { setLoading(false) }
    }
    load()
  }, [])

  function addToReceipt(p: Product) {
    initAudio()
    const tierPct = store.customer?.tierDiscountPct ?? 0
    const discount = tierPct > 0 ? Math.round(p.retail_price * tierPct / 100) : 0
    store.addItem({
      productId: p.id, sku: p.sku, name: p.name, unit: p.unit,
      qty: 1, unitPrice: p.retail_price, discount, qtyOnHand: p.qty_on_hand,
    })
    playSuccessBeep()
  }

  function handleCategory(cat: Category) {
    if (activeCategory === cat.id) {
      setActiveCategory(null)
      onSearch('')
    } else {
      setActiveCategory(cat.id)
      onSearch(cat.name)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-gray-600 text-sm">Завантаження...</div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto flex flex-col min-h-0">

      {/* Категорії — горизонтальний скрол */}
      {categories.length > 0 && (
        <div className="px-3 pt-3 pb-2 shrink-0">
          <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1">
            {categories.map((cat) => {
              const isActive = activeCategory === cat.id
              return (
                <button
                  key={cat.id}
                  onClick={() => handleCategory(cat)}
                  className="shrink-0 px-5 rounded-xl font-semibold text-sm transition-all active:scale-[0.97] border"
                  style={{
                    minHeight: 44,
                    background: isActive ? '#EAB308' : '#242424',
                    color: isActive ? '#000' : '#CCC',
                    borderColor: isActive ? '#EAB308' : '#444',
                  }}
                >
                  {cat.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Швидкі товари — POS тайли */}
      {favorites.length > 0 && (
        <div className="px-3 pb-3 flex-1">
          <div className="flex items-center gap-1.5 mb-2.5">
            <Star size={13} className="text-yellow-400" />
            <span className="text-gray-500 text-xs font-medium uppercase tracking-wider">Швидкий доступ</span>
          </div>

          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
            {favorites.map((p, i) => {
              const bg = TILE_COLORS[i % TILE_COLORS.length]
              const inStock = p.qty_on_hand > 0
              return (
                <button
                  key={p.id}
                  onClick={() => addToReceipt(p)}
                  className="rounded-xl text-left transition-all active:scale-[0.96] relative overflow-hidden flex flex-col justify-between border border-white/5"
                  style={{ background: bg, minHeight: 100 }}
                >
                  {/* Декоративний акцент */}
                  <div className="absolute top-0 right-0 w-16 h-16 rounded-full opacity-10"
                    style={{ background: 'white', transform: 'translate(30%, -30%)' }} />

                  <div className="p-3 flex flex-col h-full gap-1.5">
                    {/* Артикул */}
                    <span className="text-white/40 text-[10px] font-mono uppercase tracking-wider">{p.sku}</span>

                    {/* Назва */}
                    <p className="text-white font-semibold text-sm leading-tight flex-1"
                      style={{
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}>
                      {p.name}
                    </p>

                    <div className="flex items-end justify-between">
                      {/* Ціна */}
                      <span className="text-yellow-300 font-bold text-lg leading-none">
                        {kopecksToHryvnia(p.retail_price)}
                        <span className="text-yellow-300/70 text-xs ml-0.5">₴</span>
                      </span>

                      {/* Залишок */}
                      <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-md ${
                        inStock
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-red-500/20 text-red-400'
                      }`}>
                        {inStock ? `${p.qty_on_hand}` : '✗'}
                      </span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {!loading && favorites.length === 0 && categories.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
          <Star size={32} className="text-gray-700" />
          <p className="text-gray-500 text-sm">Позначте товари як улюблені</p>
          <p className="text-gray-600 text-xs">Вони з'являться тут для швидкого доступу</p>
        </div>
      )}
    </div>
  )
}
