import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Truck } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Card, Badge } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { purchaseApi } from '@/features/autoPurchase/purchaseApi'
import { useLatestRequest } from '@/hooks/useLatestRequest'
import { formatDate } from '@/lib/utils'

interface POItem {
  id: string
  qty: number
  product: { id: string; name: string; sku: string } | null
  customer_order_item: { id: string; order_id: string; order: { order_number: number | null } | null } | null
}

interface SupplierPO {
  order_id: string
  id: string
  po_number: string
  status: 'draft' | 'ordered' | 'received' | 'cancelled'
  notes: string | null
  created_at: string
  supplier: { id: string; name: string; phone: string | null } | null
  items: POItem[]
}

const STATUS_CONFIG: Record<SupplierPO['status'], { label: string; color: 'gray' | 'yellow' | 'green' | 'red' }> = {
  draft:     { label: 'Чернетка',  color: 'gray' },
  ordered:   { label: 'Замовлено', color: 'yellow' },
  received:  { label: 'Отримано',  color: 'green' },
  cancelled: { label: 'Скасовано', color: 'red' },
}

export default function SupplierPOsPage() {
  const [pos, setPos] = useState<SupplierPO[]>([])
  const [filter, setFilter] = useState<'active' | 'all'>('active')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const requests = useLatestRequest('supplier-needs')

  async function load() {
    const isCurrent = requests.begin()
    setLoading(true)
    setLoadError('')
    try {
      const res = await purchaseApi.supplierNeeds()
      if (isCurrent()) setPos(res.data ?? [])
    } catch {
      if (isCurrent()) { setLoadError('Не вдалося завантажити локальні замовлення постачальникам'); toast.error('Не вдалося завантажити локальні замовлення постачальникам') }
    } finally { if (isCurrent()) setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const visible = filter === 'active' ? pos.filter((p) => p.status === 'draft' || p.status === 'ordered') : pos

  return (
    <Layout title="Замовлення постачальникам">
      <div className="mb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <p className="text-gray-500 text-sm">
          Позиції локальних замовлень клієнтів, згруповані за постачальником. Статус змінюється в картці замовлення. Для складського товару прихід оформлюється накладною.
        </p>
        <div className="flex items-center gap-2">
          <div className="flex border border-gray-200 rounded-lg overflow-hidden">
            {(['active', 'all'] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${filter === f ? 'bg-yellow-400 text-gray-900' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
                {f === 'active' ? 'Активні' : 'Всі'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? <p className="py-12 text-center text-gray-400">Завантаження...</p> : loadError ? <p className="py-8 text-center text-red-700">{loadError}. <button onClick={load} className="underline">Повторити</button></p> : visible.length === 0 ? (
        <Card>
          <div className="text-center py-12 text-gray-400 text-sm">
            <Truck size={32} className="mx-auto mb-3 text-gray-300" />
            {filter === 'active' ? 'Немає активних замовлень постачальникам' : 'Замовлень постачальникам ще немає'}
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {visible.map((po) => {
            const conf = STATUS_CONFIG[po.status]
            return (
              <Card key={po.id} className="p-0 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-sm font-bold text-gray-800">{po.po_number}</span>
                    <Badge color={conf.color}>{conf.label}</Badge>
                    <span className="font-semibold text-gray-900 text-sm">{po.supplier?.name ?? 'Постачальник'}</span>
                    {po.supplier?.phone && <span className="text-xs text-gray-400 font-mono">{po.supplier.phone}</span>}
                    <span className="text-xs text-gray-400">{formatDate(po.created_at)}</span>
                  </div>
                  {(po.status === 'draft' || po.status === 'ordered') && (
                    <Link to={`/orders/${po.order_id}`} className="text-sm text-yellow-700 hover:underline">Відкрити замовлення</Link>
                  )}
                </div>
                <div className="divide-y divide-gray-50">
                  {po.items.map((item) => (
                    <div key={item.id} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-gray-800">{item.product?.name ?? 'Товар'}</span>
                        {item.product?.sku && <span className="text-gray-400 text-xs ml-2 font-mono">{item.product.sku}</span>}
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-gray-600 font-semibold">{item.qty} шт</span>
                        {item.customer_order_item?.order_id && (
                          <Link to={`/orders/${item.customer_order_item.order_id}`}
                            className="text-xs text-yellow-600 hover:text-yellow-700 font-medium">
                            замовлення {item.customer_order_item.order?.order_number ? `#${item.customer_order_item.order.order_number}` : '→'}
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {po.notes && <div className="px-4 py-2 bg-gray-50 text-xs text-gray-500 italic">{po.notes}</div>}
              </Card>
            )
          })}
        </div>
      )}
    </Layout>
  )
}
