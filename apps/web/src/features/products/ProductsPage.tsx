import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Package, AlertTriangle } from 'lucide-react'
import { productApi } from './productApi'
import type { Product, PaginatedProducts } from '@/types/product'
import { kopecksToHryvnia, stockStatus } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, SearchInput, Table } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

const STATUS_COLOR: Record<string, 'green' | 'orange' | 'red'> = {
  ok: 'green', low: 'orange', out: 'red',
}
const STATUS_LABEL = { ok: 'Є', low: 'Мало', out: 'Нема' }

export default function ProductsPage() {
  const navigate = useNavigate()
  const [result, setResult] = useState<PaginatedProducts | null>(null)
  const [search, setSearch] = useState('')
  const [lowStock, setLowStock] = useState(false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await productApi.list({
        search: search || undefined,
        low_stock: lowStock ? 'true' : undefined,
        page,
        per_page: 20,
      })
      setResult(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка завантаження')
    } finally {
      setLoading(false)
    }
  }, [search, lowStock, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [search, lowStock])

  async function handleDelete(product: Product) {
    if (!confirm(`Видалити товар "${product.name}"?`)) return
    try {
      await productApi.delete(product.id)
      toast.success('Товар видалено')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    }
  }

  const columns = [
    {
      key: 'sku', header: 'Артикул', className: 'w-32',
      render: (p: Product) => <span className="font-mono text-xs text-gray-600">{p.sku}</span>,
    },
    {
      key: 'name', header: 'Назва',
      render: (p: Product) => (
        <div>
          <button onClick={() => navigate(`/products/${p.id}`)} className="font-medium text-gray-900 hover:text-yellow-700 text-left">
            {p.name}
          </button>
          {p.category && <div className="text-xs text-gray-400">{p.category.name}</div>}
        </div>
      ),
    },
    {
      key: 'brand', header: 'Бренд', className: 'w-32',
      render: (p: Product) => <span className="text-gray-500">{p.brand?.name ?? '—'}</span>,
    },
    {
      key: 'price', header: 'Ціна роздріб', className: 'w-32 text-right',
      render: (p: Product) => <span className="font-semibold">{kopecksToHryvnia(p.retail_price)} ₴</span>,
    },
    {
      key: 'qty', header: 'Залишок', className: 'w-28 text-right',
      render: (p: Product) => (
        <div className="flex items-center justify-end gap-1">
          {stockStatus(p) === 'low' && <AlertTriangle size={12} className="text-orange-500" />}
          <span>{p.qty_on_hand} {p.unit}</span>
        </div>
      ),
    },
    {
      key: 'status', header: 'Статус', className: 'w-20 text-center',
      render: (p: Product) => {
        const s = stockStatus(p)
        return <Badge color={STATUS_COLOR[s]}>{STATUS_LABEL[s]}</Badge>
      },
    },
    {
      key: 'actions', header: '', className: 'w-28 text-right',
      render: (p: Product) => (
        <div className="flex items-center justify-end gap-2">
          <button onClick={() => navigate(`/products/${p.id}/edit`)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Редагувати</button>
          <button onClick={() => handleDelete(p)} className="text-xs text-red-500 hover:text-red-700">Видалити</button>
        </div>
      ),
    },
  ]

  return (
    <Layout
      title={`Товари${result ? ` (${result.pagination.total})` : ''}`}
      actions={
        <Button icon={<Plus size={16} />} onClick={() => navigate('/products/new')}>
          Новий товар
        </Button>
      }
    >
      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Пошук за артикулом, назвою або штрихкодом..."
          className="flex-1"
        />
        <Button
          variant={lowStock ? 'primary' : 'secondary'}
          onClick={() => setLowStock(!lowStock)}
          icon={<AlertTriangle size={14} />}
        >
          Мало на складі
        </Button>
      </div>

      <Card padding="none">
        <Table
          columns={columns}
          data={result?.data ?? []}
          keyFn={(p) => p.id}
          loading={loading}
          empty={
            <div className="flex flex-col items-center gap-2 text-gray-400">
              <Package size={40} className="opacity-30" />
              <p>Товарів не знайдено</p>
            </div>
          }
        />

        {result && result.pagination.total_pages > 1 && (
          <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between text-sm text-gray-500">
            <span>
              Показано {(page - 1) * 20 + 1}–{Math.min(page * 20, result.pagination.total)} з {result.pagination.total}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>←</Button>
              <span className="px-3 py-1 bg-gray-100 rounded-lg font-medium text-gray-700">{page} / {result.pagination.total_pages}</span>
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(result.pagination.total_pages, p + 1))} disabled={page === result.pagination.total_pages}>→</Button>
            </div>
          </div>
        )}
      </Card>
    </Layout>
  )
}
