import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Phone, Copy, Edit, ExternalLink, CreditCard } from 'lucide-react'
import { customerApi } from './customerApi'
import { customerVehiclesApi } from './customerVehiclesApi'
import type { Customer, CustomerSale, CustomerVehicle } from '@/types/customer'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDateTime } from '@/lib/utils'

interface Props {
  customerId: string | null
  onClose: () => void
}

export function CustomerDrawer({ customerId, onClose }: Props) {
  const navigate = useNavigate()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [sales, setSales] = useState<CustomerSale[]>([])
  const [cars, setCars] = useState<CustomerVehicle[]>([])
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<'info' | 'orders' | 'chat'>('info')

  useEffect(() => {
    if (!customerId) { setCustomer(null); return }
    setLoading(true)
    Promise.all([
      customerApi.get(customerId),
      customerApi.getSales(customerId),
      customerVehiclesApi.list(customerId),
    ]).then(([c, s, v]) => {
      setCustomer(c.data)
      setSales(s.data)
      setCars(v.data)
    }).catch(() => {
      toast.error('Не вдалося завантажити клієнта')
      onClose()
    }).finally(() => setLoading(false))
  }, [customerId, onClose])

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text)
    toast.success(`Скопійовано: ${label}`)
  }

  if (!customerId) return null

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed top-0 right-0 z-50 h-full w-full max-w-md bg-white shadow-2xl flex flex-col animate-slide-left">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-yellow-100 text-yellow-700 flex items-center justify-center text-base font-bold shrink-0">
              {customer ? (customer.full_name ?? customer.phone)[0].toUpperCase() : '?'}
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-gray-900 text-sm truncate">
                {customer?.full_name ?? 'Завантаження...'}
                {customer?.primary_vin && (
                  <button onClick={() => copy(customer.primary_vin!, 'VIN')}
                    className="font-mono text-[10px] text-gray-400 hover:text-yellow-700 ml-2 uppercase transition-colors"
                    title="Копіювати VIN">
                    {customer.primary_vin}
                  </button>
                )}
              </p>
              {customer && (
                <button onClick={() => copy(customer.phone, 'телефон')}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-yellow-700 mt-0.5">
                  <Phone size={11} />
                  {customer.phone}
                  <Copy size={10} className="opacity-40" />
                </button>
              )}
            </div>
          </div>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Завантаження...</div>
        ) : !customer ? null : (
          <div className="flex-1 overflow-y-auto">
            {/* VIP / Борг / Ризик */}
            <div className="flex gap-2 px-5 pt-4 pb-2">
              {customer.vip_level && customer.vip_level !== 'standard' && (
                <span className={`text-xs font-bold px-2 py-1 rounded ${
                  customer.vip_level === 'gold' ? 'bg-yellow-100 text-yellow-700' :
                  customer.vip_level === 'silver' ? 'bg-gray-200 text-gray-600' :
                  'bg-orange-100 text-orange-600'
                }`}>
                  {customer.vip_level === 'gold' ? '🥇 Gold' : customer.vip_level === 'silver' ? '🥈 Silver' : '🥉 Bronze'}
                </span>
              )}
              {customer.debt_balance > 0 && (
                <span className="text-xs font-semibold text-red-600 bg-red-50 px-2 py-1 rounded">
                  Борг: {formatMoney(customer.debt_balance)}
                </span>
              )}
              {customer.risk_profile === 'high' && (
                <span className="text-xs font-semibold text-red-600 bg-red-50 px-2 py-1 rounded">
                  ⚠️ Проблемний
                </span>
              )}
            </div>

            {/* Таби */}
            <div className="flex gap-0 px-5 border-b border-gray-100">
              {(['info', 'orders'] as const).map((t) => (
                <button key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                    tab === t
                      ? 'border-yellow-400 text-gray-900'
                      : 'border-transparent text-gray-400 hover:text-gray-600'
                  }`}
                >
                  {t === 'info' ? '📋 Інфо' : '📦 Замовлення'}
                </button>
              ))}
            </div>

            {/* Інфо */}
            {tab === 'info' && (
              <div className="px-5 py-4 space-y-4">
                {/* Контакти */}
                <div className="space-y-2">
                  <h4 className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">Контакти</h4>
                  <div className="bg-gray-50 rounded-lg p-3 space-y-2">
                    <DetailRow label="Телефон" value={customer.phone}
                      actions={
                        <button onClick={() => copy(customer.phone, 'телефон')}
                          className="text-gray-400 hover:text-yellow-600 p-1">
                          <Copy size={13} />
                        </button>
                      } />
                    {customer.email && <DetailRow label="Email" value={customer.email} />}
                    {customer.notes && (
                      <div>
                        <p className="text-[10px] text-gray-400 mb-0.5">Нотатки</p>
                        <p className="text-xs text-gray-700">{customer.notes}</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Автомобілі */}
                <div className="space-y-2">
                  <h4 className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
                    🚗 Автомобілі ({cars.length})
                  </h4>
                  {cars.length === 0 ? (
                    <p className="text-xs text-gray-400">Не додано</p>
                  ) : (
                    <div className="space-y-1.5">
                      {cars.slice(0, 3).map((car) => (
                        <div key={car.id} className="bg-gray-50 rounded-lg px-3 py-2.5">
                          <p className="text-sm font-semibold text-gray-900">{car.brand} {car.model}</p>
                          <div className="flex gap-3 text-xs text-gray-500 mt-0.5">
                            {car.year && <span>{car.year} р.</span>}
                            {car.vin && (
                              <span className="font-mono flex items-center gap-1">
                                VIN: {car.vin.slice(0, 8)}…
                                <button onClick={() => copy(car.vin!, 'VIN')}
                                  className="text-gray-400 hover:text-yellow-600">
                                  <Copy size={10} />
                                </button>
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Швидкі дії */}
                <div className="space-y-1.5">
                  <button
                    onClick={() => navigate(`/customers/${customer.id}/edit`)}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg bg-gray-50 hover:bg-gray-100 text-sm text-gray-700 transition-colors text-left"
                  >
                    <Edit size={15} className="text-gray-400" />
                    Редагувати клієнта
                  </button>
                  <button
                    onClick={() => copy(`+${customer.phone.replace(/\D/g, '')}`, 'номер для дзвінка')}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg bg-gray-50 hover:bg-gray-100 text-sm text-gray-700 transition-colors text-left"
                  >
                    <CreditCard size={15} className="text-gray-400" />
                    Копіювати номер
                  </button>
                  <button
                    onClick={() => navigate(`/customers/${customer.id}`)}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg bg-yellow-50 hover:bg-yellow-100 text-sm font-medium text-yellow-800 transition-colors text-left"
                  >
                    <ExternalLink size={15} />
                    Відкрити в CRM
                  </button>
                </div>
              </div>
            )}

            {/* Замовлення */}
            {tab === 'orders' && (
              <div className="px-5 py-4">
                {sales.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">Покупок ще немає</p>
                ) : (
                  <div className="space-y-1.5">
                    {sales.map((s) => (
                      <div key={s.id}
                        className="flex items-center justify-between px-3.5 py-2.5 bg-gray-50 rounded-lg text-sm">
                        <div>
                          <span className="font-mono text-xs text-gray-500">#{s.sale_number}</span>
                          <span className="text-gray-300 mx-1.5">·</span>
                          <span className="text-xs text-gray-500">{formatDateTime(s.completed_at)}</span>
                        </div>
                        <span className="font-semibold text-gray-900 text-sm">
                          {formatMoney(s.total)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function DetailRow({ label, value, actions }: { label: string; value: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-[10px] text-gray-400">{label}</p>
        <p className="text-sm font-medium text-gray-800">{value}</p>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  )
}
