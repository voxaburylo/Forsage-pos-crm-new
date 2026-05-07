import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Edit, Trash2, Clock, AlertTriangle, CheckCircle, XCircle } from 'lucide-react'
import { productApi } from './productApi'
import type { Product } from '@/types/product'
import { kopecksToHryvnia, stockStatus } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

function StockBadge({ product }: { product: Product }) {
  const status = stockStatus(product)
  const map = {
    ok:  { color: 'green' as const, icon: <CheckCircle size={14} />, label: 'Є в наявності' },
    low: { color: 'orange' as const, icon: <AlertTriangle size={14} />, label: 'Мало' },
    out: { color: 'red' as const, icon: <XCircle size={14} />, label: 'Нема' },
  }
  const { color, icon, label } = map[status]
  return (
    <Badge color={color} className="flex items-center gap-1 text-sm px-3 py-1">
      {icon} {label}
    </Badge>
  )
}

export default function ProductDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const [product, setProduct] = useState<Product | null>(null)
  const [history, setHistory] = useState<{ price_type: string; old_price: number; new_price: number; created_at: string }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    Promise.all([
      productApi.get(id),
      productApi.priceHistory(id),
    ]).then(([{ data }, { data: hist }]) => {
      setProduct(data)
      setHistory(hist as typeof history)
    }).catch(() => navigate('/products')).finally(() => setLoading(false))
  }, [id, navigate])

  async function handleDelete() {
    if (!product || !confirm(`Видалити товар "${product.name}"?`)) return
    try {
      await productApi.delete(product.id)
      toast.success('Товар видалено')
      navigate('/products')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    }
  }

  if (loading || !product) return (
    <Layout>
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div>
    </Layout>
  )

  return (
    <Layout
      title={product.name}
      actions={
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" icon={<Edit size={14} />} onClick={() => navigate(`/products/${product.id}/edit`)}>
            Редагувати
          </Button>
          <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={handleDelete}>
            Видалити
          </Button>
        </div>
      }
    >
      <div className="max-w-3xl space-y-4">

        {/* Основна інфо */}
        <Card>
          <div className="flex items-start justify-between mb-4">
            <div>
              <p className="text-xs text-gray-400 mb-1">Артикул</p>
              <p className="font-mono font-semibold text-gray-800">{product.sku}</p>
            </div>
            <StockBadge product={product} />
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Категорія</p>
              <p className="text-sm text-gray-800">{product.category?.name ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Бренд</p>
              <p className="text-sm text-gray-800">{product.brand?.name ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Штрихкод</p>
              <p className="text-sm font-mono text-gray-800">{product.barcode ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Одиниця</p>
              <p className="text-sm text-gray-800">{product.unit}</p>
            </div>
          </div>

          {product.notes && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <p className="text-xs text-gray-400 mb-0.5">Примітки</p>
              <p className="text-sm text-gray-700">{product.notes}</p>
            </div>
          )}
        </Card>

        {/* Ціни та залишок */}
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <p className="text-xs text-gray-400 mb-1">Закупівельна ціна</p>
            <p className="text-2xl font-bold text-gray-900">{kopecksToHryvnia(product.purchase_price)} ₴</p>
          </Card>
          <Card>
            <p className="text-xs text-gray-400 mb-1">Роздрібна ціна</p>
            <p className="text-2xl font-bold text-gray-900">{kopecksToHryvnia(product.retail_price)} ₴</p>
          </Card>
          <Card>
            <p className="text-xs text-gray-400 mb-1">Залишок / Мінімум</p>
            <p className="text-2xl font-bold text-gray-900">{product.qty_on_hand} {product.unit}</p>
            <p className="text-xs text-gray-400 mt-0.5">мін: {product.reorder_point} {product.unit}</p>
          </Card>
        </div>

        {/* Маржа */}
        {product.purchase_price > 0 && (
          <Card>
            <p className="text-xs text-gray-400 mb-1">Маржа</p>
            <p className="text-xl font-bold text-green-600">
              {kopecksToHryvnia(product.retail_price - product.purchase_price)} ₴
              {' '}
              <span className="text-sm text-gray-500 font-normal">
                ({Math.round((1 - product.purchase_price / product.retail_price) * 100)}%)
              </span>
            </p>
          </Card>
        )}

        {/* Історія цін */}
        {history.length > 0 && (
          <Card padding="none">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
              <Clock size={16} className="text-gray-400" />
              <h3 className="font-semibold text-gray-800 text-sm">Історія цін</h3>
            </div>
            <div className="divide-y divide-gray-50">
              {history.map((h, i) => (
                <div key={i} className="px-6 py-3 flex items-center justify-between text-sm">
                  <div>
                    <span className="text-gray-500 capitalize">{h.price_type === 'retail' ? 'Роздрібна' : 'Закупівельна'}: </span>
                    <span className="line-through text-gray-400">{kopecksToHryvnia(h.old_price)} ₴</span>
                    <span className="mx-2 text-gray-400">→</span>
                    <span className="font-semibold text-gray-800">{kopecksToHryvnia(h.new_price)} ₴</span>
                  </div>
                  <span className="text-gray-400 text-xs">
                    {new Date(h.created_at).toLocaleDateString('uk-UA')}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </Layout>
  )
}
