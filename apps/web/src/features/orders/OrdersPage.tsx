import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import {
  Plus, Phone, MessageSquare, FilePen, ClipboardList,
  AlertCircle, Search, Send, User, Car, ExternalLink,
  Trash2, X, Check, Pencil, Copy, ArrowRight, Clock,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { SubNavTabs, ORDERS_TABS } from '@/components/SubNavTabs'
import { orderApi } from './orderApi'
import { canDeleteDraftOrder, isCompletedOrderStatus, isTerminalOrderStatus } from './orderStatus'
import { startRepeatOrder, formatOrderNo } from './orderActions'
import { customerApi } from '@/features/customers/customerApi'
import { supplierApi } from '@/features/suppliers/supplierApi'
import { customerVehiclesApi } from '@/features/customers/customerVehiclesApi'
import { Menu } from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
import { Card, Badge, Button, Modal, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate, formatDateTime } from '@/lib/utils'
import type { CustomerVehicle } from '@/types/customer'

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
}
const PLATFORM_LABELS: Record<string, string> = { telegram: 'TG' }
const ORDERS_READ_TIMEOUT_MS = 10_000
const ORDERS_WRITE_TIMEOUT_MS = 15_000

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

type BadgeColor = 'green' | 'orange' | 'red' | 'blue' | 'gray' | 'yellow'

const STATUS_CONFIG: Record<string, { label: string; color: BadgeColor; hint?: string }> = {
  lead:       { label: 'Лід',         color: 'blue',   hint: 'Запит із чату чи дзвінка — ще не оформлене замовлення' },
  quoted:     { label: 'Чернетка',    color: 'gray',   hint: 'Неоформлене замовлення' },
  new:        { label: 'Нове',         color: 'gray',   hint: 'Нове замовлення, ще не опрацьоване менеджером' },
  in_progress:{ label: 'В роботі',     color: 'yellow', hint: 'Замовлення в роботі' },
  ordered:    { label: 'Замовлено',    color: 'yellow', hint: 'Замовлено в постачальника — очікуємо надходження' },
  arrived:    { label: 'Прибуло',      color: 'green',  hint: 'Товар прибув на склад — можна повідомити клієнта' },
  called:     { label: 'Повідомл.',    color: 'blue',   hint: 'Клієнта повідомлено про готовність' },
  no_answer:  { label: 'Не відповів',  color: 'orange', hint: 'Клієнт не відповів — передзвонити' },
  ready:      { label: 'До видачі',    color: 'green',  hint: 'Готове до видачі клієнту' },
  completed:  { label: 'Видано',       color: 'green',  hint: 'Видано клієнту — угоду закрито' },
  canceled:   { label: 'Скасовано',    color: 'red',    hint: 'Замовлення скасовано' },
  archived:   { label: 'Архів',       color: 'gray',   hint: 'Закрита історична версія замовлення' },
}

// Кольорові статуси позицій замовлення (ORD-18)
const ITEM_STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  pending:  { label: 'Очікує',     cls: 'bg-gray-100 text-gray-600' },
  ordered:  { label: 'Замовлено',  cls: 'bg-yellow-100 text-yellow-700' },
  arrived:  { label: 'Прийшло',    cls: 'bg-green-100 text-green-700' },
  handed:   { label: 'Видано',     cls: 'bg-blue-100 text-blue-700' },
  canceled: { label: 'Скасовано',  cls: 'bg-red-100 text-red-700' },
  returned: { label: 'Повернено',  cls: 'bg-purple-100 text-purple-700' },
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
    { status: 'ordered',  label: 'Замовити', icon: '📥' },
    { status: 'canceled', label: 'Скасувати позицію', icon: '❌' },
  ],
  ordered: [
    { status: 'arrived',  label: 'Приїхало',  icon: '📦' },
    { status: 'canceled', label: 'Скасувати позицію', icon: '❌' },
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
  core_deposit_amount?: number
  core_return_status?: string
}

interface CustomerOrder {
  id: string
  order_number: number | null
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

type Tab = 'all' | 'leads' | 'drafts' | 'bots' | 'active' | 'ready' | 'completed' | 'canceled'

type Selection = { kind: 'chat'; id: string } | { kind: 'order'; id: string } | null

// ───────────────────────── Helpers ─────────────────────────

function avatarLetter(chat: Chat): string {
  const name = chat.customer?.full_name ?? chat.first_name ?? chat.username
  return name ? name[0].toUpperCase() : '#'
}

function chatLabel(chat: Chat): string {
  return chat.customer?.full_name ?? chat.first_name ?? chat.username ?? `ID ${chat.platform_chat_id.slice(0, 6)}`
}

// Чернетка = ЛИШЕ рукописна (QuickDraft, source='mobile_draft') або позначені
// нотатки-чернетки. Замовлення з форми (source='walk_in') — це відкрите замовлення,
// що очікує відповідь клієнта, а НЕ чернетка.
function isDraft(o: CustomerOrder) {
  return o.status === 'quoted' || (o.status === 'lead' && (o.source === 'mobile_draft' || o.items.some((i) => (i as { is_draft_note?: boolean }).is_draft_note)))
}
function isLead(o: CustomerOrder) {
  return o.status === 'lead' && !isDraft(o)
}

function draftCountLabel(count: number) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return 'чернетка'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'чернетки'
  return 'чернеток'
}

