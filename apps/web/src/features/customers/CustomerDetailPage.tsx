import { useEffect, useState, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Edit, Trash2, ShoppingBag, Plus, Copy, ClipboardList } from 'lucide-react'
import { desktopBridge } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { customerApi } from './customerApi'
import { orderApi, type CustomerOrder } from '@/features/orders/orderApi'
import { customerVehiclesApi } from './customerVehiclesApi'
import CustomerNotes from './CustomerNotes'
import CustomerPreferences from './CustomerPreferences'
import { startRepeatOrder, formatOrderNo } from '@/features/orders/orderActions'
import { canUseOrderCash } from '@/features/orders/orderUx'
import { posCustomerMoneyApi } from '@/features/pos/posCustomerMoneyApi'
import { CustomerBalances } from './CustomerBalances'
import { customerCashPath, customerMoneyLabel } from './customerUi'
import type { Customer, CustomerSale, CustomerVehicle } from '@/types/customer'
import { QuickCustomerEditModal } from './QuickCustomerEditModal'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDateTime } from '@/lib/utils'

const PAYMENT_LABELS: Record<string, string> = { cash: 'Готівка', card: 'Картка', transfer: 'Переказ', debt: 'Борг', mixed: 'Змішана' }

export default function CustomerDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const role = useAuthStore((s) => s.session?.user?.app_metadata?.role as string | undefined)
  const local = Boolean(desktopBridge())
  const offlineMode = useAuthStore((s) => s.offlineMode)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [sales, setSales] = useState<CustomerSale[]>([])
  const [cars, setCars] = useState<CustomerVehicle[]>([])
  const [customerOrders, setCustomerOrders] = useState<CustomerOrder[]>([])
  const [deposit, setDeposit] = useState<{ balance: number; transactions: any[] } | null>(null)
  const [depositError, setDepositError] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [revision, setRevision] = useState(0)
  const [editModal, setEditModal] = useState(false)
  const [deleteModal, setDeleteModal] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const request = useRef(0)
  const orderBusy = useRef(false)

  useEffect(() => {
    if (!id) return
    const token = ++request.current
    const active = () => request.current === token
    const failed = (section: string) => (error: unknown) => {
      if (active()) setErrors((old) => ({ ...old, [section]: error instanceof Error ? error.message : 'Не вдалося завантажити' }))
    }
    setErrors({}); setLoading(true); setCustomer(null); setSales([]); setCars([]); setCustomerOrders([])
    setDeposit(null); setDepositError(''); setHasMore(false)
    customerApi.get(id).then(({ data }) => { if (active()) setCustomer(data) }).catch(failed('Картка'))
      .finally(() => { if (active()) setLoading(false) })
    customerApi.getSales(id).then(({ data }) => { if (active()) setSales(data) }).catch(failed('Чеки'))
    customerVehiclesApi.list(id).then(({ data }) => { if (active()) setCars(data) }).catch(failed('Автомобілі'))
    posCustomerMoneyApi.getDeposit(id).then(({ data }) => { if (active()) setDeposit(data as typeof deposit) })
      .catch((e) => { if (active()) setDepositError(e instanceof Error ? e.message : 'Не вдалося завантажити кошти клієнта') })
    orderBusy.current = true; setOrdersLoading(true)
    orderApi.list(0, {}, 25, { customer_id: id }).then(({ data, meta }) => {
      if (active()) { setCustomerOrders(data); setHasMore(meta.has_more) }
    }).catch(failed('Замовлення')).finally(() => { if (active()) { orderBusy.current = false; setOrdersLoading(false) } })
    return () => { request.current++ }
  }, [id, revision])

  async function moreOrders() {
    if (!id || orderBusy.current || !hasMore) return
    const token = request.current
    orderBusy.current = true; setOrdersLoading(true)
    try {
      const { data, meta } = await orderApi.list(customerOrders.length, {}, 25, { customer_id: id })
      if (token !== request.current) return
      setCustomerOrders((old) => Array.from(new Map([...old, ...data].map((o) => [o.id, o])).values()))
      setHasMore(meta.has_more)
    } catch (e) { if (token === request.current) toast.error(e instanceof Error ? e.message : 'Не вдалося завантажити замовлення') }
    finally { if (token === request.current) { orderBusy.current = false; setOrdersLoading(false) } }
  }
  async function handleDelete() {
    if (!customer || deleting) return
    setDeleting(true)
    try { await customerApi.delete(customer.id); toast.success('Клієнта видалено'); navigate('/customers') }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Не вдалося видалити') }
    finally { setDeleting(false) }
  }
  if (loading) return <Layout title="Клієнт"><p className="p-6 text-gray-500">Завантаження картки...</p></Layout>
  if (!customer) return <Layout title="Клієнт"><p role="alert">{errors['Картка'] || 'Клієнта не знайдено'}</p><Button onClick={() => setRevision((n) => n + 1)}>Повторити</Button></Layout>

  return (
    <Layout
      title={`${customer.full_name ?? customer.phone}${customer.primary_vin ? `  ${customer.primary_vin}` : ''}`}
      actions={
        <div className="flex gap-2">
          {local && <Button size="sm" icon={<ClipboardList size={14} />}
            onClick={() => navigate(`/orders/new?customer_id=${customer.id}`)}>
            Замовлення
          </Button>}
          {local && <Button variant="secondary" size="sm" icon={<Edit size={14} />} onClick={() => setEditModal(true)}>
            Редагувати
          </Button>}
          {local && ['owner', 'admin'].includes(role ?? '') && <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => setDeleteModal(true)}>
            Видалити
          </Button>}
        </div>
      }
    >
      <div className="w-full max-w-6xl space-y-4">
        {Object.keys(errors).length > 0 && <div role="alert" className="rounded-lg border border-red-200 p-3 text-sm text-red-700">
          {Object.entries(errors).map(([key, message]) => <p key={key}>{key}: {message}</p>)}
          <Button size="sm" variant="secondary" onClick={() => setRevision((n) => n + 1)}>Повторити завантаження</Button>
        </div>}

        {/* Основна інфо */}
        <Card>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2 lg:col-span-1">
              <p className="text-xs text-gray-400 mb-0.5">Телефон</p>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={`tel:${customer.phone}`}
                  className="font-mono text-lg font-extrabold text-blue-600 hover:underline sm:text-xl"
                  title="Подзвонити"
                >
                  {customer.phone}
                </a>
                <button
                  type="button"
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 text-xs font-semibold text-gray-600 hover:border-yellow-300 hover:bg-yellow-50"
                  title="Копіювати телефон"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(customer.phone)
                      toast.success('Телефон скопійовано')
                    } catch {
                      toast.error('Не вдалося скопіювати телефон')
                    }
                  }}
                >
                  <Copy size={14} /> Копіювати
                </button>
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Email</p>
              <p className="text-sm text-gray-800">{customer.email ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Дата народження</p>
              <p className="text-sm font-medium text-gray-800">
                {customer.birth_date ? customer.birth_date.slice(0, 10).split('-').reverse().join('.') : '—'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 mt-3 pt-3 border-t border-gray-100">
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Статус клієнта</p>
              <p className="text-sm font-semibold text-gray-900">
                {(customer as any).client_status === 'sto' ? '🔧 СТО' : '👤 Звичайний клієнт'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Процент клієнта</p>
              <p className="text-sm font-semibold text-gray-900">{customer.discount_pct ?? 0}%</p>
            </div>
          </div>
          <p className="mt-3 text-sm text-gray-600">{customer.loyalty_mode === 'cashback' ? 'Накопичення на рахунок' : 'Знижка в касі'}{customer.price_tier ? ' · ' + customer.price_tier.name : ''}</p>

          {customer.tags.length > 0 && (
            <div className="flex gap-2 mt-3">
              {customer.tags.map((t) => <Badge key={t} color="blue">{t}</Badge>)}
            </div>
          )}
          {customer.notes && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <p className="text-xs text-gray-400 mb-0.5">Примітки</p>
              <p className="text-sm text-gray-700">{customer.notes}</p>
            </div>
          )}
        </Card>

        <CustomerBalances customer={customer} deposit={deposit?.balance}/>
        {local && canUseOrderCash(role) && <Button onClick={() => navigate(customerCashPath(customer.id))}>Розрахунки в касі</Button>}
        <Card>
          <h3 className="mb-3 font-semibold">Рух коштів клієнта — останні 50 операцій</h3>
          {depositError ? <p role="alert" className="text-sm text-red-700">{depositError}</p> : deposit ? (
            <div className="max-h-64 overflow-auto">
              {deposit.transactions.length === 0 && <p className="text-sm text-gray-500">Операцій немає</p>}
              {deposit.transactions.map((entry: any) => <div key={entry.id} className="flex flex-wrap justify-between gap-2 border-b py-2 text-sm">
                <span>{formatDateTime(entry.created_at)} · {entry.notes || customerMoneyLabel(entry.method)}</span>
                <span className={entry.amount >= 0 ? 'text-emerald-700' : 'text-red-700'}>{entry.amount > 0 ? '+' : ''}{formatMoney(entry.amount)} · залишок {formatMoney(entry.balance_after)}</span>
              </div>)}
            </div>
          ) : <p className="text-sm text-gray-500">Завантаження...</p>}
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">Автомобілі ({cars.length})</h3>{local && <Button size="sm" variant="secondary" onClick={() => setEditModal(true)}>Додати / редагувати</Button>}</div>
          {errors['Автомобілі'] ? <p role="alert" className="text-red-700">{errors['Автомобілі']}</p> : cars.length === 0 ? <p className="text-sm text-gray-500">Автомобілі ще не додані</p> : <div className="grid gap-3 md:grid-cols-2">{cars.map((car) => <div key={car.id} className="rounded-lg border p-3">
            <p className="font-semibold">{car.brand} {car.model} {car.year || ''}</p>
            <p className="break-all font-mono text-sm">{car.vin || 'VIN не вказано'}</p>
            {car.notes && <p className="mt-1 text-sm text-gray-500">{car.notes}</p>}
          </div>)}</div>}
        </Card>

        {!local && !offlineMode && (
          <>
            <Card><CustomerNotes customerId={customer.id} /></Card>
            <Card><CustomerPreferences customerId={customer.id} /></Card>
          </>
        )}

        {/* Замовлення клієнта */}
        <Card padding="none">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ClipboardList size={16} className="text-gray-400" />
              <h3 className="font-semibold text-gray-800 text-sm">Замовлення ({customerOrders.length})</h3>
            </div>
            {local && <button
              onClick={() => navigate(`/orders/new?customer_id=${customer.id}`)}
              className="text-xs text-yellow-600 hover:text-yellow-700 font-medium flex items-center gap-1"
            >
              <Plus size={12} /> Нове
            </button>}
          </div>
          {ordersLoading && customerOrders.length === 0 ? (
            <p className="px-6 py-6 text-center text-gray-400 text-sm">Завантаження замовлень…</p>
          ) : customerOrders.length === 0 ? (
            <p className="px-6 py-6 text-center text-gray-400 text-sm">{errors['Замовлення'] ? 'Замовлення не завантажені' : 'Замовлень ще немає'}</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {customerOrders.map((o: any) => {
                const isDraft = o.items.some((item: { is_draft_note?: boolean }) => item.is_draft_note)
                const statusLabel: Record<string, string> = {
                  lead: 'Чернетка', quoted: 'Пропозиція', new: 'Нове', in_progress: 'У роботі', ordered: 'Замовлено', arrived: 'Надійшло', called: 'Повідомлено', no_answer: 'Не відповідає', archived: 'Архів',
                  ready: 'До видачі', completed: 'Видано', canceled: 'Скасовано',
                }
                const statusColor: Record<string, string> = {
                  lead: 'bg-blue-100 text-blue-700', new: 'bg-gray-100 text-gray-600',
                  in_progress: 'bg-yellow-100 text-yellow-700', ready: 'bg-green-100 text-green-700',
                  completed: 'bg-green-100 text-green-700', canceled: 'bg-red-100 text-red-700',
                }
                return (
                  <div
                    key={o.id}
                    className="w-full px-6 py-3 flex items-center justify-between text-sm hover:bg-gray-50 transition-colors gap-2"
                  >
                    <button
                      onClick={() => navigate(`/orders/${o.id}`)}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left"
                    >
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${statusColor[o.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {isDraft ? 'Чернетка' : (statusLabel[o.status] ?? o.status)}
                      </span>
                      <span className="text-gray-500 font-mono text-xs shrink-0">
                        {formatOrderNo(o)}
                      </span>
                      {o.vehicle_info?.make && (
                        <span className="text-gray-400 text-xs truncate">
                          🚗 {o.vehicle_info.make} {o.vehicle_info.model}
                        </span>
                      )}
                    </button>
                    <div className="flex items-center gap-3 shrink-0 ml-2">
                      {o.total_amount > 0 && (
                        <span className="font-semibold text-gray-900">{formatMoney(o.total_amount)}</span>
                      )}
                      <span className="text-xs text-emerald-700">Сплачено: {formatMoney(o.total_paid ?? o.prepayment ?? 0)}</span>
                      <span className="text-gray-400 text-xs hidden sm:inline">{new Date(o.created_at).toLocaleDateString('uk-UA')}</span>
                      {local && !isDraft && o.items?.length > 0 && (
                        <button
                          onClick={() => startRepeatOrder(o, navigate)}
                          className="text-gray-400 hover:text-yellow-600 p-1 rounded hover:bg-yellow-50 transition-colors"
                          title="Повторити замовлення"
                        >
                          <Copy size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* Історія покупок */}
        {hasMore && <Button variant="secondary" size="sm" onClick={moreOrders} loading={ordersLoading}>Ще замовлення</Button>}
        <Card padding="none">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
            <ShoppingBag size={16} className="text-gray-400" />
            <h3 className="font-semibold text-gray-800 text-sm">Каса — останні чеки ({sales.length}, до 200)</h3>
          </div>
          {sales.length === 0 ? (
            <p className="px-6 py-8 text-center text-gray-400 text-sm">{errors['Чеки'] ? 'Чеки не завантажені' : 'Покупок ще немає'}</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {sales.map((s) => (
                <div key={s.id} className="px-6 py-3 flex items-center justify-between text-sm">
                  <div>
                    <span className="font-mono text-gray-600 text-xs">#{s.sale_number}</span>
                    <span className="mx-2 text-gray-300">·</span>
                    <span className="text-gray-500">{PAYMENT_LABELS[s.payment_method] ?? s.payment_method}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="font-semibold text-gray-900">{formatMoney(s.total)}</span>
                    <span className="text-gray-400 text-xs">{formatDateTime(s.completed_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <QuickCustomerEditModal
        customer={customer}
        open={editModal}
        onClose={() => setEditModal(false)}
        onSaved={(updated) => {
          setCustomer(updated)
          setEditModal(false)
          setRevision((n) => n + 1)
        }}
      />



      <Modal open={deleteModal} onClose={() => setDeleteModal(false)} title="Видалити клієнта?" size="sm">
        <p className="text-sm text-gray-600 mb-6">
          Клієнта <span className="font-medium">"{customer?.full_name ?? customer?.phone}"</span> буде видалено.
          Видалення неможливе за наявності боргу, коштів, бонусів або активних замовлень. Історія операцій зберігається.
        </p>
        <div className="flex gap-3">
          <Button variant="danger" loading={deleting} onClick={handleDelete} className="flex-1">
            Видалити
          </Button>
          <Button variant="secondary" onClick={() => setDeleteModal(false)}>Скасувати</Button>
        </div>
      </Modal>
    </Layout>
  )
}

