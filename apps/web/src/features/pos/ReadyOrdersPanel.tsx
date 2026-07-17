import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
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
  order_number?: number | null
  customer: { id: string; phone: string; full_name: string | null; card_barcode?: string | null } | null
  total_amount: number
  prepayment: number
  total_paid: number
  items: OrderItem[]
  created_at: string
  status: string
  pickup_cell: string | null
}

const READY_ORDER_READ_TIMEOUT_MS = 10_000
const READY_ORDER_WRITE_TIMEOUT_MS = 30_000
const ACTIVE_ORDER_STATUSES = 'lead,quoted,new,in_progress,ordered,arrived,called,no_answer,ready'

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function ReadyOrdersPanel({ isMobileInline, onCloseMobile }: { isMobileInline?: boolean; onCloseMobile?: () => void } = {}) {
  const store = usePOSStore()
  const [searchParams, setSearchParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const [orders, setOrders] = useState<ReadyOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [completing, setCompleting] = useState<string | null>(null)
  
  // Search & Payment states
  const [search, setSearch] = useState('')
  const [payOrder, setPayOrder] = useState<ReadyOrder | null>(null)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState<'cash' | 'card' | 'transfer' | 'account'>('cash')
  const [payFiscal, setPayFiscal] = useState(false)
  const [paying, setPaying] = useState(false)
  // Рахунок клієнта (передплата) — для оплати замовлення з балансу
  const [accountBalance, setAccountBalance] = useState<number | null>(null)

  useEffect(() => {
    setAccountBalance(null)
    if (payMethod === 'account') setPayMethod('cash')
    const customerId = payOrder?.customer?.id
    if (!customerId) return
    api.get<{ data: { balance: number } }>(`/api/v1/customers/${customerId}/deposit`, { silent: true, timeoutMs: READY_ORDER_READ_TIMEOUT_MS })
      .then((r) => setAccountBalance(r.data?.balance ?? 0))
      .catch(() => setAccountBalance(0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payOrder?.id])

  // Скан картки клієнта при відкритій панелі «Видати» → показуємо ЙОГО замовлення
  useEffect(() => {
    if (!(open || isMobileInline)) return
    const handler = (event: Event) => {
      const c = (event as CustomEvent<any>).detail
      if (!c?.phone && !c?.full_name) return
      event.preventDefault()
      setSearch(c.phone ?? c.full_name)
      toast.success(`Замовлення клієнта: ${c.full_name ?? c.phone}`)
    }
    window.addEventListener('forsage:pos-customer-scanned', handler)
    return () => window.removeEventListener('forsage:pos-customer-scanned', handler)
  }, [open, isMobileInline])

  // Скан штрих-коду замовлення (ORD-1043) на касі → одразу вікно оплати
  useEffect(() => {
    const handler = async (event: Event) => {
      const num = (event as CustomEvent<{ number?: string }>).detail?.number
      if (!num) return
      try {
        const { data } = await api.get<{ data: any[] }>(
          `/api/v1/customer-orders?search=${encodeURIComponent(num)}&per_page=5`,
          { silent: true, timeoutMs: READY_ORDER_READ_TIMEOUT_MS },
        )
        const order = (data ?? []).find((o) => String(o.order_number) === String(num)) ?? (data ?? [])[0]
        if (!order) { toast.error(`Замовлення №${num} не знайдено`); return }
        if (order.status === 'completed') { toast.error(`Замовлення №${num} вже видане`); return }
        const remaining = order.total_amount - (order.total_paid ?? 0)
        setPayOrder(order)
        setPayAmount(remaining > 0 ? (remaining / 100).toString() : '')
        if (remaining <= 0) toast.success(`Замовлення №${num} сплачено повністю — можна видавати`)
      } catch (e) {
        toast.error(getErrorMessage(e, 'Не вдалося знайти замовлення'))
      }
    }
    window.addEventListener('forsage:pos-pay-order', handler)
    return () => window.removeEventListener('forsage:pos-pay-order', handler)
  }, [])

  useEffect(() => {
    const orderQuery = (searchParams.get('order') ?? searchParams.get('customer') ?? '').trim()
    if (!orderQuery) return
    setSearch(orderQuery)
    setOpen(true)
    const next = new URLSearchParams(searchParams)
    next.delete('order')
    next.delete('customer')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const url = search.trim()
        ? `/api/v1/customer-orders?search=${encodeURIComponent(search.trim())}&per_page=50`
        : `/api/v1/customer-orders?status=${ACTIVE_ORDER_STATUSES}&per_page=80`
      const { data } = await api.get<{ data: ReadyOrder[] }>(url, { silent: true, timeoutMs: READY_ORDER_READ_TIMEOUT_MS })
      setOrders((data ?? []).filter((order) => !['completed', 'canceled', 'archived'].includes(order.status)))
    } catch (e) {
      if (open || isMobileInline || search.trim()) {
        toast.error(getErrorMessage(e, 'Не вдалося завантажити замовлення для видачі'))
      }
    } finally {
      setLoading(false)
    }
  }, [isMobileInline, open, search])

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
    const canAcceptOpenDraftDeposit = ['lead', 'quoted'].includes(payOrder.status) && remaining <= 0
    if (!canAcceptOpenDraftDeposit && amountVal > remaining) {
      toast.error('Сума перевищує залишок до сплати')
      return
    }
    if (payMethod === 'account' && amountVal > (accountBalance ?? 0)) {
      toast.error(`На рахунку клієнта лише ${formatMoney(accountBalance ?? 0)}`)
      return
    }

    setPaying(true)
    try {
      await api.post(
        `/api/v1/customer-orders/${payOrder.id}/payments`,
        {
          amount: amountVal,
          method: payMethod,
          is_fiscal: payMethod === 'account' ? false : payFiscal,
          shift_id: store.currentShift?.id || null,
          notes: payMethod === 'account' ? 'Оплата з рахунку клієнта' : (canAcceptOpenDraftDeposit ? 'Касова передоплата чернетки' : 'Касова оплата замовлення'),
        },
        undefined,
        { silent: true, timeoutMs: READY_ORDER_WRITE_TIMEOUT_MS },
      )
      toast.success(payMethod === 'account' ? 'Списано з рахунку клієнта!' : 'Оплату успішно внесено!')
      setPayOrder(null)
      setPayAmount('')
      setPayFiscal(false)
      await load()
    } catch (e) {
      toast.error(getErrorMessage(e, 'Помилка внесення оплати'))
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
      await api.post(
        `/api/v1/customer-orders/${order.id}/complete`,
        {
          payment_method: 'cash',
          cash_amount: 0,
          card_amount: 0,
          is_fiscal: false,
        },
        undefined,
        { silent: true, timeoutMs: READY_ORDER_WRITE_TIMEOUT_MS },
      )
      toast.success('Замовлення видано!')
      await load()
    } catch (e) {
      toast.error(getErrorMessage(e, 'Помилка видачі замовлення'))
    } finally {
      setCompleting(null)
    }
  }

  const count = orders.length

  if (isMobileInline) {
    return (
      <div className="flex flex-col h-full bg-[#1A1A1A] text-white">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-800 shrink-0 bg-[#0D0D0D]">
          <span className="text-base font-bold tracking-wide">Замовлення / передоплата</span>
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
            placeholder="№ замовлення, телефон, клієнт або штрихкод картки..."
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
              {search.trim() ? 'Нічого не знайдено' : 'Немає активних замовлень'}
            </div>
          )}

          {!loading && orders.map((order) => {
            const remaining = order.total_amount - (order.total_paid ?? 0)
            const isCompleting = completing === order.id
            const canAcceptPayment = !['completed', 'canceled', 'archived'].includes(order.status) && (remaining > 0 || ['lead', 'quoted'].includes(order.status))
            
            let statusLabel = order.status
            let statusColor = 'bg-gray-700 text-gray-300'
            if (order.status === 'ready') {
              statusLabel = 'Готовий'
              statusColor = 'bg-green-900/60 text-green-300'
            } else if (order.status === 'lead') {
              statusLabel = 'Чернетка'
              statusColor = 'bg-yellow-950 text-yellow-300'
            } else if (order.status === 'in_progress') {
              statusLabel = 'В роботі'
              statusColor = 'bg-indigo-900/60 text-indigo-300'
            } else if (order.status === 'ordered') {
              statusLabel = 'Замовлено'
              statusColor = 'bg-purple-900/60 text-purple-300'
            } else if (order.status === 'arrived') {
              statusLabel = 'Приїхало'
              statusColor = 'bg-cyan-900/60 text-cyan-300'
            } else if (order.status === 'called' || order.status === 'no_answer') {
              statusLabel = order.status === 'called' ? 'Подзвонили' : 'Не відповів'
              statusColor = 'bg-orange-950 text-orange-300'
            } else if (order.status === 'quoted') {
              statusLabel = 'Пропозиція'
              statusColor = 'bg-amber-950 text-amber-300'
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
                      № {order.order_number ?? order.id.slice(0, 8)} &nbsp;·&nbsp; {formatMoney(order.total_amount)}
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
                        setPayAmount(remaining > 0 ? (remaining / 100).toString() : '');
                      }}
                      style={{ minHeight: 44 }}
                      className="flex-1 py-2.5 text-sm rounded-xl bg-yellow-600 hover:bg-yellow-500
                                 active:bg-yellow-700 text-white font-semibold transition-colors"
                    >
                      {remaining > 0 ? 'Внести ' + formatMoney(remaining) : 'Внести передоплату'}
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
              <h3 className="text-white font-semibold text-sm mb-4">Оплата / передоплата замовлення</h3>
              
              <div className="text-xs text-gray-400 mb-4 space-y-1">
                <div>Клієнт: {payOrder.customer?.full_name ?? payOrder.customer?.phone}</div>
                <div>Сума замовлення: {formatMoney(payOrder.total_amount)}</div>
                <div>Вже сплачено: {formatMoney(payOrder.total_paid)}</div>
                <div className="text-white font-medium">Залишок до сплати: {formatMoney(payOrder.total_amount - (payOrder.total_paid ?? 0))}</div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Сума передоплати / оплати (₴)</label>
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
                  <div className="grid grid-cols-2 gap-2">
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
                      Термінал
                    </button>
                    <button
                      type="button"
                      onClick={() => setPayMethod('transfer')}
                      className={`py-3 text-sm font-semibold rounded-xl border transition-colors ${
                        payMethod === 'transfer'
                          ? 'bg-yellow-600 text-white border-yellow-500'
                          : 'bg-gray-900 text-gray-400 border-gray-700 hover:bg-gray-750'
                      }`}
                    >
                      Переказ
                    </button>
                    <button
                      type="button"
                      onClick={() => setPayMethod('account')}
                      disabled={!payOrder.customer?.id || (accountBalance ?? 0) <= 0}
                      className={`py-3 text-sm font-semibold rounded-xl border transition-colors disabled:opacity-40 ${
                        payMethod === 'account'
                          ? 'bg-emerald-600 text-white border-emerald-500'
                          : 'bg-gray-900 text-emerald-300 border-gray-700 hover:bg-gray-750'
                      }`}
                    >
                      З рахунку {accountBalance != null ? `(${formatMoney(accountBalance)})` : ''}
                    </button>
                  </div>
                </div>

                <label className="flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-900 px-3 py-3 text-sm text-gray-300">
                  <input type="checkbox" checked={payFiscal} onChange={(e) => setPayFiscal(e.target.checked)}
                    className="h-4 w-4 accent-yellow-500" />
                  Провести через ПРРО (фіскальний чек)
                </label>

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
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold
                   bg-yellow-500 hover:bg-yellow-400 text-black transition-colors"
      >
        <Package size={15} />
        <span>Замовлення / передоплата</span>
        {count > 0 && (
          <span className="bg-black/20 text-black text-[10px] font-bold rounded-full
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
            <span className="text-sm font-semibold text-white">Замовлення / передоплата</span>
            <button onClick={() => setOpen(false)} aria-label="Закрити видачу" className="text-gray-400 hover:text-white">
              <X size={15} />
            </button>
          </div>
          
          <div className="px-4 py-2 border-b border-gray-700">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="№ замовлення, телефон, клієнт або штрихкод картки..."
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
                {search.trim() ? 'Нічого не знайдено' : 'Немає активних замовлень'}
              </div>
            )}

            {!loading && orders.map((order) => {
              const remaining = order.total_amount - (order.total_paid ?? 0)
              const isCompleting = completing === order.id
              const canAcceptPayment = !['completed', 'canceled', 'archived'].includes(order.status) && (remaining > 0 || ['lead', 'quoted'].includes(order.status))
              
              // Helper to style status label
              let statusLabel = order.status
              let statusColor = 'bg-gray-700 text-gray-300'
              if (order.status === 'ready') {
                statusLabel = 'Готовий'
                statusColor = 'bg-green-900/60 text-green-300'
              } else if (order.status === 'lead') {
                statusLabel = 'Чернетка'
                statusColor = 'bg-yellow-950 text-yellow-300'
              } else if (order.status === 'in_progress') {
                statusLabel = 'В роботі'
                statusColor = 'bg-indigo-900/60 text-indigo-300'
              } else if (order.status === 'ordered') {
                statusLabel = 'Замовлено'
                statusColor = 'bg-purple-900/60 text-purple-300'
              } else if (order.status === 'arrived') {
                statusLabel = 'Приїхало'
                statusColor = 'bg-cyan-900/60 text-cyan-300'
              } else if (order.status === 'called' || order.status === 'no_answer') {
                statusLabel = order.status === 'called' ? 'Подзвонили' : 'Не відповів'
                statusColor = 'bg-orange-950 text-orange-300'
              } else if (order.status === 'quoted') {
                statusLabel = 'Пропозиція'
                statusColor = 'bg-amber-950 text-amber-300'
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
                        № {order.order_number ?? order.id.slice(0, 8)} &nbsp;·&nbsp; {formatMoney(order.total_amount)}
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
                          setPayAmount(remaining > 0 ? (remaining / 100).toString() : '');
                        }}
                        className="flex-1 py-2.5 text-sm rounded-lg bg-yellow-600 hover:bg-yellow-500
                                   active:bg-yellow-700 text-white font-semibold transition-colors"
                      >
                        {remaining > 0 ? 'Внести ' + formatMoney(remaining) : 'Внести передоплату'}
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
            <h3 className="text-white font-semibold text-sm mb-4">Оплата / передоплата замовлення</h3>
            
            <div className="text-xs text-gray-400 mb-4 space-y-1">
              <div>Клієнт: {payOrder.customer?.full_name ?? payOrder.customer?.phone}</div>
              <div>Сума замовлення: {formatMoney(payOrder.total_amount)}</div>
              <div>Вже сплачено: {formatMoney(payOrder.total_paid)}</div>
              <div className="text-white font-medium">Залишок до сплати: {formatMoney(payOrder.total_amount - (payOrder.total_paid ?? 0))}</div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Сума передоплати / оплати (₴)</label>
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
                <div className="grid grid-cols-2 gap-2">
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
                    Термінал
                  </button>
                  <button
                    type="button"
                    onClick={() => setPayMethod('transfer')}
                    className={`py-3 text-sm font-semibold rounded-lg border transition-colors ${
                      payMethod === 'transfer'
                        ? 'bg-yellow-600 text-white border-yellow-500'
                        : 'bg-gray-900 text-gray-400 border-gray-700 hover:bg-gray-750'
                    }`}
                  >
                    Переказ
                  </button>
                  <button
                    type="button"
                    onClick={() => setPayMethod('account')}
                    disabled={!payOrder.customer?.id || (accountBalance ?? 0) <= 0}
                    className={`py-3 text-sm font-semibold rounded-lg border transition-colors disabled:opacity-40 ${
                      payMethod === 'account'
                        ? 'bg-emerald-600 text-white border-emerald-500'
                        : 'bg-gray-900 text-emerald-300 border-gray-700 hover:bg-gray-750'
                    }`}
                  >
                    З рахунку {accountBalance != null ? `(${formatMoney(accountBalance)})` : ''}
                  </button>
                </div>
              </div>

              <label className="flex items-center gap-3 rounded-lg border border-gray-700 bg-gray-900 px-3 py-3 text-sm text-gray-300">
                <input type="checkbox" checked={payFiscal} onChange={(e) => setPayFiscal(e.target.checked)}
                  className="h-4 w-4 accent-yellow-500" />
                Провести через ПРРО (фіскальний чек)
              </label>

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
