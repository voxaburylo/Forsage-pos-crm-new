import { useState } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
import { productApi } from './productApi'
import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { toast } from '@/components/ui/Toast'

interface Props {
  product: Product
  onClose: () => void
  onMerged: () => void
}

export function MergeModal({ product, onClose, onMerged }: Props) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Product[]>([])
  const [selected, setSelected] = useState<Product | null>(null)
  const [merging, setMerging] = useState(false)
  const [confirm, setConfirm] = useState(false)

  async function handleSearch(q: string) {
    setSearch(q)
    if (!q.trim()) { setResults([]); return }
    try {
      const { data } = await productApi.list({ search: q, per_page: 8 })
      setResults(data.filter((p) => p.id !== product.id))
    } catch { setResults([]) }
  }

  async function handleMerge() {
    if (!selected) return
    setMerging(true)
    try {
      await productApi.merge(product.id, selected.id)
      toast.success(`Товар "${selected.name}" об'єднано з "${product.name}"`)
      onMerged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
    finally { setMerging(false) }
  }

  const totalStock = product.qty_on_hand + (selected?.qty_on_hand ?? 0)
  const hasDiffBarcode = selected?.barcode && selected.barcode !== product.barcode

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-white rounded-2xl border w-full max-w-lg mx-4 p-6 space-y-4 shadow-xl">
        <h2 className="text-lg font-bold text-gray-900">🔗 Злиття дублікатів</h2>

        {/* Основний товар */}
        <div className="bg-green-50 border border-green-200 rounded-xl p-3">
          <p className="text-xs text-green-700 font-medium mb-1">Основний товар (залишиться)</p>
          <p className="font-semibold text-gray-900">{product.name}</p>
          <p className="text-xs text-gray-500">{product.sku} · {kopecksToHryvnia(product.retail_price)} ₴ · {product.qty_on_hand} {product.unit}</p>
          {product.barcode && <p className="text-xs text-gray-400">ШК: {product.barcode}</p>}
        </div>

        {/* Пошук дубліката */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Товар-дублікат (буде видалено)</label>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input type="text" value={search} onChange={(e) => handleSearch(e.target.value)}
              placeholder="Пошук за назвою або артикулом..."
              className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          {results.length > 0 && (
            <div className="mt-1 border border-gray-200 rounded-lg divide-y max-h-40 overflow-y-auto">
              {results.map((p) => (
                <button key={p.id} onClick={() => { setSelected(p); setResults([]); setSearch(p.name); setConfirm(false) }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between ${selected?.id === p.id ? 'bg-yellow-50' : ''}`}>
                  <div>
                    <span className="font-medium">{p.name}</span>
                    <span className="text-gray-400 text-xs ml-2">{p.sku}</span>
                  </div>
                  <span className="text-xs text-gray-400">{p.qty_on_hand} шт · {kopecksToHryvnia(p.retail_price)} ₴</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Прев'ю результату */}
        {selected && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-1">
            <p className="text-xs font-semibold text-gray-700">Результат злиття:</p>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-600">Залишок:</span>
              <span className="font-bold text-green-700">{totalStock} {product.unit}</span>
            </div>
            {hasDiffBarcode && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-600">Штрих-коди:</span>
                <span className="font-medium text-gray-800">{product.barcode} + {selected.barcode}</span>
              </div>
            )}
          </div>
        )}

        {/* Попередження */}
        {selected && !confirm && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
            <AlertTriangle size={16} className="text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-800">Дія незворотня!</p>
              <p className="text-xs text-red-600">Товар "{selected.name}" буде видалено, всі дані перенесено до основного товару.</p>
              <button onClick={() => setConfirm(true)}
                className="text-xs text-red-700 font-medium mt-1 underline">Я розумію, продовжити</button>
            </div>
          </div>
        )}

        {confirm && (
          <button onClick={handleMerge} disabled={merging}
            className="w-full py-3 rounded-xl bg-red-600 text-white font-bold hover:bg-red-700 disabled:opacity-40 transition-colors">
            {merging ? 'Об\'єднання...' : '✅ Підтвердити злиття'}
          </button>
        )}

        <button onClick={onClose} className="w-full py-2 text-sm text-gray-500 hover:text-gray-700">Скасувати</button>
      </div>
    </div>
  )
}
