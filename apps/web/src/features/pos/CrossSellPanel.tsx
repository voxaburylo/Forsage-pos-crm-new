import { useState, useEffect } from 'react'
import { Lightbulb } from 'lucide-react'
import { request } from '@/lib/api'
import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { usePOSStore } from '@/stores/posStore'
import { playSuccessBeep, initAudio } from '@/lib/audioService'

export function CrossSellPanel() {
  const store = usePOSStore()
  const [suggestions, setSuggestions] = useState<Product[]>([])

  // Завантажуємо рекомендації для останнього доданого товару
  useEffect(() => {
    const currentProductIds = store.items.map((i) => i.productId)

    if (store.items.length === 0) { setSuggestions([]); return }
    const lastItem = store.items[store.items.length - 1]
    if (!lastItem) { setSuggestions([]); return }

    // Не запитуємо cobuy для синтетичних ID швидких товарів
    if (lastItem.productId.startsWith('quick_')) { setSuggestions([]); return }

    const controller = new AbortController()

    request<{ data: Product[] }>(`/api/v1/products/${lastItem.productId}/cobuy`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) {
          // Фільтруємо ті, що вже в чеку
          setSuggestions(res.data.filter((p) => !currentProductIds.includes(p.id)))
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setSuggestions([])
      })

    return () => controller.abort()
  }, [store.items.length])

  if (suggestions.length === 0) return null

  function addToReceipt(p: Product) {
    initAudio()
    const tierPct = store.customer?.tierDiscountPct ?? 0
    const discount = tierPct > 0 ? Math.round(p.retail_price * tierPct / 100) : 0
    store.addItem({
      productId: p.id, sku: p.sku, name: p.name, unit: p.unit,
      qty: 1, unitPrice: p.retail_price, discount, qtyOnHand: p.qty_on_hand,
    })
    playSuccessBeep()
    setSuggestions((prev) => prev.filter((s) => s.id !== p.id))
  }

  return (
    <div className="px-4 pb-2">
      <div className="bg-yellow-400/10 border border-yellow-500/30 rounded-xl p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-yellow-300 text-xs font-medium">
          <Lightbulb size={14} />
          Рекомендуємо запропонувати:
        </div>
        <div className="space-y-1.5">
          {suggestions.slice(0, 3).map((p) => (
            <button key={p.id} onClick={() => addToReceipt(p)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-yellow-400/5 hover:bg-yellow-400/20 border border-yellow-500/20 hover:border-yellow-500/50 transition-all text-left">
              <div className="flex-1 min-w-0">
                <p className="text-white text-xs font-medium truncate">{p.name}</p>
                <p className="text-gray-500 text-[10px]">{p.qty_on_hand > 0 ? `● ${p.qty_on_hand} ${p.unit}` : '✗ Нема'}</p>
              </div>
              <div className="text-right shrink-0 ml-2">
                <p className="text-yellow-400 text-xs font-bold">{kopecksToHryvnia(p.retail_price)} ₴</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
