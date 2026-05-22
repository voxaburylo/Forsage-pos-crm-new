import { useState, useEffect, useRef } from 'react'
import { productApi } from '@/features/products/productApi'
import { adminApi } from '@/features/admin/adminApi'
import type { QuickItemConfig, QuickChildItem } from '@/features/admin/adminApi'
import { kopecksToHryvnia } from '@/types/product'
import { usePOSStore } from '@/stores/posStore'
import { playSuccessBeep, initAudio } from '@/lib/audioService'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'

interface FoodItem {
  id: string
  sku: string
  name: string
  retail_price: number
  unit: string
  category?: { name: string } | null
}

const DEFAULT_ITEMS: QuickItemConfig[] = [
  {
    sku: 'FOOD', label: 'ЇЖА', emoji: '🍕', price: 0, color: '#7C2D12',
    type: 'food_popup', category_filter: ['Кава та напої', 'Снеки та хотдоги'],
    children: [],
  },
  { sku: 'CAM13',  label: 'КАМЕРА 13', emoji: '⚙️', price: 0,   color: '#065F46', type: 'static', children: [
    { label: 'Р13', sku: 'CAM-R13', price: 0 },
    { label: 'Р14', sku: 'CAM-R14', price: 0 },
  ]},
  { sku: 'PACKET', label: 'ПАКЕТ',     emoji: '🛍', price: 500, color: '#075985', type: 'static', children: [] },
]

