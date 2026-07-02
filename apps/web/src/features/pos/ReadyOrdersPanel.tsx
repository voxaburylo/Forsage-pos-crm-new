import { useState, useEffect, useCallback } from 'react'
import { Package, X, ChevronDown, Loader2, User } from 'lucide-react'
import { api } from '@/lib/api'
import { usePOSStore } from '@/stores/posStore'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'

interface OrderItem {
  id: string
  product_id: string | null
  sku: string | null
  name: string
  source_type: 'warehouse' | 'supplier'
  sell_price: number
  qty: number
  item_status: string
  core_deposit_amount?: number
  core_return_status?: string
}

interface ReadyOrder {
  id: string
  customer: { id: string; phone: string; full_name: string | null } | null
  total_amount: number
  prepayment: number
  total_paid: number
  items: OrderItem[]
  created_at: string
  status: string
  pickup_cell: string | null
}

export function ReadyOrdersPanel({ isMobileInline, onCloseMobile }: { isMobileInline?: boolean; onCloseMobile?: () => void } = {}) {
  const store = usePOSStore()
  const [open, setOpen] = useState(false)
  const [orders, setOrders] = useState<ReadyOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [completing, setCompleting] = useState<string | null>(null)
  
  // Search & Payment states
  const [search, setSearch] = useState('')
  const [payOrder, setPayOrder] = useState<ReadyOrder | null>(null)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState<'cash' | 'card'>('cash')
  const [paying, setPaying] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const url = search.trim()
        ? `/api/v1/customer-orders?search=${encodeURIComponent(search.trim())}&per_page=50`
        : '/api/v1/customer-orders?status=ready'
      const { data } = await api.get<{ data: ReadyOrder[] }>(url)
      setOrders(data ?? [])
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  async function handleAddPayment() {
    if (!payOrder) return
    const amountVal = Math.round(parseFloat(payAmount) * 100)
    if (isNaN(amountVal) || amountVal <= 0) {
      toast.error('Некоректна сума')
      return
    }

    const remaining = payOrder.total_amount - (payOrder.total_paid ?? 0)
    if (amountVal > remaining) {
      toast.error('Сума перевищує залишок до сплати')
      return
    }

    setPaying(true)
    try {
      await api.post(`/api/v1/customer-orders/${payOrder.id}/payments`, {
        amount: amountVal,
        method: payMethod,
        is_fiscal: payMethod === 'card',
        shift_id: store.currentShift?.id || null,
        notes: 'Касова оплата замовлення',
      })
      toast.success('Оплату успішно внесено!')
      setPayOrder(null)
      setPayAmount('')
      await load()
    } catch (e: any) {
      toast.error(e.message ?? 'Помилка внесення оплати')
    } finally {
      setPaying(false)
    }
  }

  async function completeOrder(order: ReadyOrder) {
    const remaining = order.total_amount - (order.total_paid ?? 0)
    if (remaining > 0) {
      toast.error(`Залишок до оплати: ${formatMoney(remaining)}. Спочатку внесіть оплату в замовленні.`)
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

  if (isMobileInline) {
    return (
      <div className="flex flex-col h-full bg-[#1A1A1A] text-white">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-800 shrink-0 bg-[#0D0D0D]">
          <span className="text-base font-bold tracking-wide">Видача готових замовлень</span>
          {onCloseMobile && (
            <button onClick={onCloseMobile} aria-label="Закрити видачу" className="text-gray-400 hover:text-white p-1">
              <X size={20} />
            </button>
          )}
        </div>
        
        <div className="px-4 py-3 border-b border-gray-850 shrink-0 bg-[#151515]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Пошук замовлення (номер, телефон, клієнт)..."
            className="w-full bg-[#2C2C2C] text-white placeholder-gray-500 text-sm rounded-xl px-4 py-2.5 
                       border border-gray-700 focus:outline-none focus:border-yellow-400"
          />
        </div>

        <div className="flex-1 overflow-y-auto pb-4">
          {loading && (
            <div className="flex justify-center py-12">
              <Loader2 size={24} className="animate-spin text-gray-400" />
            </div>
          )}

          {!loading && orders.length === 0 && (
            <div className="text-center py-12 text-gray-500 text-sm">
              {search.trim() ? 'Нічого не знайдено' : 'Немає готових замовлень'}
            </div>
          )}

          {!loading && orders.map((order) => {
            const remaining = order.total_amount - (order.total_paid ?? 0)
            const isCompleting = completing === order.id
            const canAcceptPayment = remaining > 0 && !['completed', 'canceled'].includes(order.status)
            
            let statusLabel = order.status
            let statusColor = 'bg-gray-700 text-gray-300'
            if (order.status === 'ready') {
              statusLabel = 'Готовий'
              statusColor = 'bg-green-900/60 text-green-300'
            } else if (order.status === 'lead') {
              statusLabel = 'Чернетка'
              statusColor = 'bg-yellow-950 text-yellow-300'
            } else if (order.status === 'new') {
              statusLabel = 'Новий'
              statusColor = 'bg-blue-900/60 text-blue-300'
            } else if (order.status === 'completed') {
              statusLabel = 'Виданий'
              statusColor = 'bg-gray-900 text-gray-500'
            }
            
            return (
              <div
                key={order.id}
                className="px-4 py-4 border-b border-gray-800 hover:bg-[#252525] last:border-0"
              >
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div>
                    <div className="flex items-center gap-1.5 text-sm font-medium text-white">
                      <User size={13} className="text-gray-400" />
                      {order.customer?.full_name ?? order.customer?.phone ?? 'Без клієнта'}
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${statusColor}`}>
                        {statusLabel}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-400 mt-1.5">
                      Код: #{order.id.slice(0, 8)} &nbsp;·&nbsp; {formatMoney(order.total_amount)}
                      {remaining > 0 ? (
                        <span className="text-orange-400 ml-1">· залишок {formatMoney(remaining)}</span>
                      ) : (
                        <span className="text-green-400 ml-1">· Сплачено повністю</span>
                      )}
                    </div>
                    {order.pickup_cell && (
                      <div className="mt-1.5 inline-flex rounded-md bg-blue-900/50 px-2 py-1 text-[11px] font-semibold text-blue-200">
                        📍 Забрати з комірки: {order.pickup_cell}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  {canAcceptPayment && (
                    <button
                      onClick={() => {
                        setPayOrder(order);
                        setPayAmount((remaining / 100).toString());
                      }}
                      style={{ minHeight: 44 }}
                      className="flex-1 py-2.5 text-sm rounded-xl bg-yellow-600 hover:bg-yellow-500
                                 active:bg-yellow-700 text-white font-semibold transition-colors"
                    >
                      Оплатити {formatMoney(remaining)}
                    </button>
                  )}
                  {order.status === 'ready' && remaining <= 0 && (
                    <button
                      onClick={() => completeOrder(order)}
                      disabled={isCompleting || remaining > 0}
                      style={{ minHeight: 44 }}
                      className="flex-1 py-2.5 text-sm rounded-xl font-semibold transition-colors
                                 disabled:opacity-50 disabled:cursor-not-allowed
                                 bg-green-600 hover:bg-green-500 active:bg-green-700 text-white"
                    >
                      {isCompleting ? (
                        <Loader2 size={12} className="animate-spin mx-auto" />
                      ) : (
                        'Видати'
                      )}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Модалка оплати замовлення */}
        {payOrder && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] p-4">
            <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5 w-full max-w-sm shadow-2xl">
              <h3 className="text-white font-semibold text-sm mb-4">Прийняти оплату по замовленню</h3>
              
              <div className="text-xs text-gray-400 mb-4 space-y-1">
                <div>Клієнт: {payOrder.customer?.full_name ?? payOrder.customer?.phone}</div>
                <div>Сума замовлення: {formatMoney(payOrder.total_amount)}</div>
                <div>Вже сплачено: {formatMoney(payOrder.total_paid)}</div>
                <div className="text-white font-medium">Залишок до сплати: {formatMoney(payOrder.total_amount - (payOrder.total_paid ?? 0))}</div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Сума оплати (₴)</label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    className="w-full bg-gray-900 border border-gray-700 text-white text-lg font-semibold rounded-xl px-3 py-3
                               focus:outline-none focus:border-yellow-500"
                  />
                </div>

                <div>
                  <label className="block text-xs text-gray-400 mb-1">Спосіб оплати</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPayMethod('cash')}
                      className={`flex-1 py-3 text-sm font-semibold rounded-xl border transition-colors ${
                        payMethod === 'cash'
                          ? 'bg-yellow-600 text-white border-yellow-500'
                          : 'bg-gray-900 text-gray-400 border-gray-700 hover:bg-gray-750'
                      }`}
                    >
                      Готівка
                    </button>
                    <button
                      type="button"
                      onClick={() => setPayMethod('card')}
                      className={`flex-1 py-3 text-sm font-semibold rounded-xl border transition-colors ${
                        payMethod === 'card'
                          ? 'bg-yellow-600 text-white border-yellow-500'
                          : 'bg-gray-900 text-gray-400 border-gray-700 hover:bg-gray-750'
                      }`}
                    >
                      Картка
                    </button>
                  </div>
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setPayOrder(null)}
                    className="flex-1 py-3 text-sm rounded-xl bg-gray-700 hover:bg-gray-600 text-gray-300 font-semibold"
                  >
                    Скасувати
                  </button>
                  <button
                    type="button"
                    onClick={handleAddPayment}
                    disabled={paying}
                    className="flex-1 py-3 text-sm rounded-xl bg-green-600 hover:bg-green-500 text-white font-semibold
                               disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  >
                    {paying ? <Loader2 size={12} className="animate-spin" /> : 'Внести'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

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
        <div className="absolute right-0 top-full mt-1 w-[380px] max-w-[calc(100vw-1.5rem)] bg-gray-800 border border-gray-700
                        rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700">
            <span className="text-sm font-semibold text-white">Видача готових замовлень</span>
            <button onClick={() => setOpen(false)} aria-label="Закрити видачу" className="text-gray-400 hover:text-white">
              <X size={15} />
            </button>
          </div>
          
          <div className="px-4 py-2 border-b border-gray-700">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Пошук (номер, телефон, клієнт)..."
              className="w-full bg-gray-900 text-white placeholder-gray-500 text-xs rounded-lg px-3 py-1.5 
                         border border-gray-700 focus:outline-none focus:border-yellow-500"
            />
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {loading && (
              <div className="flex justify-center py-8">
                <Loader2 size={20} className="animate-spin text-gray-400" />
              </div>
            )}

            {!loading && orders.length === 0 && (
              <div className="text-center py-8 text-gray-500 text-sm">
                {search.trim() ? 'Нічого не знайдено' : 'Немає готових замовлень'}
              </div>
            )}

            {!loading && orders.map((order: any) => {
              const remaining = order.total_amount - (order.total_paid ?? 0)
              const isCompleting = completing === order.id
              const canAcceptPayment = remaining > 0 && !['completed', 'canceled'].includes(order.status)
              
              // Helper to style status label
              let statusLabel = order.status
              let statusColor = 'bg-gray-700 text-gray-300'
              if (order.status === 'ready') {
                statusLabel = 'Готовий'
                statusColor = 'bg-green-900/60 text-green-300'
              } else if (order.status === 'lead') {
                statusLabel = 'Чернетка'
                statusColor = 'bg-yellow-950 text-yellow-300'
              } else if (order.status === 'new') {
                statusLabel = 'Новий'
                statusColor = 'bg-blue-900/60 text-blue-300'
              } else if (order.status === 'completed') {
                statusLabel = 'Виданий'
                statusColor = 'bg-gray-900 text-gray-500'
              }
              
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
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${statusColor}`}>
                          {statusLabel}
                        </span>
                      </div>
                      <div className="text-[11px] text-gray-400 mt-1">
                        Код: #{order.id.slice(0, 8)} &nbsp;·&nbsp; {formatMoney(order.total_amount)}
                        {remaining > 0 ? (
                          <span className="text-orange-400 ml-1">· залишок {formatMoney(remaining)}</span>
                        ) : (
                          <span className="text-green-400 ml-1">· Сплачено повністю</span>
                        )}
                      </div>
                      {order.pickup_cell && (
                        <div className="mt-1.5 inline-flex rounded-md bg-blue-900/50 px-2 py-1 text-[11px] font-semibold text-blue-200">
                          📍 Забрати з комірки: {order.pickup_cell}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    {canAcceptPayment && (
                      <button
                        onClick={() => {
                          setPayOrder(order);
                          setPayAmount((remaining / 100).toString());
                        }}
                        className="flex-1 py-2.5 text-sm rounded-lg bg-yellow-600 hover:bg-yellow-500
                                   active:bg-yellow-700 text-white font-semibold transition-colors"
                      >
                        Оплатити {formatMoney(remaining)}
                      </button>
                    )}
                    {order.status === 'ready' && remaining <= 0 && (
                      <button
                        onClick={() => completeOrder(order)}
                        disabled={isCompleting || remaining > 0}
                        className="flex-1 py-2.5 text-sm rounded-lg font-semibold transition-colors
                                   disabled:opacity-50 disabled:cursor-not-allowed
                                   bg-green-600 hover:bg-green-500 active:bg-green-700 text-white"
                      >
                        {isCompleting ? (
                          <Loader2 size={12} className="animate-spin mx-auto" />
                        ) : (
                          'Видати'
                        )}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Модалка оплати замовлення */}
      {payOrder && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] p-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 w-full max-w-sm shadow-2xl">
            <h3 className="text-white font-semibold text-sm mb-4">Прийняти оплату по замовленню</h3>
            
            <div className="text-xs text-gray-400 mb-4 space-y-1">
              <div>Клієнт: {payOrder.customer?.full_name ?? payOrder.customer?.phone}</div>
              <div>Сума замовлення: {formatMoney(payOrder.total_amount)}</div>
              <div>Вже сплачено: {formatMoney(payOrder.total_paid)}</div>
              <div className="text-white font-medium">Залишок до сплати: {formatMoney(payOrder.total_amount - (payOrder.total_paid ?? 0))}</div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Сума оплати (₴)</label>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 text-white text-lg font-semibold rounded-lg px-3 py-3
                             focus:outline-none focus:border-yellow-500"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Спосіб оплати</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPayMethod('cash')}
                    className={`flex-1 py-3 text-sm font-semibold rounded-lg border transition-colors ${
                      payMethod === 'cash'
                        ? 'bg-yellow-600 text-white border-yellow-500'
                        : 'bg-gray-900 text-gray-400 border-gray-700 hover:bg-gray-750'
                    }`}
                  >
                    Готівка
                  </button>
                  <button
                    type="button"
                    onClick={() => setPayMethod('card')}
                    className={`flex-1 py-3 text-sm font-semibold rounded-lg border transition-colors ${
                      payMethod === 'card'
                        ? 'bg-yellow-600 text-white border-yellow-500'
                        : 'bg-gray-900 text-gray-400 border-gray-700 hover:bg-gray-750'
                    }`}
                  >
                    Картка
                  </button>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPayOrder(null)}
                  className="flex-1 py-3 text-sm rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 font-semibold"
                >
                  Скасувати
                </button>
                <button
                  type="button"
                  onClick={handleAddPayment}
                  disabled={paying}
                  className="flex-1 py-3 text-sm rounded-lg bg-green-600 hover:bg-green-500 text-white font-semibold
                             disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                >
                  {paying ? <Loader2 size={12} className="animate-spin" /> : 'Внести'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