function uniqueNamed<T extends { name: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter((item) => {
    const key = item.name.trim().toLocaleLowerCase('uk-UA')
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function LoadingCards({ count = 3 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" aria-label="Завантаження">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4 animate-pulse">
          <div className="flex justify-between">
            <div className="h-4 w-20 rounded bg-gray-100" />
            <div className="h-4 w-16 rounded bg-gray-100" />
          </div>
          <div className="h-5 w-2/3 rounded bg-gray-100" />
          <div className="h-4 w-full rounded bg-gray-100" />
          <div className="h-9 w-full rounded-lg bg-gray-100" />
        </div>
      ))}
    </div>
  )
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
          <span className="font-mono text-[11px] text-gray-500 shrink-0">{formatOrderNo(order)}</span>
          <span className="font-semibold text-sm text-gray-900 truncate">{name}</span>
        </div>
        <span className="text-[10px] text-gray-400 shrink-0">{formatDate(order.created_at)}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge color={conf.color}>{conf.label}</Badge>
          {draft && (
            <span className="text-[9px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-semibold">
              Чернетка
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
  const customerId = customer?.id
  const loadDataRequestRef = useRef(0)

  const loadData = useCallback(() => {
    const requestId = ++loadDataRequestRef.current
    const isCurrentRequest = () => requestId === loadDataRequestRef.current
    setLoading(true)

    const ordersRequest = orderApi.list()
      .then((response) => {
        if (!isCurrentRequest()) return
        const allOrders = response.data ?? []
        setChatOrders(allOrders.filter((order) => order.chat_id === chat.id).slice(0, 10))
        setOrders(customerId
          ? allOrders.filter((order) => order.customer_id === customerId).slice(0, 5)
          : [])
      })
      .catch(() => {
        if (!isCurrentRequest()) return
        setChatOrders([])
        setOrders([])
      })

    const requests: Promise<unknown>[] = [ordersRequest]
    if (customerId) {
      requests.push(
        customerVehiclesApi.list(customerId)
          .then((response) => { if (isCurrentRequest()) setVehicles(response.data ?? []) })
          .catch(() => { if (isCurrentRequest()) setVehicles([]) }),
      )
    } else {
      setVehicles([])
      setOrders([])
    }

    Promise.allSettled(requests)
      .finally(() => { if (isCurrentRequest()) setLoading(false) })
  }, [chat.id, customerId])

  useEffect(() => {
    loadData()
    return () => { loadDataRequestRef.current += 1 }
  }, [loadData])

  useEffect(() => {
    const query = searchPhone.trim()
    if (query.length < 3) {
      setSearchResults([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      customerApi.list({ search: query, per_page: 5 })
        .then((r) => { if (!cancelled) setSearchResults(r.data ?? []) })
        .catch(() => { if (!cancelled) setSearchResults([]) })
    }, 400)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
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
      await api.patch(`/api/v1/chats/${chat.id}/link-customer`, { customer_id: customerId }, { silent: true, timeoutMs: ORDERS_WRITE_TIMEOUT_MS })
      toast.success('Клієнта прив\'язано')
      onCustomerLinked(customerId)
      setSearchPhone(''); setSearchResults([])
    } catch (error) { toast.error(getErrorMessage(error, 'Помилка прив\'язки')) }
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
                  <span className="font-bold text-gray-700">{formatOrderNo(o)}</span>
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
        prepayment: 0,
        prepayment_method: null,
        prepayment_is_fiscal: false,
        items: validItems.map((r) => ({
          name: r.name.trim(), qty: parseFloat(r.qty) || 1,
          sell_price: Math.round(parseFloat(r.sell_price || '0') * 100),
          buy_price: 0, source_type: 'supplier' as const,
        })),
      }, { silent: true })
      if (!result?.data?.id) throw new Error('Сервер не повернув ID')

      if (sendPrices && chatId) {
        const lines = validItems.map((r, i) => {
          const price = (Math.round(parseFloat(r.sell_price || '0') * 100) / 100).toFixed(2)
          return `${i + 1}. ${r.name.trim()} — ${price} грн × ${parseFloat(r.qty) || 1}`
        }).join('\n')
        const msg = `🔧 *Нове замовлення #${result.data.id.slice(0, 8)}*\n\n${lines}\n\n💰 *Сума:* ${formatMoney(total)}\n\nМенеджер зв'яжеться з вами! 🚀`
        api.post(`/api/v1/chats/${chatId}/send`, { text: msg }, undefined, { silent: true, timeoutMs: ORDERS_WRITE_TIMEOUT_MS }).catch(() => {})
      }
      onCreated()
    } catch (e) { toast.error(getErrorMessage(e, 'Помилка створення замовлення')) }
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

        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Передоплату приймає касир у касі: знайдіть замовлення за номером, телефоном або штрихкодом картки клієнта.
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


// ─── DraftsGrid Component ───
interface DraftsGridProps {
  orders: CustomerOrder[]
  loading: boolean
  onLoad: () => void
  onEdit: (id: string) => void
  offset: number
  onPrevPage: () => void
  onNextPage: () => void
  hasMore: boolean
}

function DraftsGrid({ orders, loading, onLoad, onEdit, offset, onPrevPage, onNextPage, hasMore }: DraftsGridProps) {
  const navigate = useNavigate()
  const drafts = orders.filter(isDraft)

  async function handleConvertToOrder(orderId: string) {
    navigate(`/orders/new?draftId=${orderId}`)
  }

  async function handleDelete(orderId: string, clientName: string) {
    if (!confirm(`Видалити чернетку для "${clientName}"?`)) return
    try {
      await orderApi.delete(orderId, { silent: true, timeoutMs: ORDERS_WRITE_TIMEOUT_MS })
      toast.success('Чернетку видалено')
      onLoad()
    } catch (error) {
      toast.error(getErrorMessage(error, 'Помилка видалення'))
    }
  }

  return (
    <div className="flex-1 p-4 md:p-6 overflow-y-auto bg-gray-50/50">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <h2 className="text-lg md:text-xl font-bold text-gray-900">Робочі чернетки</h2>
          <Button size="sm" icon={<Plus size={14} />} onClick={() => navigate('/quotes/new')}>
            Створити чернетку
          </Button>
        </div>

        {loading && drafts.length === 0 ? (
          <LoadingCards />
        ) : drafts.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
            <p className="text-gray-500 text-sm font-medium">Активних чернеток немає</p>
            <p className="text-gray-400 text-xs mt-1">Телефон, VIN і список побажань клієнта — без цін та артикулів</p>
            <Button size="sm" icon={<Plus size={14} />} className="mt-4" onClick={() => navigate('/quotes/new')}>
              Створити чернетку
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {drafts.map((d) => {
              const isUrgent = d.comment?.toLowerCase().includes('терміново')
              return (
                <div key={d.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm flex flex-col hover:shadow-md transition-shadow">
                  <div className="p-5 flex-1 space-y-4">
                    {/* Header */}
                    <div className="flex justify-between items-start">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${
                        isUrgent ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {isUrgent ? 'Терміново' : 'Чернетка'}
                      </span>
                      <span className="text-xs text-gray-400 font-mono">
                        {formatDate(d.created_at)}
                      </span>
                    </div>

                    {/* Client info */}
                    <div>
                      <h4 className="font-bold text-gray-900 leading-tight">
                        {d.customer?.full_name ?? 'Без клієнта'}
                      </h4>
                      {d.customer?.phone && (
                        <p className="text-xs text-gray-400 mt-0.5">{d.customer.phone}</p>
                      )}
                    </div>

                    {/* Vehicle */}
                    {d.vehicle_info && (
                      <div className="bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 flex items-center justify-between text-xs text-gray-600">
                        <div className="flex items-center gap-2">
                          <Car size={14} className="text-gray-400" />
                          <span>{d.vehicle_info.make} {d.vehicle_info.model} {d.vehicle_info.year ? `(${d.vehicle_info.year})` : ''}</span>
                        </div>
                        {d.vehicle_info.vin && (
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(d.vehicle_info?.vin ?? '')
                              toast.success('VIN скопійовано')
                            }}
                            className="text-gray-400 hover:text-gray-600 transition-colors p-1 cursor-pointer"
                            title="Скопіювати VIN"
                          >
                            <Copy size={12} />
                          </button>
                        )}
                      </div>
                    )}

                    {/* Items list */}
                    {d.items && d.items.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Деталі</p>
                        <ul className="text-xs text-gray-600 space-y-1">
                          {d.items.slice(0, 3).map((item) => (
                            <li key={item.id} className="flex justify-between gap-2">
                              <span className="truncate">{item.name}</span>
                              <span className="text-gray-400 shrink-0">x{item.qty}</span>
                            </li>
                          ))}
                          {d.items.length > 3 && (
                            <li className="text-[10px] text-gray-400 italic">ще {d.items.length - 3} позицій...</li>
                          )}
                        </ul>
                      </div>
                    )}

                    <div className="flex items-center justify-between border-t border-gray-100 pt-3 text-xs">
                      <span className="text-gray-400">
                        {d.items?.length ?? 0} {(d.items?.length ?? 0) === 1 ? 'позиція' : 'позицій'}
                      </span>
                      <span className="font-bold text-gray-900">{formatMoney(d.total_amount)}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="border-t border-gray-100 px-5 py-3.5 bg-gray-50/30 rounded-b-2xl flex items-center justify-between gap-2">
                    <div className="flex gap-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onEdit(d.id)}
                        icon={<Pencil size={12} />}
                        title="Редагувати"
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        className="text-red-600 hover:text-red-700"
                        onClick={() => handleDelete(d.id, d.customer?.full_name ?? 'Без клієнта')}
                        icon={<Trash2 size={12} />}
                        title="Видалити"
                      />
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleConvertToOrder(d.id)}
                      icon={<ArrowRight size={12} />}
                      className="!bg-green-500 hover:!bg-green-600 text-white font-semibold text-xs py-1.5 px-3"
                    >
                      Оформити замовлення
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Пагінація чернеток */}
        {(offset > 0 || hasMore) && (
        <div className="flex items-center justify-between px-5 py-4 bg-white border border-gray-100 rounded-2xl shadow-sm">
          <span className="text-xs text-gray-500">
            Показано {drafts.length} {draftCountLabel(drafts.length)}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={offset === 0}
              onClick={onPrevPage}
            >
              Попередня сторінка
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!hasMore}
              onClick={onNextPage}
            >
              Наступна сторінка
            </Button>
          </div>
        </div>
        )}

      </div>
    </div>
  )
}

// ─── OrdersTable Component ───
interface OrdersTableProps {
  orders: CustomerOrder[]
  loading: boolean
  search: string
  setSearch: (s: string) => void
  offset: number
  onPrevPage: () => void
  onNextPage: () => void
  hasMore: boolean
  onQuickView: (o: CustomerOrder) => void
  onQuickOrder: (o: CustomerOrder) => void
  onDelete: (o: CustomerOrder) => void
  canDelete: boolean
  statusTab: Tab
  onStatusTab: (t: Tab) => void
}

function OrdersTable({ orders, loading, search, setSearch, offset, onPrevPage, onNextPage, hasMore, onQuickView, onQuickOrder, onDelete, canDelete, statusTab, onStatusTab }: OrdersTableProps) {
  const navigate = useNavigate()

  const statusFilters: Array<{ id: Tab; label: string; accent?: boolean }> = [
    { id: 'all',       label: 'Усі активні' },
    { id: 'active',    label: 'В дорозі' },
    { id: 'ready',     label: 'До видачі', accent: true },
    { id: 'completed', label: 'Виконані' },
    { id: 'canceled',  label: 'Скасовані' },
  ]

  return (
    <div className="flex-1 p-4 md:p-6 overflow-y-auto bg-gray-50/50">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <h2 className="text-lg md:text-xl font-bold text-gray-900">База замовлень</h2>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <div className="relative flex-1 md:w-85">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setSearch('') }}
                placeholder="Пошук: № замовлення, клієнт, телефон, авто…"
                className={`w-full bg-white border border-gray-200 rounded-lg pl-9 ${search ? 'pr-9' : 'pr-4'} py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400`}
              />
              {search && (
                <button type="button" onClick={() => setSearch('')}
                  className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                  aria-label="Очистити пошук" title="Очистити пошук (Esc)">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Фільтр за статусом — доступний прямо у списку (раніше був лише в інбоксі чатів) */}
        <div className="flex gap-1.5 flex-wrap -mt-2">
          {statusFilters.map((f) => (
            <button key={f.id} onClick={() => onStatusTab(f.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusTab === f.id
                  ? f.accent ? 'bg-green-500 text-white' : 'bg-yellow-400 text-black'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}>
              {f.label}
            </button>
          ))}
        </div>

        {/* Mobile card layout (ORD-12) */}
        <div className="md:hidden space-y-3">
          {loading && orders.length === 0 ? (
            <LoadingCards count={2} />
          ) : orders.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center">
              <p className="text-gray-500 text-sm font-medium">{search ? 'Нічого не знайдено' : 'Тут поки порожньо'}</p>
              <p className="text-gray-400 text-xs mt-1">{search ? 'Спробуйте інший запит — №, ім’я, телефон чи авто' : 'Створіть перше замовлення, щоб воно з’явилося тут'}</p>
            </div>
          ) : orders.map((o: CustomerOrder) => {
            const paid = o.total_paid ?? o.prepayment ?? 0
            const hasDebt = o.status !== 'canceled' && o.total_amount > paid
            const conf = STATUS_CONFIG[o.status] ?? { label: o.status, color: 'gray' as BadgeColor }
            return (
              <div key={o.id} onClick={() => onQuickView(o)}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-2.5 cursor-pointer active:bg-gray-50">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-gray-900 text-sm">{formatOrderNo(o)}</span>
                  <div className="flex items-center gap-1.5">
                    {o.status === 'completed' && hasDebt && <Badge color="red">Є борг</Badge>}
                    <Badge color={conf.color}>{conf.label}</Badge>
                  </div>
                </div>
                <div>
                  <p className="font-semibold text-gray-900 text-sm">{o.customer?.full_name ?? '—'}</p>
                  {o.customer?.phone && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        navigator.clipboard.writeText(o.customer?.phone ?? '')
                        toast.success('Телефон скопійовано')
                      }}
                      className="mt-0.5 inline-flex items-center gap-1 font-mono text-xs text-gray-600"
                    >
                      {o.customer.phone} <Copy size={11} />
                    </button>
                  )}
                </div>
                {o.vehicle_info?.make && (
                  <p className="text-xs text-gray-500 flex items-center gap-1">
                    <Car size={12} className="text-gray-400" />
                    {o.vehicle_info.make} {o.vehicle_info.model} {o.vehicle_info.year ? `(${o.vehicle_info.year})` : ''}
                  </p>
                )}
                {o.vehicle_info?.vin && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      navigator.clipboard.writeText(o.vehicle_info?.vin ?? '')
                      toast.success('VIN скопійовано')
                    }}
                    className="flex w-fit items-center gap-1 rounded bg-gray-100 px-2 py-1 font-mono text-xs font-bold tracking-wide text-gray-800"
                  >
                    VIN {o.vehicle_info.vin} <Copy size={11} />
                  </button>
                )}
                {o.items.filter((i) => !i.is_draft_note).slice(0, 3).map((item) => (
                  <p key={item.id} className="truncate text-xs text-gray-600">
                    {item.name}{item.sku ? ` · ${item.sku}` : ''} × {item.qty}
                  </p>
                ))}
                {o.comment && <p className="line-clamp-2 text-xs italic text-amber-700">📝 {o.comment}</p>}
                <div className="flex items-end justify-between pt-2 border-t border-gray-50">
                  <div className="text-xs space-y-0.5">
                    <div className="font-bold text-gray-900 text-sm">{formatMoney(o.total_amount)}</div>
                    {paid > 0 && <div className="text-blue-600">Сплачено: {formatMoney(paid)}</div>}
                    {hasDebt && <div className="text-red-500 font-semibold">Борг: {formatMoney(o.total_amount - paid)}</div>}
                  </div>
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {(isLead(o) || o.status === 'new') && (
                      <Button size="sm" className="!bg-green-500 hover:!bg-green-600 text-white font-semibold" title="Закрити накладну як замовлено" onClick={() => onQuickOrder(o)}>В замовлення</Button>
                    )}
                    <Button variant="secondary" size="sm" icon={<Copy size={13} />} title="Повторити" onClick={() => startRepeatOrder(o, navigate)} />
                    <Button variant="secondary" size="sm" onClick={() => navigate('/orders/' + o.id)}>Перегляд</Button>
                    {canDelete && canDeleteDraftOrder(o) && (
                      <Button variant="danger-outline" size="sm" icon={<Trash2 size={13} />} title="Видалити замовлення" onClick={() => onDelete(o)} />
                    )}
                  </div>
                </div>
                <div className="text-[11px] text-gray-400 flex items-center justify-end gap-1">
                  <Clock size={10} className="shrink-0" /> {formatDateTime(o.created_at)}
                </div>
              </div>
            )
          })}
          {(offset > 0 || hasMore) && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <Button variant="secondary" size="sm" disabled={offset === 0} onClick={onPrevPage} className="flex-1">← Назад</Button>
              <Button variant="secondary" size="sm" disabled={!hasMore} onClick={onNextPage} className="flex-1">Далі →</Button>
            </div>
          )}
        </div>

        {/* Table Card — desktop */}
        <Card padding="none" className="overflow-hidden hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50">
                <tr className="bg-gray-50 text-gray-400 text-xs font-bold uppercase tracking-wider border-b border-gray-100">
                  <th className="px-5 py-4">Замовлення</th>
                  <th className="px-5 py-4">Клієнт</th>
                  <th className="px-5 py-4">Запчастини / VIN</th>
                  <th className="px-5 py-4">Сума</th>
                  <th className="px-5 py-4">Статус</th>
                  <th className="px-5 py-4 text-right">Дії</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading && orders.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-8">
                      <div className="space-y-3 animate-pulse" aria-label="Завантаження замовлень">
                        {Array.from({ length: 4 }, (_, i) => (
                          <div key={i} className="h-11 rounded-lg bg-gray-100" />
                        ))}
                      </div>
                    </td>
                  </tr>
                ) : orders.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-14 text-center">
                      <p className="text-gray-500 text-sm font-medium">{search ? 'Нічого не знайдено' : 'Тут поки порожньо'}</p>
                      <p className="text-gray-400 text-xs mt-1">{search ? 'Спробуйте інший запит — №, ім’я, телефон чи авто' : 'Створіть перше замовлення, щоб воно з’явилося тут'}</p>
                    </td>
                  </tr>
                )}
                {orders.map((o: CustomerOrder) => {
                  const paid = o.total_paid ?? o.prepayment ?? 0
                  const hasDebt = o.status !== 'canceled' && o.total_amount > paid
                  return (
                    <tr key={o.id} onClick={() => onQuickView(o)} className="hover:bg-gray-50/30 transition-colors cursor-pointer">
                      {/* Замовлення */}
                      <td className="px-5 py-4 align-top">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-gray-900">{formatOrderNo(o)}</span>
                          <span className="text-[10px] text-gray-500 bg-gray-100 rounded px-1.5 py-0.5 font-medium">
                            {o.source === 'walk_in' ? 'Магазин' : o.source === 'phone' ? 'Телефон' : 'Чат'}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                          <Clock size={11} className="text-gray-400 shrink-0" />
                          {formatDateTime(o.created_at)}
                        </div>
                        {o.comment && (
                          <div className="mt-1 max-w-[220px] truncate text-xs italic text-amber-700" title={o.comment}>
                            📝 {o.comment}
                          </div>
                        )}
                      </td>

                      {/* Клієнт */}
                      <td className="px-5 py-4">
                        <div className="font-bold text-gray-900">
                          {o.customer?.full_name ?? '—'}
                        </div>
                        {o.customer?.phone && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              navigator.clipboard.writeText(o.customer?.phone ?? '')
                              toast.success('Телефон скопійовано')
                            }}
                            className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-gray-600 hover:text-gray-900"
                            title="Скопіювати телефон"
                          >
                            {o.customer.phone} <Copy size={11} />
                          </button>
                        )}
                      </td>

                      {/* Запчастини та VIN */}
                      <td className="px-5 py-4">
                        <div className="max-w-[300px] space-y-1">
                          {o.items.filter((i) => !i.is_draft_note).slice(0, 3).map((item) => (
                            <div key={item.id} className="truncate text-xs text-gray-700" title={item.name}>
                              {item.name}{item.sku ? <span className="font-mono text-gray-400"> · {item.sku}</span> : null}
                              <span className="text-gray-400"> × {item.qty}</span>
                            </div>
                          ))}
                          {o.vehicle_info?.vin && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                navigator.clipboard.writeText(o.vehicle_info?.vin ?? '')
                                toast.success('VIN скопійовано')
                              }}
                              className="mt-1 inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 font-mono text-xs font-bold tracking-wide text-gray-800 hover:bg-gray-200"
                              title="Скопіювати VIN"
                            >
                              {o.vehicle_info.vin} <Copy size={11} />
                            </button>
                          )}
                        </div>
                      </td>

                      {/* Сума */}
                      <td className="px-5 py-4">
                        <div className="font-bold text-gray-900">{formatMoney(o.total_amount)}</div>
                        {paid > 0 && (
                          <div className="text-[11px] text-blue-600 mt-0.5">
                            Сплачено: {formatMoney(paid)}
                          </div>
                        )}
                        {hasDebt && (
                          <div className="text-[11px] text-red-500 font-semibold mt-0.5">
                            Борг: {formatMoney(o.total_amount - paid)}
                          </div>
                        )}
                      </td>

                      {/* Статус */}
                      <td className="px-5 py-4">
                        <div className="flex flex-col items-start gap-1.5">
                        <span title={STATUS_CONFIG[o.status]?.hint} className={`px-2.5 py-1 rounded-full text-xs font-semibold cursor-help ${
                          STATUS_CONFIG[o.status]?.color === 'green' ? 'bg-green-50 text-green-700' :
                          STATUS_CONFIG[o.status]?.color === 'red' ? 'bg-red-50 text-red-700' :
                          STATUS_CONFIG[o.status]?.color === 'yellow' ? 'bg-yellow-50 text-yellow-700' :
                          STATUS_CONFIG[o.status]?.color === 'orange' ? 'bg-orange-50 text-orange-700' :
                          STATUS_CONFIG[o.status]?.color === 'blue' ? 'bg-blue-50 text-blue-700' :
                          'bg-gray-50 text-gray-700'
                        }`}>
                          {STATUS_CONFIG[o.status]?.label ?? o.status}
                        </span>
                        {o.status === 'completed' && hasDebt && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-50 text-red-700">
                            Є борг
                          </span>
                        )}
                        </div>
                      </td>

                      {/* Дії */}
                      <td className="px-5 py-4 text-right">
                        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                          {(isLead(o) || o.status === 'new') && (
                            <Button size="sm" className="!bg-green-500 hover:!bg-green-600 text-white font-semibold" title="Закрити накладну як замовлено" onClick={() => onQuickOrder(o)}>
                              В замовлення
                            </Button>
                          )}
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<Copy size={13} />}
                            title="Повторити замовлення"
                            onClick={() => startRepeatOrder(o, navigate)}
                          />
                          <Button variant="secondary" size="sm" onClick={() => navigate('/orders/' + o.id)}>
                            Відкрити
                          </Button>
                          {canDelete && canDeleteDraftOrder(o) && (
                            <Button variant="danger-outline" size="sm" icon={<Trash2 size={13} />} title="Видалити замовлення" onClick={() => onDelete(o)} />
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Пагінація замовлень — ховаємо, коли все вміщається на одну сторінку */}
          {(offset > 0 || hasMore) && (
            <div className="flex items-center justify-between px-5 py-4 bg-white border-t border-gray-100">
              <span className="text-xs text-gray-500">
                Показано {orders.length} замовлень
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={offset === 0}
                  onClick={onPrevPage}
                >
                  Попередня сторінка
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!hasMore}
                  onClick={onNextPage}
                >
                  Наступна сторінка
                </Button>
              </div>
            </div>
          )}

        </Card>
      </div>
    </div>
  )
}

