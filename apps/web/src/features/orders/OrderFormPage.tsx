import { useEffect, useState, useMemo, useRef, useId } from 'react'
import { useNavigate, useSearchParams, useParams } from 'react-router-dom'
import { Plus, Trash2, User, Car, Check, ChevronRight, ArrowLeft, Search, ClipboardList, X } from 'lucide-react'
import { orderApi, type CreateOrderPayload, type CustomerOrder } from './orderApi'
import { productApi } from '@/features/products/productApi'
import { kopecksToHryvnia } from '@/types/product'
import type { Product } from '@/types/product'
import { customerApi } from '@/features/customers/customerApi'
import { supplierApi } from '@/features/suppliers/supplierApi'
import { adminApi } from '@/features/admin/adminApi'
import { pricingApi } from '@/features/admin/pricingApi'
import { customerVehiclesApi } from '@/features/customers/customerVehiclesApi'
import { api } from '@/lib/api'
import { recognizeVehicleImage } from '@/lib/vehicleOcr'
import { Layout } from '@/components/Layout'
import { Button, Input, Card } from '@/components/ui'
import { buildMessengerText, printInvoice, printDeliveryNote, loadSellerRequisites, hasSellerRequisites } from './orderDocuments'
import { toast } from '@/components/ui/Toast'
import { OrderProductResults } from './OrderProductResults'
import { availableStock, orderNumber, stockFirst, validateOrderRows, replaceOrderProduct } from './orderUx'
import { readOrderFormDraft, writeOrderFormDraft } from './orderFormDraft'
import { saveOrderForm } from './orderFormSave'
import { useAuthStore } from '@/stores/authStore'
function saveRecentItem(key: string, value: string) {
  if (!value) return
  try {
    const raw = localStorage.getItem(key)
    const items: string[] = raw ? JSON.parse(raw) : []
    const next = [value, ...items.filter(i => i !== value)].slice(0, 5)
    localStorage.setItem(key, JSON.stringify(next))
  } catch (err) {
    console.error('Failed to save to localStorage:', err)
  }
}

