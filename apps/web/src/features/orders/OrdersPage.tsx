import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Plus, Phone, MessageSquare, Truck, FilePen, ClipboardList,
  AlertCircle, Search, Send, User, Car, ExternalLink,
  Trash2, X, Check, RefreshCw,
} from 'lucide-react'
import { api } from '@/lib/api'
import { orderApi } from './orderApi'
import { shiftApi } from '@/features/pos/shiftApi'
import { customerApi } from '@/features/customers/customerApi'
import { customerVehiclesApi } from '@/features/customers/customerVehiclesApi'
import { Menu } from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
import { Card, Badge, Button, Modal, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate, formatDateTime } from '@/lib/utils'
import type { CustomerVehicle } from '@/types/customer'
import { ToastContainer } from '@/components/ui'

// ───────────────────────── Constants ─────────────────────────

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

const PLATFORM_COLORS: Record<string, string> = {
  telegram: 'bg-blue-500',
  viber:    'bg-purple-500',
  whatsapp: 'bg-green-500',
}
const PLATFORM_LABELS: Record<string, string> = { telegram: 'TG', viber: 'VB', whatsapp: 'WA' }

type BadgeColor = 'green' | 'orange' | 'red' | 'blue' | 'gray' | 'yellow'

const STATUS_CONFIG: Record<string, { label: string; color: BadgeColor }> = {
  lead:       { label: 'Лід',         color: 'blue'   },
  new:        { label: 'Нове',         color: 'gray'   },
  ordered:    { label: 'Замовлено',    color: 'yellow' },
  arrived:    { label: 'Прибуло',      color: 'green'  },
  called:     { label: 'Повідомл.',    color: 'blue'   },
  no_answer:  { label: 'Не відповів',  color: 'orange' },
  ready:      { label: 'До видачі',    color: 'green'  },
  completed:  { label: 'Видано',       color: 'green'  },
  canceled:   { label: 'Скасовано',    color: 'red'    },
}

const SOURCE_CONFIG: Record<string, { label: string; icon: React.ReactNode }> = {
  walk_in:      { label: 'Магазин',   icon: <ClipboardList size={10} /> },
  phone:        { label: 'Телефон',   icon: <Phone size={10} /> },
  messenger:    { label: 'Чат',       icon: <MessageSquare size={10} /> },
  telegram_bot: { label: 'Telegram',  icon: <MessageSquare size={10} /> },
  mobile_draft: { label: 'Мобільний', icon: <FilePen size={10} /> },
}

const ITEM_STATUS_ACTIONS: Record<string, Array<{ status: string; label: string; icon: string }>> = {
  pending: [
    { status: 'ordered',  label: 'Замовлено', icon: '📥' },
    { status: 'canceled', label: 'Скасувати', icon: '❌' },
  ],
  ordered: [
    { status: 'arrived',  label: 'Приїхало',  icon: '📦' },
    { status: 'canceled', label: 'Скасувати', icon: '❌' },
  ],
  arrived: [
    { status: 'handed', label: 'Видано', icon: '✅' },
  ],
}

// ───────────────────────── Types ─────────────────────────

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

interface OrderItem {
  id: string
  sku: string | null
  name: string
  supplier_id: string | null
  source_type: string
  item_status: string
  buy_price: number
  sell_price: number
  qty: number
  expected_date: string | null
  variants?: Array<{ brand: string; price: number; is_recommended: boolean }>
  is_draft_note?: boolean
}

interface CustomerOrder {
  id: string
  kp_number: string | null
  customer_id: string | null
  manager_id: string
  vehicle_info: { make?: string; model?: string; year?: number; vin?: string } | null
  status: string
  source: string
  prepayment: number
  prepayment_method: string | null
  total_amount: number
  total_paid: number
  chat_id: string | null
  comment: string | null
  created_at: string
  sent_to_telegram_at: string | null
  pickup_deadline_at: string | null
  customer: { id: string; phone: string; full_name: string | null } | null
  items: OrderItem[]
}

interface CustomerSearchResult {
  id: string; phone: string; full_name: string | null
}

type Vehicle = CustomerVehicle

type Tab = 'all' | 'leads' | 'drafts' | 'bots' | 'active' | 'ready' | 'completed'

type Selection = { kind: 'chat'; id: string } | { kind: 'order'; id: string } | null

// ───────────────────────── Helpers ─────────────────────────

function avatarLetter(chat: Chat): string {
  const name = chat.customer?.full_name ?? chat.first_name ?? chat.username
  return name ? name[0].toUpperCase() : '#'
}

function chatLabel(chat: Chat): string {
  return chat.customer?.full_name ?? chat.first_name ?? chat.username ?? `ID ${chat.platform_chat_id.slice(0, 6)}`
}

function isDraft(o: CustomerOrder) {
  return o.status === 'lead' && (o.source === 'walk_in' || o.source === 'mobile_draft')
}
function isLead(o: CustomerOrder) {
  return o.status === 'lead' && !isDraft(o)
}

// ───────────────────────── Left list rows ─────────────────────────

