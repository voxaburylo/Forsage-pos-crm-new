import { useState, useRef, useEffect } from 'react'
import { Search, Plus } from 'lucide-react'
import { productApi } from '@/features/products/productApi'
import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { usePOSStore } from '@/stores/posStore'
import { toast } from '@/components/ui/Toast'

export function SearchPanel() {
  const store = usePOSStore()
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState<Product[]>([])
  const [loading, setLoading]   = useState(false)
  const inputRef                = useRef<HTMLInputElement>(null)
  const timer                   = useRef<ReturnType<typeof setTimeout>>()

  // Автофокус на полі пошуку завжди
  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    clearTimeout(timer.current)
    if (!query.trim()) { setResults([]); return }

    timer.current = setTimeout(async () => {
      setLoading(true)
      try {
        const { data } = await productApi.search(query, 8)
        setResults(data)
      } catch { setResults([]) }
      finally { setLoading(false) }
    }, 200)
  }, [query])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setQuery(''); setResults([]); return }
    if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault()
      addToReceipt(results[0])
      setQuery('')
      setResults([])
    }
  }

  function addToReceipt(p: Product) {
    if (!p.is_active) { toast.error('Товар неактивний'); return }
    store.addItem({
      productId: p.id,
      sku:       p.sku,
      name:      p.name,
      unit:      p.unit,
      qty:       1,
      unitPrice: p.retail_price,
      discount:  0,
    })
    inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col h-full bg-[#1A1A1A] p-4">
      {/* Поле пошуку */}
      <div className="relative mb-4">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Пошук: артикул, назва, штрихкод... (Enter — додати)"
          className="w-full bg-[#2C2C2C] text-white placeholder-gray-500 pl-10 pr-4 py-3 rounded-xl text-sm border border-gray-700 focus:outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400"
        />
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
          <p className="text-gray-600 text-sm text-center py-12">
            Введіть артикул або назву товару
          </p>
        )}

        {results.map((p, idx) => (
          <button
            key={p.id}
            onClick={() => { addToReceipt(p); setQuery(''); setResults([]) }}
            className={`w-full text-left p-4 rounded-xl border transition-all ${
              idx === 0
                ? 'bg-[#2C2C2C] border-yellow-400/50 hover:border-yellow-400'
                : 'bg-[#242424] border-gray-700 hover:border-gray-500'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-mono text-yellow-400 text-xs mb-0.5">{p.sku}</p>
                <p className="text-white text-sm font-medium leading-tight">{p.name}</p>
                {p.brand && <p className="text-gray-500 text-xs mt-0.5">{p.brand.name}</p>}
              </div>
              <div className="text-right shrink-0">
                <p className="text-white font-bold text-lg">{kopecksToHryvnia(p.retail_price)} ₴</p>
                <p className={`text-xs mt-0.5 ${
                  p.qty_on_hand <= 0 ? 'text-red-400' :
                  p.qty_on_hand <= p.reorder_point ? 'text-orange-400' : 'text-green-400'
                }`}>
                  {p.qty_on_hand <= 0 ? '✗ Нема' : `● ${p.qty_on_hand} ${p.unit}`}
                </p>
              </div>
            </div>
            {idx === 0 && (
              <div className="flex items-center gap-1 mt-2 text-yellow-400/60 text-xs">
                <Plus size={10} />
                <span>Enter щоб додати</span>
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