function getRecentItems(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

import { formatMoney } from '@/lib/utils'
import type { Customer, CustomerVehicle } from '@/types/customer'

// ─── Helpers ───
const VIN_WMI: Record<string, string> = {
  WBA: 'BMW', WBS: 'BMW', WDB: 'Mercedes-Benz', WDD: 'Mercedes-Benz',
  WAU: 'Audi', WUA: 'Audi', WVW: 'Volkswagen', VF1: 'Renault',
  JTD: 'Toyota', JHM: 'Honda', KMH: 'Hyundai', KNA: 'Kia',
  SAL: 'Land Rover', YV1: 'Volvo', ZAR: 'Alfa Romeo', ZFA: 'Fiat',
  WF0: 'Ford', W0L: 'Opel', JSA: 'Mazda', TMB: 'Škoda',
}

function vinMake(vin: string): string {
  if (!vin) return 'Авто'
  const cleanVin = vin.trim().toUpperCase()
  return VIN_WMI[cleanVin.slice(0, 4)] ?? VIN_WMI[cleanVin.slice(0, 3)] ?? 'Авто'
}

interface Supplier { id: string; name: string }

function normalizeSupplierName(value: string): string {
  return value.trim().toLocaleLowerCase('uk-UA')
}

function uniqueSuppliers(list: Supplier[]): Supplier[] {
  const seen = new Set<string>()
  return list.filter((supplier) => {
    const key = normalizeSupplierName(supplier.name)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function SupplierQuickPicker({
  suppliers,
  value,
  onChange,
  onCreate,
  placeholder = 'Постачальник',
}: {
  suppliers: Supplier[]
  value: string
  onChange: (supplierId: string) => void
  onCreate: (name: string) => Promise<Supplier | null>
  placeholder?: string
}) {
  const [text, setText] = useState('')
  const [creating, setCreating] = useState(false)
  const reactListId = useId()
  const listId = `supplier-list-${reactListId.replace(/:/g, '')}`

  useEffect(() => {
    if (!value) return
    const selected = suppliers.find((supplier) => supplier.id === value)
    if (selected) setText(selected.name)
  }, [value, suppliers])

  function applyText(nextText: string) {
    setText(nextText)
    const exact = suppliers.find((supplier) => normalizeSupplierName(supplier.name) === normalizeSupplierName(nextText))
    onChange(exact?.id ?? '')
  }

  async function handleCreate() {
    const name = text.trim()
    if (!name) {
      toast.error('Вкажіть назву постачальника')
      return
    }
    const exact = suppliers.find((supplier) => normalizeSupplierName(supplier.name) === normalizeSupplierName(name))
    if (exact) {
      onChange(exact.id)
      setText(exact.name)
      return
    }
    setCreating(true)
    try {
      const created = await onCreate(name)
      if (created) {
        onChange(created.id)
        setText(created.name)
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex gap-1.5">
      <input
        value={text}
        list={listId}
        onChange={(event) => applyText(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
      />
      <datalist id={listId}>
        {suppliers.map((supplier) => <option key={supplier.id} value={supplier.name} />)}
      </datalist>
      {text.trim() && !suppliers.some((supplier) => normalizeSupplierName(supplier.name) === normalizeSupplierName(text)) && <button
        type="button"
        onClick={handleCreate}
        disabled={creating}
        title="Додати постачальника"
        className="shrink-0 rounded-lg border border-gray-200 bg-white px-3 text-sm font-bold text-gray-600 hover:border-yellow-300 hover:bg-yellow-50 hover:text-yellow-700 disabled:opacity-60"
      >
        {creating ? '...' : <Plus size={16} />}
      </button>}
    </div>
  )
}

interface ItemRow {
  local_key?: string
  id?:         string
  name:        string
  sku:         string
  qty:         string
  sell_price:  string
  supplier_id: string
  expected_date?: string
  product_id?: string | null
  stock?:      number
  item_type?:  'product' | 'service'
  item_status?: CustomerOrder['items'][number]['item_status']
  buy_price?:  string
  source_type?: 'warehouse' | 'supplier'
}

const EMPTY_ITEM: ItemRow = { name: '', sku: '', qty: '1', sell_price: '0', supplier_id: '', expected_date: '', product_id: null, item_type: 'product', buy_price: '0', source_type: 'supplier' }

interface FormBackup {
  items: ItemRow[]; customerId: string; selectedCustomer: Customer | null
  selectedVehicle: CustomerVehicle | null; vehicles: CustomerVehicle[]
  loadedVehicleInfo: { make?: string; model?: string; year?: number; vin?: string } | null
  loadedOrderVersion?: string; comment: string; isUrgent: boolean; step: 1 | 2 | 3 | 4
  newCustName: string; newCustPhone: string; newVehBrand: string; newVehModel: string
  newVehYear: string; newVehVin: string; showAddCustomer: boolean; showAddVehicle: boolean
  draftHint: CustomerOrder | null; totalPaid: number; loadedStatus: string
}

export default function OrderFormPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const user = useAuthStore((state) => state.session?.user)
  const key = `forsage:order-form:v1:${user?.app_metadata?.tenant_id ?? 'local'}:${user?.id ?? 'anonymous'}:${id ?? 'new'}:${params.toString()}`
  const [revision, setRevision] = useState(0)
  return <OrderFormEditor key={`${key}:${revision}`} backupKey={key} onReset={() => setRevision((value) => value + 1)} />
}

function OrderFormEditor({ backupKey, onReset }: { backupKey: string; onReset: () => void }) {
  const [backup] = useState(() => readOrderFormDraft<FormBackup>(backupKey))
  const backupFinished = useRef(false)
  const [backupState, setBackupState] = useState('')
  const [discardPrompt, setDiscardPrompt] = useState(false)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { id } = useParams()
  const [loading, setLoading] = useState(!backup && Boolean(id || searchParams.get('draftId')))
  const [loadError, setLoadError] = useState('')
  const sourceDraftId = !id ? searchParams.get('draftId') : null
  const [formReady, setFormReady] = useState(!id && !sourceDraftId)
  const [totalPaid, setTotalPaid] = useState(0)
  const [loadedStatus, setLoadedStatus] = useState('lead')
  const [draftHint, setDraftHint] = useState<CustomerOrder | null>(null)
  const [draftHintOpen, setDraftHintOpen] = useState(!!sourceDraftId)

  // ORD-3: на десктопі (≥1024px) показуємо всі секції на одному екрані без кроків
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Wizard state
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)

  // Step 1: Customer
  const [customerId, setCustomerId] = useState('')
  const [loadedOrderVersion, setLoadedOrderVersion] = useState<string>()
  const [customerSearch, setCustomerSearch] = useState('')
  const [defaultCustomers, setDefaultCustomers] = useState<Customer[]>([])
  const [searchedCustomers, setSearchedCustomers] = useState<Customer[]>([])
  const [defaultCustomersLoading, setDefaultCustomersLoading] = useState(true)
  const [searchCustomersLoading, setSearchCustomersLoading] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  
  // Inline Create Customer
  const [showAddCustomer, setShowAddCustomer] = useState(false)
  const [newCustName, setNewCustName] = useState('')
  const [newCustPhone, setNewCustPhone] = useState('')
  const [addingCustomer, setAddingCustomer] = useState(false)

  // Step 2: Vehicle
  const [vehicles, setVehicles] = useState<CustomerVehicle[]>([])
  const [selectedVehicle, setSelectedVehicle] = useState<CustomerVehicle | null>(null)
  // Авто із замовлення, якого немає в гаражі клієнта — щоб при редагуванні
  // НЕ загубити його (інакше vehicle_info затирався б на null при збереженні)
  const [loadedVehicleInfo, setLoadedVehicleInfo] = useState<{ make?: string; model?: string; year?: number; vin?: string } | null>(null)

  // Inline Create Vehicle
  const [showAddVehicle, setShowAddVehicle] = useState(false)
  const [newVehBrand, setNewVehBrand] = useState('')
  const [newVehModel, setNewVehModel] = useState('')
  const [newVehYear, setNewVehYear] = useState('')
  const [newVehVin, setNewVehVin] = useState('')
  const [addingVehicle, setAddingVehicle] = useState(false)

  useEffect(() => {
    if (id || backup) return
    const vin = searchParams.get('vin')?.trim().toUpperCase() ?? ''
    const make = searchParams.get('make')?.trim() ?? ''
    const model = searchParams.get('model')?.trim() ?? ''
    const yearText = searchParams.get('year')?.trim() ?? ''
    const year = Number.parseInt(yearText, 10)
    if (!vin && !make && !model && !Number.isFinite(year)) return

    setNewVehVin(vin)
    setNewVehBrand(make)
    setNewVehModel(model)
    setNewVehYear(Number.isFinite(year) ? String(year) : '')
    setLoadedVehicleInfo({
      vin: vin || undefined,
      make: make || undefined,
      model: model || undefined,
      year: Number.isFinite(year) ? year : undefined,
    })
    setShowAddVehicle(true)
  }, [id, searchParams])

  // Duplicate order initialization (P1 Fix 9)
  useEffect(() => {
    if (id || backup) return
    const raw = sessionStorage.getItem('duplicate_order_payload')
    if (raw) {
      sessionStorage.removeItem('duplicate_order_payload')
      try {
        const payload = JSON.parse(raw)
        if (payload.customer_id) {
          setCustomerId(payload.customer_id)
          // Load customer
          customerApi.get(payload.customer_id)
            .then((r) => {
              if (r.data) setSelectedCustomer(r.data)
            })
            .catch(() => {})
          // Load vehicles
          customerVehiclesApi.list(payload.customer_id)
            .then((res) => {
              const list = res.data || []
              setVehicles(list)
              if (payload.vehicle_info) {
                const veh = list.find((v) => 
                  v.brand === payload.vehicle_info.make && 
                  v.model === payload.vehicle_info.model && 
                  v.vin === payload.vehicle_info.vin
                )
                if (veh) setSelectedVehicle(veh)
              }
            })
            .catch(() => {})
        }
        if (payload.items && payload.items.length > 0) {
          setItems(payload.items)
        }
      } catch (e) {
        console.error('Duplication payload error', e)
      }
    }
  }, [id])

  // Чернетка не перетворюється на напівготове замовлення автоматично.
  // Вона висить поруч як список-підказка, а менеджер заповнює нормальну накладну.
  useEffect(() => {
    if (!sourceDraftId || backup) return
    orderApi.get(sourceDraftId)
      .then(({ data: draft }) => {
        setDraftHint(draft)
        setDraftHintOpen(true)
        setComment(draft.comment ?? '')
        if (draft.customer) {
          setCustomerId(draft.customer.id)
          customerApi.get(draft.customer.id)
            .then((result) => setSelectedCustomer(result.data))
            .catch(() => {})
          customerVehiclesApi.list(draft.customer.id)
            .then((result) => {
              setVehicles(result.data ?? [])
              const matched = (result.data ?? []).find((vehicle) => vehicle.vin === draft.vehicle_info?.vin)
              if (matched) setSelectedVehicle(matched)
            })
            .catch(() => {})
        }
        if (draft.vehicle_info) setLoadedVehicleInfo(draft.vehicle_info)
        setStep(3)
      })
      .catch(() => {
        toast.error('Чернетку не знайдено')
        navigate('/orders?tab=drafts')
      })
      .finally(() => { setFormReady(true); setLoading(false) })
  }, [sourceDraftId, navigate])

  // Load existing order details for editing (P0 Fix 1)
  useEffect(() => {
    if (!id || backup) return
    setLoading(true)
    orderApi.get(id)
      .then((r) => {
        const o = r.data
        if (!o) return
        setLoadedOrderVersion(o.updated_at)
        setTotalPaid(o.total_paid ?? o.prepayment ?? 0)
        setLoadedStatus(o.status)
        
        // Load customer
        if (o.customer) {
          setCustomerId(o.customer.id)
          const fallbackCust: Customer = {
            id: o.customer.id,
            phone: o.customer.phone,
            full_name: o.customer.full_name,
            email: '',
            debt_balance: 0,
            notes: null,
            tags: [],
            price_tier_id: null,
            price_tier: null,
            bonus_balance: 0,
            vip_level: 'standard',
            risk_profile: 'low',
            card_barcode: null,
            primary_vin: o.vehicle_info?.vin ?? null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
          }
          customerApi.get(o.customer.id)
            .then((res) => {
              if (res.data) setSelectedCustomer(res.data)
              else setSelectedCustomer(fallbackCust)
            })
            .catch(() => {
              setSelectedCustomer(fallbackCust)
            })
          
          // Load vehicles
          customerVehiclesApi.list(o.customer.id)
            .then((res) => {
              const list = res.data || []
              setVehicles(list)
              if (o.vehicle_info) {
                const veh = list.find((v) =>
                  v.brand === o.vehicle_info?.make &&
                  v.model === o.vehicle_info?.model &&
                  v.vin === o.vehicle_info?.vin
                )
                if (veh) setSelectedVehicle(veh)
                // Авто є в замовленні, але не в гаражі — зберігаємо, щоб не загубити
                else setLoadedVehicleInfo(o.vehicle_info as any)
              }
            })
            .catch(() => {})
        } else if (o.vehicle_info) {
          // Замовлення без клієнта, але з авто — теж не губимо
          setLoadedVehicleInfo(o.vehicle_info as any)
        }
        
        // Set comment & urgency
        let cleanComment = o.comment ?? ''
        if (cleanComment.includes('[ТЕРМІНОВО]')) {
          setIsUrgent(true)
          cleanComment = cleanComment.replace('[ТЕРМІНОВО]', '').trim()
        }
        setComment(cleanComment)
        
        // Оплати замовлень більше не редагуються тут: гроші приймає касир у касі.
        
        // Items
        if (o.items && o.items.length > 0) {
          setItems(o.items.map(item => ({
            id: item.id,
            name: item.name,
            sku: item.sku ?? '',
            qty: item.qty.toString(),
            sell_price: (item.sell_price / 100).toString(),
            supplier_id: item.supplier_id ?? '',
            expected_date: item.expected_date ? item.expected_date.split('T')[0] : '',
            product_id: item.product_id ?? null,
            item_type: item.item_type ?? 'product',
            item_status: item.item_status,
            buy_price: item.buy_price ? (item.buy_price / 100).toString() : '0',
            source_type: item.source_type ?? (item.product_id ? 'warehouse' : 'supplier'),
          })))
        }
        // Редагування: клієнт і авто вже відомі — одразу переходимо до позицій,
        // щоб не показувати екран вибору клієнта «з нуля» (плутало користувачів)
        setStep(3)
        setFormReady(true)
      })
      .catch(() => setLoadError('Не вдалося завантажити замовлення. Нічого не змінено.'))
      .finally(() => setLoading(false))
  }, [id])

  // Step 3: Items
  const [items, setItems] = useState<ItemRow[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])

  // Швидка націнка: відсотки та округлення беремо з Налаштувань магазину.
  const [quickPercents, setQuickPercents] = useState<number[]>([])
  const [priceRounding, setPriceRounding] = useState<{ enabled: boolean; step: number; dir: 'up' | 'down' | 'nearest' }>({ enabled: false, step: 100, dir: 'nearest' })
  useEffect(() => {
    adminApi.getSettings()
      .then((r) => {
        const s = r.data
        const pcts = Array.isArray(s.quick_percents) ? s.quick_percents.filter((n) => Number(n) > 0) : []
        setQuickPercents(pcts)
        setPriceRounding({
          enabled: s.price_rounding_enabled === true,
          step: Number(s.price_rounding_step) || 100,
          dir: s.price_rounding_dir === 'up' || s.price_rounding_dir === 'down' ? s.price_rounding_dir : 'nearest',
        })
      })
      .catch(() => {})
  }, [])


  // Step 4: Summary & Checkout
  const [comment, setComment] = useState('')
  const [isUrgent, setIsUrgent] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    if (!backup) return
    setItems(backup.items); setCustomerId(backup.customerId); setSelectedCustomer(backup.selectedCustomer)
    setSelectedVehicle(backup.selectedVehicle); setVehicles(backup.vehicles ?? [])
    setLoadedVehicleInfo(backup.loadedVehicleInfo); setLoadedOrderVersion(backup.loadedOrderVersion)
    setComment(backup.comment); setIsUrgent(backup.isUrgent); setStep(backup.step)
    setNewCustName(backup.newCustName); setNewCustPhone(backup.newCustPhone)
    setNewVehBrand(backup.newVehBrand); setNewVehModel(backup.newVehModel); setNewVehYear(backup.newVehYear); setNewVehVin(backup.newVehVin)
    setShowAddCustomer(backup.showAddCustomer); setShowAddVehicle(backup.showAddVehicle)
    setDraftHint(backup.draftHint); setTotalPaid(backup.totalPaid ?? 0); setLoadedStatus(backup.loadedStatus ?? 'lead')
    setFormReady(true)
  }, [backup])

  const snapshot: FormBackup = { items, customerId, selectedCustomer, selectedVehicle, vehicles, loadedVehicleInfo, loadedOrderVersion, comment, isUrgent, step,
    newCustName, newCustPhone, newVehBrand, newVehModel, newVehYear, newVehVin, showAddCustomer, showAddVehicle, draftHint, totalPaid, loadedStatus }
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const readyRef = useRef(formReady)
  readyRef.current = formReady
  const snapshotJson = JSON.stringify(snapshot)
  useEffect(() => {
    if (!formReady || backupFinished.current) return
    const timer = window.setTimeout(() => {
      if (backupFinished.current) return
      const ok = writeOrderFormDraft(backupKey, snapshotRef.current)
      setBackupState(ok ? 'Введені дані збережено на цьому пристрої' : 'Не вдалося зберегти форму на пристрої. Збережіть замовлення перед виходом.')
    }, 300)
    return () => window.clearTimeout(timer)
  }, [backupKey, formReady, snapshotJson])
  useEffect(() => {
    const flush = () => {
      if (readyRef.current && !backupFinished.current) writeOrderFormDraft(backupKey, snapshotRef.current)
    }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); flush() }
  }, [backupKey])

  // Query parameter support
  useEffect(() => {
    if (backup) return
    const qCustomerId = searchParams.get('customer_id')
    if (qCustomerId) {
      customerApi.get(qCustomerId)
        .then((r) => {
          if (r.data) {
            handleCustomerSelect(r.data)
          }
        })
        .catch(() => {})
    }
  }, [searchParams])

  // Load default/recent customers on mount
  useEffect(() => {
    customerApi.list({ per_page: 5, sort: 'recent' })
      .then((r) => setDefaultCustomers((r as any).data ?? []))
      .catch(() => {})
      .finally(() => setDefaultCustomersLoading(false))

    supplierApi.list({ per_page: 200, is_active: 'true' })
      .then((r) => setSuppliers(uniqueSuppliers((r as any).data ?? [])))
      .catch(() => {})
  }, [])

  // Auto-search customers
  useEffect(() => {
    const query = customerSearch.trim()
    if (query.length < 2) {
      setSearchedCustomers([])
      setSearchCustomersLoading(false)
      return
    }

    let cancelled = false
    setSearchCustomersLoading(true)
    const timer = window.setTimeout(() => {
      customerApi.list({ search: query, per_page: 8 })
        .then((r) => { if (!cancelled) setSearchedCustomers((r as any).data ?? []) })
        .catch(() => { if (!cancelled) setSearchedCustomers([]) })
        .finally(() => { if (!cancelled) setSearchCustomersLoading(false) })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [customerSearch])

  // Decode brand from VIN on the fly
  useEffect(() => {
    if (newVehVin.length >= 4) {
      const brand = vinMake(newVehVin)
      if (brand !== 'Авто') {
        setNewVehBrand(brand)
      }
    }
  }, [newVehVin])

  // Selection handlers
  const customerVehicleRequest = useRef(0)
  function handleSkipCustomer() {
    customerVehicleRequest.current++
    setSelectedCustomer(null)
    setCustomerId('')
    setSelectedVehicle(null)
    setLoadedVehicleInfo(null)
    setVehicles([])
    setStep(3)
  }

  function handleCustomerSelect(c: Customer) {
    const request = ++customerVehicleRequest.current
    if (customerId && customerId !== c.id) setLoadedVehicleInfo(null)
    setSelectedVehicle(null)
    setVehicles([])
    setSelectedCustomer(c)
    setCustomerId(c.id)
    setCustomerSearch('')
    setShowAddCustomer(false)

    // Load customer vehicles
    customerVehiclesApi.list(c.id)
      .then((r) => {
        if (request !== customerVehicleRequest.current) return
        const list = (r as any).data ?? []
        setVehicles(list)
        // ORD-4: якщо авто рівно одне — підставляємо й одразу до товарів
        if (list.length === 1) {
          setSelectedVehicle(list[0])
          setStep(3)
        } else {
          setStep(2)
        }
      })
      .catch(() => {
        if (request !== customerVehicleRequest.current) return
        setStep(2)
      })
  }

  function handleVehicleSelect(v: CustomerVehicle | null) {
    setSelectedVehicle(v)
    setLoadedVehicleInfo(null)
    setShowAddVehicle(false)
    setStep(3)
  }

  // Create handlers
  async function handleCreateCustomer(e: React.FormEvent) {
    e.preventDefault()
    if (!newCustPhone.trim()) {
      toast.error('Введіть номер телефону')
      return
    }
    setAddingCustomer(true)
    try {
      const res = await customerApi.quickCreate(newCustPhone.trim(), newCustName.trim())
      if (res.data) {
        toast.success(res.meta?.reused ? 'Клієнт уже є в базі — вибрано його картку' : 'Клієнта створено!')
        saveRecentItem('recent_phones', newCustPhone.trim())
        handleCustomerSelect(res.data)
      }
    } catch (err) {
      // Телефон уже в базі — не глухий кут, а підставляємо існуючого клієнта
      if (err instanceof Error && /вже існує/i.test(err.message)) {
        try {
          const found = await customerApi.list({ search: newCustPhone.trim(), page: 1, per_page: 1 })
          const existing = found.data?.[0]
          if (existing) {
            toast.success(`Клієнт уже є в базі — вибрано: ${existing.full_name ?? existing.phone}`)
            handleCustomerSelect(existing)
            return
          }
        } catch { /* впадемо в загальну помилку нижче */ }
      }
      toast.error(err instanceof Error ? err.message : 'Помилка при створенні клієнта')
    } finally {
      setAddingCustomer(false)
    }
  }

  const [decodingVin, setDecodingVin] = useState(false)
  async function handleDecodeVin() {
    const vin = newVehVin.trim()
    if (vin.length < 11) { toast.error('Введіть VIN (мінімум 11 символів)'); return }
    setDecodingVin(true)
    try {
      const { data } = await api.get<{ data: { make: string; model: string; year: string } }>(
        `/api/v1/vin/decode?vin=${encodeURIComponent(vin)}`,
      )
      if (data.make) setNewVehBrand(data.make)
      if (data.model) setNewVehModel(data.model)
      if (data.year) setNewVehYear(String(data.year))
      if (data.make || data.model) toast.success('VIN декодовано')
      else toast.warning('Сервіс не повернув марку/модель за цим VIN')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка декодування VIN')
    } finally {
      setDecodingVin(false)
    }
  }

  const [ocrLoading, setOcrLoading] = useState(false)
  async function handleVinPhoto(file: File) {
    setOcrLoading(true)
    try {
      const data = await recognizeVehicleImage(file)
      if (data.vin) setNewVehVin(data.vin)
      if (data.make) setNewVehBrand(data.make)
      if (data.model) setNewVehModel(data.model)
      if (data.year) setNewVehYear(String(data.year))
      setLoadedVehicleInfo({
        vin: data.vin ?? undefined,
        make: data.make ?? undefined,
        model: data.model ?? undefined,
        year: data.year ?? undefined,
      })
      const vehicleLabel = [data.make, data.model, data.year].filter(Boolean).join(' ')
      toast.success(data.vin ? `VIN розпізнано: ${data.vin}` : `Автомобіль розпізнано: ${vehicleLabel}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося розпізнати фото')
    } finally {
      setOcrLoading(false)
    }
  }
  async function handleCreateVehicle(e: React.FormEvent) {
    e.preventDefault()
    if (!newVehBrand.trim() || !newVehModel.trim()) {
      toast.error('Введіть марку та модель')
      return
    }
    setAddingVehicle(true)
    try {
      const res = await customerVehiclesApi.create(customerId, {
        brand: newVehBrand.trim(),
        model: newVehModel.trim(),
        year: newVehYear ? parseInt(newVehYear) : null,
        vin: newVehVin.trim() || null,
      })
      if (res.data) {
        toast.success('Автомобіль додано!')
        // Reload vehicles list
        const vList = await customerVehiclesApi.list(customerId)
        setVehicles((vList as any).data ?? [])
        if (newVehVin.trim()) saveRecentItem('recent_vins', newVehVin.trim())
        handleVehicleSelect(res.data)
      }
    } catch {
      toast.error('Помилка додавання автомобіля')
    } finally {
      setAddingVehicle(false)
    }
  }

  // Єдине поле пошуку товару в замовленні: шукаємо ЛИШЕ у власній базі.
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Product[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  function startReplacement(index: number) {
    setReplaceIndex(index)
    setSearch(items[index].sku || items[index].name)
    searchInputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }

  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setSearchResults([]); setSearchLoading(false); setSearchError(''); return }
    setSearchLoading(true)
    setSearchError('')
    let cancelled = false
    const t = window.setTimeout(async () => {
      try {
        const r = await productApi.search(q, 50)
        if (!cancelled) setSearchResults(stockFirst(r.data ?? []))
      } catch {
        if (!cancelled) {
          setSearchResults([])
          setSearchError('Не вдалося виконати пошук. Перевірте з’єднання та повторіть.')
        }
      } finally {
        if (!cancelled) setSearchLoading(false)
      }
    }, 180)
    return () => { cancelled = true; window.clearTimeout(t) }
  }, [search])

  // Товар не знайдено в базі → одразу додаємо inline-рядок «під замовлення»
  // з підставленою назвою. Без окремого модального вікна — заповнюємо прямо тут.
  function openBackorder() {
    addManualItemRow(search.trim())
    setSearch('')
    setSearchResults([])
  }
  function addProductAsItem(p: Product) {
    setItems((rows) => {
      const stock = availableStock(p)
      if (replaceIndex !== null) {
        return rows.map((row, index) => index !== replaceIndex ? row : replaceOrderProduct(row, p))
      }
      const base = rows
      const existingIndex = base.findIndex((row) => row.product_id === p.id)
      if (existingIndex >= 0) {
        return base.map((row, index) => index === existingIndex
          ? { ...row, qty: String((orderNumber(row.qty) || 0) + 1) }
          : row)
      }
      return [...base, {
        ...EMPTY_ITEM,
        local_key: crypto.randomUUID(),
        name: p.name,
        sku: p.sku ?? '',
        sell_price: kopecksToHryvnia(p.retail_price),
        buy_price: p.purchase_price ? kopecksToHryvnia(p.purchase_price) : '0',
        product_id: p.id,
        stock,
        source_type: stock > 0 || p.is_service ? 'warehouse' : 'supplier',
        item_type: p.is_service ? 'service' : 'product',
      }]
    })
    setSearch('')
    setSearchResults([])
    toast.success(replaceIndex !== null ? 'Товар замінено. Кількість і ціна продажу збережені.' : `Додано: ${p.name}`)
    setReplaceIndex(null)
  }

  // Копіювання списку для месенджера (підтвердження клієнту)
  async function copyMessengerText() {
    const validItems = items.filter((r) => r.name.trim())
    if (!validItems.length) { toast.error('Немає позицій для копіювання'); return }
    const veh = selectedVehicle
      ? { vin: selectedVehicle.vin, make: selectedVehicle.brand, model: selectedVehicle.model }
      : loadedVehicleInfo
        ? { vin: loadedVehicleInfo.vin, make: loadedVehicleInfo.make, model: loadedVehicleInfo.model }
        : null
    const car = veh ? [veh.make, veh.model].filter(Boolean).join(' ') : ''
    const text = buildMessengerText({
      vin: veh?.vin ?? null,
      car: car || null,
      lines: validItems.map((r) => ({
        name: r.name.trim(),
        qty: orderNumber(r.qty) || 0,
        unitHrn: orderNumber(r.sell_price) || 0,
      })),
      fullyPaid: totalPaid >= totalKop && totalKop > 0,
    })
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Скопійовано для месенджера')
    } catch {
      toast.error('Не вдалося скопіювати')
    }
  }

  // Складаємо CustomerOrder-подібний об'єкт із поточного стану форми для документів,
  // щоб можна було сформувати рахунок/накладну прямо з рядків, ще до збереження.
  function buildOrderForDocs(): CustomerOrder {
    const validItems = items.filter((r) => r.name.trim())
    const veh = selectedVehicle
      ? { make: selectedVehicle.brand, model: selectedVehicle.model, year: selectedVehicle.year ?? undefined, vin: selectedVehicle.vin ?? undefined }
      : loadedVehicleInfo ?? null
    return {
      id: id ?? 'new',
      order_number: null,
      customer: selectedCustomer ? { id: selectedCustomer.id, phone: selectedCustomer.phone, full_name: selectedCustomer.full_name } : null,
      vehicle_info: veh,
      created_at: new Date().toISOString(),
      total_amount: totalKop,
      total_paid: totalPaid,
      prepayment: totalPaid,
      items: validItems.map((r, i) => ({
        id: r.id ?? String(i),
        name: r.name.trim(),
        sku: r.sku.trim() || null,
        qty: orderNumber(r.qty) || 0,
        sell_price: Math.round(orderNumber(r.sell_price) * 100),
        buy_price: 0,
        product_id: r.product_id ?? null,
        supplier_id: r.supplier_id || null,
      })),
    } as unknown as CustomerOrder
  }

  function printDoc(kind: 'invoice' | 'delivery') {
    const validItems = items.filter((r) => r.name.trim())
    if (!validItems.length) { toast.error('Немає позицій для документа'); return }
    const seller = loadSellerRequisites()
    if (!hasSellerRequisites(seller)) toast.warning('Реквізити продавця не заповнені (Налаштування → Реквізити продавця)')
    const order = buildOrderForDocs()
    try {
      if (kind === 'invoice') printInvoice(order, seller)
      else printDeliveryNote(order, seller)
    } catch {
      toast.error('Не вдалося сформувати документ. Перевірте, чи не заблоковані спливаючі вікна.')
    }
  }

  // Items manipulation
  function removeItem(i: number) { setItems((p) => p.filter((_, idx) => idx !== i)); setReplaceIndex(null) }
  function updateItem<K extends keyof ItemRow>(i: number, key: K, val: ItemRow[K]) {
    setItems((p) => p.map((row, idx) => idx === i ? { ...row, [key]: val } : row))
  }

  function addManualItemRow(name = '') {
    setItems((rows) => [...rows, { ...EMPTY_ITEM, local_key: crypto.randomUUID(), source_type: 'supplier', name }])
  }

  // Швидка націнка: рахує ціну продажу від закупки за обраним відсотком,
  // з округленням як у Налаштуваннях (price_rounding_*).
  const MARKUP_PRESETS = [20, 30, 40, 50, 70, 100]
  const markupOptions = quickPercents.length ? quickPercents : MARKUP_PRESETS
  function applyMarkup(index: number, pct: number) {
    setItems((rows) => rows.map((row, i) => {
      if (i !== index) return row
      const buy = orderNumber(row.buy_price ?? '0') || 0
      if (buy <= 0) {
        toast.error('Спершу вкажіть ціну закупки')
        return row
      }
      let kop = Math.round(buy * 100 * (1 + pct / 100))
      if (priceRounding.enabled) {
        const step = Math.max(1, priceRounding.step)
        const scaled = kop / step
        const r = priceRounding.dir === 'up' ? Math.ceil(scaled)
          : priceRounding.dir === 'down' ? Math.floor(scaled)
          : Math.round(scaled)
        kop = r * step
      }
      return { ...row, sell_price: String(kop / 100) }
    }))
  }

  // «За таблицею»: роздрібна за правилами націнки від закупки (як у картці товару/накладній).
  async function applyMarkupTable(index: number) {
    const row = items[index]
    const buy = Math.round((orderNumber(row?.buy_price ?? '0') || 0) * 100)
    if (!buy) { toast.error('Спершу вкажіть ціну закупки'); return }
    try {
      const res = await pricingApi.autoRetail(buy)
      const retailPrice = res.data.retail_price
      if (retailPrice != null) setItems((current) => current.map((item) => {
        const same = item === row || (row.id && item.id === row.id) || (row.local_key && item.local_key === row.local_key)
        return same && Math.round(orderNumber(item.buy_price ?? '0') * 100) === buy ? { ...item, sell_price: String(retailPrice / 100) } : item
      }))
      else toast.warning('Націнка за таблицею не налаштована')
    } catch { toast.error('Помилка розрахунку за таблицею') }
  }


  async function createSupplierFromName(name: string): Promise<Supplier | null> {
    const cleanName = name.trim()
    if (!cleanName) { toast.error('Вкажіть назву постачальника'); return null }
    const existing = suppliers.find((supplier) => normalizeSupplierName(supplier.name) === normalizeSupplierName(cleanName))
    if (existing) return existing
    try {
      const { data } = await supplierApi.create({ name: cleanName })
      setSuppliers((current) => uniqueSuppliers([data, ...current]))
      toast.success('Постачальника «' + data.name + '» додано')
      return data
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося додати постачальника')
      return null
    }
  }

  const totalKop = useMemo(() => {
    return items.reduce((s, row) => {
      if (!row.name.trim() || row.item_status === 'canceled' || row.item_status === 'returned') return s
      const price = orderNumber(row.sell_price) || 0
      const qty = orderNumber(row.qty) || 0
      return s + Math.round(Math.round(price * 100) * qty)
    }, 0)
  }, [items])

  // Сума до сплати: знижка береться з картки клієнта у касі, у замовленні її не дублюємо.
  const toPayKop = Math.max(0, totalKop - totalPaid)
  // Save a draft without advancing supply status. Only explicit registration activates it.
  async function handleSave(action: 'save' | 'order' = 'save') {
    if (savingRef.current) return
    const validItems = items.filter((row) => row.name.trim())
    if (!validItems.length) { toast.error('Додайте хоча б одну позицію з назвою'); setStep(3); return }
    const error = validateOrderRows(validItems)
    if (error) { toast.error(error); setStep(3); return }
    savingRef.current = true
    setSaving(true)
    const vehicleInfo = selectedVehicle
      ? { make: selectedVehicle.brand, model: selectedVehicle.model, year: selectedVehicle.year ?? undefined, vin: selectedVehicle.vin ?? undefined }
      : loadedVehicleInfo
    const payload: CreateOrderPayload = {
      customer_id: customerId || null,
      ...(!id ? { source: action === 'save' ? 'mobile_draft' as const : 'walk_in' as const } : {}),
      vehicle_info: vehicleInfo,
      comment: [isUrgent ? '[ТЕРМІНОВО]' : '', comment.trim()].filter(Boolean).join(' ') || null,
      items: validItems.map((row) => ({
        id: row.id, name: row.name.trim(), sku: row.sku.trim() || null,
        product_id: row.product_id || null,
        qty: orderNumber(row.qty),
        sell_price: Math.round(orderNumber(row.sell_price) * 100),
        buy_price: Math.round(orderNumber(row.buy_price ?? '0') * 100),
        supplier_id: row.source_type === 'supplier' ? row.supplier_id || null : null,
        source_type: row.source_type ?? (row.product_id ? 'warehouse' : 'supplier'),
        item_type: row.item_type ?? 'product', item_status: row.item_status,
        expected_date: row.source_type === 'supplier' && row.expected_date ? row.expected_date : null,
      })),
    }
    try {
      const { order: saved, activationError } = await saveOrderForm(orderApi, payload, {
        id, version: loadedOrderVersion, activate: action === 'order',
        onPersisted: () => {
          backupFinished.current = true
          try { sessionStorage.removeItem(backupKey) } catch { /* saved document remains accessible */ }
        },
      })
      if (activationError) {
        toast.warning('Чернетку збережено, але оформлення не завершено: ' + (activationError instanceof Error ? activationError.message : 'спробуйте з картки замовлення'))
      } else {
        toast.success(action === 'order' ? 'Замовлення оформлено' : id ? 'Зміни збережено' : 'Чернетку збережено')
      }
      navigate('/orders/' + saved.id)
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : 'Помилка збереження. Введені дані залишилися у формі.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }


  function addDraftHintItemToOrder(item: CustomerOrder['items'][number]) {
    const nextRow: ItemRow = {
      ...EMPTY_ITEM,
      local_key: crypto.randomUUID(),
      name: item.name,
      sku: item.sku ?? '',
      qty: String(item.qty || 1),
      sell_price: item.sell_price ? kopecksToHryvnia(item.sell_price) : '0',
      buy_price: item.buy_price ? kopecksToHryvnia(item.buy_price) : '0',
      product_id: item.product_id ?? null,
      supplier_id: item.supplier_id ?? '',
      item_type: item.item_type ?? 'product',
      source_type: item.source_type ?? (item.product_id ? 'warehouse' : 'supplier'),
    }
    setItems((current) => {
      const emptyIndex = current.findIndex((row) => !row.name.trim())
      if (emptyIndex >= 0) return current.map((row, index) => index === emptyIndex ? nextRow : row)
      return [...current, nextRow]
    })
    setStep(3)
    toast.success(`Додано з чернетки: ${item.name}`)
  }
  // Ctrl+S only saves; it never silently advances the order status.
  const saveRef = useRef(handleSave)
  saveRef.current = handleSave
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  // Customer List to show
  const customerList = customerSearch.trim().length >= 2 ? searchedCustomers : defaultCustomers
  const customerListLoading = customerSearch.trim().length >= 2 ? searchCustomersLoading : defaultCustomersLoading
  const hasValidItems = items.some((item) => item.name.trim().length > 0)

  if (loadError) return <Layout title="Замовлення" onBack={() => navigate('/orders')}><p className="p-4 text-red-700">{loadError}</p><Button onClick={onReset}>Повторити завантаження</Button></Layout>
  if (loading) {
    return (
      <Layout title={id ? "Редагування замовлення" : "Нове замовлення"} onBack={() => navigate(-1)}>
        <div className="flex items-center justify-center min-h-[300px]">
          <p className="text-gray-400 text-sm">Завантаження даних замовлення...</p>
        </div>
      </Layout>
    )
  }

  return (
    <Layout title={id ? "Редагування замовлення" : "Нове замовлення"} onBack={() => navigate(-1)}>
      <fieldset disabled={saving} className={`mx-auto min-w-0 max-w-4xl space-y-4 transition-[margin] lg:max-w-none ${draftHintOpen ? 'xl:mr-[26rem]' : ''}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
          <p role="status">{backupState}</p>
          <button type="button" onClick={() => setDiscardPrompt(true)} className="underline">Відкинути незбережені правки</button>
        </div>
        {discardPrompt && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p>Прибрати введені зміни з цього пристрою? Збережене замовлення не буде видалено.</p>
          <div className="mt-2 flex gap-2">
            <Button variant="danger" onClick={() => {
              try { sessionStorage.removeItem(backupKey) } catch { toast.error('Не вдалося очистити форму'); return }
              backupFinished.current = true
              onReset()
            }}>Відкинути правки</Button>
            <Button variant="secondary" onClick={() => setDiscardPrompt(false)}>Продовжити редагування</Button>
          </div>
        </div>}
        
        {/* Step Indicator — лише в покроковому (мобільному) режимі */}
        {!isDesktop && (
        <div className="bg-white border border-gray-100 rounded-2xl p-3 shadow-sm grid grid-cols-4 gap-1">
          {[
            { s: 1, label: 'Клієнт' },
            { s: 2, label: 'Автомобіль' },
            { s: 3, label: 'Запчастини' },
            { s: 4, label: 'Завершення' },
          ].map((item) => {
            const isActive = step === item.s
            const isCompleted = step > item.s
            return (
              <div key={item.s} className="flex flex-col items-center gap-1 min-w-0">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm transition-colors ${
                  isActive ? 'bg-yellow-400 text-black' :
                  isCompleted ? 'bg-green-500 text-white' :
                  'bg-gray-100 text-gray-400'
                }`}>
                  {isCompleted ? <Check size={14} /> : item.s}
                </div>
                <span className={`text-[10px] sm:text-xs font-semibold text-center truncate w-full ${isActive ? 'text-gray-900' : 'text-gray-400'}`}>
                  {item.label}
                </span>
              </div>
            )
          })}
        </div>
        )}

        {/* ─────────────── STEP 1: SELECT CUSTOMER ─────────────── */}
        {(isDesktop || step === 1) && (
          <div className="space-y-6">
            {isDesktop && step > 1 ? (
              <Card className="border-green-100 bg-green-50/40">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-green-500 text-white">
                      <Check size={16} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-green-700">Клієнта обрано</p>
                      <p className="truncate text-sm font-bold text-gray-900">
                        {selectedCustomer?.full_name ?? selectedCustomer?.phone ?? 'Гість'}
                      </p>
                      {selectedCustomer?.phone && <p className="text-xs text-gray-500">{selectedCustomer.phone}</p>}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => setStep(1)}>Змінити</Button>
                </div>
              </Card>
            ) : (
            <Card className="max-w-2xl mx-auto lg:max-w-none">
              <div className="text-center space-y-2 mb-6">
                <h3 className="text-lg font-bold text-gray-900">Нове замовлення</h3>
                <p className="text-sm text-gray-500">Оберіть клієнта, щоб розпочати оформлення</p>
              </div>

              {/* Search Bar */}
              <div className="relative mb-6">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Пошук: Ім'я, Телефон або VIN..."
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-10 pr-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                />
              </div>

              {/* Customers list */}
              {customerListLoading ? (
                <div className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden mb-6 bg-white" aria-label="Завантаження клієнтів">
                  {Array.from({ length: 3 }, (_, i) => (
                    <div key={i} className="px-4 py-3.5 flex items-center gap-3 animate-pulse">
                      <div className="w-9 h-9 rounded-full bg-gray-100" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-1/2 rounded bg-gray-100" />
                        <div className="h-3 w-1/3 rounded bg-gray-100" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : customerList.length > 0 ? (
                <div className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden mb-6 bg-white shadow-sm">
                  {customerList.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => handleCustomerSelect(c)}
                      className="w-full text-left px-4 py-3.5 flex items-center justify-between hover:bg-gray-50/50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
                          <User size={16} />
                        </div>
                        <div>
                          <p className="font-bold text-gray-900 text-sm">{c.full_name ?? 'Без імені'}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{c.phone}</p>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        {c.debt_balance > 0 && (
                          <span className="text-xs bg-red-50 text-red-600 font-semibold px-2 py-0.5 rounded">
                            Борг {formatMoney(c.debt_balance)}
                          </span>
                        )}
                        {c.primary_vin ? (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                            {vinMake(c.primary_vin)} ({c.primary_vin.slice(0, 6)}...)
                          </span>
                        ) : (
                          <span className="text-[10px] text-gray-300">Немає авто</span>
                        )}
                        <ChevronRight size={16} className="text-gray-400" />
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-center text-gray-400 py-6 border border-dashed border-gray-200 rounded-xl mb-6">
                  Клієнтів не знайдено
                </div>
              )}

              {/* DASHED ADD CUSTOMER BUTTON */}
              {!showAddCustomer ? (
                <div className="space-y-3">
                  <button
                    onClick={() => setShowAddCustomer(true)}
                    className="w-full border-2 border-dashed border-gray-200 hover:border-yellow-400 hover:bg-yellow-50/20 text-gray-600 hover:text-yellow-700 font-semibold py-3 px-4 rounded-xl text-center text-sm transition-all duration-200 cursor-pointer flex items-center justify-center gap-2"
                  >
                    <Plus size={16} /> Створити нового клієнта
                  </button>
                  <button
                    onClick={handleSkipCustomer}
                    className="w-full border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-700 font-semibold py-3 px-4 rounded-xl text-center text-sm transition-all duration-200 cursor-pointer flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    ⚡ Швидке замовлення без клієнта
                  </button>
                </div>
              ) : (
                <form onSubmit={handleCreateCustomer} className="border border-yellow-100 bg-yellow-50/20 rounded-xl p-4 space-y-4">
                  <h4 className="font-bold text-yellow-800 text-sm">Створення нового клієнта</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Input
                      label="Повне ім'я клієнта"
                      value={newCustName}
                      onChange={(e) => setNewCustName(e.target.value)}
                      placeholder="Вардан..."
                      required
                    />
                    <div>
                    <Input
                      label="Телефон клієнта"
                      value={newCustPhone}
                      onChange={(e) => setNewCustPhone(e.target.value)}
                      placeholder="0973829369"
                      required
                    />
                    {getRecentItems('recent_phones').length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5 items-center">
                        <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">Нещодавні:</span>
                        {getRecentItems('recent_phones').map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setNewCustPhone(p)}
                            className="text-[10px] bg-gray-100 hover:bg-yellow-100 text-gray-700 px-2 py-0.5 rounded-full transition font-mono border border-gray-200/50"
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setShowAddCustomer(false)}>Скасувати</Button>
                    <Button type="submit" size="sm" disabled={addingCustomer}>Зберегти клієнта</Button>
                  </div>
                </form>
              )}
            </Card>
            )}
          </div>
        )}

        {/* ─────────────── STEP 2: SELECT VEHICLE ─────────────── */}
        {(isDesktop || step === 2) && selectedCustomer && (
          <div className="space-y-6 max-w-2xl mx-auto lg:max-w-none">
            {isDesktop && step > 2 ? (
              <Card className="border-green-100 bg-green-50/40">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-green-500 text-white">
                      <Check size={16} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-green-700">Автомобіль</p>
                      <p className="truncate text-sm font-bold text-gray-900">
                        {selectedVehicle
                          ? `${selectedVehicle.brand} ${selectedVehicle.model}${selectedVehicle.year ? ` (${selectedVehicle.year})` : ''}`
                          : loadedVehicleInfo
                            ? `${loadedVehicleInfo.make ?? ''} ${loadedVehicleInfo.model ?? ''}${loadedVehicleInfo.year ? ` (${loadedVehicleInfo.year})` : ''}`.trim() || 'Авто із замовлення'
                            : 'Без прив’язаного автомобіля'}
                      </p>
                      {(selectedVehicle?.vin || loadedVehicleInfo?.vin) && <p className="font-mono text-xs text-gray-500">{selectedVehicle?.vin ?? loadedVehicleInfo?.vin}</p>}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => setStep(2)}>Змінити</Button>
                </div>
              </Card>
            ) : (
            <Card>
              <div className="flex items-center gap-3 border-b border-gray-100 pb-4 mb-4">
                {!isDesktop && <Button size="sm" variant="ghost" onClick={() => setStep(1)} icon={<ArrowLeft size={14} />} title="Назад до вибору клієнта" />}
                <div>
                  <h3 className="font-bold text-gray-900 text-base">Оберіть автомобіль для замовлення</h3>
                  <p className="text-xs text-gray-400 mt-0.5">Клієнт: {selectedCustomer.full_name ?? 'Без імені'} ({selectedCustomer.phone})</p>
                </div>
              </div>

              {/* Vehicles List */}
              {vehicles.length > 0 ? (
                <div className="space-y-3 mb-6">
                  {vehicles.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => handleVehicleSelect(v)}
                      className="w-full border border-gray-100 hover:border-yellow-400 hover:bg-yellow-50/10 rounded-xl p-4 flex items-center justify-between transition-all"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-yellow-50 text-yellow-600 flex items-center justify-center font-bold">
                          <Car size={16} />
                        </div>
                        <div className="text-left">
                          <p className="font-bold text-gray-900 text-sm">{v.brand} {v.model}{v.year ? ` (${v.year})` : ''}</p>
                          {v.vin && <p className="text-xs text-gray-400 font-mono mt-0.5">{v.vin}</p>}
                        </div>
                      </div>
                      <ChevronRight size={16} className="text-gray-400" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-center text-gray-400 py-6 border border-dashed border-gray-200 rounded-xl mb-6">
                  Немає прив'язаних автомобілів
                </div>
              )}

              {/* Inline Create Vehicle */}
              {!showAddVehicle ? (
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setShowAddVehicle(true)}
                    className="w-full border-2 border-dashed border-gray-200 hover:border-yellow-400 hover:bg-yellow-50/20 text-gray-600 hover:text-yellow-700 font-semibold py-3 px-4 rounded-xl text-center text-sm transition-all duration-200 cursor-pointer flex items-center justify-center gap-2"
                  >
                    <Plus size={16} /> Додати новий автомобіль
                  </button>
                  
                  <Button variant="secondary" onClick={() => handleVehicleSelect(null)} className="w-full mt-2">
                    Пропустити вибір авто
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleCreateVehicle} className="border border-yellow-100 bg-yellow-50/20 rounded-xl p-4 space-y-4">
                  <h4 className="font-bold text-yellow-800 text-sm">Додавання автомобіля</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                    <Input
                      label="VIN-код (17 знаків)"
                      value={newVehVin}
                      onChange={(e) => setNewVehVin(e.target.value.toUpperCase())}
                      placeholder="KNEDE241260000300"
                    />
                    <div className="flex items-center gap-3 mt-1.5">
                      <label className="text-xs font-semibold text-blue-600 hover:text-blue-700 cursor-pointer">
                        {ocrLoading ? 'Розпізнавання…' : '📷 VIN з фото'}
                        <input type="file" accept="image/*" capture="environment" className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVinPhoto(f); e.target.value = '' }} />
                      </label>
                      <button type="button" onClick={handleDecodeVin} disabled={decodingVin || newVehVin.trim().length < 11}
                        className="text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed">
                        {decodingVin ? 'Декодування…' : '✨ Декодувати (марка/модель/рік)'}
                      </button>
                    </div>
                    {getRecentItems('recent_vins').length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5 items-center">
                        <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">Нещодавні:</span>
                        {getRecentItems('recent_vins').map((v) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setNewVehVin(v)}
                            className="text-[10px] bg-gray-100 hover:bg-yellow-100 text-gray-700 px-2 py-0.5 rounded-full transition font-mono border border-gray-200/50"
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                    <Input
                      label="Марка / Бренд"
                      value={newVehBrand}
                      onChange={(e) => setNewVehBrand(e.target.value)}
                      placeholder="Kia"
                      required
                    />
                    <Input
                      label="Модель"
                      value={newVehModel}
                      onChange={(e) => setNewVehModel(e.target.value)}
                      placeholder="Rio"
                      required
                    />
                    <Input
                      label="Рік випуску"
                      value={newVehYear}
                      onChange={(e) => setNewVehYear(e.target.value)}
                      placeholder="2015"
                      type="number"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setShowAddVehicle(false)}>Скасувати</Button>
                    <Button type="submit" size="sm" disabled={addingVehicle}>Додати автомобіль</Button>
                  </div>
                </form>
              )}
            </Card>
            )}
          </div>
        )}

        {/* ─────────────── STEP 3: PARTS SPECIFICATION ─────────────── */}
        {(isDesktop || step === 3) && (
          <div className="space-y-6">
            {/* Header info */}
            <div className="bg-white border border-gray-100 rounded-2xl p-4 md:p-6 shadow-sm flex flex-wrap justify-between items-center gap-4">
              <div className="flex items-center gap-3">
                {!isDesktop && <Button size="sm" variant="ghost" onClick={() => setStep(selectedCustomer ? 2 : 1)} icon={<ArrowLeft size={14} />} title="Назад до даних клієнта" />}
                <div>
                  <h3 className="font-bold text-gray-900">Специфікація замовлення</h3>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Клієнт: <span className="font-bold text-gray-700">{selectedCustomer ? (selectedCustomer.full_name ?? 'Без імені') : 'Гість'}</span>
                    {selectedCustomer && (selectedCustomer as any).debt_balance > 0 && (
                      <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700"
                        title="У клієнта є непогашений борг">
                        ⚠ Борг: {formatMoney((selectedCustomer as any).debt_balance)}
                      </span>
                    )}
                    {selectedCustomer && (
                      <> | Авто: <span className="font-bold text-gray-700">{selectedVehicle ? `${selectedVehicle.brand} ${selectedVehicle.model}${selectedVehicle.year ? ` (${selectedVehicle.year})` : ''}` : loadedVehicleInfo ? (`${loadedVehicleInfo.make ?? ''} ${loadedVehicleInfo.model ?? ''}`.trim() || 'З замовлення') : 'Не обрано'}</span>
                        <button type="button" onClick={() => setStep(2)} className="ml-1.5 text-yellow-600 hover:text-yellow-700 font-semibold underline">змінити</button>
                      </>
                    )}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Сума замовлення</p>
                <p className="text-lg font-bold text-yellow-600">{formatMoney(totalKop)}</p>
              </div>
            </div>

            {/* ─── Єдине поле пошуку товару ─── */}
            <Card>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">Пошук товару</label>
              {replaceIndex !== null && <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-blue-50 p-2 text-sm text-blue-800">
                <span>Заміна позиції {replaceIndex + 1}. Кількість і ціна продажу залишаться вашими.</span>
                <button type="button" className="underline" onClick={() => { setReplaceIndex(null); setSearch('') }}>Скасувати заміну</button>
              </div>}
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Артикул, OEM, назва або штрихкод..."
                  autoFocus
                  className="w-full bg-white border border-gray-200 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
                />
              </div>

              {searchLoading && (
                <p className="mt-3 text-xs text-gray-400">Шукаю у власній базі…</p>
              )}
              {!searchLoading && searchError && (
                <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{searchError}</p>
              )}

              {/* Знайдені товари та їх аналоги */}
              {!searchLoading && searchResults.length > 0 && (
                <OrderProductResults products={searchResults} onSelect={addProductAsItem} replacing={replaceIndex !== null} />
              )}

              {/* Не знайдено → пропонуємо додати під замовлення */}
              {replaceIndex === null && !searchLoading && !searchError && search.trim().length >= 2 && searchResults.length === 0 && (
                <button
                  type="button"
                  onClick={openBackorder}
                  className="mt-3 w-full flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-yellow-300 bg-yellow-50 px-4 py-6 text-center hover:bg-yellow-100 transition-colors"
                >
                  <span className="text-sm font-bold text-yellow-800">Додати товар під замовлення</span>
                  <span className="text-xs text-yellow-700">У базі не знайдено. Знайдіть у постачальника та внесіть вручну.</span>
                </button>
              )}

              {replaceIndex !== null && !searchLoading && !searchError && search.trim().length >= 2 && searchResults.length === 0 && <p className="mt-2 text-sm text-gray-500">Товар не знайдено. Змініть запит або скасуйте заміну.</p>}

            </Card>

            {/* ─── Додані позиції замовлення ─── */}
            <Card padding="none">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                <h4 className="font-bold text-gray-800 text-sm">Позиції замовлення</h4>
                <span className="text-xs text-gray-400">{items.filter((r) => r.name.trim()).length} шт</span>
              </div>
              {items.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-gray-400">
                  Почніть із пошуку товару вгорі або додайте замовлену запчастину вручну кнопкою внизу.
                </p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {items.map((row, idx) => {
                    const backorder = row.source_type === 'supplier'
                    const locked = !!row.item_status && row.item_status !== 'pending'
                    const shortage = !backorder && row.item_type !== 'service' && row.stock !== undefined && orderNumber(row.qty) > row.stock
                    const fieldClass = 'w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300'
                    return (
                      <div key={row.id ?? row.local_key ?? idx} className={backorder ? 'bg-amber-50/40 px-3 py-3 sm:px-4' : 'px-3 py-3 sm:px-4'}>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-gray-600">Позиція {idx + 1}</span>
                            {row.product_id && !locked ? (
                              <select aria-label={`Джерело позиції ${idx + 1}`} value={row.source_type ?? 'warehouse'}
                                onChange={(e) => setItems((rows) => rows.map((item, index) => index === idx ? { ...item, source_type: e.target.value as 'warehouse' | 'supplier', supplier_id: '', expected_date: '' } : item))}
                                className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs">
                                <option value="warehouse">Зі складу</option>
                                <option value="supplier">Під замовлення</option>
                              </select>
                            ) : <span className={backorder ? 'text-xs text-orange-700' : 'text-xs text-green-700'}>{backorder ? 'Під замовлення' : 'Зі складу'}</span>}
                            {!backorder && row.stock !== undefined && row.item_type !== 'service' && <span className="text-xs text-gray-500">Доступно: {row.stock}</span>}
                          </div>
                          <div className="flex items-center gap-2">
                            {!locked && <button type="button" onClick={() => startReplacement(idx)} className="rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50">Замінити товар ▾</button>}
                            <button type="button" onClick={() => removeItem(idx)} title="Видалити рядок" aria-label={`Видалити позицію ${idx + 1}`} className="rounded p-1.5 text-red-600 hover:bg-red-50"><Trash2 size={16} /></button>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3 lg:grid-cols-12">
                          <label className="col-span-2 lg:col-span-4">
                            <span className="mb-1 block text-xs text-gray-600">Назва запчастини, бренд *</span>
                            <input value={row.name} onChange={(e) => updateItem(idx, 'name', e.target.value)} placeholder="Назва та бренд запчастини" className={fieldClass} />
                          </label>
                          <label className="lg:col-span-2">
                            <span className="mb-1 block text-xs text-gray-600">Артикул / OEM</span>
                            <input value={row.sku} onChange={(e) => updateItem(idx, 'sku', e.target.value)} className={fieldClass} />
                          </label>
                          <label className="lg:col-span-1">
                            <span className="mb-1 block text-xs text-gray-600">Кількість</span>
                            <input type="number" min="0" step="1" value={row.qty} onChange={(e) => updateItem(idx, 'qty', e.target.value)} className={fieldClass} aria-invalid={shortage} />
                          </label>
                          <label className="lg:col-span-3">
                            <span className="mb-1 block text-xs text-gray-600">Закупка, грн</span>
                            <div className="flex gap-1">
                              <input inputMode="decimal" value={row.buy_price ?? '0'} onChange={(e) => updateItem(idx, 'buy_price', e.target.value)} className={fieldClass + ' min-w-0'} />
                              <select value="" aria-label={`Націнка позиції ${idx + 1}`} title="Розрахувати ціну продажу"
                                onChange={(e) => { const value = e.target.value; if (value === 'table') void applyMarkupTable(idx); else if (value) applyMarkup(idx, Number(value)) }}
                                className="w-24 shrink-0 rounded-lg border border-gray-200 bg-white px-1 text-xs">
                                <option value="">Націнка</option>
                                <option value="table">За таблицею</option>
                                {markupOptions.map((pct) => <option key={pct} value={pct}>{pct}%</option>)}
                              </select>
                            </div>
                          </label>
                          <label className="lg:col-span-2">
                            <span className="mb-1 block text-xs text-gray-600">Продаж, грн</span>
                            <input inputMode="decimal" value={row.sell_price} onChange={(e) => updateItem(idx, 'sell_price', e.target.value)} className={fieldClass + ' font-semibold'} />
                          </label>
                          {backorder && <>
                            <div className="lg:col-span-4">
                              <span className="mb-1 block text-xs text-gray-600">Постачальник</span>
                              <SupplierQuickPicker suppliers={suppliers} value={row.supplier_id} onChange={(value) => updateItem(idx, 'supplier_id', value)} onCreate={createSupplierFromName} placeholder="Пошук або новий" />
                            </div>
                            <label className="lg:col-span-2">
                              <span className="mb-1 block text-xs text-gray-600">Очікуємо</span>
                              <input type="date" value={row.expected_date ?? ''} onChange={(e) => updateItem(idx, 'expected_date', e.target.value)} className={fieldClass} />
                            </label>
                          </>}
                        </div>
                        {shortage && <p role="alert" className="mt-2 text-xs font-medium text-red-700">Доступно {row.stock}, потрібно {row.qty}. Зменшіть кількість або виберіть «Під замовлення».</p>}
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="border-t border-gray-100 p-3">
                <button
                  type="button"
                  onClick={() => addManualItemRow()}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-3 text-sm font-bold text-gray-900 transition-colors hover:bg-yellow-500"
                >
                  <Plus size={17} />
                  Новий рядок
                </button>
              </div>

              {!isDesktop && (
                <div className="px-4 py-3 border-t border-gray-100 flex gap-2 justify-end bg-gray-50/50">
                  <Button variant="secondary" onClick={() => setStep(selectedCustomer ? 2 : 1)}>Назад</Button>
                  <Button disabled={!hasValidItems} onClick={() => setStep(4)}>Далі</Button>
                </div>
              )}
              {!isDesktop && !hasValidItems && (
                <p className="px-4 pb-3 text-xs text-orange-600">
                  Додайте хоча б одну позицію, щоб перейти далі.
                </p>
              )}
            </Card>

          </div>
        )}

        {/* ─────────────── STEP 4: SUMMARY & CHECKOUT ─────────────── */}
        {(isDesktop || step === 4) && (
          <div className="space-y-6 max-w-3xl mx-auto lg:max-w-none">
            {/* Header info */}
            <div className="bg-white border border-gray-100 rounded-2xl p-4 md:p-6 shadow-sm flex items-center gap-3">
              {!isDesktop && <Button size="sm" variant="ghost" onClick={() => setStep(3)} icon={<ArrowLeft size={14} />} title="Назад до позицій" />}
              <div>
                <h3 className="font-bold text-gray-900">Завершення оформлення</h3>
                <p className="text-xs text-gray-400 mt-0.5">Перевірте деталі замовлення та виберіть дію збереження</p>
              </div>
            </div>

            {/* Review Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Order Info Summary */}
              <Card className="space-y-4">
                <h4 className="font-bold text-gray-800 text-sm border-b border-gray-100 pb-2">Деталі контрагента</h4>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Клієнт:</span>
                    <span className="font-semibold text-gray-800">{selectedCustomer ? (selectedCustomer.full_name ?? 'Без імені') : 'Гість'}</span>
                  </div>
                  {selectedCustomer && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Телефон:</span>
                        <span className="font-semibold text-gray-800">{selectedCustomer.phone}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Автомобіль:</span>
                        <span className="font-semibold text-gray-800">
                          {selectedVehicle
                            ? `${selectedVehicle.brand} ${selectedVehicle.model}`
                            : loadedVehicleInfo
                              ? `${loadedVehicleInfo.make ?? ''} ${loadedVehicleInfo.model ?? ''}`.trim() || 'З замовлення'
                              : 'Не прив\'язано'}
                        </span>
                      </div>
                    </>
                  )}
                  {(selectedVehicle?.vin || loadedVehicleInfo?.vin) && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">VIN-код:</span>
                      <span className="font-mono text-xs text-gray-800">{selectedVehicle?.vin ?? loadedVehicleInfo?.vin}</span>
                    </div>
                  )}
                </div>

                <h4 className="font-bold text-gray-800 text-sm border-b border-gray-100 pb-2 pt-2">Сума замовлення</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Загальна сума товарів:</span>
                    <span className="font-semibold text-gray-800">{formatMoney(totalKop)}</span>
                  </div>
                  <div className="flex justify-between items-center border-t border-gray-100 pt-2">
                    <span className="text-gray-500 font-semibold">До сплати:</span>
                    <span className="text-xl font-extrabold text-yellow-600">
                      {formatMoney(toPayKop)}
                    </span>
                  </div>
                  {totalPaid > 0 && <div className="flex justify-between text-green-700"><span>Вже сплачено:</span><span>{formatMoney(totalPaid)}</span></div>}
                </div>
              </Card>

              {/* Checkout Actions */}
              <Card className="space-y-4">
                <h4 className="font-bold text-gray-800 text-sm border-b border-gray-100 pb-2">Коментар</h4>

                {/* Comment Box */}
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">Коментар до замовлення</label>
                    {/* Швидкі теги коментаря (ORD-34) */}
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {['Передзвонити', 'Самовивіз', 'Потрібна накладна', 'Доставка'].map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setComment((c) => c.includes(tag) ? c : (c.trim() ? `${c.trim()}, ${tag}` : tag))}
                          className="text-[11px] font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-yellow-100 hover:text-yellow-700 transition-colors"
                        >
                          + {tag}
                        </button>
                      ))}
                    </div>
                    <textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="Особливі побажання клієнта..."
                      rows={2}
                      className="w-full bg-white border border-gray-200 rounded-lg p-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400"
                    />
                  </div>

                  {/* Urgency checkbox */}
                  <label className="flex items-center gap-2 text-xs font-bold text-red-600 hover:text-red-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={isUrgent}
                      onChange={(e) => setIsUrgent(e.target.checked)}
                      className="rounded text-red-500 focus:ring-red-400 h-3.5 w-3.5"
                    />
                    🔥 ТЕРМІНОВО (позначити замовлення червоним)
                  </label>
                </div>
              </Card>

            </div>

            {/* Документи — другорядні дії; основна дія — збереження. */}
            <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm space-y-3 lg:sticky lg:bottom-4 z-10">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <details className="relative">
                  <summary className="cursor-pointer rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium">Документи</summary>
                  <div className="absolute bottom-full left-0 mb-2 min-w-56 rounded-xl border border-gray-200 bg-white p-2 shadow-lg flex flex-col gap-1">
                    <Button variant="secondary" disabled={!hasValidItems} onClick={() => printDoc('invoice')}>Рахунок-фактура</Button>
                    <Button variant="secondary" disabled={!hasValidItems} onClick={() => printDoc('delivery')}>Видаткова накладна</Button>
                    <Button variant="secondary" disabled={!hasValidItems} onClick={copyMessengerText}>Копіювати для клієнта</Button>
                  </div>
                </details>
                <div className="flex gap-2 flex-wrap">
                  {!isDesktop && <Button variant="secondary" onClick={() => setStep(3)}>До деталей</Button>}
                  <Button variant={id && !['lead', 'quoted'].includes(loadedStatus) ? 'primary' : 'secondary'} disabled={!hasValidItems || saving} onClick={() => handleSave('save')}>
                    {saving ? 'Збереження…' : id ? 'Зберегти зміни' : 'Зберегти чернетку'}
                  </Button>
                  {(!id || ['lead', 'quoted'].includes(loadedStatus)) && <Button disabled={!hasValidItems || saving} onClick={() => handleSave('order')}>
                    Оформити замовлення
                  </Button>}
                </div>
              </div>
              <p className="text-xs text-gray-500">Збереження оновлює резерв складських позицій. Замовлення постачальнику менеджер робить окремо.</p>
            </div>

          </div>
        )}

      </fieldset>

      {draftHint && !draftHintOpen && (
        <button
          type="button"
          onClick={() => setDraftHintOpen(true)}
          className="fixed bottom-4 right-4 z-30 rounded-full border border-yellow-300 bg-yellow-400 px-4 py-2 text-sm font-extrabold text-black shadow-xl hover:bg-yellow-300"
        >
          Чернетка-підказка · {draftHint.items.length}
        </button>
      )}
      {draftHint && draftHintOpen && (
        <aside className="fixed bottom-4 right-4 top-20 z-30 flex w-[24rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-yellow-300 bg-white shadow-2xl">
          <div className="flex items-start justify-between gap-3 border-b border-yellow-200 bg-yellow-50 px-4 py-3">
            <div className="flex gap-2">
              <ClipboardList size={19} className="mt-0.5 shrink-0 text-yellow-700" />
              <div>
                <p className="font-bold text-gray-900">Чернетка-підказка</p>
                <p className="text-xs text-gray-500">Залишається відкритою, поки ви її не закриєте</p>
              </div>
            </div>
            <button type="button" onClick={() => setDraftHintOpen(false)} className="rounded-lg p-1.5 text-gray-500 hover:bg-white" aria-label="Закрити чернетку">
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-gray-900">{draftHint.customer?.full_name ?? 'Без імені'}</p>
              {draftHint.customer?.phone && <p className="font-mono text-gray-600">{draftHint.customer.phone}</p>}
              {draftHint.vehicle_info?.vin && (
                <p className="break-all rounded-lg bg-gray-100 px-2.5 py-2 font-mono text-sm font-bold tracking-wide text-gray-900">
                  VIN {draftHint.vehicle_info.vin}
                </p>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400">Що потрібно знайти</p>
              <ol className="space-y-2">
                {draftHint.items.map((item, index) => (
                  <li key={item.id} className="flex items-start gap-2 rounded-xl border border-gray-100 bg-gray-50 p-3 text-sm font-medium text-gray-800">
                    <span className="text-gray-400">{index + 1}.</span>
                    <span className="min-w-0 flex-1">{item.name}</span>
                    <button type="button" onClick={() => addDraftHintItemToOrder(item)} className="shrink-0 rounded-lg bg-white px-2 py-1 text-xs font-bold text-yellow-700 shadow-sm hover:bg-yellow-100">
                      + в заказ
                    </button>
                  </li>
                ))}
              </ol>
            </div>
            {draftHint.comment && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="mb-1 text-xs font-bold uppercase">Нотатка</p>
                <p className="whitespace-pre-wrap">{draftHint.comment}</p>
              </div>
            )}
          </div>
        </aside>
      )}

    </Layout>
  )
}