export function FavoritesPanel() {
  const store = usePOSStore()
  const [items, setItems]             = useState<QuickItemConfig[]>([])
  const [cam13BasePrice, setCam13]    = useState<number>(0)
  const [popupItem, setPopupItem]     = useState<QuickItemConfig | null>(null)
  const [foodItem, setFoodItem]       = useState<QuickItemConfig | null>(null)
  const [foodProducts, setFoodProds]  = useState<FoodItem[]>([])
  const [foodLoading, setFoodLoading] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  const foodRef  = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [settingsRes] = await Promise.all([
          adminApi.getSettings(),
          productApi.search('CAM13', 1).then((r) => {
            if (r.data?.[0]?.retail_price > 0) setCam13(r.data[0].retail_price)
          }).catch(() => {}),
        ])
        const cfg = settingsRes.data.pos_quick_items
        setItems(cfg && cfg.length > 0 ? cfg : DEFAULT_ITEMS)
      } catch {
        setItems(DEFAULT_ITEMS)
      }
    }
    load()
  }, [])

  // Завантаження товарів для food_popup
  useEffect(() => {
    if (!foodItem) return
    setFoodLoading(true)
    const cats = foodItem.category_filter ?? []
    api.get<{ data: FoodItem[] }>('/api/v1/products?per_page=200&is_active=true')
      .then((r) => {
        const filtered = (r.data ?? []).filter((p) =>
          cats.length === 0 || cats.includes(p.category?.name ?? '')
        )
        setFoodProds(filtered)
      })
      .catch(() => toast.error('Помилка завантаження'))
      .finally(() => setFoodLoading(false))
  }, [foodItem])

  // Закриття варіант-попапу кліком поза
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setPopupItem(null)
    }
    if (popupItem) {
      document.addEventListener('mousedown', onOutside)
      return () => document.removeEventListener('mousedown', onOutside)
    }
  }, [popupItem])

  function getPrice(item: QuickItemConfig): number {
    if (item.sku === 'CAM13' && cam13BasePrice > 0) return cam13BasePrice
    return item.price ?? 0
  }

  function addToReceipt(sku: string, label: string, price: number) {
    initAudio()
    if (price <= 0) { toast.warning(`❌ ${label} відсутній в базі`); return }
    store.addItem({ productId: `quick_${sku}`, sku, name: label, unit: 'шт', qty: 1, unitPrice: price, discount: 0, qtyOnHand: 999 })
    playSuccessBeep()
    setPopupItem(null)
  }

  function addFoodProduct(p: FoodItem) {
    initAudio()
    store.addItem({ productId: p.id, sku: p.sku, name: p.name, unit: p.unit, qty: 1, unitPrice: p.retail_price, discount: 0, qtyOnHand: 999 })
    playSuccessBeep()
    setFoodItem(null)
  }

  async function addChildItem(parentSku: string, child: QuickChildItem) {
    let price = child.price ?? 0
    if (price <= 0 && child.sku) {
      try {
        const r = await productApi.search(child.sku, 1)
        if (r.data?.[0]?.retail_price > 0) price = r.data[0].retail_price
      } catch {
        /* ignore */
      }
    }
    addToReceipt(child.sku || `${parentSku}_${child.label}`, child.label, price)
  }

  if (items.length === 0) return null

  // Групуємо товари їжі по категоріях для відображення в попапі
  const cats = foodItem?.category_filter ?? []
  const grouped = cats.length > 0
    ? cats.map((cat) => ({ cat, products: foodProducts.filter((p) => p.category?.name === cat) }))
        .filter((g) => g.products.length > 0)
    : [{ cat: 'Товари', products: foodProducts }]

  return (
    <>
      {/* ─── Нижня панель ─────────────────────────────────────────── */}
      <div className="border-t-2 border-gray-700 bg-[#0D0D0D] shrink-0">
        <div className="flex items-stretch">
          {items.slice(0, 6).map((item) => {
            const price       = getPrice(item)
            const isFood      = item.type === 'food_popup'
            const hasChildren = !isFood && (item.children?.length ?? 0) > 0

            return (
              <button key={item.sku}
                onClick={() => {
                  if (isFood) {
                    setFoodProds([])
                    setFoodItem(item)
                  } else if (hasChildren) {
                    setPopupItem(popupItem?.sku === item.sku ? null : item)
                  } else {
                    addToReceipt(item.sku, item.label, price)
                  }
                }}
                className="flex-1 flex flex-col items-center justify-center text-white font-bold transition-all active:scale-[0.95] hover:brightness-125 border-r-2 border-black/30 last:border-r-0 relative gap-1"
                style={{ background: item.color ?? '#2C2C2C', minHeight: 80, minWidth: 0 }}
              >
                <span className="text-2xl leading-none drop-shadow">{item.emoji ?? '📦'}</span>
                <span className="text-xs font-bold leading-tight text-center px-1 tracking-wide uppercase">{item.label}</span>
                {!isFood && (
                  <span className="text-xs font-mono text-white/80 font-semibold">
                    {price > 0 ? `${kopecksToHryvnia(price).replace('.00', '')} ₴` : '—'}
                  </span>
                )}
                {hasChildren && <span className="absolute top-1.5 right-2 text-[10px] text-white/50">▼</span>}
              </button>
            )
          })}
        </div>
      </div>

      {/* ─── Попап варіантів (static з children) ──────────────────── */}
      {popupItem && (popupItem.children?.length ?? 0) > 0 && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setPopupItem(null)}>
          <div ref={popupRef}
            className="bg-[#1A1A1A] rounded-t-2xl border-t border-gray-700 w-full max-w-lg mx-auto shadow-2xl animate-slide-up"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-800">
              <span className="text-white font-bold text-lg">{popupItem.emoji} {popupItem.label}</span>
              <button onClick={() => setPopupItem(null)}
                className="text-gray-500 text-2xl hover:text-white w-10 h-10 flex items-center justify-center rounded-lg hover:bg-gray-800">&times;</button>
            </div>
            <div className="p-4 max-h-[60vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => addToReceipt(popupItem.sku, popupItem.label, getPrice(popupItem))}
                  className="flex flex-col items-center justify-center p-5 rounded-2xl text-white font-bold transition-all active:scale-[0.96] hover:brightness-110"
                  style={{ background: popupItem.color ?? '#2C2C2C', minHeight: 100 }}>
                  <span className="text-3xl">{popupItem.emoji}</span>
                  <span className="text-sm font-bold mt-2">Базовий</span>
                  <span className="text-base font-bold font-mono mt-1 text-yellow-300">
                    {getPrice(popupItem) > 0 ? `${kopecksToHryvnia(getPrice(popupItem)).replace('.00', '')} ₴` : '—'}
                  </span>
                </button>
                {popupItem.children!.map((child) => (
                  <button key={child.sku || child.label}
                    onClick={async () => { await addChildItem(popupItem.sku, child) }}
                    className="flex flex-col items-center justify-center p-5 rounded-2xl bg-[#2C2C2C] hover:bg-gray-700 text-white font-bold transition-all active:scale-[0.96] border-2 border-gray-600"
                    style={{ minHeight: 100 }}>
                    <span className="text-base font-bold">{child.label}</span>
                    <span className="text-xs font-mono mt-1 text-gray-400">{child.sku}</span>
                    <span className="text-base font-bold font-mono mt-1 text-yellow-300">
                      {(child.price ?? 0) > 0 ? `${kopecksToHryvnia(child.price!).replace('.00', '')} ₴` : '—'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Попап ЇЖА / food_popup ───────────────────────────────── */}
      {foodItem && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setFoodItem(null)}>
          <div ref={foodRef}
            className="bg-[#1A1A1A] rounded-t-2xl border-t border-gray-700 w-full shadow-2xl animate-slide-up"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-800">
              <span className="text-white font-bold text-lg">{foodItem.emoji} {foodItem.label}</span>
              <button onClick={() => setFoodItem(null)}
                className="text-gray-500 text-2xl hover:text-white w-10 h-10 flex items-center justify-center rounded-lg hover:bg-gray-800">&times;</button>
            </div>
            <div className="p-4 max-h-[60vh] overflow-y-auto">
              {foodLoading ? (
                <p className="text-gray-500 text-sm text-center py-8">Завантаження...</p>
              ) : foodProducts.length === 0 ? (
                <p className="text-gray-500 text-sm text-center py-8">
                  Немає товарів у вказаних категоріях
                </p>
              ) : (
                <div className="space-y-5">
                  {grouped.map(({ cat, products }) => (
                    <div key={cat}>
                      {grouped.length > 1 && (
                        <p className="text-[11px] text-gray-500 uppercase font-semibold mb-2 px-1">{cat}</p>
                      )}
                      <div className="grid grid-cols-3 gap-2">
                        {products.map((p) => (
                          <button key={p.id} onClick={() => addFoodProduct(p)}
                            className="flex flex-col items-center justify-center p-3 rounded-2xl text-white font-bold transition-all active:scale-[0.96] border border-white/10 hover:brightness-110"
                            style={{ background: foodItem.color ? foodItem.color + '99' : '#2C2C2C', minHeight: 80 }}>
                            <span className="text-xs font-bold text-center leading-tight line-clamp-2">{p.name}</span>
                            <span className="text-sm font-bold font-mono mt-1.5 text-yellow-300">{formatMoney(p.retail_price)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
