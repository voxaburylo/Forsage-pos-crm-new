import { useState, useEffect } from 'react'
import { Star } from 'lucide-react'
import { productApi } from '@/features/products/productApi'
import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { usePOSStore } from '@/stores/posStore'
import { playSuccessBeep, initAudio } from '@/lib/audioService'

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

export function DashboardPanel() {
  const store = usePOSStore()
  const [favorites, setFavorites] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const prodRes = await productApi.list({ is_active: 'true', per_page: 100 })
        setFavorites(prodRes.data.filter((p) => p.is_favorite).slice(0, 12))
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
      requiresCoreReturn: p.requires_core_return,
      coreDepositAmount: p.core_deposit_amount,
    })
    playSuccessBeep()
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
      {/* Швидкі товари — POS тайли */}
      {favorites.length > 0 && (
        <div className="px-3 py-3">
          <div className="flex items-center gap-1.5 mb-2.5">
            <Star size={13} className="text-yellow-400" />
            <span className="text-gray-500 text-xs font-medium uppercase tracking-wider">Швидкий доступ</span>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {favorites.map((p, i) => {
              const bg = TILE_COLORS[i % TILE_COLORS.length]
              const inStock = p.qty_on_hand > 0
              return (
                <button
                  key={p.id}
                  onClick={() => addToReceipt(p)}
                  className="w-36 shrink-0 rounded-xl text-left transition-all active:scale-[0.96] relative overflow-hidden flex flex-col justify-between border border-white/5"
                  style={{ background: bg, minHeight: 78 }}
                >
                  {/* Декоративний акцент */}
                  <div className="absolute top-0 right-0 w-16 h-16 rounded-full opacity-10"
                    style={{ background: 'white', transform: 'translate(30%, -30%)' }} />

                  <div className="p-2.5 flex flex-col h-full gap-1">
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

      {!loading && favorites.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
          <Star size={32} className="text-gray-700" />
          <p className="text-gray-400 text-sm font-medium">Швидкі товари ще не налаштовані</p>
          <p className="text-gray-600 text-xs max-w-sm">
            Позначте найчастіші товари зіркою в каталозі — вони з’являться тут великими кнопками.
            Категорії вже доступні одним рядком під пошуком.
          </p>
        </div>
      )}
    </div>
  )
}
