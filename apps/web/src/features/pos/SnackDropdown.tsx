import { useState, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'

interface Item {
  id: string
  sku: string
  name: string
  retail_price: number
  unit: string
  category?: { name: string } | null
}

interface Props {
  onAdd: (p: Item) => void
}

export function SnackDropdown({ onAdd }: Props) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Item[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    api.get<{ data: Item[] }>('/api/v1/products?per_page=50')
      .then((r) => setItems((r.data ?? []).filter(
        (p) => p.category?.name === 'Кава та напої' || p.category?.name === 'Снеки та хотдоги'
      )))
      .catch(() => {})
  }, [open])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const coffee = items.filter((p) => p.category?.name === 'Кава та напої')
  const snack  = items.filter((p) => p.category?.name === 'Снеки та хотдоги')

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)}
        className="flex items-center justify-center text-gray-500 hover:text-yellow-400 rounded-xl hover:bg-gray-800 w-11 h-11"
        title="Кава/Снеки">
        <span className="text-base leading-none">🍕</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-1 w-80 bg-[#1A1A1A] border border-gray-700 rounded-2xl shadow-2xl p-3 z-50 max-h-[70vh] overflow-y-auto">
          {coffee.length > 0 && (
            <div className="mb-3">
              <p className="text-[10px] text-gray-500 uppercase font-semibold mb-1.5 px-1">☕ Кава та напої</p>
              <div className="grid grid-cols-2 gap-1">
                {coffee.map((item) => (
                  <button key={item.id} onClick={() => { onAdd(item); setOpen(false) }}
                    className="text-left px-3 py-2 rounded-xl bg-gray-800/50 hover:bg-gray-700/60 border border-gray-700/30 hover:border-yellow-500/30 transition-all">
                    <span className="text-xs text-gray-300 font-medium line-clamp-2">{item.name}</span>
                    <span className="text-xs text-yellow-400 font-bold">{formatMoney(item.retail_price)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {snack.length > 0 && (
            <div>
              <p className="text-[10px] text-gray-500 uppercase font-semibold mb-1.5 px-1">🌭 Снеки та хотдоги</p>
              <div className="grid grid-cols-2 gap-1">
                {snack.map((item) => (
                  <button key={item.id} onClick={() => { onAdd(item); setOpen(false) }}
                    className="text-left px-3 py-2 rounded-xl bg-gray-800/50 hover:bg-gray-700/60 border border-gray-700/30 hover:border-yellow-500/30 transition-all">
                    <span className="text-xs text-gray-300 font-medium line-clamp-2">{item.name}</span>
                    <span className="text-xs text-yellow-400 font-bold">{formatMoney(item.retail_price)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {items.length === 0 && (
            <p className="text-gray-500 text-xs text-center py-4">Завантаження...</p>
          )}
        </div>
      )}
    </div>
  )
}