function ChatRow({ chat, active, onClick }: {
  chat: Chat; active: boolean; onClick: () => void
}) {
  const letter = avatarLetter(chat)
  const label = chatLabel(chat)
  const platformColor = PLATFORM_COLORS[chat.channel.platform] ?? 'bg-gray-400'

  return (
    <button onClick={onClick}
      className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors border-b border-gray-50 ${
        active ? 'bg-yellow-50 border-l-4 border-l-yellow-400' : 'hover:bg-gray-50 border-l-4 border-l-transparent'
      }`}>
      <div className="relative shrink-0">
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-gray-200 to-gray-300 flex items-center justify-center text-sm font-bold text-gray-600">
          {letter}
        </div>
        <span className={`absolute -bottom-0.5 -right-0.5 ${platformColor} text-white text-[8px] font-bold px-1 py-0.5 rounded`}>
          {PLATFORM_LABELS[chat.channel.platform] ?? 'MSG'}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold text-gray-900 text-sm truncate">{label}</p>
          {chat.last_message_at && (
            <span className="text-[10px] text-gray-400 shrink-0">
              {new Date(chat.last_message_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <p className="text-[11px] text-gray-400 truncate">
            {chat.customer ? chat.customer.phone : 'Без клієнта'}
          </p>
          {chat.unread_count > 0 && (
            <span className="bg-green-500 text-white text-[10px] font-bold min-w-[18px] h-4 px-1.5 rounded-full flex items-center justify-center shrink-0">
              {chat.unread_count > 99 ? '99+' : chat.unread_count}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

function OrderRow({ order, active, onClick }: {
  order: CustomerOrder; active: boolean; onClick: () => void
}) {
  const conf = STATUS_CONFIG[order.status] ?? { label: order.status, color: 'gray' as BadgeColor }
  const srcConf = SOURCE_CONFIG[order.source] ?? { label: order.source, icon: <AlertCircle size={9} /> }
  const draft = isDraft(order)
  const name = order.customer?.full_name ?? order.customer?.phone ?? 'Без клієнта'
  return (
    <button onClick={onClick}
      className={`w-full text-left px-3 py-2.5 flex flex-col gap-1 transition-colors border-b border-gray-50 ${
        active ? 'bg-yellow-50 border-l-4 border-l-yellow-400' : 'hover:bg-gray-50 border-l-4 border-l-transparent'
      }`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[11px] text-gray-500 shrink-0">#{order.id.slice(0, 6)}</span>
          <span className="font-semibold text-sm text-gray-900 truncate">{name}</span>
        </div>
        <span className="text-[10px] text-gray-400 shrink-0">{formatDate(order.created_at)}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge color={conf.color}>{conf.label}</Badge>
          {draft && (
            <span className="text-[9px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-semibold">
              КП
            </span>
          )}
          <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
            {srcConf.icon}&nbsp;{srcConf.label}
          </span>
        </div>
        <span className="text-xs font-bold text-gray-700 shrink-0">
          {order.total_amount > 0 ? formatMoney(order.total_amount) : '—'}
        </span>
      </div>
    </button>
  )
}

// ───────────────────────── CustomerPanel (right) ─────────────────────────

function CustomerPanel({ chat, messages, onCustomerLinked }: {
  chat: Chat
  messages: Message[]
  onCustomerLinked: (customerId: string) => void
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
      setVehicles([]); setOrders([])
    }
    Promise.all(promises).finally(() => setLoading(false))
  }, [chat.id, customer?.id])

  useEffect(() => { loadData() }, [loadData])

  useEffect(() => {
    if (searchPhone.trim().length < 3) { setSearchResults([]); return }
    const t = setTimeout(() => {
      customerApi.list({ search: searchPhone.trim(), per_page: 5 })
        .then((r) => setSearchResults(r.data ?? []))
        .catch(() => {})
    }, 400)
    return () => clearTimeout(t)
  }, [searchPhone])

  const detectedVins = useMemo(() => {
    const out = new Set<string>()
    for (const m of messages) {
      if (!m.text) continue
      const matches = m.text.match(VIN_REGEX)
      if (matches) matches.forEach((v) => out.add(v.toUpperCase()))
    }
    return Array.from(out)
  }, [messages])

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

  async function addDetectedVin(vin: string) {
    if (!customer?.id) return
    setAddingVin(vin)
    try {
      const { data } = await customerVehiclesApi.create(customer.id, {
        brand: vinMake(vin), model: 'VIN: ' + vin.slice(0, 8), vin,
      })
      setVehicles((prev) => [...prev, data])
      toast.success(`Авто з VIN ${vin} додано`)
    } catch { toast.error('Помилка додавання авто') }
    finally { setAddingVin(null) }
  }

  return (
    <aside className="w-80 shrink-0 flex flex-col gap-3 overflow-y-auto bg-gray-50 border-l border-gray-200 p-4">

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
                  <Badge color={(STATUS_CONFIG[o.status]?.color ?? 'gray') as BadgeColor}>
                    {STATUS_CONFIG[o.status]?.label ?? o.status}
                  </Badge>
                </div>
                <div className="text-sm font-semibold text-gray-900">{formatMoney(o.total_amount)}</div>
                {o.items && o.items.length > 0 && (
                  <p className="text-xs text-gray-500 truncate">{o.items.map((i) => i.name).join(', ')}</p>
                )}
                <button onClick={() => navigate('/orders/' + o.id)}
                  className="mt-1 text-xs text-blue-500 font-medium hover:underline text-left flex items-center gap-1">
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

      {/* Виявлені VIN */}
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
                    <button onClick={() => addDetectedVin(vin)} disabled={addingVin === vin}
                      className="mt-1 bg-blue-500 text-white rounded px-2 py-1 text-[11px] font-semibold hover:bg-blue-600 disabled:opacity-50 self-start transition-colors">
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

      {/* Інші замовлення клієнта */}
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
                <button key={o.id} onClick={() => navigate('/orders/' + o.id)}
                  className="flex items-center justify-between text-sm py-1 w-full text-left hover:bg-gray-50 rounded px-1">
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-800 font-medium truncate">{o.items[0]?.name ?? 'Замовлення'}</p>
                    <p className="text-gray-400 text-xs">{STATUS_CONFIG[o.status]?.label ?? o.status}</p>
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
          chatId={chat.id}
          onClose={() => setShowOrderModal(false)}
          onCreated={() => { setShowOrderModal(false); toast.success('Замовлення створено'); loadData() }}
        />
      )}
    </aside>
  )
}

// ───────────────────────── QuickOrderModal ─────────────────────────

interface QuickOrderItem { name: string; qty: string; sell_price: string }

function QuickOrderModal({ customer, vehicles, chatId, onClose, onCreated }: {
  customer: { id: string; phone: string; full_name: string | null } | null
  vehicles: Vehicle[]; chatId?: string
  onClose: () => void; onCreated: () => void
}) {
  const [vehicleId, setVehicleId] = useState('')
  const [comment, setComment] = useState('')
  const [prepayment, setPrepayment] = useState('0')
  const [method, setMethod] = useState<'cash' | 'card' | 'transfer'>('cash')
  const [items, setItems] = useState<QuickOrderItem[]>([{ name: '', qty: '1', sell_price: '0' }])
  const [sendPrices, setSendPrices] = useState(true)
  const [saving, setSaving] = useState(false)
  const vehicle = vehicles.find((v) => v.id === vehicleId)
  const total = items.reduce((s, r) => s + Math.round(parseFloat(r.sell_price || '0') * 100) * (parseFloat(r.qty || '1') || 1), 0)

  function updateItem(i: number, key: keyof QuickOrderItem, val: string) {
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
        source: 'messenger',
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
      if (!result?.data?.id) throw new Error('Сервер не повернув ID')

      if (sendPrices && chatId) {
        const lines = validItems.map((r, i) => {
          const price = (Math.round(parseFloat(r.sell_price || '0') * 100) / 100).toFixed(2)
          return `${i + 1}. ${r.name.trim()} — ${price} грн × ${parseFloat(r.qty) || 1}`
        }).join('\n')
        const msg = `🔧 *Нове замовлення #${result.data.id.slice(0, 8)}*\n\n${lines}\n\n💰 *Сума:* ${formatMoney(total)}\n\nМенеджер зв'яжеться з вами! 🚀`
        api.post(`/api/v1/chats/${chatId}/send`, { text: msg }).catch(() => {})
      }
      onCreated()
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
            <p className="font-semibold text-orange-600">Без прив'язаного клієнта — буде створено лід цього чату</p>
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

        {chatId && (
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={sendPrices} onChange={(e) => setSendPrices(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-yellow-500 focus:ring-yellow-400" />
            <span className="text-sm text-gray-700">📨 Надіслати ціни клієнту в чат</span>
          </label>
        )}

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

// ───────────────────────── Main: OrdersPage ─────────────────────────

export default function OrdersPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const urlChatId = searchParams.get('chat_id')

  // дані
  const [chats, setChats] = useState<Chat[]>([])
  const [orders, setOrders] = useState<CustomerOrder[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingChats, setLoadingChats] = useState(true)
  const [loadingOrders, setLoadingOrders] = useState(true)

  // ui
  const [tab, setTab] = useState<Tab>('all')

  useEffect(() => {
    const urlTab = searchParams.get('tab') as Tab
    if (urlTab && ['all', 'leads', 'drafts', 'bots', 'active', 'ready', 'completed'].includes(urlTab)) {
      setTab(urlTab)
    }
  }, [searchParams])
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<Selection>(null)
  const [now] = useState(() => new Date())
  const [showCustPanelMobile, setShowCustPanelMobile] = useState(false)

  useEffect(() => {
    setShowCustPanelMobile(false)
  }, [selection])

  // композер
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLInputElement>(null)

  // модалки
  const [payModal, setPayModal] = useState<CustomerOrder | null>(null)
  const [payMethod, setPayMethod] = useState<'cash' | 'card' | 'mixed'>('cash')
  const [isFiscal, setIsFiscal] = useState(false)
  const [cancelModal, setCancelModal] = useState<CustomerOrder | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // bulk arrival
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkSupplier, setBulkSupplier] = useState('')
  const [bulkItems, setBulkItems] = useState<any[]>([])
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set())
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])

  // ── завантаження чатів ──
  const loadChats = useCallback(() => {
    api.get<{ data: Chat[] }>('/api/v1/chats', { silent: true })
      .then((r) => { setChats(r.data ?? []); setLoadingChats(false) })
      .catch(() => setLoadingChats(false))
  }, [])
  useEffect(() => {
    loadChats()
    const t = setInterval(loadChats, 5000)
    return () => clearInterval(t)
  }, [loadChats])

  // ── завантаження замовлень за вкладкою ──
  function tabParams(t: Tab): string {
    const p = new URLSearchParams({ per_page: '200' })
    if (t === 'active')    p.set('status', 'new,ordered,arrived,called,no_answer')
    if (t === 'ready')     p.set('status', 'ready')
    if (t === 'completed') p.set('status', 'completed,canceled')
    if (t === 'leads' || t === 'drafts') p.set('status', 'lead')
    return p.toString()
  }
  const loadOrders = useCallback(() => {
    setLoadingOrders(true)
    api.get<{ data: CustomerOrder[] }>(`/api/v1/customer-orders?${tabParams(tab)}`, { silent: true })
      .then((r) => setOrders(r.data ?? []))
      .catch(() => toast.error('Помилка завантаження замовлень'))
      .finally(() => setLoadingOrders(false))
  }, [tab])
  useEffect(() => {
    loadOrders()
    const t = setInterval(loadOrders, 60_000)
    return () => clearInterval(t)
  }, [loadOrders])

  // ── постачальники (для масового приймання) ──
  useEffect(() => {
    api.get<{ data: Array<{ id: string; name: string }> }>('/api/v1/suppliers?per_page=200', { silent: true })
      .then((r) => setSuppliers(r.data ?? []))
      .catch(() => {})
  }, [])

  // ── автовибір чату з URL ?chat_id= ──
  useEffect(() => {
    if (!urlChatId) return
    const found = chats.find((c) => c.id === urlChatId)
    if (found && (selection?.kind !== 'chat' || selection.id !== found.id)) {
      setSelection({ kind: 'chat', id: found.id })
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete('chat_id')
        return next
      }, { replace: true })
    }
  }, [urlChatId, chats, selection, setSearchParams])

  // ── повідомлення для активного чату ──
  const activeChatId = selection?.kind === 'chat' ? selection.id : null
  useEffect(() => {
    if (!activeChatId) { setMessages([]); return }
    function load() {
      api.get<{ data: Message[] }>(`/api/v1/chats/${activeChatId}/messages`, { silent: true })
        .then((r) => setMessages(r.data ?? []))
        .catch(() => {})
    }
    load()
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [activeChatId])

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // ── фільтрація ──
  const chatsShown = tab === 'all' || tab === 'leads' || tab === 'bots'

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (tab === 'bots')      return false
      if (tab === 'all')       return !['completed', 'canceled'].includes(o.status)
      if (tab === 'leads')     return isLead(o)
      if (tab === 'drafts')    return isDraft(o)
      if (tab === 'active')    return ['new', 'ordered', 'arrived', 'called', 'no_answer'].includes(o.status)
      if (tab === 'ready')     return o.status === 'ready'
      if (tab === 'completed') return ['completed', 'canceled'].includes(o.status)
      return true
    })
  }, [orders, tab])

  const sq = search.toLowerCase().trim()

  const displayChats = useMemo(() => {
    if (!chatsShown) return [] as Chat[]
    const list = !sq ? chats : chats.filter((c) =>
      chatLabel(c).toLowerCase().includes(sq) ||
      (c.customer?.phone?.includes(sq) ?? false),
    )
    return [...list].sort((a, b) => (b.unread_count - a.unread_count) ||
      (new Date(b.last_message_at ?? 0).getTime() - new Date(a.last_message_at ?? 0).getTime()))
  }, [chats, chatsShown, sq])

  const displayOrders = useMemo(() => {
    if (!sq) return filteredOrders
    return filteredOrders.filter((o) =>
      o.customer?.full_name?.toLowerCase().includes(sq) ||
      o.customer?.phone?.includes(sq) ||
      (o.kp_number?.toLowerCase().includes(sq) ?? false) ||
      (o.vehicle_info?.vin?.toLowerCase().includes(sq) ?? false) ||
      o.items.some((i) =>
        i.name.toLowerCase().includes(sq) ||
        (i.sku?.toLowerCase().includes(sq) ?? false),
      ),
    )
  }, [filteredOrders, sq])

  // ── похідні: вибраний чат/замовлення ──
  const selectedChat = selection?.kind === 'chat' ? chats.find((c) => c.id === selection.id) ?? null : null
  const selectedOrder = selection?.kind === 'order' ? orders.find((o) => o.id === selection.id) ?? null : null

  // ── статистика ──
  const stats = useMemo(() => ({
    leads:     orders.filter(isLead).length + chats.length,
    drafts:    orders.filter(isDraft).length,
    active:    orders.filter((o) => ['new', 'ordered', 'arrived', 'called', 'no_answer'].includes(o.status)).length,
    ready:     orders.filter((o) => o.status === 'ready').length,
    completed: orders.filter((o) => ['completed', 'canceled'].includes(o.status)).length,
  }), [orders, chats])

  const TABS: Array<{ id: Tab; label: string; count: number; accent?: boolean }> = [
    { id: 'all',       label: 'Усі',           count: chats.length + filteredOrders.length },
    { id: 'leads',     label: 'Ліди',          count: stats.leads },
    { id: 'drafts',    label: 'Чернетки',      count: stats.drafts },
    { id: 'bots',      label: 'Месенджер',     count: chats.length },
    { id: 'active',    label: 'В дорозі',      count: stats.active },
    { id: 'ready',     label: 'До видачі',     count: stats.ready, accent: true },
    { id: 'completed', label: 'Завершені',     count: stats.completed },
  ]

  // ── дії ──
  async function doSend() {
    if (!selectedChat || !input.trim()) return
    const text = input.trim()
    setSending(true); setInput('')
    try {
      await api.post(`/api/v1/chats/${selectedChat.id}/send`, { text })
      setMessages((p) => [...p, {
        id: Date.now().toString(), chat_id: selectedChat.id,
        sender_type: 'manager', text, created_at: new Date().toISOString(),
      }])
    } catch { toast.error('Помилка відправлення') }
    finally { setSending(false); composerRef.current?.focus() }
  }

  async function resolveChat(chat: Chat) {
    if (!confirm('Закрити чат? Нові повідомлення створять новий чат.')) return
    try {
      await api.patch(`/api/v1/chats/${chat.id}/resolve`, {})
      toast.success('Чат закрито')
      setSelection(null)
      loadChats()
    } catch { toast.error('Помилка закриття чату') }
  }

  function handleCustomerLinked(_customerId: string) {
    loadChats(); loadOrders()
  }

  async function changeOrderStatus(orderId: string, status: string) {
    try {
      await orderApi.updateStatus(orderId, status as any)
      toast.success('Статус змінено')
      loadOrders()
    } catch { toast.error('Помилка') }
  }

  async function updateItemStatus(orderId: string, itemId: string, status: string) {
    try {
      await orderApi.updateItemStatus(orderId, itemId, status as any)
      toast.success('Статус змінено')
      loadOrders()
    } catch { toast.error('Помилка') }
  }

  async function handleComplete(order: CustomerOrder) {
    try {
      const shiftRes = await shiftApi.current().catch(() => ({ data: null }))
      const shiftId = shiftRes.data?.id ?? null
      await orderApi.complete(order.id, { payment_method: payMethod, is_fiscal: isFiscal, shift_id: shiftId })
      toast.success('Замовлення видано')
      setPayModal(null)
      loadOrders()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
  }

  async function handleCancel(order: CustomerOrder, refund: boolean) {
    try {
      await orderApi.cancel(order.id, refund)
      toast.success(refund ? 'Скасовано, передоплату повернено' : 'Замовлення скасовано')
      setCancelModal(null)
      loadOrders()
    } catch { toast.error('Помилка') }
  }

  async function handleCancelAsCredit(order: CustomerOrder) {
    try {
      await orderApi.cancel(order.id, false, null, true)
      toast.success('Скасовано, передоплата залишена як кредит')
      setCancelModal(null)
      loadOrders()
    } catch { toast.error('Помилка') }
  }

  async function loadBulkItems() {
    if (!bulkSupplier) return
    try {
      const { data } = await orderApi.pendingItems(bulkSupplier)
      setBulkItems(data)
      setBulkSelected(new Set(data.map((i: any) => i.id)))
    } catch { toast.error('Помилка завантаження') }
  }

  async function handleBulkArrival() {
    if (bulkSelected.size === 0) { toast.error('Виберіть позиції'); return }
    try {
      await orderApi.bulkArrival([...bulkSelected])
      toast.success(`Прийнято ${bulkSelected.size} позицій`)
      setBulkOpen(false); setBulkItems([]); setBulkSupplier('')
      loadOrders()
    } catch { toast.error('Помилка') }
  }

  // ── рендер ──
  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Mobile backdrop for sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-20 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {/* шапка */}
        <header className="bg-white border-b border-gray-100 px-3 md:px-6 py-2 md:py-3 flex items-center justify-between shrink-0 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button className="md:hidden shrink-0 p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
              onClick={() => setSidebarOpen(true)} aria-label="Меню">
              <Menu size={20} />
            </button>
            {selection ? (
              <button onClick={() => setSelection(null)}
                className="md:hidden shrink-0 text-gray-400 hover:text-gray-600 transition-colors text-xl leading-none">
                ←
              </button>
            ) : null}
            <h1 className="font-bold text-gray-900 text-sm md:text-lg truncate">Замовлення</h1>
          </div>
          <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
            <Button variant="secondary" size="sm" icon={<FilePen size={14} />}
              className="!hidden md:!inline-flex" onClick={() => navigate('/quotes/new')}>
              Чернетка
            </Button>
            <Button variant="secondary" size="sm" icon={<FilePen size={14} />}
              className="md:hidden !px-2" onClick={() => navigate('/quotes/new')}
              title="Чернетка" />
            <Button variant="secondary" size="sm" icon={<Truck size={14} />}
              className="!hidden md:!inline-flex" onClick={() => setBulkOpen(true)}>
              Приймання
            </Button>
            <Button variant="secondary" size="sm" icon={<Truck size={14} />}
              className="md:hidden !px-2" onClick={() => setBulkOpen(true)}
              title="Приймання" />
            <Button size="sm" icon={<Plus size={14} />} onClick={() => navigate('/orders/new')}>
              <span className="hidden sm:inline">Нове замовлення</span>
            </Button>
          </div>
        </header>

        {/* робоча площина */}
        <div className="flex-1 flex min-h-0 min-w-0">

          {/* ── Ліва панель — на мобільному на всю ширину ── */}
          <aside className={`w-full md:w-80 shrink-0 border-r border-gray-200 bg-white flex flex-col ${selection ? 'hidden md:flex' : 'flex'}`}>
            <div className="px-3 pt-3 pb-2 border-b border-gray-100 space-y-2">
              <div className="flex gap-1 overflow-x-auto md:flex-wrap pb-1.5 md:pb-0 scrollbar-none whitespace-nowrap scroll-smooth -mx-3 px-3 md:mx-0 md:px-0">
                {TABS.map((t) => (
                  <button key={t.id} onClick={() => setTab(t.id)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                      tab === t.id
                        ? t.accent ? 'bg-green-500 text-white' : 'bg-yellow-400 text-black'
                        : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                    }`}>
                    {t.label}
                    {t.count > 0 && (
                      <span className={`ml-1 text-[9px] px-1 py-0.5 rounded-full ${
                        tab === t.id ? 'bg-black/20' : 'bg-white text-gray-500'
                      }`}>{t.count}</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="relative flex items-center gap-1">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Пошук..."
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg pl-7 pr-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-yellow-300" />
                <button onClick={() => { loadChats(); loadOrders() }}
                  className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100" title="Оновити">
                  <RefreshCw size={13} />
                </button>
              </div>
            </div>

            {/* список */}
            <div className="flex-1 overflow-y-auto">
              {chatsShown && displayChats.length > 0 && (
                <>
                  <p className="px-3 pt-3 pb-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                    Чати ({displayChats.length})
                  </p>
                  {displayChats.map((c) => (
                    <ChatRow key={c.id} chat={c}
                      active={selection?.kind === 'chat' && selection.id === c.id}
                      onClick={() => setSelection({ kind: 'chat', id: c.id })} />
                  ))}
                </>
              )}
              {displayOrders.length > 0 && (
                <>
                  {chatsShown && displayChats.length > 0 && (
                    <p className="px-3 pt-3 pb-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                      Замовлення ({displayOrders.length})
                    </p>
                  )}
                  {displayOrders.map((o) => (
                    <OrderRow key={o.id} order={o}
                      active={selection?.kind === 'order' && selection.id === o.id}
                      onClick={() => setSelection({ kind: 'order', id: o.id })} />
                  ))}
                </>
              )}
              {loadingChats && loadingOrders ? (
                <p className="p-6 text-center text-sm text-gray-400">Завантаження...</p>
              ) : displayChats.length === 0 && displayOrders.length === 0 && (
                <div className="flex flex-col items-center justify-center h-48 text-center px-4">
                  <ClipboardList size={28} className="text-gray-200 mb-2" />
                  <p className="text-gray-400 text-xs">Немає записів у цьому розділі</p>
                </div>
              )}
            </div>
          </aside>

          {/* ── Середня панель — на мобільному тільки коли вибрано ── */}
          <div className={`flex-1 flex flex-col min-w-0 bg-white ${!selection ? 'hidden md:flex' : 'flex'}`}>
            {selectedChat ? (
              <>
                {/* шапка чату */}
                <div className="px-3 md:px-5 py-3 border-b border-gray-200 flex items-center gap-3 shrink-0">
                  <button onClick={() => setSelection(null)}
                    className="md:hidden shrink-0 text-gray-400 hover:text-gray-600 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 -ml-1"
                    title="Назад">
                    ←
                  </button>
                  <div className="relative shrink-0">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-gray-200 to-gray-300 flex items-center justify-center text-base font-bold text-gray-600">
                      {avatarLetter(selectedChat)}
                    </div>
                    <span className={`absolute -bottom-0.5 -right-0.5 ${PLATFORM_COLORS[selectedChat.channel.platform] ?? 'bg-gray-400'} text-white text-[9px] font-bold px-1 py-0.5 rounded`}>
                      {PLATFORM_LABELS[selectedChat.channel.platform] ?? 'MSG'}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-gray-900 text-base leading-tight truncate">{chatLabel(selectedChat)}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {selectedChat.customer?.phone ?? `ID: ${selectedChat.platform_chat_id}`}
                      {!selectedChat.customer && <span className="text-orange-400 ml-2">● Клієнта не прив'язано</span>}
                    </p>
                  </div>
                    <button onClick={() => setShowCustPanelMobile(true)}
                      className="lg:hidden text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                      title="Картка клієнта">
                      <User size={18} />
                    </button>
                    <button onClick={() => resolveChat(selectedChat)}
                      className="text-gray-400 hover:text-red-500 p-1.5 rounded-lg hover:bg-red-50 transition-colors" title="Закрити чат">
                      🔒
                    </button>
                </div>

                {/* повідомлення */}
                <div className="flex-1 overflow-y-auto px-3 md:px-5 py-3 md:py-5 space-y-2"
                  style={{ background: 'linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)' }}>
                  {messages.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-gray-400 text-sm">Немає повідомлень</p>
                    </div>
                  ) : messages.map((msg, idx) => {
                    const isCustomer = msg.sender_type === 'customer'
                    const isBot = msg.sender_type === 'bot'
                    const prev = idx > 0 ? messages[idx - 1] : null
                    const showTime = !prev || new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() > 5 * 60_000
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
                          <div className={`max-w-[85%] md:max-w-[72%] px-3 md:px-4 py-2.5 text-[15px] leading-relaxed shadow-sm break-all ${
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

                {/* композер */}
                <form onSubmit={(e) => { e.preventDefault(); doSend() }}
                  className="px-3 md:px-5 py-3 md:py-4 border-t border-gray-200 bg-white flex gap-3 items-end shrink-0 pb-safe">
                  <input ref={composerRef} value={input} onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() } }}
                    placeholder="Написати повідомлення..."
                    className="flex-1 min-w-0 bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-[15px] focus:outline-none focus:ring-2 focus:ring-yellow-400" />
                  <button type="submit" disabled={sending || !input.trim()}
                    className="bg-yellow-400 hover:bg-yellow-300 disabled:opacity-40 text-gray-900 font-bold rounded-2xl w-12 h-12 flex items-center justify-center shrink-0 transition-colors shadow-sm">
                    <Send size={18} />
                  </button>
                </form>
              </>
            ) : selectedOrder ? (
              <OrderInlineView order={selectedOrder} now={now}
                onOpenFull={() => navigate('/orders/' + selectedOrder.id)}
                onEditDraft={() => navigate('/quotes/' + selectedOrder.id)}
                onOpenChat={(chatId) => setSelection({ kind: 'chat', id: chatId })}
                onChangeStatus={(s) => changeOrderStatus(selectedOrder.id, s)}
                onItemStatus={(itemId, s) => updateItemStatus(selectedOrder.id, itemId, s)}
                onPay={() => setPayModal(selectedOrder)}
                onCancel={() => setCancelModal(selectedOrder)}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <MessageSquare size={48} className="text-gray-200 mx-auto mb-4" />
                  <p className="text-gray-500 text-base font-medium">Виберіть запис зі списку</p>
                  <p className="text-gray-400 text-sm mt-1">Чат або замовлення відкриється тут</p>
                </div>
              </div>
            )}
          </div>

          {/* ── Права панель (тільки для чату) — відображається тільки на великих екранах ── */}
          {selectedChat && (
            <div className="hidden lg:block">
              <CustomerPanel chat={selectedChat} messages={messages} onCustomerLinked={handleCustomerLinked} />
            </div>
          )}
        </div>
      </div>

      {/* ── Модал оплати ── */}
      <Modal open={!!payModal} onClose={() => setPayModal(null)} title="Фінальний розрахунок" size="sm">
        {payModal && (
          <div className="space-y-4">
            <div className="bg-green-50 rounded-xl p-4 space-y-1 text-sm">
              <div className="flex justify-between"><span>Загальна сума:</span><span className="font-bold">{formatMoney(payModal.total_amount)}</span></div>
              {payModal.prepayment > 0 && (
                <div className="flex justify-between text-blue-600"><span>Передоплата:</span><span>{formatMoney(payModal.prepayment)}</span></div>
              )}
              <div className="border-t border-green-200 pt-1 flex justify-between text-lg font-bold">
                <span>До сплати:</span>
                <span className="text-green-700">{formatMoney(Math.max(0, payModal.total_amount - payModal.prepayment))}</span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Метод оплати</label>
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as any)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                <option value="cash">Готівка</option>
                <option value="card">Картка</option>
                <option value="mixed">Змішана</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={isFiscal} onChange={(e) => setIsFiscal(e.target.checked)} className="w-4 h-4 accent-yellow-400" />
              🧾 Фіскальний чек (ПРРО)
            </label>
            <div className="flex gap-3">
              <Button onClick={() => handleComplete(payModal)} className="flex-1 bg-green-600 hover:bg-green-700">✅ Підтвердити видачу</Button>
              <Button variant="secondary" onClick={() => setPayModal(null)}>Скасувати</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Модал скасування ── */}
      <Modal open={!!cancelModal} onClose={() => setCancelModal(null)} title="Скасувати замовлення" size="sm">
        {cancelModal && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {cancelModal.prepayment > 0
                ? `Передоплата: ${formatMoney(cancelModal.prepayment)}. Що робити з грошима?`
                : 'Ви впевнені, що хочете скасувати це замовлення?'}
            </p>
            {cancelModal.prepayment > 0 ? (
              <div className="space-y-2">
                <Button onClick={() => handleCancel(cancelModal, true)} className="w-full bg-red-600 hover:bg-red-700 text-white">
                  💰 Повернути {formatMoney(cancelModal.prepayment)}
                </Button>
                <Button variant="secondary" onClick={() => handleCancel(cancelModal, false)} className="w-full">
                  Залишити в магазині
                </Button>
                <Button variant="secondary" onClick={() => handleCancelAsCredit(cancelModal)} className="w-full border-blue-300 text-blue-700">
                  📋 Залишити як кредит клієнту
                </Button>
              </div>
            ) : (
              <div className="flex gap-3">
                <Button onClick={() => handleCancel(cancelModal, false)} className="flex-1 bg-red-600 hover:bg-red-700 text-white">Скасувати</Button>
                <Button variant="secondary" onClick={() => setCancelModal(null)}>Назад</Button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ── Модал масового приймання ── */}
      <Modal open={bulkOpen} onClose={() => setBulkOpen(false)} title="📥 Масове приймання" size="lg">
        <div className="space-y-4">
          <div className="flex gap-2">
            <select value={bulkSupplier} onChange={(e) => setBulkSupplier(e.target.value)}
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
              <option value="">— Виберіть постачальника —</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <Button size="sm" onClick={loadBulkItems}>Показати</Button>
          </div>
          {bulkItems.length > 0 && (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Знайдено {bulkItems.length} позицій</span>
                <button onClick={() => {
                  if (bulkSelected.size === bulkItems.length) setBulkSelected(new Set())
                  else setBulkSelected(new Set(bulkItems.map((i: any) => i.id)))
                }} className="text-blue-600 hover:text-blue-800 text-xs font-medium">
                  {bulkSelected.size === bulkItems.length ? 'Скасувати вибір' : 'Вибрати всі'}
                </button>
              </div>
              <div className="max-h-60 overflow-y-auto space-y-1 border border-gray-200 rounded-lg p-2">
                {bulkItems.map((item: any) => (
                  <label key={item.id}
                    className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50 rounded-lg cursor-pointer text-sm">
                    <input type="checkbox" checked={bulkSelected.has(item.id)}
                      onChange={() => {
                        const next = new Set(bulkSelected)
                        if (next.has(item.id)) next.delete(item.id); else next.add(item.id)
                        setBulkSelected(next)
                      }}
                      className="w-4 h-4 accent-yellow-400" />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium">{item.name}</span>
                      {item.sku && <span className="text-gray-400 text-xs ml-1">{item.sku}</span>}
                    </div>
                    <span className="text-xs text-gray-500">{item.order?.customer?.full_name ?? ''}</span>
                  </label>
                ))}
              </div>
              <Button onClick={handleBulkArrival} className="w-full">
                ✅ Прийняти {bulkSelected.size} позицій
              </Button>
            </>
          )}
        </div>
      </Modal>

      {/* Мобільний Drawer для картки клієнта */}
      {selectedChat && showCustPanelMobile && (
        <div className="fixed inset-0 z-40 lg:hidden">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowCustPanelMobile(false)} />
          {/* Content */}
          <div className="absolute right-0 top-0 bottom-0 w-80 max-w-[90%] bg-gray-50 shadow-xl flex flex-col animate-in slide-in-from-right duration-200 z-50">
            <div className="flex items-center justify-between p-4 border-b bg-white">
              <span className="font-bold text-gray-900">Картка клієнта</span>
              <button onClick={() => setShowCustPanelMobile(false)} className="text-gray-400 hover:text-gray-600 p-1">
                <X size={20} />
              </button>
            </div>
            <div className="flex-grow overflow-y-auto min-h-0">
              <CustomerPanel chat={selectedChat} messages={messages} onCustomerLinked={handleCustomerLinked} />
            </div>
          </div>
        </div>
      )}

      <ToastContainer />
    </div>
  )
}

