import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDialogEscape } from '@/hooks/useDialogEscape'
import { productApi } from '@/features/products/productApi'
import { adminApi } from '@/features/admin/adminApi'
import type { Product } from '@/types/product'
import { usePOSStore } from '@/stores/posStore'
import { playSuccessBeep, initAudio } from '@/lib/audioService'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'
import { posSaleBlockReason } from './posMoney'
import { DEFAULT_QUICK_ITEMS, filterQuickGallery, matchCategoryIds, mergeQuickGallery, quickGallerySources } from './quickGalleryModel'

export { DEFAULT_QUICK_ITEMS }

/** Тривалість виїзду. Коротко, щоб касир не чекав, але плавно. */
const SHEET_MS = 220

async function loadQuickGallery(): Promise<Product[]> {
  const [settings, categories] = await Promise.all([
    adminApi.getSettings().then(r => r.data.pos_quick_items).catch(() => undefined),
    adminApi.listCategories().then(r => r.data).catch(() => [] as Array<{ id: string; name: string }>),
  ])
  const sources = quickGallerySources(settings && settings.length > 0 ? settings : DEFAULT_QUICK_ITEMS)
  const categoryIds = matchCategoryIds(categories, sources.categoryNames)
  const lists = await Promise.all([
    productApi.list({ favorites: 'true', per_page: 500 }).then(r => r.data),
    ...categoryIds.map(id => productApi.list({ category_id: id, per_page: 500 }).then(r => r.data)),
    ...sources.skus.map(sku => productApi.search(sku, 10)
      .then(r => (r.data ?? []).filter(p => p.sku.toLowerCase() === sku.toLowerCase()) as Product[])
      .catch(() => [] as Product[])),
  ])
  return mergeQuickGallery(lists)
}

export function FavoritesPanel({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const navigate = useNavigate()
  const [mounted, setMounted] = useState(false)
  const [shown, setShown] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [added, setAdded] = useState<Record<string, number>>({})
  const searchRef = useRef<HTMLInputElement>(null)
  useDialogEscape(Boolean(open), () => onClose?.())

  // Монтуємо, потім у наступному кадрі вмикаємо зсув — так браузер анімує виїзд, а не «стрибок».
  useEffect(() => {
    if (open) {
      setMounted(true)
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(frame)
    }
    setShown(false)
    const timer = window.setTimeout(() => setMounted(false), SHEET_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  // Щоразу свіжий список: товар, щойно позначений «⭐ Швидкий», одразу з'являється.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setQuery('')
    setAdded({})
    setLoading(true)
    loadQuickGallery()
      .then(list => { if (!cancelled) setProducts(list) })
      .catch(() => { if (!cancelled) toast.error('Не вдалося завантажити товари швидкого доступу') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  const visible = useMemo(() => filterQuickGallery(products, query), [products, query])

  function addProduct(product: Product) {
    initAudio()
    const unitPrice = product.retail_price
    const blocked = posSaleBlockReason({ name: product.name, unitPrice, purchasePrice: product.purchase_price })
    if (blocked) { toast.error(blocked); return }
    usePOSStore.getState().addItem({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unit: product.unit,
      qty: 1,
      unitPrice,
      purchasePrice: product.purchase_price,
      discount: 0,
      qtyOnHand: product.qty_available ?? product.qty_on_hand,
      requiresCoreReturn: product.requires_core_return,
      coreDepositAmount: product.core_deposit_amount,
      photoUrl: product.photo_url ?? null,
    })
    playSuccessBeep()
    setAdded(current => ({ ...current, [product.id]: (current[product.id] ?? 0) + 1 }))
  }

  if (!mounted) return null

  return (
    <div role="dialog" aria-modal="true" aria-label="Швидкий доступ" data-quick-gallery
      className="fixed inset-0 z-40 flex flex-col justify-end"
      style={{ background: shown ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0)', transition: `background ${SHEET_MS}ms ease-out` }}
      onClick={onClose}>
      <div
        className="bg-[#1A1A1A] rounded-t-2xl border-t border-gray-700 w-full shadow-2xl pb-safe flex flex-col"
        style={{
          height: '50vh',
          transform: shown ? 'translateY(0)' : 'translateY(100%)',
          transition: `transform ${SHEET_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
          willChange: 'transform',
        }}
        onClick={(e) => e.stopPropagation()}
        onTransitionEnd={() => { if (shown) searchRef.current?.focus({ preventScroll: true }) }}>
        <div className="flex items-center gap-3 px-4 pt-3 pb-2 border-b border-gray-800">
          <span className="text-white font-bold text-base shrink-0">⭐ Швидкий доступ</span>
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Пошук у швидких товарах" aria-label="Пошук у швидких товарах"
            className="min-w-0 flex-1 rounded-lg bg-gray-900 border border-gray-700 px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none" />
          <button onClick={() => { onClose?.(); navigate('/products') }}
            title="Позначте товар «⭐ Швидкий товар» у картці товару"
            className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300 hover:text-white shrink-0">
            Додати товари
          </button>
          <button onClick={onClose} aria-label="Закрити"
            className="text-gray-500 text-2xl hover:text-white w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-800 shrink-0">&times;</button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {loading && products.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-8">Завантаження…</p>
          ) : visible.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-8">
              {query ? 'Нічого не знайдено' : 'Немає швидких товарів. Відкрийте картку товару й позначте «⭐ Швидкий товар (показувати на касі)».'}
            </p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8 gap-2">
              {visible.map(product => (
                <button key={product.id} data-quick-product={product.sku} onClick={() => addProduct(product)}
                  className="relative flex flex-col overflow-hidden rounded-xl border border-gray-700 bg-[#242424] text-left transition-transform duration-100 active:scale-[0.96] hover:border-yellow-400">
                  <div className="aspect-square w-full bg-gray-900 flex items-center justify-center overflow-hidden">
                    {product.photo_url
                      ? <img src={product.photo_url} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
                      : <span className="text-3xl text-gray-600" aria-hidden>📦</span>}
                  </div>
                  <div className="px-2 py-1.5">
                    <span className="block text-[11px] font-semibold leading-tight text-white line-clamp-2 min-h-[2.2em]">{product.name}</span>
                    <span className="block text-sm font-bold font-mono text-yellow-300 mt-0.5">{formatMoney(product.retail_price)}</span>
                  </div>
                  {added[product.id] ? (
                    <span className="absolute top-1 right-1 rounded-full bg-yellow-400 px-2 py-0.5 text-xs font-bold text-black">×{added[product.id]}</span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
