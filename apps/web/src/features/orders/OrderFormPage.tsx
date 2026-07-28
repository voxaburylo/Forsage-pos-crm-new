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
import { Layout } from '@/components/Layout'
import { Button, Input, Card } from '@/components/ui'
import { buildMessengerText, printInvoice, printDeliveryNote, loadSellerRequisites, hasSellerRequisites } from './orderDocuments'
import { toast } from '@/components/ui/Toast'
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
    if (!value) {
      setText('')
      return
    }
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
      <button
        type="button"
        onClick={handleCreate}
        disabled={creating}
        title="Додати постачальника"
        className="shrink-0 rounded-lg border border-gray-200 bg-white px-3 text-sm font-bold text-gray-600 hover:border-yellow-300 hover:bg-yellow-50 hover:text-yellow-700 disabled:opacity-60"
      >
        {creating ? '...' : <Plus size={16} />}
      </button>
    </div>
  )
}

interface ItemRow {
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
  manual_edit?: boolean
}

const EMPTY_ITEM: ItemRow = { name: '', sku: '', qty: '1', sell_price: '0', supplier_id: '', expected_date: '', product_id: null, item_type: 'product', buy_price: '0' }

export default function OrderFormPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { id } = useParams()
  const [loading, setLoading] = useState(false)
  const sourceDraftId = !id ? searchParams.get('draftId') : null
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
    if (id) return
    const vinFromUrl = searchParams.get('vin')?.trim().toUpperCase()
    if (vinFromUrl) {
      setNewVehVin(vinFromUrl)
      setShowAddVehicle(true)
    }
  }, [id, searchParams])

  // Duplicate order initialization (P1 Fix 9)
  useEffect(() => {
    if (id) return
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
    if (!sourceDraftId) return
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
  }, [sourceDraftId, navigate])

  // Load existing order details for editing (P0 Fix 1)
  useEffect(() => {
    if (!id) return
    setLoading(true)
    orderApi.get(id)
      .then((r) => {
        const o = r.data
        if (!o) return
        
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
          })))
        }
        // Редагування: клієнт і авто вже відомі — одразу переходимо до позицій,
        // щоб не показувати екран вибору клієнта «з нуля» (плутало користувачів)
        setStep(3)
      })
      .catch(() => toast.error('Помилка завантаження замовлення'))
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

  // Query parameter support
  useEffect(() => {
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
  function handleSkipCustomer() {
    setSelectedCustomer(null)
    setCustomerId('')
    setSelectedVehicle(null)
    setStep(3)
  }

  function handleCustomerSelect(c: Customer) {
    setSelectedCustomer(c)
    setCustomerId(c.id)
    setCustomerSearch('')
    setShowAddCustomer(false)

    // Load customer vehicles
    customerVehiclesApi.list(c.id)
      .then((r) => {
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
        setStep(2)
      })
  }

  function handleVehicleSelect(v: CustomerVehicle | null) {
    setSelectedVehicle(v)
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
      // Стискаємо фото перед відправкою (швидше + дешевше для OCR)
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const img = new Image()
        const url = URL.createObjectURL(file)
        img.onload = () => {
          URL.revokeObjectURL(url)
          const scale = Math.min(1, 1280 / Math.max(img.width, img.height))
          const w = Math.round(img.width * scale), h = Math.round(img.height * scale)
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = h
          const ctx = canvas.getContext('2d')
          if (!ctx) return reject(new Error('canvas'))
          ctx.drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', 0.7))
        }
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не вдалося прочитати фото')) }
        img.src = url
      })
      const { data } = await api.post<{ data: { vin: string } }>('/api/v1/vin/ocr', { image: dataUrl, mimeType: 'image/jpeg' })
      setNewVehVin(data.vin)
      toast.success('VIN розпізнано: ' + data.vin)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не вдалося розпізнати VIN')
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

  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setSearchResults([]); setSearchLoading(false); setSearchError(''); return }
    setSearchLoading(true)
    setSearchError('')
    let cancelled = false
    const t = window.setTimeout(async () => {
      try {
        const r = await productApi.search(q, 50)
        if (!cancelled) setSearchResults(r.data ?? [])
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
      const base = rows.filter((r) => r.name.trim())
      const existingIndex = base.findIndex((row) => row.product_id === p.id)
      if (existingIndex >= 0) {
        return base.map((row, index) => index === existingIndex
          ? { ...row, qty: String((parseFloat(row.qty) || 0) + 1) }
          : row)
      }
      return [...base, {
        ...EMPTY_ITEM,
        name: p.name,
        sku: p.sku ?? '',
        sell_price: kopecksToHryvnia(p.retail_price),
        buy_price: p.purchase_price ? kopecksToHryvnia(p.purchase_price) : '0',
        product_id: p.id,
        stock: p.qty_available ?? p.qty_on_hand ?? 0,
        item_type: p.is_service ? 'service' : 'product',
      }]
    })
    setSearch('')
    setSearchResults([])
    toast.success(`Додано: ${p.name}`)
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
        qty: parseFloat(r.qty) || 1,
        unitHrn: parseFloat((r.sell_price || '0').replace(',', '.')) || 0,
      })),
      fullyPaid: false,
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
      total_paid: 0,
      prepayment: 0,
      items: validItems.map((r, i) => ({
        id: r.id ?? String(i),
        name: r.name.trim(),
        sku: r.sku.trim() || null,
        qty: parseFloat(r.qty) || 1,
        sell_price: Math.round(parseFloat((r.sell_price || '0').replace(',', '.')) * 100),
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
  function removeItem(i: number) { setItems((p) => p.filter((_, idx) => idx !== i)) }
  function updateItem<K extends keyof ItemRow>(i: number, key: K, val: ItemRow[K]) {
    setItems((p) => p.map((row, idx) => idx === i ? { ...row, [key]: val } : row))
  }

  function addManualItemRow(name = '') {
    setItems((rows) => [...rows, { ...EMPTY_ITEM, manual_edit: true, name }])
  }

  // Швидка націнка: рахує ціну продажу від закупки за обраним відсотком,
  // з округленням як у Налаштуваннях (price_rounding_*).
  const MARKUP_PRESETS = [20, 30, 40, 50, 70, 100]
  const markupOptions = quickPercents.length ? quickPercents : MARKUP_PRESETS
  function applyMarkup(index: number, pct: number) {
    setItems((rows) => rows.map((row, i) => {
      if (i !== index) return row
      const buy = parseFloat((row.buy_price || '0').replace(',', '.')) || 0
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
    const buy = Math.round((parseFloat((row?.buy_price || '0').replace(',', '.')) || 0) * 100)
    if (!buy) { toast.error('Спершу вкажіть ціну закупки'); return }
    try {
      const res = await pricingApi.autoRetail(buy)
      if (res.data.retail_price != null) updateItem(index, 'sell_price', String(res.data.retail_price / 100))
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
      const price = parseFloat(row.sell_price || '0') || 0
      const qty = parseFloat(row.qty || '1') || 1
      return s + Math.round(price * 100) * qty
    }, 0)
  }, [items])

  // Сума до сплати: знижка береться з картки клієнта у касі, у замовленні її не дублюємо.
  const toPayKop = Math.max(0, totalKop)
  // Дві дії збереження:
  //  • 'save'  — лишити ВІДКРИТИМ (клієнт ще думає); статус не форсуємо.
  //  • 'order' — «В замовлення»: закрити накладну як «Замовлено» (status='ordered',
  //              резерв складу НЕ виконується, тож не впаде на позиціях під замовлення).
  async function handleSave(action: 'save' | 'order' = 'save') {
    const validItems = items.filter((row) => row.name.trim())
    if (validItems.length === 0) {
      toast.error('Додайте хоча б одну позицію з назвою')
      setStep(3)
      return
    }

    // ORD-5: не дати випадково оформити замовлення на 0 грн (лише при «В замовлення»)
    if (action === 'order' && toPayKop === 0) {
      if (!confirm('Сума замовлення 0 ₴. Оформити замовлення без вартості?')) {
        setStep(3)
        return
      }
    }

    // ORD-27: попередження про можливий дубль (той самий клієнт+сума за короткий проміжок)
    if (!id && customerId && totalKop > 0) {
      try {
        const recent = await orderApi.list()
        const cutoff = Date.now() - 30 * 60 * 1000
        const dup = ((recent as any).data ?? []).filter((o: any) => o.customer_id === customerId).find((o: any) =>
          o.status !== 'canceled' &&
          o.total_amount === totalKop &&
          new Date(o.created_at).getTime() > cutoff,
        )
        if (dup) {
          const noLabel = dup.order_number != null ? `#${dup.order_number} ` : ''
          if (!confirm(`Можливий дубль: у клієнта вже є замовлення ${noLabel}на ${formatMoney(totalKop)} за останні 30 хв.\nВсе одно створити нове?`)) {
            return
          }
        }
      } catch { /* помилка перевірки не блокує створення */ }
    }

    const vehicleInfo = selectedVehicle
      ? {
          make:  selectedVehicle.brand,
          model: selectedVehicle.model,
          year:  selectedVehicle.year ?? undefined,
          vin:   selectedVehicle.vin ?? undefined,
        }
      : loadedVehicleInfo // при редагуванні зберігаємо авто, якого немає в гаражі

    const finalComment = [
      isUrgent ? '[ТЕРМІНОВО]' : '',
      comment.trim(),
    ].filter(Boolean).join(' ')

    const payload: CreateOrderPayload = {
      customer_id: customerId || null,
      source: 'walk_in',
      parent_draft_id: null,
      vehicle_info: vehicleInfo,
      comment: finalComment || null,
      // Гроші приймаються тільки через касу: там є зміна, ПРРО, борги і журнал дій.
      prepayment: 0,
      prepayment_method: null,
      prepayment_is_fiscal: false,
      items: validItems.map((row) => ({
        id:          row.id,
        name:        row.name.trim(),
        sku:         row.sku.trim() || null,
        product_id:  row.product_id || null,
        qty:         parseFloat(row.qty) || 1,
        sell_price:  Math.round(parseFloat(row.sell_price || '0') * 100),
        buy_price:   Math.round(parseFloat(row.buy_price || '0') * 100),
        supplier_id: row.supplier_id || null,
        source_type: row.product_id ? 'warehouse' : 'supplier',
        item_type:   row.item_type ?? 'product',
        item_status: row.item_status,
        expected_date: row.supplier_id && row.expected_date ? row.expected_date : null,
      })),
    }

    setSaving(true)
    try {
      let orderId = id
      if (id) {
        await orderApi.update(id, payload)
      } else {
        const result = await orderApi.create(payload)
        orderId = (result as { data: { id: string } }).data.id
      }
      if (!orderId) throw new Error('Не отримано ідентифікатор замовлення')

      if (action === 'order') {
        // «В замовлення»: закриваємо накладну як «Замовлено». Резерв складу тут
        // не виконується (лише для new/in_progress), тож на позиціях під замовлення не впаде.
        await orderApi.updateStatus(orderId, 'ordered').catch(() => {
          toast.warning('Збережено, але не вдалося позначити «Замовлено»')
        })
        toast.success('Оформлено в замовлення')
      } else {
        // «Зберегти»: відкрите замовлення. Новий запис бекенд створює як lead, а
        // вкладка «Усі активні» ліди ховає → переводимо у 'new', щоб замовлення
        // одразу було ВИДИМЕ у списку активних (не «зникало» у вкладку «Ліди»).
        if (!id) await orderApi.updateStatus(orderId, 'new').catch(() => {})
        toast.success('Замовлення збережено')
      }
      navigate('/orders/' + orderId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка збереження')
    } finally {
      setSaving(false)
    }
  }


  function addDraftHintItemToOrder(item: CustomerOrder['items'][number]) {
    const nextRow: ItemRow = {
      ...EMPTY_ITEM,
      name: item.name,
      sku: item.sku ?? '',
      qty: String(item.qty || 1),
      sell_price: item.sell_price ? kopecksToHryvnia(item.sell_price) : '0',
      buy_price: item.buy_price ? kopecksToHryvnia(item.buy_price) : '0',
      product_id: item.product_id ?? null,
      supplier_id: item.supplier_id ?? '',
      item_type: item.item_type ?? 'product',
    }
    setItems((current) => {
      const emptyIndex = current.findIndex((row) => !row.name.trim())
      if (emptyIndex >= 0) return current.map((row, index) => index === emptyIndex ? nextRow : row)
      return [...current, nextRow]
    })
    setStep(3)
    toast.success(`Додано з чернетки: ${item.name}`)
  }
  // ORD-35: гаряча клавіша Ctrl+S — зберегти (на кроці 4 оформити, інакше чернетка)
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
      <div className={`mx-auto max-w-4xl space-y-6 transition-[margin] lg:max-w-none ${draftHintOpen ? 'xl:mr-[26rem]' : ''}`}>
        
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
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                <input
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

              {/* Знайдені товари зі складу */}
              {!searchLoading && searchResults.length > 0 && (
                <div className="mt-3 max-h-96 divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-100">
                  {searchResults.map((p) => {
                    const stock = p.qty_available ?? p.qty_on_hand ?? 0
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-gray-50">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-800 truncate">{p.name}</p>
                          <p className="text-[11px] text-gray-400 font-mono truncate">
                            {p.sku}
                            {p.barcode && <> · {p.barcode}</>}
                            {p.storage_bin && <> · полиця {p.storage_bin}</>}
                            {' · '}
                            <span className={stock > 0 ? 'text-green-600' : 'text-orange-500'}>
                              {stock > 0 ? `на складі: ${stock}` : 'немає на складі'}
                            </span>
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-sm font-bold text-yellow-600">{formatMoney(p.retail_price)}</span>
                          <Button size="sm" onClick={() => addProductAsItem(p)} icon={<Plus size={14} />}>Додати</Button>
                        </div>
                      </div>
                    )
                  })}
                  {searchResults.length >= 50 && (
                    <p className="px-3 py-1.5 text-center text-[11px] text-gray-400">
                      Показано перші 50 — уточніть запит, якщо не знайшли
                    </p>
                  )}
                </div>
              )}

              {/* Не знайдено → пропонуємо додати під замовлення */}
              {!searchLoading && !searchError && search.trim().length >= 2 && searchResults.length === 0 && (
                <button
                  type="button"
                  onClick={openBackorder}
                  className="mt-3 w-full flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-yellow-300 bg-yellow-50 px-4 py-6 text-center hover:bg-yellow-100 transition-colors"
                >
                  <span className="text-2xl">➕</span>
                  <span className="text-sm font-bold text-yellow-800">Додати товар під замовлення</span>
                  <span className="text-xs text-yellow-700">У базі не знайдено. Знайдіть у постачальника та внесіть вручну.</span>
                </button>
              )}

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
                    if (row.manual_edit) {
                      return (
                        <div key={idx} className="bg-yellow-50/60 px-3 py-3 sm:px-4">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-orange-700">⏳ Запчастина під замовлення</span>
                            <button
                              type="button"
                              onClick={() => removeItem(idx)}
                              className="rounded p-1.5 text-red-500 hover:bg-red-50 hover:text-red-700"
                              title="Видалити рядок"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-12">
                            <label className="lg:col-span-4">
                              <span className="mb-1 block text-[11px] font-medium text-gray-500">Назва запчастини *</span>
                              <input
                                autoFocus
                                value={row.name}
                                onChange={(e) => updateItem(idx, 'name', e.target.value)}
                                placeholder="Назва запчастини"
                                className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
                              />
                            </label>
                            <label className="lg:col-span-2">
                              <span className="mb-1 block text-[11px] font-medium text-gray-500">Артикул / OEM</span>
                              <input
                                value={row.sku}
                                onChange={(e) => updateItem(idx, 'sku', e.target.value)}
                                placeholder="Артикул"
                                className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
                              />
                            </label>
                            <label className="lg:col-span-1">
                              <span className="mb-1 block text-[11px] font-medium text-gray-500">К-сть</span>
                              <input
                                type="number"
                                min="1"
                                step="1"
                                value={row.qty}
                                onChange={(e) => updateItem(idx, 'qty', e.target.value)}
                                className="w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
                              />
                            </label>
                            <label className="lg:col-span-3">
                              <span className="mb-1 block text-[11px] font-medium text-gray-500">Постачальник</span>
                              <SupplierQuickPicker
                                suppliers={suppliers}
                                value={row.supplier_id}
                                onChange={(supplierId) => updateItem(idx, 'supplier_id', supplierId)}
                                onCreate={createSupplierFromName}
                                placeholder="Пошук або новий"
                              />
                            </label>
                            <label className="lg:col-span-2">
                              <span className="mb-1 block text-[11px] font-medium text-gray-500">Очікуємо</span>
                              <input
                                type="date"
                                value={row.expected_date ?? ''}
                                onChange={(e) => updateItem(idx, 'expected_date', e.target.value)}
                                className="w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
                              />
                            </label>
                            <label className="lg:col-span-2 lg:col-start-7">
                              <span className="mb-1 block text-[11px] font-medium text-gray-500">Закупка, грн</span>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={row.buy_price ?? '0'}
                                onChange={(e) => updateItem(idx, 'buy_price', e.target.value)}
                                className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
                              />
                            </label>
                            <label className="lg:col-span-3">
                              <span className="mb-1 block text-[11px] font-medium text-gray-500">Продаж, грн</span>
                              <div className="flex gap-1">
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={row.sell_price}
                                  onChange={(e) => updateItem(idx, 'sell_price', e.target.value)}
                                  className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-yellow-300"
                                />
                                <select
                                  value=""
                                  title="Розрахувати ціну: за таблицею націнки або швидкий відсоток від закупки"
                                  onChange={(e) => { const v = e.target.value; if (v === 'table') applyMarkupTable(idx); else if (v) applyMarkup(idx, Number(v)); e.target.value = '' }}
                                  className="shrink-0 rounded-lg border border-gray-200 bg-white px-1.5 text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-yellow-300"
                                >
                                  <option value="">▾</option>
                                  <option value="table">За таблицею</option>
                                  {markupOptions.map((p) => <option key={p} value={p}>{p}%</option>)}
                                </select>
                              </div>
                            </label>
                          </div>
                        </div>
                      )
                    }
                    if (!row.name.trim()) return null
                    const isBackorder = !!row.supplier_id || !row.product_id
                    const supplierName = suppliers.find((s) => s.id === row.supplier_id)?.name
                    return (
                      <div key={idx} className="flex items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-gray-800">{row.name}</span>
                            {isBackorder ? (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">⏳ Під замовлення</span>
                            ) : (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-green-100 text-green-700">✓ На складі</span>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-400 font-mono mt-0.5">
                            {row.sku && <>{row.sku} · </>}
                            {formatMoney(Math.round(parseFloat(row.sell_price || '0') * 100))}
                            {isBackorder && supplierName && <> · {supplierName}</>}
                            {isBackorder && row.expected_date && <> · до {row.expected_date}</>}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-[10px] text-gray-400">×</span>
                          <input
                            type="number"
                            min="1"
                            value={row.qty}
                            onChange={(e) => updateItem(idx, 'qty', e.target.value)}
                            className="w-14 bg-white border border-gray-200 rounded-lg px-2 py-1 text-sm text-center focus:outline-none focus:ring-1 focus:ring-yellow-400"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          className="text-red-500 hover:text-red-700 hover:bg-red-50 p-1.5 rounded transition-colors shrink-0"
                          title="Видалити"
                        >
                          <Trash2 size={14} />
                        </button>
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

            {/* Панель дій: документи + збереження */}
            <div className="bg-white border border-gray-100 rounded-2xl p-4 md:p-6 shadow-sm space-y-4 lg:sticky lg:bottom-4">
              {/* Документи прямо з рядків замовлення (без відкриття накладної) */}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" disabled={!hasValidItems} className="flex-1 min-w-[9rem]" onClick={() => printDoc('invoice')}>
                  🧾 Рахунок-фактура
                </Button>
                <Button variant="secondary" disabled={!hasValidItems} className="flex-1 min-w-[9rem]" onClick={() => printDoc('delivery')}>
                  📄 Видаткова накладна
                </Button>
                <Button variant="secondary" disabled={!hasValidItems} className="flex-1 min-w-[9rem]" onClick={copyMessengerText}>
                  💬 Копіювати в буфер
                </Button>
              </div>

              <div className="border-t border-gray-100" />

              {/* Збереження: «Зберегти» = відкрите (клієнт думає); «В замовлення» = замовлено */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                {!isDesktop
                  ? <Button variant="secondary" onClick={() => setStep(3)}>Назад до деталей</Button>
                  : <span className="text-xs text-gray-400 hidden sm:block">«Зберегти» — лишити відкритим (клієнт думає) · «В замовлення» — закрити як замовлено</span>}

                <div className="flex gap-2 w-full sm:w-auto">
                  <Button
                    variant="secondary"
                    disabled={saving}
                    className="flex-1 sm:flex-initial"
                    onClick={() => handleSave('save')}
                  >
                    {id ? 'Зберегти зміни' : 'Зберегти'}
                  </Button>
                  <Button
                    disabled={saving}
                    className="flex-1 sm:flex-initial !bg-green-500 hover:!bg-green-600 text-white font-bold"
                    onClick={() => handleSave('order')}
                  >
                    В замовлення
                  </Button>
                </div>
              </div>
            </div>

          </div>
        )}

      </div>

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
