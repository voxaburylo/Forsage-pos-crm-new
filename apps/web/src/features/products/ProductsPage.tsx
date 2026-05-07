import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search, Package, AlertTriangle, XCircle, Filter } from 'lucide-react'
import { productApi } from './productApi'
import type { Product, PaginatedProducts } from '@/types/product'
import { kopecksToHryvnia, stockStatus } from '@/types/product'

const STATUS_STYLES = {
  ok: 'bg-green-100 text-green-700',
  low: 'bg-orange-100 text-orange-700',
  out: 'bg-red-100 text-red-700',
}
const STATUS_LABELS = { ok: 'Є', low: 'Мало', out: 'Нема' }

export default function ProductsPage() {
  const navigate = useNavigate()
  const [result, setResult] = useState<PaginatedProducts | null>(null)
  const [search, setSearch] = useState('')
  const [lowStock, setLowStock] = useState(false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await productApi.list({
        search: search || undefined,
        low_stock: lowStock ? 'true' : undefined,
        page,
        per_page: 20,
      })
      setResult(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження')
    } finally {
      setLoading(false)
    }
  }, [search, lowStock, page])

  useEffect(() => { load() }, [load])

  // Debounce search
  useEffect(() => {
    setPage(1)
  }, [search, lowStock])

  async function handleDelete(product: Product) {
    if (!confirm(`Видалити товар "${product.name}"?`)) return
    try {
      await productApi.delete(product.id)
      load()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Помилка')
    }
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/dashboard')} className="text-gray-400 hover:text-gray-600 text-sm">← Назад</button>
          <span className="text-gray-300">|</span>
          <Package size={20} className="text-gray-600" />
          <h1 className="font-bold text-gray-900">Товари</h1>
          {result && (
            <span className="bg-gray-100 text-gray-600 text-xs font-medium px-2 py-0.5 rounded-full">
              {result.pagination.total}
            </span>
          )}
        </div>
        <button
          onClick={() => navigate('/products/new')}
          className="flex items-center gap-2 bg-accent hover:bg-accent-dark text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
        >
          <Plus size={16} />
          Новий товар
        </button>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {/* Filters */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4 flex gap-3 items-center">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Пошук за артикулом, назвою або штрихкодом..."
              className="w-full pl-9 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <XCircle size={14} />
              </button>
            )}
          </div>
          <button
            onClick={() => setLowStock(!lowStock)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
              lowStock ? 'bg-orange-50 border-orange-300 text-orange-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'
            }`}
          >
            <Filter size={14} />
            Мало на складі
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{error}</div>
        )}

        {/* Table */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          {loading ? (
            <div className="p-12 text-center text-gray-400 text-sm">Завантаження...</div>
          ) : !result?.data.length ? (
            <div className="p-12 text-center text-gray-400">
              <Package size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Товарів не знайдено</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">Артикул</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">Назва</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">Бренд</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Ціна роздріб</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Залишок</th>
                  <th className="text-center px-4 py-3 text-gray-500 font-medium">Статус</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {result.data.map((p) => {
                  const status = stockStatus(p)
                  return (
                    <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-gray-600 text-xs">{p.sku}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{p.name}</div>
                        {p.category && <div className="text-xs text-gray-400">{p.category.name}</div>}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{p.brand?.name ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">
                        {kopecksToHryvnia(p.retail_price)} ₴
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">
                        <div className="flex items-center justify-end gap-1">
                          {status === 'low' && <AlertTriangle size={12} className="text-orange-500" />}
                          {p.qty_on_hand} {p.unit}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[status]}`}>
                          {STATUS_LABELS[status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => navigate(`/products/${p.id}/edit`)}
                            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                          >
                            Редагувати
                          </button>
                          <button
                            onClick={() => handleDelete(p)}
                            className="text-xs text-red-500 hover:text-red-700"
                          >
                            Видалити
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {/* Pagination */}
          {result && result.pagination.total_pages > 1 && (
            <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between text-sm text-gray-500">
              <span>
                Показано {(page - 1) * 20 + 1}–{Math.min(page * 20, result.pagination.total)} з {result.pagination.total}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40 hover:border-gray-300"
                >
                  ←
                </button>
                <span className="px-3 py-1 bg-gray-100 rounded-lg font-medium text-gray-700">
                  {page} / {result.pagination.total_pages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(result.pagination.total_pages, p + 1))}
                  disabled={page === result.pagination.total_pages}
                  className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40 hover:border-gray-300"
                >
                  →
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
