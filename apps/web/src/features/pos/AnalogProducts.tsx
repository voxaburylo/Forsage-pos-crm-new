import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Link2, MapPin, Plus } from 'lucide-react'
import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { productApi } from '@/features/products/productApi'
import { normalizeAnalogs, queueAnalogLookup } from './analogLookup'

export function AnalogProducts({ productId, onAdd }: { productId: string; onAdd: (product: Product) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Product[] | null>(null)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!root.current) return
    const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), { rootMargin: '100px' })
    observer.observe(root.current)
    const refresh = () => setRevision(v => v+1)
    window.addEventListener('forsage:offline-products-refreshed', refresh)
    window.addEventListener('forsage:offline-stock-updated', refresh)
    return () => {
      observer.disconnect()
      window.removeEventListener('forsage:offline-products-refreshed', refresh)
      window.removeEventListener('forsage:offline-stock-updated', refresh)
    }
  }, [])
  useEffect(() => {
    if (!visible) return
    let active = true
    setRows(null); setError(false)
    void queueAnalogLookup(() => active, () => productApi.getAnalogs(productId)).then(data => {
      if (!active || !data) return
      const response = data as { analogs?: Product[]; data?: Product[] }
      setRows(normalizeAnalogs(productId, Array.isArray(data) ? data : response.analogs ?? response.data ?? []))
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [productId, visible, revision])
  return <div ref={root} className="mt-1">
    <button type="button" aria-expanded={open} aria-controls={`analogs-${productId}`}
      onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
      className="flex items-center gap-2 px-3 py-2 text-sm text-yellow-300 rounded-lg hover:bg-gray-700">
      <Link2 size={14} /> Аналоги
      <span className="rounded bg-gray-700 px-2 font-semibold">{error ? '!' : rows === null ? '…' : rows.length >= 100 ? '100+' : rows.length}</span>
      <ChevronDown size={14} className={open ? 'rotate-180' : ''} />
    </button>
    {open && <div id={`analogs-${productId}`} className="ml-4 mr-1 mb-3 pl-3 border-l-2 border-yellow-500/40 space-y-2">
      {error ? <button className="text-sm text-amber-300 py-2" onClick={() => setRevision(v => v+1)}>Не вдалося завантажити. Повторити</button>
        : rows === null ? <p className="text-xs text-gray-400 py-2">Пошук аналогів…</p>
        : rows.length === 0 ? <p className="text-xs text-gray-400 py-2">Аналогів у базі не знайдено</p>
        : rows.map(p => {
          const qty = p.qty_available ?? p.qty_on_hand
          return <div key={p.id} className="p-3 rounded-xl bg-[#242424] border border-gray-700 flex items-start gap-3">
            {p.photo_url && <img src={p.photo_url} alt="" className="w-10 h-10 rounded object-cover" />}
            <div className="flex-1 min-w-0">
              <p className="text-xs text-yellow-400 font-mono">{p.sku} <span className="font-sans text-gray-400">· аналог</span></p>
              <p className="text-sm text-white leading-snug">{p.name}</p>
              {p.brand && <p className="text-xs text-gray-400">{p.brand.name}</p>}
              {p.storage_bin && <p className="flex gap-1 text-xs text-gray-400 mt-1"><MapPin size={12} />{p.storage_bin}</p>}
            </div>
            <div className="shrink-0 text-right">
              <p className="font-bold text-white">{kopecksToHryvnia(p.retail_price)} грн</p>
              <p className={`text-xs ${qty > 0 ? 'text-green-400' : 'text-red-400'}`}>{qty > 0 ? `${qty} ${p.unit}` : 'Немає в наявності'}</p>
              <button type="button" disabled={!p.is_service && qty <= 0} onClick={() => onAdd(p)}
                className="mt-2 flex items-center gap-1 rounded px-2 py-1 bg-yellow-400 text-black text-xs disabled:opacity-40">
                <Plus size={12} /> Додати
              </button>
            </div>
          </div>
        })}
    </div>}
  </div>
}
