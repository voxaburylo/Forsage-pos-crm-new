import { useEffect, useRef, useState } from 'react'
import type { Product } from '@/types/product'
import { productApi } from '@/features/products/productApi'
import { formatMoney } from '@/lib/utils'
import { availableStock, stockFirst } from './orderUx'
import { normalizeAnalogs, queueAnalogLookup } from '@/features/pos/analogLookup'

export function OrderProductResults({ products, onSelect, replacing = false }: {
  products: Product[]; onSelect: (product: Product) => void; replacing?: boolean
}) {
  return <div className="mt-3 max-h-96 overflow-y-auto rounded-xl border border-gray-200 divide-y divide-gray-100">
    {stockFirst(products).map((product) => <OrderProductResult key={product.id} product={product} onSelect={onSelect} replacing={replacing} />)}
    {products.length >= 50 && <p className="p-2 text-center text-xs text-gray-500">Перші 50 результатів — уточніть запит, якщо не знайшли потрібне.</p>}
  </div>
}

function ProductChoice({ product, onSelect, replacing }: { product: Product; onSelect: (product: Product) => void; replacing: boolean }) {
  const stock = availableStock(product)
  return <div className="flex flex-wrap items-center gap-2 px-3 py-2">
    <div className="min-w-0 flex-1 basis-48">
      <p className="text-sm font-semibold text-gray-900 break-words">{product.name}</p>
      <p className="text-xs text-gray-500 break-words">{[product.sku, product.barcode, product.storage_bin && `Полиця ${product.storage_bin}`].filter(Boolean).join(' · ')}</p>
      <p className={`text-xs font-medium ${stock > 0 ? 'text-green-700' : 'text-orange-700'}`}>{product.is_service ? 'Послуга' : stock > 0 ? `Доступно: ${stock} ${product.unit ?? 'шт'}` : 'Немає в наявності — під замовлення'}</p>
    </div>
    <span className="text-sm font-bold">{formatMoney(product.retail_price)}</span>
    <button type="button" onClick={() => onSelect(product)} className="rounded-lg bg-yellow-400 px-3 py-2 text-sm font-semibold hover:bg-yellow-500">{replacing ? 'Замінити' : 'Додати'}</button>
  </div>
}

function OrderProductResult({ product, onSelect, replacing }: { product: Product; onSelect: (product: Product) => void; replacing: boolean }) {
  const [open, setOpen] = useState(false)
  const [analogs, setAnalogs] = useState<Product[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!root.current) return
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)))
    observer.observe(root.current)
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener('forsage:offline-stock-updated', refresh)
    window.addEventListener('forsage:offline-products-refreshed', refresh)
    return () => {
      observer.disconnect()
      window.removeEventListener('forsage:offline-stock-updated', refresh)
      window.removeEventListener('forsage:offline-products-refreshed', refresh)
    }
  }, [])
  useEffect(() => {
    if (!visible && !open) return
    let active = true
    setLoading(true)
    setError(false)
    // Only visible results, one lookup at a time, using the same catalogue links as POS.
    void queueAnalogLookup(() => active, () => productApi.getAnalogs(product.id)).then((result) => {
      if (active && result) setAnalogs(normalizeAnalogs(product.id, result.analogs ?? []))
    }).catch(() => { if (active) setError(true) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [product.id, visible, open, revision])

  return <div ref={root}>
    <ProductChoice product={product} onSelect={onSelect} replacing={replacing} />
    <button type="button" aria-expanded={open} onClick={() => {
      setOpen(!open)
    }} className="mb-2 ml-3 text-xs font-medium text-blue-700 underline underline-offset-2">
      {open ? 'Згорнути аналоги' : 'Аналоги'}{analogs !== null ? ` (${analogs.length})` : ''}
    </button>
    {open && <div className="ml-5 mr-2 mb-3 rounded-lg border-l-2 border-blue-200 bg-blue-50/50 divide-y divide-blue-100">
      {loading && <p className="p-3 text-xs text-gray-500">Шукаємо аналоги у власній базі…</p>}
      {error && <button type="button" className="p-3 text-xs text-red-700 underline" onClick={() => setRevision((value) => value + 1)}>Не вдалося завантажити аналоги. Повторити</button>}
      {analogs?.length === 0 && <p className="p-3 text-xs text-gray-600">У базі немає пов’язаних аналогів.</p>}
      {analogs?.map((analog) => <ProductChoice key={analog.id} product={analog} onSelect={onSelect} replacing={replacing} />)}
    </div>}
  </div>
}
