import { useState, useEffect, useCallback } from 'react'
import { Package, X, ChevronDown, Loader2, User } from 'lucide-react'
import { api } from '@/lib/api'
import { usePOSStore } from '@/stores/posStore'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'
import type { POSItem, POSCustomer } from '@/stores/posStore'

interface OrderItem {
  id: string
  product_id: string | null
  sku: string | null
  name: string
  source_type: 'warehouse' | 'supplier'
  sell_price: number
  qty: number
  item_status: string
}

interface ReadyOrder {
  id: string
  customer: { id: string; phone: string; full_name: string | null } | null
  total_amount: number
  prepayment: number
  total_paid: number
  items: OrderItem[]
  created_at: string
}

export function ReadyOrdersPanel() {
  const store = usePOSStore()
  const [open, setOpen] = useState(false)
  const [orders, setOrders] = useState<ReadyOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [completing, setCompleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get<{ data: ReadyOrder[] }>('/api/v1/customer-orders?status=ready')
      setOrders(data ?? [])
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  function loadOrderToCart(order: ReadyOrder) {
    const warehouseItems = order.items.filter(
      (i) => i.source_type === 'warehouse' && i.product_id && i.item_status === 'arrived'
    )
    if (!warehouseItems.length) {
      toast.error('Немає складських позицій зі статусом "Прийнято"')
      return
    }

    for (const i of warehouseItems) {
      const posItem: Omit<POSItem, 'total'> = {
        productId:  i.product_id!,
        sku:        i.sku ?? '',
        name:       i.name,
        unit:       'шт',
        qty:        i.qty,
        unitPrice:  i.sell_price,
        discount:   0,
        qtyOnHand:  999,
      }
      store.addItem(posItem)
    }

    if (order.customer) {
      const c = order.customer
      const customer: POSCustomer = {
        id:              c.id,
        phone:           c.phone,
        name:            c.full_name,
        debtBalance:     0,
        tierDiscountPct: 0,
        tierName:        null,
        vipLevel:        'standard',
        riskProfile:     'low',
      }
      store.setCustomer(customer)
    }

    setOpen(false)
    toast.success(`Замовлення завантажено: ${warehouseItems.length} позицій`)
  }

  async function completeOrder(order: ReadyOrder) {
    const remaining = order.total_amount - (order.total_paid ?? 0)
    if (remaining > 0) {
      toast.error(`Залишок до оплати: ${formatMoney(remaining)} ₴. Спочатку внесіть оплату в замовленні.`)
      return
    }

    setCompleting(order.id)
    try {
      await api.post(`/api/v1/customer-orders/${order.id}/complete`, {
        payment_method: 'cash',
        cash_amount: 0,
        card_amount: 0,
        is_fiscal: false,
      })
      toast.success('Замовлення видано!')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка видачі замовлення')
    } finally {
      setCompleting(null)
    }
  }

  const count = orders.length

  return (
    <div className="relative">
      <button
        onClick={() => { setOpen((v) => !v); if (!open) load() }}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium
                   bg-gray-700 hover:bg-gray-600 text-white transition-colors"
      >
        <Package size={15} />
        <span>Видати</span>
        {count > 0 && (
          <span className="bg-orange-500 text-white text-[10px] font-bold rounded-full
                           px-1.5 py-0.5 leading-none min-w-[18px] text-center">
            {count}
          </span>
        )}
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-[380px] bg-gray-800 border border-gray-700
                        rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700">
            <span className="text-sm font-semibold text-white">Готові замовлення</span>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-white">
              <X size={15} />
            </button>
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {loading && (
              <div className="flex justify-center py-8">
                <Loader2 size={20} className="animate-spin text-gray-400" />
              </div>
            )}

            {!loading && orders.length === 0 && (
              <div className="text-center py-8 text-gray-500 text-sm">
                Немає готових замовлень
              </div>
            )}

            {!loading && orders.map((order) => {
              const remaining = order.total_amount - (order.total_paid ?? 0)
              const isCompleting = completing === order.id
              return (
                <div
                  key={order.id}
                  className="px-4 py-3 border-b border-gray-700 hover:bg-gray-750 last:border-0"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <div className="flex items-center gap-1.5 text-sm font-medium text-white">
                        <User size={13} className="text-gray-400" />
                        {order.customer?.full_name ?? order.customer?.phone ?? 'Без клієнта'}
                      </div>
                      <div className="text-[11px] text-gray-400 mt-0.5">
                        {order.items.filter((i) => i.item_status === 'arrived' && i.source_type === 'warehouse').length} позицій зі складу
                        &nbsp;·&nbsp; {formatMoney(order.total_amount)} ₴
                        {remaining > 0 && (
                          <span className="text-orange-400 ml-1">· залишок {formatMoney(remaining)} ₴</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => loadOrderToCart(order)}
                      className="flex-1 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600
                                 text-gray-300 font-medium transition-colors"
                    >
                      У кошик
                    </button>
                    <button
                      onClick={() => completeOrder(order)}
                      disabled={isCompleting || remaining > 0}
                      className="flex-1 py-1 text-xs rounded font-medium transition-colors
                                 disabled:opacity-50 disabled:cursor-not-allowed
                                 bg-green-600 hover:bg-green-500 text-white"
                    >
                      {isCompleting ? (
                        <Loader2 size={12} className="animate-spin mx-auto" />
                      ) : (
                        'Видати'
                      )}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
