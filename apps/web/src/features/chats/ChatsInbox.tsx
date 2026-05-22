import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Send, MessageSquare, User, Car, Plus, Trash2,
  ClipboardList, ExternalLink, Phone, X, Check,
  RefreshCw, Search,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button, Modal, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatDateTime, formatMoney } from '@/lib/utils'
import { customerVehiclesApi } from '@/features/customers/customerVehiclesApi'
import { customerApi } from '@/features/customers/customerApi'
import { orderApi, type OrderSource } from '@/features/orders/orderApi'
import { Sidebar } from '@/components/Sidebar'
import type { CustomerVehicle } from '@/types/customer'

type Vehicle = CustomerVehicle

interface Chat {
  id: string; channel_id: string; platform_chat_id: string
  customer_id: string | null; username: string | null
  first_name: string | null; phone: string | null
  last_message_at: string | null; unread_count: number
  channel: { id: string; name: string; platform: string }
  customer: { id: string; phone: string; full_name: string | null } | null
}

interface Message {
  id: string; chat_id: string
  sender_type: 'customer' | 'manager' | 'bot'
  text: string; created_at: string
}

interface CustomerOrder {
  id: string; status: string; total_amount: number; created_at: string
  items: Array<{ name: string }>
}

interface CustomerSearchResult {
  id: string; phone: string; full_name: string | null
}

const PLATFORM_COLORS: Record<string, string> = {
  telegram: 'bg-blue-500',
  viber:    'bg-purple-500',
  whatsapp: 'bg-green-500',
}
const PLATFORM_LABELS: Record<string, string> = { telegram: 'TG', viber: 'VB', whatsapp: 'WA' }

const ORDER_STATUS: Record<string, string> = {
  lead: 'Лід', new: 'Нове', in_progress: 'В дорозі',
  ordered: 'Замовлено', arrived: 'Прибуло', called: 'Повідомлено',
  no_answer: 'Не відповідає', ready: 'До видачі',
  completed: 'Видано', canceled: 'Скасовано',
}

const VIN_REGEX = /[A-HJ-NPR-Z0-9]{17}/gi

const VIN_WMI: Record<string, string> = {
  WBA: 'BMW', WBS: 'BMW', WDB: 'Mercedes-Benz', WDD: 'Mercedes-Benz',
  WAU: 'Audi', WUA: 'Audi', WVW: 'Volkswagen', VF1: 'Renault',
  JTD: 'Toyota', JHM: 'Honda', KMH: 'Hyundai', KNA: 'Kia',
  SAL: 'Land Rover', YV1: 'Volvo', ZAR: 'Alfa Romeo', ZFA: 'Fiat',
  WF0: 'Ford', W0L: 'Opel', JSA: 'Mazda', TMB: 'Škoda',
}

function vinMake(vin: string): string {
  return VIN_WMI[vin.slice(0, 4).toUpperCase()] ?? VIN_WMI[vin.slice(0, 3).toUpperCase()] ?? 'Авто'
}

function avatarLetter(chat: Chat): string {
  const name = chat.customer?.full_name ?? chat.first_name ?? chat.username
  return name ? name[0].toUpperCase() : '#'
}

function chatLabel(chat: Chat): string {
  return chat.customer?.full_name ?? chat.first_name ?? chat.username ?? `ID ${chat.platform_chat_id.slice(0, 6)}`
}