// ───────────────────────── Order inline view ─────────────────────────

function OrderInlineView({
  order, now, onOpenFull, onEditDraft, onOpenChat,
  onChangeStatus, onItemStatus, onPay, onCancel,
}: {
  order: CustomerOrder
  now: Date
  onOpenFull: () => void
  onEditDraft: () => void
  onOpenChat: (chatId: string) => void
  onChangeStatus: (status: string) => void
  onItemStatus: (itemId: string, status: string) => void
  onPay: () => void
  onCancel: () => void
}) {
  const conf = STATUS_CONFIG[order.status] ?? { label: order.status, color: 'gray' as BadgeColor }
  const srcConf = SOURCE_CONFIG[order.source] ?? { label: order.source, icon: <AlertCircle size={10} /> }
  const draft = isDraft(order)
  const totalPaid = order.total_paid ?? order.prepayment
  const remaining = order.total_amount - totalPaid
  const allArrived = order.items.every((i) => ['arrived', 'handed', 'canceled'].includes(i.item_status))
  const allHanded = order.items.every((i) => ['handed', 'canceled'].includes(i.item_status))
  const canComplete = allArrived && !allHanded && !['completed', 'canceled'].includes(order.status)
  const canCancel = !['completed', 'canceled'].includes(order.status)
  const overdue = order.pickup_deadline_at && new Date(order.pickup_deadline_at) < now

  return (
    <div className="flex-1 overflow-y-auto p-3 md:p-6 pb-safe">
      <div className="max-w-3xl mx-auto space-y-4">

        {/* шапка */}
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2 flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs text-gray-500">#{order.id.slice(0, 8)}</span>
                {order.kp_number && (
                  <span className="text-xs font-mono font-bold text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">{order.kp_number}</span>
                )}
                <Badge color={conf.color}>{conf.label}</Badge>
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                  {srcConf.icon}&nbsp;{srcConf.label}
                </span>
                {overdue && (
                  <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-bold">
                    ⚠️ Прострочено
                  </span>
                )}
                <span className="text-xs text-gray-400">{formatDate(order.created_at)}</span>
              </div>
              <div className="text-sm text-gray-700">
                {order.customer ? (
                  <span className="font-medium">{order.customer.full_name ?? order.customer.phone}</span>
                ) : (
                  <span className="text-gray-400">Клієнт не вказаний</span>
                )}
              </div>
              {order.vehicle_info && (
                <p className="text-xs text-gray-500">
                  🚗 {[order.vehicle_info.make, order.vehicle_info.model, order.vehicle_info.year].filter(Boolean).join(' ')}
                  {order.vehicle_info.vin && <span className="ml-1 font-mono text-gray-400">{order.vehicle_info.vin}</span>}
                </p>
              )}
              {order.comment && <p className="text-xs text-gray-500 italic">{order.comment}</p>}
            </div>
            <div className="text-right shrink-0 space-y-1">
              <div className="text-2xl font-bold text-gray-900">{formatMoney(order.total_amount)}</div>
              {totalPaid > 0 && <div className="text-xs text-green-600">Сплачено: {formatMoney(totalPaid)}</div>}
              {remaining > 0 && !allHanded && <div className="text-xs text-orange-600">Залишок: {formatMoney(remaining)}</div>}
            </div>
          </div>
        </Card>

        {/* кнопки дій */}
        <div className="flex gap-2 flex-wrap">
          {draft ? (
            <Button icon={<FilePen size={14} />} onClick={onEditDraft}>Редагувати КП</Button>
          ) : canComplete && (
            <Button onClick={onPay} className="bg-green-600 hover:bg-green-700 text-white">💰 Видати</Button>
          )}
          {order.status === 'arrived' && (
            <>
              <Button size="sm" variant="secondary" onClick={() => onChangeStatus('called')}>📞 Подзвонив</Button>
              <Button size="sm" variant="secondary" onClick={() => onChangeStatus('no_answer')}>❌ Не відповів</Button>
            </>
          )}
          {order.chat_id && (
            <Button size="sm" variant="secondary" icon={<MessageSquare size={14} />} onClick={() => onOpenChat(order.chat_id!)}>
              Чат
            </Button>
          )}
          <Button size="sm" variant="secondary" icon={<ExternalLink size={14} />} onClick={onOpenFull}>
            Відкрити повністю
          </Button>
          {canCancel && (
            <Button size="sm" variant="secondary" onClick={onCancel} className="text-red-500 hover:text-red-600">
              ❌ Скасувати
            </Button>
          )}
        </div>

        {/* позиції */}
        <Card>
          <h3 className="font-semibold text-gray-800 mb-3 text-sm">Позиції замовлення</h3>
          {order.items.length === 0 ? (
            <p className="text-sm text-gray-400">Позиції відсутні</p>
          ) : (
            <div className="space-y-1.5">
              {order.items.map((item) => {
                const actions = ITEM_STATUS_ACTIONS[item.item_status]
                const itemConf = STATUS_CONFIG[item.item_status]
                return (
                  <div key={item.id} className="flex flex-col sm:flex-row sm:items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm gap-1.5">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-gray-800">{item.name}</span>
                      {item.sku && <span className="text-gray-400 text-xs ml-1.5 font-mono">{item.sku}</span>}
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-white border border-gray-200 text-gray-600">
                        {itemConf?.label ?? item.item_status}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 md:gap-2 shrink-0 ml-0 sm:ml-2 flex-wrap">
                      <span className="text-gray-600 text-xs whitespace-nowrap">{item.qty} × {formatMoney(item.sell_price)}</span>
                      {actions?.map((a) => (
                        <button key={a.status} onClick={() => onItemStatus(item.id, a.status)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-white border border-gray-200 hover:bg-gray-100 transition-colors">
                          {a.icon} <span className="hidden sm:inline">{a.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
