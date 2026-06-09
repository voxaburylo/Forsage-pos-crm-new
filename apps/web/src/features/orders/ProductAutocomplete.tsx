import { useEffect, useRef, useState } from 'react'
import { productApi } from '@/features/products/productApi'
import type { Product } from '@/types/product'
import { formatMoney } from '@/lib/utils'

interface ProductAutocompleteProps {
  value: string
  onChange: (val: string) => void
  /** Викликається при виборі товару з каталогу — підставляє SKU/ціну/тощо. */
  onSelect: (product: Product) => void
  placeholder?: string
  className?: string
  required?: boolean
}

/**
 * Поле назви/артикула з автопідказкою по товарній базі (ORD-1).
 * Друк → випадають збіги (назва, артикул, ціна, залишок) → вибір підставляє дані.
 * Ручний ввід лишається доступним як запасний варіант (роботи/разові позиції).
 */
export function ProductAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = 'Введіть назву або артикул...',
  className = '',
  required,
}: ProductAutocompleteProps) {
  const [results, setResults] = useState<Product[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Прапор, щоб після вибору не запускати повторний пошук по підставленій назві.
  const justSelected = useRef(false)

  // Закриття при кліку поза полем
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  // Debounced пошук
  useEffect(() => {
    if (justSelected.current) { justSelected.current = false; return }
    const q = value.trim()
    if (q.length < 2) { setResults([]); setOpen(false); return }
    setLoading(true)
    const t = setTimeout(() => {
      productApi.search(q, 8)
        .then((r) => {
          setResults(r.data ?? [])
          setOpen((r.data ?? []).length > 0)
          setHighlight(0)
        })
        .catch(() => setResults([]))
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(t)
  }, [value])

  function pick(p: Product) {
    justSelected.current = true
    onSelect(p)
    setOpen(false)
    setResults([])
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(results[highlight]) }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => { if (results.length > 0) setOpen(true) }}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        className={className || 'w-full bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400'}
      />
      {open && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {loading && results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-400">Пошук...</div>
          ) : results.map((p, idx) => {
            const stock = p.qty_available ?? p.qty_on_hand ?? 0
            return (
              <button
                key={p.id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); pick(p) }}
                onMouseEnter={() => setHighlight(idx)}
                className={`w-full text-left px-3 py-2 border-b border-gray-50 last:border-0 transition-colors ${
                  idx === highlight ? 'bg-yellow-50' : 'hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-800 truncate">{p.name}</span>
                  <span className="text-xs font-bold text-yellow-600 shrink-0">{formatMoney(p.retail_price)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <span className="text-[10px] text-gray-400 font-mono truncate">{p.sku}</span>
                  <span className={`text-[10px] shrink-0 font-semibold ${
                    stock > 0 ? 'text-green-600' : 'text-gray-400'
                  }`}>
                    {stock > 0 ? `На складі: ${stock}` : 'Немає на складі'}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
