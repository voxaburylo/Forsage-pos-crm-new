import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Search, ChevronRight, Monitor } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Badge, Card } from '@/components/ui'
import { formatDate, formatDateTime, formatMoney } from '@/lib/utils'
import { orderApi, type CustomerOrder } from './orderApi'
import { formatOrderNo } from './orderActions'
import { WaitingOrdersNote } from './WebOrderFormPage'
import {
  ITEM_STATUS_LABEL, ORDER_STATUS_LABEL, ORDER_VIEW_GROUPS, filterOrders, orderDebt, orderGroup, orderPaymentState, pickupOverdue,
  type OrderViewGroup,
} from './orderViewModel'

/**
 * Замовлення клієнтів у вебі — тільки перегляд копії з каси: статус, оплата, готовність до видачі.
 * Змінювати замовлення можна лише в програмі на касі.
 */
export default function OrdersViewPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [orders, setOrders] = useState<CustomerOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [group, setGroup] = useState<OrderViewGroup>('active')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    orderApi.list(0, { silent: true }, 300, { search: query || undefined })
      .then(({ data }) => { if (!cancelled) setOrders(data) })
      .catch(() => { if (!cancelled) setError('Не вдалося завантажити замовлення. Перевірте інтернет і спробуйте ще раз.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query])

  const shown = useMemo(() => filterOrders(orders, group), [orders, group])
  const counts = useMemo(() => Object.fromEntries(ORDER_VIEW_GROUPS.map(g => [g.id, filterOrders(orders, g.id).length])), [orders])

  if (id) return <OrderView id={id} onBack={() => navigate('/orders')} />

  return (
    <Layout title="Замовлення клієнтів">
      <ReadOnlyNote />
      {/* 22.11.2026 (етап 8): замовлення з телефона — бланк іде на касу, створює його каса. */}
      <button type="button" onClick={() => navigate('/orders/new')}
        className="mb-3 w-full rounded-xl bg-yellow-400 px-4 py-3 text-sm font-semibold text-gray-900 hover:bg-yellow-300 sm:w-auto">
        + Нове замовлення (через касу)
      </button>
      <WaitingOrdersNote />
      <div className="mb-3 flex flex-wrap gap-2">
        {ORDER_VIEW_GROUPS.map(g => (
          <button key={g.id} type="button" onClick={() => setGroup(g.id)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${group === g.id ? 'bg-yellow-400 text-gray-900' : 'bg-white text-gray-600 ring-1 ring-gray-200'}`}>
            {g.label} <span className="opacity-60">{counts[g.id] ?? 0}</span>
          </button>
        ))}
      </div>
      <label className="relative mb-3 block">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={search} onChange={e => setSearch(e.target.value)} aria-label="Пошук замовлення"
          placeholder="Номер, клієнт, телефон, VIN або товар"
          className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300" />
      </label>
      {error && <Card className="text-sm text-red-600">{error}</Card>}
      {loading && !orders.length && <p className="py-8 text-center text-sm text-gray-400">Завантаження…</p>}
      {!loading && !error && !shown.length && <p className="py-8 text-center text-sm text-gray-400">Замовлень немає</p>}
      <div className="space-y-2">
        {shown.map(order => <OrderRow key={order.id} order={order} onOpen={() => navigate('/orders/' + order.id)} />)}
      </div>
    </Layout>
  )
}

function ReadOnlyNote() {
  return (
    <div className="mb-3 flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-500">
      <Monitor size={14} /> Перегляд. Змінювати замовлення, приймати оплату й видавати — у програмі на касі.
    </div>
  )
}

function PaymentBadge({ order }: { order: CustomerOrder }) {
  const state = orderPaymentState(order)
  if (state === 'paid') return <Badge color="green">Оплачено</Badge>
  if (state === 'partial') return <Badge color="yellow">Борг {formatMoney(orderDebt(order))}</Badge>
  return <Badge color="red">Не оплачено</Badge>
}

function OrderRow({ order, onOpen }: { order: CustomerOrder; onOpen: () => void }) {
  const overdue = pickupOverdue(order)
  const car = [order.vehicle_info?.make, order.vehicle_info?.model, order.vehicle_info?.year].filter(Boolean).join(' ')
  return (
    <button type="button" onClick={onOpen} className="w-full rounded-xl bg-white p-3 text-left ring-1 ring-gray-100 hover:ring-yellow-300">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">
            {formatOrderNo(order)} · {order.customer?.full_name || order.customer?.phone || 'Без клієнта'}
          </p>
          <p className="truncate text-xs text-gray-500">{[order.customer?.phone, car, formatDate(order.created_at)].filter(Boolean).join(' · ')}</p>
        </div>
        <ChevronRight size={16} className="shrink-0 text-gray-300" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge color={orderGroup(order.status) === 'ready' ? 'green' : orderGroup(order.status) === 'done' ? 'gray' : 'yellow'}>{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge>
        <PaymentBadge order={order} />
        {overdue && <Badge color="red">Минув строк видачі</Badge>}
        {order.pickup_cell && <span className="text-xs text-gray-500">Комірка {order.pickup_cell}</span>}
        <span className="ml-auto text-sm font-bold text-gray-800">{formatMoney(order.total_amount)}</span>
      </div>
    </button>
  )
}

function OrderView({ id, onBack }: { id: string; onBack: () => void }) {
  const navigate = useNavigate()
  const [order, setOrder] = useState<CustomerOrder | null>(null)
  const [payments, setPayments] = useState<any[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([orderApi.get(id, { silent: true }), orderApi.listPayments(id, { silent: true }).catch(() => ({ data: [] }))])
      .then(([o, p]) => { if (!cancelled) { setOrder(o.data); setPayments(Array.isArray(p.data) ? p.data : []) } })
      .catch(() => { if (!cancelled) setError('Замовлення не знайдено або немає звʼязку з сервером.') })
    return () => { cancelled = true }
  }, [id])

  return (
    <Layout title={order ? `Замовлення ${formatOrderNo(order)}` : 'Замовлення'} onBack={onBack}>
      <ReadOnlyNote />
      {error && <Card className="text-sm text-red-600">{error}</Card>}
      {!order && !error && <p className="py-8 text-center text-sm text-gray-400">Завантаження…</p>}
      {order && (
        <div className="space-y-3">
          <Card className="space-y-1.5 text-sm">
            <div className="flex flex-wrap gap-1.5">
              <Badge color={orderGroup(order.status) === 'ready' ? 'green' : 'yellow'}>{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge>
              <PaymentBadge order={order} />
              {pickupOverdue(order) && <Badge color="red">Минув строк видачі</Badge>}
            </div>
            <p><span className="text-gray-500">Клієнт:</span> {order.customer?.full_name || '—'} {order.customer?.phone && <a className="text-blue-600" href={`tel:${order.customer.phone}`}>{order.customer.phone}</a>}</p>
            {order.vehicle_info && <p><span className="text-gray-500">Авто:</span> {[order.vehicle_info.make, order.vehicle_info.model, order.vehicle_info.year].filter(Boolean).join(' ')}{order.vehicle_info.vin ? ` · VIN ${order.vehicle_info.vin}` : ''}</p>}
            <p><span className="text-gray-500">Створено:</span> {formatDateTime(order.created_at)}</p>
            {order.pickup_deadline_at && <p><span className="text-gray-500">Забрати до:</span> {formatDate(order.pickup_deadline_at)}</p>}
            {order.pickup_cell && <p><span className="text-gray-500">Комірка видачі:</span> {order.pickup_cell}</p>}
            {order.comment && <p><span className="text-gray-500">Коментар:</span> {order.comment}</p>}
          </Card>
          <Card className="divide-y divide-gray-50 p-0">
            {order.items.filter(item => !item.is_draft_note).map(item => (
              <div key={item.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-gray-800">{item.name}</p>
                  <p className="text-xs text-gray-500">{[item.sku, ITEM_STATUS_LABEL[item.item_status] ?? item.item_status].filter(Boolean).join(' · ')}</p>
                </div>
                <span className="shrink-0 text-right text-gray-700">{item.qty} × {formatMoney(item.sell_price)}</span>
              </div>
            ))}
          </Card>
          {/* 22.11.2026 (етап 8): до відкритого замовлення з телефона можна додати позиції — додає каса. */}
          {orderGroup(order.status) !== 'done' && !order.sale_id && (
            <button type="button" onClick={() => navigate('/orders/' + order.id + '/add')}
              className="w-full rounded-xl bg-yellow-400 px-4 py-3 text-sm font-semibold text-gray-900 hover:bg-yellow-300">
              + Додати позиції (через касу)
            </button>
          )}
          <Card className="space-y-1 text-sm">
            <p className="flex justify-between"><span className="text-gray-500">Сума</span><b>{formatMoney(order.total_amount)}</b></p>
            {order.discount_amount > 0 && <p className="flex justify-between"><span className="text-gray-500">Знижка</span><span>{formatMoney(order.discount_amount)}</span></p>}
            <p className="flex justify-between"><span className="text-gray-500">Оплачено</span><span>{formatMoney(order.total_paid)}</span></p>
            <p className="flex justify-between"><span className="text-gray-500">Борг</span><b className={orderDebt(order) ? 'text-red-600' : ''}>{formatMoney(orderDebt(order))}</b></p>
            {payments.length > 0 && (
              <div className="pt-2 text-xs text-gray-500">
                {payments.map((payment: any, index: number) => (
                  <p key={payment.id ?? index}>{payment.created_at ? formatDateTime(payment.created_at) : ''} · {formatMoney(Number(payment.amount) || 0)}{payment.payment_method ? ` · ${payment.payment_method}` : ''}</p>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </Layout>
  )
}
