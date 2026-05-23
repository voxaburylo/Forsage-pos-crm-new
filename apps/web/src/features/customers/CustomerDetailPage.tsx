import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Edit, Trash2, CreditCard, ShoppingBag, Car, Plus, Copy, ClipboardList } from 'lucide-react'
import { api } from '@/lib/api'
import { customerApi } from './customerApi'
import { customerVehiclesApi } from './customerVehiclesApi'
import type { CustomerVehicle } from '@/types/customer'
import CustomerNotes from './CustomerNotes'
import CustomerLoyalty from './CustomerLoyalty'
import CustomerPreferences from './CustomerPreferences'
import { pricingApi } from '@/features/admin/pricingApi'
import type { PriceTier } from '@/features/admin/pricingApi'
import type { Customer, CustomerSale } from '@/types/customer'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDateTime } from '@/lib/utils'

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', debt: 'Борг', mixed: 'Змішана',
}

export default function CustomerDetailPage() {
  const navigate    = useNavigate()
  const { id }      = useParams<{ id: string }>()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [sales, setSales]       = useState<CustomerSale[]>([])
  const [loading, setLoading]   = useState(true)
  const [payModal, setPayModal] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [paying, setPaying]     = useState(false)
  const [tiers, setTiers]       = useState<PriceTier[]>([])
  const [savingTier, setSavingTier] = useState(false)
  const [cars, setCars]         = useState<CustomerVehicle[]>([])
  const [carModal, setCarModal] = useState(false)
  const [carForm, setCarForm]   = useState({ brand: '', model: '', year: '', vin: '', notes: '' })
  const [savingCar, setSavingCar] = useState(false)
  const [deleteModal, setDeleteModal] = useState(false)
  const [deleting, setDeleting]       = useState(false)
  const [confirmingCarId, setConfirmingCarId] = useState<string | null>(null)
  const [customerOrders, setCustomerOrders] = useState<any[]>([])

  const load = useCallback(async () => {
    if (!id) return
    try {
      const [{ data }, { data: s }, tiersRes, { data: carsData }, ordersRes] = await Promise.all([
        customerApi.get(id),
        customerApi.getSales(id),
        pricingApi.listTiers(),
        customerVehiclesApi.list(id),
        api.get<{ data: any[] }>(`/api/v1/customer-orders?customer_id=${id}&per_page=20`).catch(() => ({ data: [] })),
      ])
      setCustomer(data)
      setSales(s)
      setTiers(tiersRes.data)
      setCars(carsData)
      setCustomerOrders(ordersRes.data ?? [])
    } catch {
      navigate('/customers')
    } finally {
      setLoading(false)
    }
  }, [id, navigate])

  useEffect(() => { load() }, [load])

  async function handleSetTier(tierId: string) {
    if (!customer) return
    setSavingTier(true)
    try {
      await customerApi.update(customer.id, { price_tier_id: tierId || null } as Parameters<typeof customerApi.update>[1])
      load()
      toast.success('Ціновий рівень збережено')
    } catch { toast.error('Помилка збереження') } finally { setSavingTier(false) }
  }

  async function handleDelete() {
    if (!customer) return
    setDeleting(true)
    try {
      await customerApi.delete(customer.id)
      toast.success('Клієнта видалено')
      navigate('/customers')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
      setDeleting(false)
    }
  }

  async function handlePayDebt() {
    if (!customer || !payAmount) return
    const kopecks = Math.round(parseFloat(payAmount) * 100)
    if (kopecks <= 0) { toast.error('Вкажіть суму більше 0'); return }

    setPaying(true)
    try {
      const { data } = await customerApi.payDebt(customer.id, kopecks)
      setCustomer(data)
      setPayModal(false)
      setPayAmount('')
      toast.success(`Борг погашено на ${formatMoney(kopecks)}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setPaying(false)
    }
  }

  if (loading || !customer) return (
    <Layout><div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div></Layout>
  )

  return (
    <Layout
      title={`${customer.full_name ?? customer.phone}${customer.primary_vin ? `  ${customer.primary_vin}` : ''}`}
      actions={
        <div className="flex gap-2">
          <Button size="sm" icon={<ClipboardList size={14} />}
            onClick={() => navigate(`/orders/new?customer_id=${customer.id}`)}>
            Замовлення
          </Button>
          <Button variant="secondary" size="sm" icon={<Edit size={14} />} onClick={() => navigate(`/customers/${customer.id}/edit`)}>
            Редагувати
          </Button>
          <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => setDeleteModal(true)}>
            Видалити
          </Button>
        </div>
      }
    >
      <div className="max-w-3xl space-y-4">

        {/* Основна інфо */}
        <Card>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Телефон</p>
              <p className="font-mono font-semibold text-gray-900">{customer.phone}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Email</p>
              <p className="text-sm text-gray-800">{customer.email ?? '—'}</p>
            </div>
          </div>
          {/* Ціновий рівень */}
          {tiers.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <p className="text-xs text-gray-400 mb-1">Ціновий рівень</p>
              <select
                disabled={savingTier}
                value={(customer as unknown as Record<string, unknown>)['price_tier_id'] as string ?? ''}
                onChange={(e) => handleSetTier(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:opacity-60"
              >
                <option value="">Стандартна ціна</option>
                {tiers.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} (-{t.discount_pct}%)</option>
                ))}
              </select>
            </div>
          )}

          {/* VIP та Risk */}
          <div className="flex gap-3 mt-3 pt-3 border-t border-gray-100">
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">VIP рівень</label>
              <select value={customer.vip_level}
                onChange={async (e) => {
                  const val = e.target.value as Customer['vip_level']
                  try {
                    await customerApi.update(customer.id, { vip_level: val })
                    setCustomer((prev) => prev ? { ...prev, vip_level: val } : prev)
                    toast.success('VIP рівень оновлено')
                  } catch { toast.error('Помилка') }
                }}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 w-full">
                <option value="standard">Standard</option>
                <option value="bronze">🥉 Bronze</option>
                <option value="silver">🥈 Silver</option>
                <option value="gold">🥇 Gold</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">Ризик-профіль</label>
              <select value={customer.risk_profile}
                onChange={async (e) => {
                  const val = e.target.value as Customer['risk_profile']
                  try {
                    await customerApi.update(customer.id, { risk_profile: val })
                    setCustomer((prev) => prev ? { ...prev, risk_profile: val } : prev)
                    toast.success('Ризик-профіль оновлено')
                  } catch { toast.error('Помилка') }
                }}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 w-full">
                <option value="low">🟢 Низький</option>
                <option value="medium">🟡 Середній</option>
                <option value="high">🔴 Високий</option>
              </select>
            </div>
          </div>

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

        {/* Борг */}
        <Card className={customer.debt_balance > 0 ? 'border-red-200 bg-red-50' : ''}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Поточний борг</p>
              <p className={`text-2xl font-bold ${customer.debt_balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {customer.debt_balance > 0 ? formatMoney(customer.debt_balance) : 'Без боргу'}
              </p>
            </div>
            {customer.debt_balance > 0 && (
              <Button icon={<CreditCard size={16} />} onClick={() => setPayModal(true)}>
                Погасити борг
              </Button>
            )}
          </div>
        </Card>

        {/* Автомобілі */}
        <Card padding="none">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Car size={16} className="text-gray-400" />
              <h3 className="font-semibold text-gray-800 text-sm">Автомобілі ({cars.length})</h3>
            </div>
            <Button size="sm" variant="outline" icon={<Plus size={14} />} onClick={() => setCarModal(true)}>
              Додати авто
            </Button>
          </div>
          {cars.length === 0 ? (
            <p className="px-6 py-8 text-center text-gray-400 text-sm">Автомобілів ще не додано</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {cars.map((car) => (
                <div key={car.id} className="px-6 py-3 flex items-center justify-between text-sm">
                  <div>
                    <p className="font-semibold text-gray-900">{car.brand} {car.model}</p>
                    <div className="flex gap-3 text-xs text-gray-500 mt-0.5">
                      {car.year && <span>{car.year} р.</span>}
                      {car.vin && (
                        <span className="font-mono flex items-center gap-1">
                          VIN: {car.vin}
                          <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(car.vin!); toast.success('VIN скопійовано') }}
                            className="text-gray-400 hover:text-gray-600" title="Скопіювати VIN">
                            <Copy size={10} />
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    title={confirmingCarId === car.id ? 'Натисніть ще раз для підтвердження' : 'Видалити авто'}
                    onClick={async () => {
                      if (confirmingCarId !== car.id) { setConfirmingCarId(car.id); return }
                      setConfirmingCarId(null)
                      await customerVehiclesApi.delete(id!, car.id)
                      setCars((prev) => prev.filter((c) => c.id !== car.id))
                      toast.success('Авто видалено')
                    }}
                    onBlur={() => setConfirmingCarId(null)}
                    className={confirmingCarId === car.id ? 'text-red-600' : 'text-red-300 hover:text-red-500'}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Бонуси */}
        <Card>
          <CustomerLoyalty customerId={customer.id} />
        </Card>

        {/* Нотатки */}
        <Card>
          <CustomerNotes customerId={customer.id} />
        </Card>

        {/* Уподобання сповіщень */}
        <Card>
          <CustomerPreferences customerId={customer.id} />
        </Card>

        {/* Замовлення клієнта */}
        <Card padding="none">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ClipboardList size={16} className="text-gray-400" />
              <h3 className="font-semibold text-gray-800 text-sm">Замовлення ({customerOrders.length})</h3>
            </div>
            <button
              onClick={() => navigate(`/orders/new?customer_id=${customer.id}`)}
              className="text-xs text-yellow-600 hover:text-yellow-700 font-medium flex items-center gap-1"
            >
              <Plus size={12} /> Нове
            </button>
          </div>
          {customerOrders.length === 0 ? (
            <p className="px-6 py-6 text-center text-gray-400 text-sm">Замовлень ще немає</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {customerOrders.map((o: any) => {
                const isDraft = o.status === 'lead' && ['walk_in', 'mobile_draft'].includes(o.source)
                const statusLabel: Record<string, string> = {
                  lead: 'Лід', new: 'Нове', in_progress: 'В дорозі',
                  ready: 'До видачі', completed: 'Видано', canceled: 'Скасовано',
                }
                const statusColor: Record<string, string> = {
                  lead: 'bg-blue-100 text-blue-700', new: 'bg-gray-100 text-gray-600',
                  in_progress: 'bg-yellow-100 text-yellow-700', ready: 'bg-green-100 text-green-700',
                  completed: 'bg-green-100 text-green-700', canceled: 'bg-red-100 text-red-700',
                }
                return (
                  <button
                    key={o.id}
                    onClick={() => navigate(isDraft ? `/quotes/${o.id}` : `/orders/${o.id}`)}
                    className="w-full px-6 py-3 flex items-center justify-between text-sm hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${statusColor[o.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {isDraft ? 'Чернетка' : (statusLabel[o.status] ?? o.status)}
                      </span>
                      <span className="text-gray-500 font-mono text-xs shrink-0">
                        {o.kp_number ?? `#${o.id.slice(0, 8)}`}
                      </span>
                      {o.vehicle_info?.make && (
                        <span className="text-gray-400 text-xs truncate">
                          🚗 {o.vehicle_info.make} {o.vehicle_info.model}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-2">
                      {o.total_amount > 0 && (
                        <span className="font-semibold text-gray-900">{formatMoney(o.total_amount)}</span>
                      )}
                      <span className="text-gray-400 text-xs">{new Date(o.created_at).toLocaleDateString('uk-UA')}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </Card>

        {/* Історія покупок */}
        <Card padding="none">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
            <ShoppingBag size={16} className="text-gray-400" />
            <h3 className="font-semibold text-gray-800 text-sm">Каса — чеки ({sales.length})</h3>
          </div>
          {sales.length === 0 ? (
            <p className="px-6 py-8 text-center text-gray-400 text-sm">Покупок ще немає</p>
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

      {/* Модалка додавання авто */}
      <Modal open={carModal} onClose={() => setCarModal(false)} title="Додати автомобіль" size="sm">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Марка *</label>
              <input value={carForm.brand} onChange={(e) => setCarForm({ ...carForm, brand: e.target.value })}
                placeholder="Toyota, BMW..."
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Модель *</label>
              <input value={carForm.model} onChange={(e) => setCarForm({ ...carForm, model: e.target.value })}
                placeholder="Camry, X5..."
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Рік</label>
              <input type="number" min="1900" max="2100"
                value={carForm.year} onChange={(e) => setCarForm({ ...carForm, year: e.target.value })}
                placeholder="2012"
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">VIN-код</label>
              <input value={carForm.vin} onChange={(e) => setCarForm({ ...carForm, vin: e.target.value.toUpperCase() })}
                maxLength={17} placeholder="17 символів"
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Нотатки</label>
            <textarea value={carForm.notes} onChange={(e) => setCarForm({ ...carForm, notes: e.target.value })}
              rows={2} placeholder="Додаткова інформація..."
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none" />
          </div>
          <div className="flex gap-3">
            <Button loading={savingCar} onClick={async () => {
              if (!carForm.brand.trim() || !carForm.model.trim()) {
                toast.error('Марка та модель обов\'язкові'); return
              }
              setSavingCar(true)
              try {
                const { data } = await customerVehiclesApi.create(id!, {
                  brand: carForm.brand.trim(),
                  model: carForm.model.trim(),
                  year: carForm.year ? parseInt(carForm.year) : null,
                  vin: carForm.vin.trim() || null,
                  notes: carForm.notes.trim() || null,
                })
                setCars((prev) => [data, ...prev])
                setCarModal(false)
                setCarForm({ brand: '', model: '', year: '', vin: '', notes: '' })
                toast.success('Автомобіль додано')
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Помилка')
              } finally { setSavingCar(false) }
            }} className="flex-1">
              Зберегти
            </Button>
            <Button variant="secondary" onClick={() => setCarModal(false)}>Скасувати</Button>
          </div>
        </div>
      </Modal>

      {/* Модалка погашення боргу */}
      <Modal open={payModal} onClose={() => setPayModal(false)} title="Погасити борг" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Поточний борг: <strong className="text-red-600">{formatMoney(customer.debt_balance)}</strong>
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Сума оплати (грн)</label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              max={(customer.debt_balance / 100).toFixed(2)}
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div className="flex gap-3">
            <Button loading={paying} onClick={handlePayDebt} className="flex-1">
              Підтвердити оплату
            </Button>
            <Button variant="secondary" onClick={() => setPayModal(false)}>Скасувати</Button>
          </div>
        </div>
      </Modal>

      <Modal open={deleteModal} onClose={() => setDeleteModal(false)} title="Видалити клієнта?" size="sm">
        <p className="text-sm text-gray-600 mb-6">
          Клієнта <span className="font-medium">"{customer?.full_name ?? customer?.phone}"</span> буде видалено.
          Цю дію не можна скасувати.
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