export default function OrdersPage() {
  const navigate = useNavigate()
  const location = useLocation()
  // Режим «Чат-боти» (маршрут /chats) — лише чати; режим замовлень (/orders) — лише замовлення.
  const chatMode = location.pathname.startsWith('/chats')
  const offlineMode = useAuthStore((state) => state.offlineMode)
  const [searchParams, setSearchParams] = useSearchParams()
  const urlChatId = searchParams.get('chat_id')

  // дані
  const [chats, setChats] = useState<Chat[]>([])
  const [orders, setOrders] = useState<CustomerOrder[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingChats, setLoadingChats] = useState(chatMode && !offlineMode)
  const [loadingOrders, setLoadingOrders] = useState(true)

  // ui
  const [tab, setTab] = useState<Tab>(chatMode ? 'bots' : 'all')
  const [offset, setOffset] = useState(0)

  // Reset offset on tab changes
  useEffect(() => {
    setOffset(0)
  }, [tab])

  useEffect(() => {
    if (chatMode) { setTab('bots'); return }   // у режимі чатів вкладка завжди «чати»
    const urlTab = searchParams.get('tab') as Tab
    // «bots» свідомо НЕ дозволений у блоці /orders — чати живуть лише на /chats (меню «Чат-боти»)
    if (urlTab && ['all', 'leads', 'drafts', 'active', 'ready', 'completed', 'canceled'].includes(urlTab)) {
      setTab(urlTab)
    }
  }, [searchParams, chatMode])
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<Selection>(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
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
  const [callbackModal, setCallbackModal] = useState<{ orderId: string; status: string } | null>(null)
  const [callbackDate, setCallbackDate] = useState('')
  const [callbackTime, setCallbackTime] = useState('')
  const [cancelModal, setCancelModal] = useState<CustomerOrder | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const session = useAuthStore((s) => s.session)
  const role = (session?.user?.app_metadata?.role as string) ?? 'cashier'

  // bulk arrival
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkSupplier, setBulkSupplier] = useState('')
  const [bulkItems, setBulkItems] = useState<any[]>([])
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set())
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const orderCacheRef = useRef(new Map<string, CustomerOrder[]>())
  const orderLoadRequestRef = useRef(0)

  // ── завантаження чатів ──
  const loadChats = useCallback(() => {
    if (!chatMode || offlineMode) { setChats([]); setLoadingChats(false); return }
    api.get<{ data: Chat[] }>('/api/v1/chats', { silent: true, timeoutMs: ORDERS_READ_TIMEOUT_MS })
      .then((r) => { setChats((r.data ?? []).filter((chat) => chat.channel.platform === 'telegram')); setLoadingChats(false) })
      .catch(() => setLoadingChats(false))
  }, [chatMode, offlineMode])
  useEffect(() => {
    if (!chatMode || offlineMode) {
      setChats([])
      setLoadingChats(false)
      return
    }
    setLoadingChats(true)
    loadChats()
    const timer = window.setInterval(loadChats, 5000)
    return () => window.clearInterval(timer)
  }, [chatMode, offlineMode, loadChats])

  // ── завантаження замовлень за вкладкою ──
  const loadOrders = useCallback(async (showLoading = true) => {
    const requestId = ++orderLoadRequestRef.current
    const cacheKey = `${tab}:${offset}`
    const cached = orderCacheRef.current.get(cacheKey)
    if (cached) setOrders(cached)
    setLoadingOrders(showLoading || !cached)
    try {
      const response = await orderApi.list(offset, { silent: true, timeoutMs: ORDERS_READ_TIMEOUT_MS }, 50)
      if (requestId !== orderLoadRequestRef.current) return
      const next = response.data ?? []
      orderCacheRef.current.set(cacheKey, next)
      if (tab === 'all') {
        orderCacheRef.current.set(`active:${offset}`, next.filter((o) => ['new', 'ordered', 'arrived', 'called', 'no_answer'].includes(o.status)))
        orderCacheRef.current.set(`ready:${offset}`, next.filter((o) => o.status === 'ready'))
        orderCacheRef.current.set(`completed:${offset}`, next.filter((o) => isCompletedOrderStatus(o.status)))
        orderCacheRef.current.set(`canceled:${offset}`, next.filter((o) => o.status === 'canceled'))
        orderCacheRef.current.set(`drafts:${offset}`, next.filter(isDraft))
      }
      setOrders(next)
    } catch (error) {
      if (requestId === orderLoadRequestRef.current && showLoading) {
        toast.error(getErrorMessage(error, 'Помилка завантаження замовлень'))
      }
    } finally {
      if (requestId === orderLoadRequestRef.current) setLoadingOrders(false)
    }
  }, [tab, offset])
  useEffect(() => {
    void loadOrders()
    const timer = window.setInterval(() => { void loadOrders(false) }, 15_000)
    return () => {
      orderLoadRequestRef.current += 1
      window.clearInterval(timer)
    }
  }, [loadOrders])
  useEffect(() => {
    const refreshFromLocalPull = () => {
      orderCacheRef.current.clear()
      void loadOrders(false)
    }
    window.addEventListener('forsage:desktop-sync-completed', refreshFromLocalPull)
    return () => window.removeEventListener('forsage:desktop-sync-completed', refreshFromLocalPull)
  }, [loadOrders])

  // ── постачальники (для масового приймання) ──
  useEffect(() => {
    supplierApi.list({ per_page: 200 })
      .then((r) => setSuppliers(uniqueNamed(r.data ?? [])))
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
    if (!chatMode || offlineMode || !activeChatId) { setMessages([]); return }
    let cancelled = false
    let requestId = 0
    function load() {
      const currentRequest = ++requestId
      api.get<{ data: Message[] }>(`/api/v1/chats/${activeChatId}/messages`, { silent: true, timeoutMs: ORDERS_READ_TIMEOUT_MS })
        .then((r) => {
          if (!cancelled && currentRequest === requestId) setMessages(r.data ?? [])
        })
        .catch(() => {})
    }
    load()
    const timer = window.setInterval(load, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeChatId, chatMode, offlineMode])

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // ── фільтрація ──
  const chatsShown = chatMode

  const filteredOrders = useMemo(() => {
    // У режимі «Чат-боти» показуємо ЛІДИ (запити з чатів) поряд із самими чатами
    if (chatMode) return orders.filter(isLead)
    return orders.filter((o) => {
      if (tab === 'bots')      return false
      // «Список замовлень» → «Усі активні»: усі відкриті замовлення, включно з
      // відкритими лідами (щоб збережені «Зберегти»-замовлення не губились —
      // окремої вкладки «Ліди» більше немає). Ховаємо лише рукописні чернетки.
      if (tab === 'all')       return !isTerminalOrderStatus(o.status) && !isDraft(o)
      if (tab === 'leads')     return isLead(o)
      if (tab === 'drafts')    return isDraft(o)
      if (tab === 'active')    return ['new', 'ordered', 'arrived', 'called', 'no_answer'].includes(o.status)
      if (tab === 'ready')     return o.status === 'ready'
      if (tab === 'completed') return isCompletedOrderStatus(o.status)
      if (tab === 'canceled')  return o.status === 'canceled'
      return true
    })
  }, [orders, tab, chatMode])

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
      formatOrderNo(o).toLowerCase().includes(sq) ||
      (o.order_number != null && String(o.order_number).includes(sq)) ||
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
    leads:     orders.filter(isLead).length,
    drafts:    orders.filter(isDraft).length,
    active:    orders.filter((o) => ['new', 'ordered', 'arrived', 'called', 'no_answer'].includes(o.status)).length,
    ready:     orders.filter((o) => o.status === 'ready').length,
    completed: orders.filter((o) => isCompletedOrderStatus(o.status)).length,
  }), [orders, chats])

  const TABS: Array<{ id: Tab; label: string; count: number; accent?: boolean }> = chatMode
    ? [
        { id: 'bots', label: 'Усі чати', count: chats.length },
      ]
    : [
        { id: 'all',       label: 'Усі',       count: filteredOrders.length },
        { id: 'leads',     label: 'Ліди',      count: stats.leads },
        { id: 'drafts',    label: 'Чернетки',  count: stats.drafts },
        { id: 'active',    label: 'В дорозі',  count: stats.active },
        { id: 'ready',     label: 'До видачі', count: stats.ready, accent: true },
        { id: 'completed', label: 'Завершені', count: stats.completed },
      ]

  // ── дії ──
  async function doSend() {
    if (!selectedChat || !input.trim()) return
    const text = input.trim()
    setSending(true); setInput('')
    try {
      await api.post(`/api/v1/chats/${selectedChat.id}/send`, { text }, undefined, { silent: true, timeoutMs: ORDERS_WRITE_TIMEOUT_MS })
      setMessages((p) => [...p, {
        id: Date.now().toString(), chat_id: selectedChat.id,
        sender_type: 'manager', text, created_at: new Date().toISOString(),
      }])
    } catch (error) { toast.error(getErrorMessage(error, 'Помилка відправлення')) }
    finally { setSending(false); composerRef.current?.focus() }
  }

  async function resolveChat(chat: Chat) {
    if (!confirm('Закрити чат? Нові повідомлення створять новий чат.')) return
    try {
      await api.patch(`/api/v1/chats/${chat.id}/resolve`, {}, { silent: true, timeoutMs: ORDERS_WRITE_TIMEOUT_MS })
      toast.success('Чат закрито')
      setSelection(null)
      loadChats()
    } catch (error) { toast.error(getErrorMessage(error, 'Помилка закриття чату')) }
  }

  function handleCustomerLinked(_customerId: string) {
    loadChats(); loadOrders()
  }

  async function changeOrderStatus(orderId: string, status: string, callbackAt?: string | null) {
    if ((status === 'called' || status === 'no_answer') && callbackAt === undefined) {
      setCallbackModal({ orderId, status })
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      setCallbackDate(tomorrow.toISOString().split('T')[0])
      setCallbackTime('10:00')
      return
    }

    const previousOrders = orders
    orderCacheRef.current.clear()
    setOrders((current) => current.map((order) => order.id === orderId ? { ...order, status } : order))
    try {
      const response = await orderApi.updateStatus(orderId, status as any, callbackAt, { silent: true })
      setOrders((current) => current.map((order) => order.id === orderId ? { ...order, ...response.data } : order))
      toast.success('Статус змінено')
      setCallbackModal(null)
      await loadOrders(false)
    } catch (error) {
      setOrders(previousOrders)
      toast.error(getErrorMessage(error, 'Не вдалося змінити статус'))
    }
  }

  function handleConfirmCallback() {
    if (!callbackModal) return
    const dt = new Date(`${callbackDate}T${callbackTime}`)
    if (isNaN(dt.getTime())) {
      toast.error('Вкажіть коректну дату та час')
      return
    }
    changeOrderStatus(callbackModal.orderId, callbackModal.status, dt.toISOString())
  }

  async function updateItemStatus(orderId: string, itemId: string, status: string) {
    try {
      await orderApi.updateItemStatus(orderId, itemId, status as any, { silent: true })
      toast.success('Статус змінено')
      loadOrders()
    } catch (error) { toast.error(getErrorMessage(error, 'Не вдалося змінити статус позиції')) }
  }

  function openOrderPaymentInPos(order: CustomerOrder) {
    const searchValue = order.order_number ? String(order.order_number) : order.id
    navigate(`/pos?order=${encodeURIComponent(searchValue)}`)
  }

  async function handleCancel(order: CustomerOrder, refund: boolean) {
    try {
      await orderApi.cancel(order.id, refund, undefined, undefined, { silent: true })
      toast.success(refund ? 'Скасовано, передоплату повернено' : 'Замовлення скасовано')
      setCancelModal(null)
      loadOrders()
    } catch (error) { toast.error(getErrorMessage(error, 'Не вдалося скасувати замовлення')) }
  }

  async function handleCancelAsCredit(order: CustomerOrder) {
    try {
      await orderApi.cancel(order.id, false, null, true, { silent: true })
      toast.success('Скасовано, передоплата залишена як кредит')
      setCancelModal(null)
      loadOrders()
    } catch (error) { toast.error(getErrorMessage(error, 'Не вдалося скасувати замовлення')) }
  }

  // Швидке «В замовлення» прямо зі списку, без відкриття накладної:
  // закриваємо відкрите замовлення як «Замовлено» (status='ordered', без резерву складу).
  async function handleQuickOrder(order: CustomerOrder) {
    try {
      await orderApi.updateStatus(order.id, 'ordered', undefined, { silent: true })
      toast.success(`${formatOrderNo(order)} → В замовлення`)
      loadOrders()
    } catch (error) { toast.error(getErrorMessage(error, 'Не вдалося оформити в замовлення')) }
  }

  async function handleDeleteOrder(order: CustomerOrder) {
    const label = formatOrderNo(order)
    const client = order.customer?.full_name ?? order.customer?.phone ?? 'без клієнта'
    if (!confirm(`Видалити ${label} (${client}) зі списку?\n\nДія буде записана в журнал. Фінансові документи та історія залишаться збереженими.`)) return
    try {
      await orderApi.delete(order.id, { silent: true })
      if (selection?.kind === 'order' && selection.id === order.id) setSelection(null)
      toast.success(`${label} видалено зі списку`)
      await loadOrders()
    } catch (error) {
      toast.error(getErrorMessage(error, 'Не вдалося видалити замовлення'))
    }
  }

  async function loadBulkItems() {
    if (!bulkSupplier) return
    try {
      const { data } = await orderApi.pendingItems(bulkSupplier, { silent: true })
      setBulkItems(data)
      setBulkSelected(new Set(data.map((i: any) => i.id)))
    } catch (error) { toast.error(getErrorMessage(error, 'Помилка завантаження')) }
  }

  async function handleBulkArrival() {
    if (bulkSelected.size === 0) { toast.error('Виберіть позиції'); return }
    try {
      await orderApi.bulkArrival([...bulkSelected], { silent: true })
      toast.success(`Прийнято ${bulkSelected.size} позицій`)
      setBulkOpen(false); setBulkItems([]); setBulkSupplier('')
      loadOrders()
    } catch (error) { toast.error(getErrorMessage(error, 'Не вдалося прийняти позиції')) }
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
        <header className="bg-white border-b border-gray-100 px-3 md:px-6 py-3 md:py-3.5 min-h-[58px] flex items-center justify-between shrink-0 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button className="md:hidden shrink-0 p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
              onClick={() => setSidebarOpen(true)} aria-label="Меню">
              <Menu size={20} />
            </button>
            {selection ? (
              <button onClick={() => setSelection(null)}
                className="md:hidden shrink-0 text-gray-400 hover:text-gray-600 transition-colors text-xl leading-none"
                aria-label="Повернутися до списку"
                title="Повернутися до списку">
                ←
              </button>
            ) : null}
            <h1 className="font-bold text-gray-900 text-base md:text-lg leading-tight truncate">{chatMode ? 'Чат-боти' : 'Замовлення'}</h1>
          </div>
          {!chatMode && (
          <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
            <div className="flex items-center gap-1 rounded-xl bg-gray-50 p-0.5">
              <Button size="sm" icon={<Plus size={14} />} onClick={() => navigate('/orders/new')} title="Нове замовлення">
                <span className="hidden sm:inline">Нове замовлення</span><span className="sm:hidden">Нове</span>
              </Button>
              <Button variant="secondary" size="sm" icon={<FilePen size={14} />} onClick={() => navigate('/quotes/new')} title="Чернетка">
                <span className="hidden sm:inline">Чернетка</span><span className="sm:hidden">Черн.</span>
              </Button>
            </div>
          </div>
          )}
        </header>
        {!chatMode && <SubNavTabs tabs={ORDERS_TABS} currentRole={role} />}

        {/* робоча площина */}
        <div className="flex-1 flex min-h-0 min-w-0">
          {tab === 'bots' ? (
            <>

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
                      Ліди — запити ({displayOrders.length})
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
                onOpenChat={(chatId) => navigate('/chats?chat_id=' + encodeURIComponent(chatId))}
                onChangeStatus={(s) => changeOrderStatus(selectedOrder.id, s)}
                onItemStatus={(itemId, s) => updateItemStatus(selectedOrder.id, itemId, s)}
                onPay={() => openOrderPaymentInPos(selectedOrder)}
                onCancel={() => setCancelModal(selectedOrder)}
                onRepeat={() => startRepeatOrder(selectedOrder, navigate)}
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
            </>
          ) : tab === 'drafts' ? (
            <DraftsGrid 
              orders={orders} 
              loading={loadingOrders}
              onLoad={loadOrders} 
              onEdit={(id) => navigate('/quotes/' + id)} 
              offset={offset}
              onPrevPage={() => setOffset(Math.max(0, offset - 50))}
              onNextPage={() => setOffset(offset + 50)}
              hasMore={orders.length >= 50}
            />
          ) : (
            <OrdersTable 
              orders={displayOrders} 
              loading={loadingOrders}
              search={search} 
              setSearch={setSearch} 
              offset={offset}
              onPrevPage={() => setOffset(Math.max(0, offset - 50))}
              onNextPage={() => setOffset(offset + 50)}
              hasMore={orders.length >= 50}
              onQuickView={(o) => navigate('/orders/' + o.id)}
              onQuickOrder={handleQuickOrder}
              onDelete={handleDeleteOrder}
              canDelete={role === 'owner' || role === 'admin'}
              statusTab={tab}
              onStatusTab={setTab}
            />
          )}
        </div>
      </div>

      {/* ── Модал скасування ── */}
      <Modal open={!!cancelModal} onClose={() => setCancelModal(null)} title="Скасувати замовлення" size="sm">
        {cancelModal && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {(cancelModal.total_paid ?? cancelModal.prepayment ?? 0) > 0
                ? `Оплачено: ${formatMoney(cancelModal.total_paid ?? cancelModal.prepayment ?? 0)}. Що робити з грошима?`
                : 'Ви впевнені, що хочете скасувати це замовлення?'}
            </p>
            {(cancelModal.total_paid ?? cancelModal.prepayment ?? 0) > 0 ? (
              <div className="space-y-2">
                <Button onClick={() => handleCancel(cancelModal, true)} className="w-full bg-red-600 hover:bg-red-700 text-white">
                  💰 Повернути {formatMoney(cancelModal.total_paid ?? cancelModal.prepayment ?? 0)}
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
              <button
                onClick={() => setShowCustPanelMobile(false)}
                className="text-gray-400 hover:text-gray-600 p-1"
                aria-label="Закрити картку клієнта"
                title="Закрити"
              >
                <X size={20} />
              </button>
            </div>
            <div className="flex-grow overflow-y-auto min-h-0">
              <CustomerPanel chat={selectedChat} messages={messages} onCustomerLinked={handleCustomerLinked} />
            </div>
          </div>
        </div>
      )}

      {/* Модал планування передзвону (P2 Fix 14) */}
      <Modal
        open={callbackModal !== null}
        onClose={() => setCallbackModal(null)}
        title="Запланувати передзвон"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            Ви переводите замовлення в статус "${callbackModal?.status === 'called' ? 'Повідомлено' : 'Не відповів'}". 
            Вкажіть дату та час для повторного контакту.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Дата"
              type="date"
              value={callbackDate}
              onChange={(e) => setCallbackDate(e.target.value)}
            />
            <Input
              label="Час"
              type="time"
              value={callbackTime}
              onChange={(e) => setCallbackTime(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={handleConfirmCallback} className="flex-1">
              📅 Запланувати
            </Button>
            <Button
              variant="secondary"
              onClick={() => changeOrderStatus(callbackModal!.orderId, callbackModal!.status, null)}
              className="flex-1"
            >
              Пропустити
            </Button>
          </div>
        </div>
      </Modal>

    </div>
  )
}

// ───────────────────────── Order inline view ─────────────────────────

function OrderInlineView({
  order, now, onOpenFull, onEditDraft, onOpenChat,
  onChangeStatus, onItemStatus, onPay, onCancel, onRepeat,
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
  onRepeat: () => void
}) {
  const conf = STATUS_CONFIG[order.status] ?? { label: order.status, color: 'gray' as BadgeColor }
  const srcConf = SOURCE_CONFIG[order.source] ?? { label: order.source, icon: <AlertCircle size={10} /> }
  const draft = isDraft(order)
  const totalPaid = order.total_paid ?? order.prepayment
  // Скасоване замовлення не має «залишку до сплати» — обов'язань немає
  const remaining = order.status === 'canceled' ? 0 : order.total_amount - totalPaid
  const allArrived = order.items.every((i) => ['arrived', 'handed', 'canceled'].includes(i.item_status))
  const allHanded = order.items.every((i) => ['handed', 'canceled'].includes(i.item_status))
  const terminal = isTerminalOrderStatus(order.status)
  const canComplete = allArrived && !allHanded && !terminal
  const canCancel = !terminal
  const overdue = order.pickup_deadline_at && new Date(order.pickup_deadline_at) < now
  const coreDepositTotal = order.items
    .filter((i) => i.item_status !== 'canceled')
    .reduce((s, i) => s + (i.core_deposit_amount ?? 0) * i.qty, 0)
  const allItemsCanceled = order.items.length > 0 && order.items.every((i) => i.item_status === 'canceled')

  return (
    <div className="flex-1 overflow-y-auto p-3 md:p-6 pb-safe">
      <div className="max-w-3xl mx-auto space-y-4">

        {/* шапка */}
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2 flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-bold text-gray-800">{formatOrderNo(order)}</span>
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
              {coreDepositTotal > 0 && (
                <div className="text-xs text-yellow-600 font-medium">у т.ч. застава: {formatMoney(coreDepositTotal)}</div>
              )}
              {totalPaid > 0 && <div className="text-xs text-green-600">Сплачено: {formatMoney(totalPaid)}</div>}
              {remaining > 0 && !allHanded && <div className="text-xs text-orange-600">Залишок: {formatMoney(remaining)}</div>}
            </div>
          </div>
          {allItemsCanceled && canCancel && (
            <div className="mt-3 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-sm text-red-700 font-medium flex flex-wrap items-center justify-between gap-2">
              <span>⚠️ Всі позиції скасовані — скасуйте замовлення або додайте нові позиції через редагування.</span>
              <Button size="sm" onClick={onCancel} className="bg-red-600 hover:bg-red-700 text-white shrink-0">
                ❌ Скасувати замовлення
              </Button>
            </div>
          )}
        </Card>

        {/* кнопки дій */}
        <div className="flex gap-2 flex-wrap">
          {draft ? (
            <Button icon={<FilePen size={14} />} onClick={onEditDraft}>Редагувати чернетку</Button>
          ) : canComplete && (
            <Button onClick={onPay} className="bg-green-600 hover:bg-green-700 text-white">{remaining > 0 ? '💰 Оплата / видача в касі' : '📦 Видати товар'}</Button>
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
          {!draft && order.items.length > 0 && (
            <Button size="sm" variant="secondary" icon={<Copy size={14} />} onClick={onRepeat}>
              Повторити
            </Button>
          )}
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
                const itemConf = ITEM_STATUS_CONFIG[item.item_status]
                return (
                  <div key={item.id} className="flex flex-col sm:flex-row sm:items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm gap-1.5">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-gray-800">{item.name}</span>
                      {item.sku && <span className="text-gray-400 text-xs ml-1.5 font-mono">{item.sku}</span>}
                      <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${itemConf?.cls ?? 'bg-gray-100 text-gray-600'}`}>
                        {itemConf?.label ?? item.item_status}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 md:gap-2 shrink-0 ml-0 sm:ml-2 flex-wrap">
                      <span className="text-gray-600 text-xs whitespace-nowrap">
                        {item.qty} × {formatMoney(item.sell_price)}
                        {(item.core_deposit_amount ?? 0) > 0 && item.item_status !== 'canceled' && (
                          <span className="text-yellow-600"> +{formatMoney((item.core_deposit_amount ?? 0) * item.qty)} застава</span>
                        )}
                      </span>
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