// ─── Права панель клієнта ─────────────────────────────────────────────────────
function CustomerPanel({ chat, messages, onCustomerLinked, onChatOrdersChanged }: {
  chat: Chat
  messages: Message[]
  onCustomerLinked: (customerId: string) => void
  onChatOrdersChanged?: () => void
}) {
  const navigate = useNavigate()
  const customer = chat.customer
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [orders, setOrders] = useState<CustomerOrder[]>([])
  const [chatOrders, setChatOrders] = useState<CustomerOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [showAddVehicle, setShowAddVehicle] = useState(false)
  const [vehicleForm, setVehicleForm] = useState({ brand: '', model: '', year: '', vin: '' })
  const [savingV, setSavingV] = useState(false)
  const [addingVin, setAddingVin] = useState<string | null>(null)
  const [showOrderModal, setShowOrderModal] = useState(false)
  const [searchPhone, setSearchPhone] = useState('')
  const [searchResults, setSearchResults] = useState<CustomerSearchResult[]>([])
  const [linking, setLinking] = useState(false)

  const loadData = useCallback(() => {
    setLoading(true)
    const promises: Promise<unknown>[] = [
      api.get<{ data: CustomerOrder[] }>(`/api/v1/customer-orders?chat_id=${chat.id}&per_page=10`, { silent: true })
        .then((r) => setChatOrders(r.data ?? []))
        .catch(() => { setChatOrders([]) }),
    ]

    if (customer?.id) {
      promises.push(
        customerVehiclesApi.list(customer.id).then((r) => setVehicles(r.data ?? [])),
        api.get<{ data: CustomerOrder[] }>(`/api/v1/customer-orders?customer_id=${customer.id}&per_page=5`, { silent: true })
          .then((r) => setOrders(r.data ?? []))
          .catch(() => {}),
      )
    } else {
      setVehicles([])
      setOrders([])
    }

    Promise.all(promises).finally(() => setLoading(false))
  }, [chat.id, customer?.id])

  useEffect(() => { loadData() }, [loadData])

  // VIN-коди, що з'явились у переписці
  const detectedVins = useMemo(() => {
    const out = new Set<string>()
    for (const msg of messages) {
      if (!msg.text) continue
      const matches = msg.text.match(VIN_REGEX)
      if (matches) matches.forEach((v) => out.add(v.toUpperCase()))
    }
    return Array.from(out)
  }, [messages])

  async function addDetectedVin(vin: string) {
    if (!customer?.id) return
    setAddingVin(vin)
    try {
      const make = vinMake(vin)
      const { data } = await customerVehiclesApi.create(customer.id, {
        brand: make,
        model: 'VIN: ' + vin.slice(0, 8),
        vin,
      })
      setVehicles((prev) => [...prev, data])
      toast.success(`Авто з VIN ${vin} додано в гараж`)
    } catch {
      toast.error('Помилка додавання авто')
    } finally {
      setAddingVin(null)
    }
  }

  useEffect(() => {
    if (searchPhone.trim().length < 3) { setSearchResults([]); return }
    const t = setTimeout(() => {
      customerApi.list({ search: searchPhone.trim(), per_page: 5 })
        .then((r) => setSearchResults(r.data ?? []))
        .catch(() => {})
    }, 400)
    return () => clearTimeout(t)
  }, [searchPhone])

  async function linkCustomer(customerId: string) {
    setLinking(true)
    try {
      await api.patch(`/api/v1/chats/${chat.id}/link-customer`, { customer_id: customerId })
      toast.success('Клієнта прив\'язано')
      onCustomerLinked(customerId)
      setSearchPhone(''); setSearchResults([])
    } catch { toast.error('Помилка прив\'язки') }
    finally { setLinking(false) }
  }

  async function addVehicle() {
    if (!customer?.id || !vehicleForm.brand || !vehicleForm.model) { toast.error('Введіть марку та модель'); return }
    setSavingV(true)
    try {
      const { data } = await customerVehiclesApi.create(customer.id, {
        brand: vehicleForm.brand.trim(), model: vehicleForm.model.trim(),
        year: vehicleForm.year ? parseInt(vehicleForm.year) : null,
        vin: vehicleForm.vin.trim() || null,
      })
      setVehicles((prev) => [...prev, data])
      setVehicleForm({ brand: '', model: '', year: '', vin: '' })
      setShowAddVehicle(false)
      toast.success('Авто додано')
    } catch { toast.error('Помилка') }
    finally { setSavingV(false) }
  }

  return (
    <div className="w-80 shrink-0 flex flex-col gap-3 overflow-y-auto bg-gray-50 border-l border-gray-200 p-4">

      {/* Клієнт */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
          <User size={13} /> Клієнт
        </p>
        {customer ? (
          <div className="flex items-start justify-between">
            <div>
              <p className="font-bold text-gray-900">{customer.full_name ?? 'Без імені'}</p>
              <p className="text-sm text-gray-500 flex items-center gap-1 mt-1">
                <Phone size={12} /> {customer.phone}
              </p>
            </div>
            <button onClick={() => navigate('/customers/' + customer.id)}
              className="text-blue-500 hover:text-blue-700 p-1.5 hover:bg-blue-50 rounded-lg transition-colors">
              <ExternalLink size={15} />
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-gray-400">Клієнта не прив'язано</p>
            <Input placeholder="Пошук по телефону / імені..." value={searchPhone}
              onChange={(e) => setSearchPhone(e.target.value)} />
            {searchResults.length > 0 && (
              <div className="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
                {searchResults.map((c) => (
                  <button key={c.id} onClick={() => linkCustomer(c.id)} disabled={linking}
                    className="w-full text-left px-3 py-2.5 hover:bg-yellow-50 text-sm border-b border-gray-50 last:border-0 transition-colors">
                    <span className="font-medium text-gray-900">{c.full_name ?? '—'}</span>
                    <span className="text-gray-400 ml-2 text-xs">{c.phone}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Замовлення цього чату */}
      <div className="bg-yellow-50/60 rounded-2xl border border-yellow-200 p-4 shadow-sm">
        <p className="text-xs font-bold text-yellow-700 uppercase tracking-widest mb-3 flex items-center gap-2">
          <ClipboardList size={13} /> Замовлення цього чату
        </p>
        {loading && chatOrders.length === 0 ? (
          <p className="text-sm text-gray-400">Завантаження...</p>
        ) : chatOrders.length === 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              Замовлень до цього чату ще немає. Створіть чернетку чи лід — клієнта можна прив'язати пізніше.
            </p>
            <Button onClick={() => setShowOrderModal(true)} icon={<Plus size={14} />} className="w-full">
              Нове замовлення
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {chatOrders.map((o) => (
              <div key={o.id} className="bg-white p-3 rounded-xl border border-gray-100 shadow-sm flex flex-col gap-1.5">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-gray-700">#{o.id.slice(0, 8)}</span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    o.status === 'lead' ? 'bg-blue-100 text-blue-800' :
                    o.status === 'completed' ? 'bg-green-100 text-green-800' :
                    o.status === 'canceled' ? 'bg-red-100 text-red-700' :
                    'bg-yellow-100 text-yellow-800'
                  }`}>
                    {ORDER_STATUS[o.status] ?? o.status}
                  </span>
                </div>
                <div className="text-sm font-semibold text-gray-900">{formatMoney(o.total_amount)}</div>
                {o.items && o.items.length > 0 && (
                  <p className="text-xs text-gray-500 truncate">{o.items.map((i) => i.name).join(', ')}</p>
                )}
                <button
                  onClick={() => navigate('/orders/' + o.id)}
                  className="mt-1 text-xs text-blue-500 font-medium hover:underline text-left flex items-center gap-1"
                >
                  Детальніше <ExternalLink size={12} />
                </button>
              </div>
            ))}
            <Button onClick={() => setShowOrderModal(true)} icon={<Plus size={14} />} className="w-full mt-2">
              Ще одне замовлення
            </Button>
          </div>
        )}
      </div>

      {/* Виявлені VIN-коди в чаті */}
      {customer && detectedVins.length > 0 && (
        <div className="bg-blue-50/60 rounded-2xl border border-blue-100 p-4 shadow-sm">
          <p className="text-xs font-bold text-blue-700 uppercase tracking-widest mb-2 flex items-center gap-2">
            🔑 Виявлені VIN-коди
          </p>
          <div className="space-y-2">
            {detectedVins.map((vin) => {
              const already = vehicles.some((v) => v.vin === vin)
              return (
                <div key={vin} className="flex flex-col gap-1 bg-white p-2.5 rounded-xl border border-gray-100">
                  <span className="text-xs font-mono font-bold text-gray-800 break-all">{vin}</span>
                  <span className="text-[10px] text-gray-400">Марка: {vinMake(vin)}</span>
                  {already ? (
                    <span className="text-[11px] text-green-600 font-medium flex items-center gap-1 mt-1">
                      <Check size={11} /> Вже в гаражі
                    </span>
                  ) : (
                    <button
                      onClick={() => addDetectedVin(vin)}
                      disabled={addingVin === vin}
                      className="mt-1 bg-blue-500 text-white rounded px-2 py-1 text-[11px] font-semibold hover:bg-blue-600 disabled:opacity-50 self-start transition-colors"
                    >
                      + Додати в гараж
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Авто */}
      {customer && (
        <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest flex items-center gap-2">
              <Car size={13} /> Автомобілі
            </p>
            <button onClick={() => setShowAddVehicle(!showAddVehicle)}
              className="text-yellow-500 hover:text-yellow-600 hover:bg-yellow-50 p-1 rounded-lg transition-colors">
              <Plus size={16} />
            </button>
          </div>
          {loading ? (
            <p className="text-sm text-gray-400">Завантаження...</p>
          ) : vehicles.length === 0 ? (
            <p className="text-sm text-gray-400">Авто не додано</p>
          ) : (
            <div className="space-y-2">
              {vehicles.map((v) => (
                <div key={v.id} className="flex items-start justify-between bg-gray-50 rounded-xl px-3 py-2.5">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">
                      {v.brand} {v.model} {v.year ? `(${v.year})` : ''}
                    </p>
                    {v.vin && <p className="text-xs font-mono text-gray-400 mt-0.5">{v.vin}</p>}
                  </div>
                  <button onClick={async () => {
                    if (!customer?.id) return
                    try { await customerVehiclesApi.delete(customer.id, v.id); setVehicles((p) => p.filter((x) => x.id !== v.id)) }
                    catch { toast.error('Помилка') }
                  }} className="text-gray-300 hover:text-red-400 ml-2 p-1 rounded transition-colors">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {showAddVehicle && (
            <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                {(['brand', 'model', 'year', 'vin'] as const).map((field) => (
                  <input key={field}
                    placeholder={field === 'brand' ? 'Марка *' : field === 'model' ? 'Модель *' : field === 'year' ? 'Рік' : 'VIN'}
                    type={field === 'year' ? 'number' : 'text'}
                    value={vehicleForm[field]}
                    onChange={(e) => setVehicleForm((f) => ({ ...f, [field]: field === 'vin' ? e.target.value.toUpperCase() : e.target.value }))}
                    className="border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300" />
                ))}
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={addVehicle} loading={savingV} className="flex-1">
                  <Check size={14} /> Зберегти
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setShowAddVehicle(false)}>
                  <X size={14} />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Інші замовлення клієнта (поза цим чатом) */}
      {customer && (() => {
        const others = orders.filter((o) => !chatOrders.some((co) => co.id === o.id))
        if (others.length === 0) return null
        return (
          <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
              <ClipboardList size={13} /> Інші замовлення клієнта
            </p>
            <div className="space-y-2">
              {others.slice(0, 4).map((o) => (
                <button
                  key={o.id}
                  onClick={() => navigate('/orders/' + o.id)}
                  className="flex items-center justify-between text-sm py-1 w-full text-left hover:bg-gray-50 rounded px-1"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-800 font-medium truncate">{o.items[0]?.name ?? 'Замовлення'}</p>
                    <p className="text-gray-400 text-xs">{ORDER_STATUS[o.status] ?? o.status}</p>
                  </div>
                  <span className="text-gray-700 font-semibold ml-3 shrink-0">{formatMoney(o.total_amount)}</span>
                </button>
              ))}
            </div>
          </div>
        )
      })()}

      {showOrderModal && (
        <QuickOrderModal
          customer={customer}
          vehicles={vehicles}
          source={'messenger' as OrderSource}
          chatId={chat.id}
          onClose={() => setShowOrderModal(false)}
          onCreated={() => {
            setShowOrderModal(false)
            toast.success('Замовлення створено!')
            loadData()
            onChatOrdersChanged?.()
          }}
        />
      )}
    </div>
  )
}

// ─── Модал замовлення ─────────────────────────────────────────────────────────
interface OrderItem { name: string; qty: string; sell_price: string }

function QuickOrderModal({ customer, vehicles, source, chatId, onClose, onCreated }: {
  customer: { id: string; phone: string; full_name: string | null } | null
  vehicles: Vehicle[]; source: OrderSource; chatId?: string
  onClose: () => void; onCreated: (id: string) => void
}) {
  const [vehicleId, setVehicleId] = useState('')
  const [comment, setComment] = useState('')
  const [prepayment, setPrepayment] = useState('0')
  const [method, setMethod] = useState<'cash' | 'card' | 'transfer'>('cash')
  const [items, setItems] = useState<OrderItem[]>([{ name: '', qty: '1', sell_price: '0' }])
  const [sendPrices, setSendPrices] = useState(true)
  const [saving, setSaving] = useState(false)

  const vehicle = vehicles.find((v) => v.id === vehicleId)
  const total = items.reduce((s, r) => s + Math.round(parseFloat(r.sell_price || '0') * 100) * (parseFloat(r.qty || '1') || 1), 0)

  function updateItem(i: number, key: keyof OrderItem, val: string) {
    setItems((prev) => prev.map((row, idx) => idx === i ? { ...row, [key]: val } : row))
  }

  async function handleCreate() {
    const validItems = items.filter((r) => r.name.trim())
    if (validItems.length === 0) { toast.error('Додайте хоча б одну позицію'); return }
    setSaving(true)
    try {
      const result = await orderApi.create({
        customer_id: customer?.id ?? null,
        chat_id: chatId ?? null,
        source,
        vehicle_info: vehicle ? { make: vehicle.brand, model: vehicle.model, year: vehicle.year ?? undefined, vin: vehicle.vin ?? undefined } : null,
        comment: comment.trim() || null,
        prepayment: Math.round(parseFloat(prepayment || '0') * 100),
        prepayment_method: parseFloat(prepayment) > 0 ? method : null,
        items: validItems.map((r) => ({
          name: r.name.trim(), qty: parseFloat(r.qty) || 1,
          sell_price: Math.round(parseFloat(r.sell_price || '0') * 100),
          buy_price: 0, source_type: 'supplier' as const,
        })),
      })
      if (!result?.data?.id) throw new Error('Сервер не повернув ID замовлення')

      // Надіслати ціни клієнту в чат
      if (sendPrices && chatId) {
        const priceLines = validItems.map((r, i) => {
          const price = (Math.round(parseFloat(r.sell_price || '0') * 100) / 100).toFixed(2)
          return `${i + 1}. ${r.name.trim()} — ${price} грн × ${parseFloat(r.qty) || 1}`
        }).join('\n')
        const msg = `🔧 *Нове замовлення #${result.data.id.slice(0, 8)}*\n\n${priceLines}\n\n💰 *Сума:* ${formatMoney(total)}\n\nМенеджер невдовзі зв'яжеться з вами! 🚀`
        api.post(`/api/v1/chats/${chatId}/send`, { text: msg }).catch(() => {})
      }

      onCreated(result.data.id)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
    finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title="Нове замовлення з чату" size="lg">
      <div className="space-y-4">
        <div className="bg-gray-50 rounded-xl p-3 text-sm">
          {customer ? (
            <p className="font-semibold text-gray-900">{customer.full_name ?? customer.phone}
              <span className="text-gray-400 font-normal ml-2">{customer.phone}</span>
            </p>
          ) : (
            <p className="font-semibold text-orange-600">
              Без прив'язаного клієнта — буде створено лід цього чату
            </p>
          )}
          {vehicles.length > 0 && (
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}
              className="mt-2 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300">
              <option value="">— Без авто —</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>{v.brand} {v.model} {v.year ? `(${v.year})` : ''}{v.vin ? ` — ${v.vin}` : ''}</option>
              ))}
            </select>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-gray-700">Позиції</p>
            <button onClick={() => setItems((p) => [...p, { name: '', qty: '1', sell_price: '0' }])}
              className="text-yellow-500 hover:text-yellow-600 text-xs font-medium flex items-center gap-1">
              <Plus size={13} /> Додати
            </button>
          </div>
          <div className="space-y-2">
            {items.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_70px_80px_28px] gap-2 items-center">
                <input placeholder="Назва деталі *" value={row.name} onChange={(e) => updateItem(i, 'name', e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300" />
                <input type="number" min="1" value={row.qty} onChange={(e) => updateItem(i, 'qty', e.target.value)}
                  className="border border-gray-200 rounded-lg px-2 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-yellow-300" />
                <input type="number" min="0" step="0.01" value={row.sell_price} onChange={(e) => updateItem(i, 'sell_price', e.target.value)}
                  className="border border-gray-200 rounded-lg px-2 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-yellow-300" />
                <button onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} disabled={items.length === 1}
                  className="text-gray-300 hover:text-red-400 disabled:opacity-30"><X size={16} /></button>
              </div>
            ))}
          </div>
          {total > 0 && (
            <p className="text-right mt-2 text-sm text-gray-600">
              Сума: <span className="font-bold text-gray-900">{formatMoney(total)}</span>
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={sendPrices} onChange={(e) => setSendPrices(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-yellow-500 focus:ring-yellow-400" />
          <span className="text-sm text-gray-700">📨 Надіслати ціни клієнту в чат</span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <Input label="Передоплата (грн)" type="number" min="0" step="0.01" value={prepayment} onChange={(e) => setPrepayment(e.target.value)} />
          {parseFloat(prepayment) > 0 && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Метод</label>
              <select value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'card' | 'transfer')}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300">
                <option value="cash">Готівка</option>
                <option value="card">Картка</option>
                <option value="transfer">Переказ</option>
              </select>
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Коментар</label>
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300 resize-none" />
        </div>

        <div className="flex gap-3">
          <Button onClick={handleCreate} loading={saving} className="flex-1">✅ Створити замовлення</Button>
          <Button variant="secondary" onClick={onClose}>Скасувати</Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Головний компонент ────────────────────────────────────────────────────────
export default function ChatsInbox() {
  const [chats, setChats]         = useState<Chat[]>([])
  const [activeChat, setActiveChat] = useState<Chat | null>(null)
  const [messages, setMessages]   = useState<Message[]>([])
  const [input, setInput]         = useState('')
  const [sending, setSending]     = useState(false)
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef       = useRef<HTMLInputElement>(null)

  const [searchParams, setSearchParams] = useSearchParams()
  const urlChatId = searchParams.get('chat_id')

  const loadChats = useCallback(() => {
    api.get<{ data: Chat[] }>('/api/v1/chats', { silent: true })
      .then((res) => {
        setChats(res.data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // Оновлення списку чатів кожні 5с
  useEffect(() => {
    loadChats()
    const t = setInterval(loadChats, 5000)
    return () => clearInterval(t)
  }, [loadChats])

  // Автовибір чату: спершу з URL ?chat_id=..., далі — перший зі списку
  useEffect(() => {
    if (chats.length === 0) return
    if (urlChatId) {
      const found = chats.find((c) => c.id === urlChatId)
      if (found) {
        if (activeChat?.id !== found.id) setActiveChat(found)
        // Очищуємо параметр, щоб не нав'язувати вибір при наступних рендерах
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev)
          next.delete('chat_id')
          return next
        }, { replace: true })
        return
      }
    }
    if (!activeChat) setActiveChat(chats[0])
  }, [chats, activeChat, urlChatId, setSearchParams])

  // Завантаження повідомлень активного чату кожні 2с
  const activeChatId = activeChat?.id
  useEffect(() => {
    if (!activeChatId) return
    function load() {
      api.get<{ data: Message[] }>(`/api/v1/chats/${activeChatId}/messages`, { silent: true })
        .then((res) => setMessages(res.data))
        .catch(() => {})
    }
    load()
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [activeChatId])

  // Авто-скрол вниз при нових повідомленнях
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function doSend() {
    if (!activeChat || !input.trim()) return
    const text = input.trim()
    setSending(true)
    setInput('')
    try {
      await api.post(`/api/v1/chats/${activeChat.id}/send`, { text })
      setMessages((prev) => [...prev, {
        id: Date.now().toString(), chat_id: activeChat.id,
        sender_type: 'manager', text, created_at: new Date().toISOString(),
      }])
    } catch { toast.error('Помилка відправлення') }
    finally { setSending(false); inputRef.current?.focus() }
  }

  function handleSend(e: React.FormEvent) {
    e.preventDefault()
    doSend()
  }

  function handleCustomerLinked(_customerId: string) {
    api.get<{ data: Chat[] }>('/api/v1/chats', { silent: true })
      .then((res) => {
        setChats(res.data)
        const updated = res.data.find((c) => c.id === activeChat?.id)
        if (updated) setActiveChat(updated)
      }).catch(() => {})
  }

  const filtered = search
    ? chats.filter((c) => {
        const label = chatLabel(c).toLowerCase()
        const s = search.toLowerCase()
        return label.includes(s) || c.customer?.phone?.includes(s)
      })
    : chats

  const totalUnread = chats.reduce((s, c) => s + c.unread_count, 0)

  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      <Sidebar />

      {/* ── Список чатів ──────────────────────────────────────────── */}
      <div className="w-80 shrink-0 bg-white border-r border-gray-200 flex flex-col">

        {/* Шапка */}
        <div className="px-4 py-4 border-b border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MessageSquare size={18} className="text-gray-700" />
              <h1 className="text-lg font-bold text-gray-900">Чати</h1>
              {totalUnread > 0 && (
                <span className="bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                  {totalUnread}
                </span>
              )}
            </div>
            <button onClick={loadChats} className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-100 transition-colors" title="Оновити">
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              placeholder="Пошук чату..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300 focus:border-transparent"
            />
          </div>
        </div>

        {/* Список */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-gray-400 text-sm">Завантаження...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4">
              <MessageSquare size={32} className="text-gray-200 mb-2" />
              <p className="text-gray-400 text-sm">{search ? 'Нічого не знайдено' : 'Чатів ще немає'}</p>
              {!search && <p className="text-gray-300 text-xs mt-1">Налаштуйте Telegram-бота у Канали зв'язку</p>}
            </div>
          ) : filtered.map((chat) => {
            const isActive = chat.id === activeChat?.id
            const letter = avatarLetter(chat)
            const label  = chatLabel(chat)
            const platformColor = PLATFORM_COLORS[chat.channel.platform] ?? 'bg-gray-400'

            return (
              <button key={chat.id} onClick={() => setActiveChat(chat)}
                className={`w-full text-left px-4 py-3.5 flex items-center gap-3 transition-colors border-b border-gray-50 ${
                  isActive ? 'bg-yellow-50 border-l-4 border-l-yellow-400' : 'hover:bg-gray-50 border-l-4 border-l-transparent'
                }`}>

                {/* Аватар */}
                <div className="relative shrink-0">
                  <div className="w-11 h-11 rounded-full bg-gradient-to-br from-gray-200 to-gray-300 flex items-center justify-center text-base font-bold text-gray-600">
                    {letter}
                  </div>
                  <span className={`absolute -bottom-0.5 -right-0.5 ${platformColor} text-white text-[9px] font-bold px-1 py-0.5 rounded`}>
                    {PLATFORM_LABELS[chat.channel.platform] ?? 'MSG'}
                  </span>
                </div>

                {/* Інфо */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-gray-900 text-sm truncate">{label}</p>
                    {chat.last_message_at && (
                      <span className="text-[11px] text-gray-400 shrink-0 ml-2">
                        {new Date(chat.last_message_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p className="text-xs text-gray-400 truncate">
                      {chat.customer ? chat.customer.phone : 'Клієнта не прив\'язано'}
                    </p>
                    {chat.unread_count > 0 && (
                      <span className="bg-green-500 text-white text-[10px] font-bold min-w-[20px] h-5 px-1.5 rounded-full flex items-center justify-center shrink-0 ml-2">
                        {chat.unread_count > 99 ? '99+' : chat.unread_count}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Центр: переписка ──────────────────────────────────────── */}
      {activeChat ? (
        <div className="flex-1 flex flex-col min-w-0 bg-white">

          {/* Шапка чату */}
          <div className="px-5 py-3.5 border-b border-gray-200 bg-white flex items-center gap-3 shrink-0 shadow-sm">
            <div className="relative shrink-0">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-gray-200 to-gray-300 flex items-center justify-center text-base font-bold text-gray-600">
                {avatarLetter(activeChat)}
              </div>
              <span className={`absolute -bottom-0.5 -right-0.5 ${PLATFORM_COLORS[activeChat.channel.platform] ?? 'bg-gray-400'} text-white text-[9px] font-bold px-1 py-0.5 rounded`}>
                {PLATFORM_LABELS[activeChat.channel.platform] ?? 'MSG'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-gray-900 text-base leading-tight truncate">
                {activeChat.customer?.full_name ?? activeChat.first_name ?? activeChat.username ?? 'Невідомий'}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {activeChat.customer?.phone ?? `ID: ${activeChat.platform_chat_id}`}
                {!activeChat.customer && <span className="text-orange-400 ml-2">● Клієнта не прив'язано</span>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={async () => {
                if (!confirm('Закрити чат? Після закриття нові повідомлення від клієнта створять новий чат.')) return
                try {
                  await api.patch(`/api/v1/chats/${activeChat.id}/resolve`, {})
                  toast.success('Чат закрито')
                  setActiveChat(null)
                  loadChats()
                } catch { toast.error('Помилка закриття чату') }
              }} className="text-gray-400 hover:text-red-500 p-1.5 rounded-lg hover:bg-red-50 transition-colors" title="Закрити чат">
                <span className="text-sm">🔒</span>
              </button>
            </div>
          </div>

          {/* Повідомлення */}
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-2"
            style={{ background: 'linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)' }}>
            {messages.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-gray-400 text-sm">Немає повідомлень</p>
              </div>
            ) : messages.map((msg, idx) => {
              const isCustomer = msg.sender_type === 'customer'
              const isBot      = msg.sender_type === 'bot'
              const prevMsg    = idx > 0 ? messages[idx - 1] : null
              const showTime   = !prevMsg || new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime() > 5 * 60_000

              return (
                <div key={msg.id}>
                  {showTime && (
                    <div className="flex justify-center my-3">
                      <span className="text-[11px] text-gray-400 bg-white px-3 py-1 rounded-full shadow-sm border border-gray-100">
                        {formatDateTime(msg.created_at)}
                      </span>
                    </div>
                  )}
                  <div className={`flex ${isCustomer ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[72%] px-4 py-2.5 text-[15px] leading-relaxed shadow-sm ${
                      isCustomer
                        ? 'bg-white text-gray-800 rounded-2xl rounded-tl-sm border border-gray-100'
                        : isBot
                          ? 'bg-yellow-50 text-gray-700 italic border border-yellow-200 rounded-2xl'
                          : 'bg-yellow-400 text-gray-900 rounded-2xl rounded-tr-sm'
                    }`}>
                      <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                    </div>
                  </div>
                </div>
              )
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* Поле вводу */}
          <form onSubmit={handleSend}
            className="px-5 py-4 border-t border-gray-200 bg-white flex gap-3 items-end shrink-0">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() } }}
              placeholder="Написати повідомлення... (Enter — надіслати)"
              className="flex-1 bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-[15px] focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:border-transparent resize-none"
              autoFocus
            />
            <button type="submit" disabled={sending || !input.trim()}
              className="bg-yellow-400 hover:bg-yellow-300 disabled:opacity-40 disabled:cursor-not-allowed text-gray-900 font-bold rounded-2xl w-12 h-12 flex items-center justify-center shrink-0 transition-colors shadow-sm">
              <Send size={18} />
            </button>
          </form>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-gray-50">
          <div className="text-center">
            <MessageSquare size={48} className="text-gray-200 mx-auto mb-4" />
            <p className="text-gray-500 text-base font-medium">Оберіть чат зі списку</p>
            <p className="text-gray-400 text-sm mt-1">або дочекайтесь нового повідомлення</p>
          </div>
        </div>
      )}

      {/* ── Права панель клієнта ──────────────────────────────────── */}
      {activeChat && (
        <CustomerPanel
          chat={activeChat}
          messages={messages}
          onCustomerLinked={handleCustomerLinked}
        />
      )}
    </div>
  )
}
