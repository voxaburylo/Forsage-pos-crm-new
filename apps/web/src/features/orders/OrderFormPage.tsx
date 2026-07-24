import { useEffect, useState, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams, useParams } from 'react-router-dom'
import { Plus, Trash2, User, Car, Check, ChevronRight, ArrowLeft, Search, ClipboardList, X } from 'lucide-react'
import { orderApi, type CreateOrderPayload, type CustomerOrder } from './orderApi'
import { ProductAutocomplete } from '@/components/ProductAutocomplete'
import { productApi } from '@/features/products/productApi'
import { kopecksToHryvnia } from '@/types/product'
import type { Product } from '@/types/product'
import { customerApi } from '@/features/customers/customerApi'
import { customerVehiclesApi } from '@/features/customers/customerVehiclesApi'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Button, Input, Card, Modal } from '@/components/ui'
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

function uniqueSuppliers(list: Supplier[]): Supplier[] {
  const seen = new Set<string>()
  return list.filter((supplier) => {
    const key = supplier.name.trim().toLocaleLowerCase('uk-UA')
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

interface ItemRow {
  name:        string
  sku:         string
  qty:         string
  sell_price:  string
  supplier_id: string
  expected_date?: string
  product_id?: string | null
  stock?:      number
  item_type?:  'product' | 'service'
  buy_price?:  string
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
        if (payload.discount_amount) {
          setDiscount((payload.discount_amount / 100).toString())
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
        
        // Discount
        setDiscount(o.discount_amount ? (o.discount_amount / 100).toString() : '0')
        // Items
        if (o.items && o.items.length > 0) {
          setItems(o.items.map(item => ({
            name: item.name,
            sku: item.sku ?? '',
            qty: item.qty.toString(),
            sell_price: (item.sell_price / 100).toString(),
            supplier_id: item.supplier_id ?? '',
            expected_date: item.expected_date ? item.expected_date.split('T')[0] : '',
            product_id: item.product_id ?? null,
            item_type: item.item_type ?? 'product',
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
  const [items, setItems] = useState<ItemRow[]>([{ ...EMPTY_ITEM }])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])

  // ORD-36: шаблони частих позицій (localStorage)
  const TEMPLATES_KEY = 'order_item_templates'
  const [templateModalOpen, setTemplateModalOpen] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [templates, setTemplates] = useState<Array<{ name: string; items: ItemRow[] }>>(() => {
    try { return JSON.parse(localStorage.getItem(TEMPLATES_KEY) ?? '[]') } catch { return [] }
  })
  function persistTemplates(next: Array<{ name: string; items: ItemRow[] }>) {
    setTemplates(next)
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(next))
  }
  function applyTemplate(t: { name: string; items: ItemRow[] }) {
    setItems((prev) => {
      const base = prev.filter((r) => r.name.trim())
      return [...base, ...t.items.map((i) => ({ ...EMPTY_ITEM, ...i }))]
    })
    toast.success(`Додано шаблон «${t.name}»`)
  }
  // Назву питаємо власною модалкою: Electron не реалізує window.prompt(),
  // тож на касі кнопка збереження шаблону просто мовчала.
  function saveAsTemplate() {
    const filled = items.filter((r) => r.name.trim())
    if (filled.length === 0) { toast.error('Немає позицій для шаблону'); return }
    setTemplateName('')
    setTemplateModalOpen(true)
  }
  function submitTemplate() {
    const name = templateName.trim()
    if (!name) { toast.error('Вкажіть назву шаблону'); return }
    const filled = items.filter((r) => r.name.trim())
    if (filled.length === 0) { toast.error('Немає позицій для шаблону'); return }
    persistTemplates([...templates.filter((t) => t.name !== name), { name, items: filled }])
    setTemplateModalOpen(false)
    toast.success('Шаблон збережено')
  }
  function deleteTemplate(name: string) {
    persistTemplates(templates.filter((t) => t.name !== name))
  }

  // Step 4: Summary & Checkout
  const [comment, setComment] = useState('')
  const [isUrgent, setIsUrgent] = useState(false)
  const [discount, setDiscount] = useState('0')
  const [discountMode, setDiscountMode] = useState<'uah' | 'pct'>('uah')
  const [saving, setSaving] = useState(false)

  // Query parameter support
  useEffect(() => {
    const qCustomerId = searchParams.get('customer_id')
    if (qCustomerId) {
      api.get<{ data: Customer }>('/api/v1/customers/' + qCustomerId)
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

    api.get<{ data: Supplier[] }>('/api/v1/suppliers?per_page=200&is_active=true')
      .then((r) => setSuppliers(uniqueSuppliers((r as any).data ?? [])))
      .catch(() => {})
  }, [])

  // Auto-search customers
  useEffect(() => {
    if (customerSearch.trim().length < 2) {
      setSearchedCustomers([])
      setSearchCustomersLoading(false)
      return
    }
    setSearchCustomersLoading(true)
    const t = setTimeout(() => {
      customerApi.list({ search: customerSearch.trim(), per_page: 8 })
        .then((r) => setSearchedCustomers((r as any).data ?? []))
        .catch(() => setSearchedCustomers([]))
        .finally(() => setSearchCustomersLoading(false))
    }, 300)
    return () => clearTimeout(t)
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

  // ORD-29: підбір запчастин по VIN авто (бекенд vinSearch через product_fitment)
  const [vinSuggestions, setVinSuggestions] = useState<Product[]>([])
  const [vinLoading, setVinLoading] = useState(false)
  const [vinPanelOpen, setVinPanelOpen] = useState(false)
  async function pickByVin() {
    const vin = selectedVehicle?.vin?.trim()
    if (!vin) return
    setVinPanelOpen(true)
    setVinLoading(true)
    try {
      const r = await productApi.search(vin, 15)
      setVinSuggestions(r.data ?? [])
    } catch {
      setVinSuggestions([])
    } finally {
      setVinLoading(false)
    }
  }
  function addProductAsItem(p: Product) {
    setItems((rows) => {
      const base = rows.filter((r) => r.name.trim())
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
    toast.success(`Додано: ${p.name}`)
  }

  // Items manipulation
  function addItem() { setItems((p) => [...p, { ...EMPTY_ITEM }]) }
  function removeItem(i: number) { setItems((p) => p.filter((_, idx) => idx !== i)) }
  function updateItem<K extends keyof ItemRow>(i: number, key: K, val: ItemRow[K]) {
    setItems((p) => p.map((row, idx) => idx === i ? { ...row, [key]: val } : row))
  }

  // Підстановка товару з каталогу (ORD-1): SKU + ціна + залишок + тип (ORD-24)
  function selectProduct(i: number, p: { id: string; name: string; sku: string; retail_price: number; qty_on_hand: number; qty_available?: number; is_service?: boolean; purchase_price?: number }) {
    setItems((rows) => rows.map((row, idx) => idx === i ? {
      ...row,
      name: p.name,
      sku: p.sku ?? '',
      sell_price: kopecksToHryvnia(p.retail_price),
      buy_price: p.purchase_price ? kopecksToHryvnia(p.purchase_price) : '0',
      product_id: p.id,
      stock: p.qty_available ?? p.qty_on_hand ?? 0,
      item_type: p.is_service ? 'service' : 'product',
    } : row))
  }

  const totalKop = useMemo(() => {
    return items.reduce((s, row) => {
      const price = parseFloat(row.sell_price || '0') || 0
      const qty = parseFloat(row.qty || '1') || 1
      return s + Math.round(price * 100) * qty
    }, 0)
  }, [items])

  // Сума до сплати та решта (ORD-5, ORD-6, ORD-21)
  const discountKopMemo = discountMode === 'pct'
    ? Math.round(totalKop * (Math.min(parseFloat(discount || '0'), 100) / 100))
    : Math.round(parseFloat(discount || '0') * 100)
  const toPayKop = Math.max(0, totalKop - discountKopMemo)
  // Submit Order / Save Draft
  async function handleSave(asDraft: boolean) {
    const validItems = items.filter((row) => row.name.trim())
    if (validItems.length === 0) {
      toast.error('Додайте хоча б одну позицію з назвою')
      setStep(3)
      return
    }

    // ORD-5: не дати випадково оформити замовлення на 0 грн
    if (!asDraft && toPayKop === 0) {
      if (!confirm('Сума замовлення 0 ₴. Оформити замовлення без вартості?')) {
        setStep(3)
        return
      }
    }

    // ORD-27: попередження про можливий дубль (той самий клієнт+сума за короткий проміжок)
    if (!asDraft && !id && customerId && totalKop > 0) {
      try {
        const recent = await api.get<{ data: Array<{ order_number: number | null; total_amount: number; status: string; created_at: string }> }>(
          `/api/v1/customer-orders?customer_id=${customerId}&per_page=10`,
        )
        const cutoff = Date.now() - 30 * 60 * 1000
        const dup = ((recent as any).data ?? []).find((o: any) =>
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

    const discountKop = discountKopMemo
    const payload: CreateOrderPayload = {
      customer_id: customerId || null,
      source: 'walk_in',
      parent_draft_id: !asDraft ? sourceDraftId : null,
      vehicle_info: vehicleInfo,
      comment: finalComment || null,
      // Гроші приймаються тільки через касу: там є зміна, ПРРО, борги і журнал дій.
      prepayment: 0,
      prepayment_method: null,
      prepayment_is_fiscal: false,
      discount_amount: discountKop,
      items: validItems.map((row) => ({
        name:        row.name.trim(),
        sku:         row.sku.trim() || null,
        product_id:  row.product_id || null,
        qty:         parseFloat(row.qty) || 1,
        sell_price:  Math.round(parseFloat(row.sell_price || '0') * 100),
        buy_price:   row.supplier_id ? Math.round(parseFloat(row.buy_price || '0') * 100) : 0,
        supplier_id: row.supplier_id || null,
        source_type: row.supplier_id ? 'supplier' : 'warehouse',
        item_type:   row.item_type ?? 'product',
        expected_date: row.supplier_id && row.expected_date ? row.expected_date : null,
      })),
    }

    setSaving(true)
    try {
      if (id) {
        await orderApi.update(id, payload)
        toast.success('Замовлення оновлено')
        navigate('/orders/' + id)
      } else {
        const result = await orderApi.create(payload)
        const newOrder = (result as { data: { id: string } }).data
        
        if (asDraft) {
          toast.success('Чернетку збережено')
          navigate('/orders?tab=drafts')
        } else {
          // Без передоплати бекенд створює lead. Якщо менеджер натиснув "оформити замовлення",
          // переводимо запис у робоче замовлення; оплату пізніше прийме касир у касі.
          try {
            await orderApi.updateStatus(newOrder.id, 'new')
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Не вдалося активувати замовлення'
            toast.warning(`${msg}. Збережено як чернетку — виправте і активуйте з картки замовлення.`)
            navigate('/orders/' + newOrder.id)
            return
          }
          if (sourceDraftId) {
            await api.delete(`/api/v1/customer-orders/${sourceDraftId}`).catch(() => {})
          }
          toast.success('Замовлення оформлено!')
          navigate('/orders/' + newOrder.id)
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка збереження')
    } finally {
      setSaving(false)
    }
  }

  // ORD-35: гаряча клавіша Ctrl+S — зберегти (на кроці 4 оформити, інакше чернетка)
  const saveRef = useRef(handleSave)
  saveRef.current = handleSave
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveRef.current(step !== 4)
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

            {/* Шаблони частих позицій (ORD-36) */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-gray-400">Шаблони:</span>
              {templates.length === 0 && <span className="text-xs text-gray-300">поки немає</span>}
              {templates.map((t) => (
                <span key={t.name} className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200">
                  <button type="button" onClick={() => applyTemplate(t)} className="hover:underline">+ {t.name}</button>
                  <button type="button" onClick={() => deleteTemplate(t.name)} className="text-yellow-400 hover:text-red-500" title="Видалити шаблон">×</button>
                </span>
              ))}
              <button type="button" onClick={saveAsTemplate} className="text-xs font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200">
                💾 Зберегти як шаблон
              </button>
              {/* ORD-29: підбір по VIN */}
              {selectedVehicle?.vin && (
                <button type="button" onClick={pickByVin} className="text-xs font-semibold px-2 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100">
                  🔍 Підібрати по VIN
                </button>
              )}
            </div>

            {/* Панель підбору по VIN (ORD-29) */}
            {vinPanelOpen && (
              <Card className="border-blue-100">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-bold text-gray-800 text-sm">
                    Сумісні запчастини для {selectedVehicle?.brand} {selectedVehicle?.model}
                    <span className="ml-1 font-mono text-xs text-gray-400">{selectedVehicle?.vin}</span>
                  </h4>
                  <button type="button" onClick={() => setVinPanelOpen(false)} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
                </div>
                {vinLoading ? (
                  <p className="text-xs text-gray-400 py-2">Підбираємо...</p>
                ) : vinSuggestions.length === 0 ? (
                  <p className="text-xs text-gray-400 py-2">Сумісних товарів за VIN не знайдено. Перевірте, що для авто заповнено сумісність (fitment) у каталозі.</p>
                ) : (
                  <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
                    {vinSuggestions.map((p) => {
                      const stock = p.qty_available ?? p.qty_on_hand ?? 0
                      return (
                        <div key={p.id} className="flex items-center justify-between gap-2 py-2">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-gray-800 truncate">{p.name}</p>
                            <p className="text-[10px] text-gray-400 font-mono">{p.sku} · {stock > 0 ? `склад: ${stock}` : 'немає'}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-xs font-bold text-yellow-600">{formatMoney(p.retail_price)}</span>
                            <Button size="sm" variant="secondary" icon={<Plus size={12} />} onClick={() => addProductAsItem(p)} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </Card>
            )}

            {/* Parts Table */}
            <Card padding="none">
              {/* Mobile: позиції картками (ORD-17) */}
              <div className="md:hidden divide-y divide-gray-100">
                {items.map((row, idx) => (
                  <div key={idx} className="p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-gray-400">Позиція {idx + 1}</span>
                      {items.length > 1 && (
                        <button type="button" onClick={() => removeItem(idx)} className="text-red-500 hover:text-red-700 p-1" title="Видалити">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                    <ProductAutocomplete
                      value={row.name}
                      onChange={(val) => setItems((p) => p.map((r, i) => i === idx ? { ...r, name: val, product_id: null, stock: undefined } : r))}
                      onSelect={(prod) => selectProduct(idx, prod)}
                      placeholder="Назва або артикул..."
                    />
                    {row.product_id && row.stock !== undefined && (
                      <span className={`block text-[10px] font-semibold ${row.stock > 0 ? 'text-green-600' : 'text-orange-500'}`}>
                        {row.stock > 0 ? `✓ На складі: ${row.stock}` : '⚠ Немає на складі — під замовлення'}
                      </span>
                    )}
                    <div className="grid grid-cols-3 gap-2">
                      <input value={row.sku} onChange={(e) => updateItem(idx, 'sku', e.target.value)} placeholder="Артикул"
                        className="bg-white border border-gray-200 rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 font-mono" />
                      <input value={row.qty} onChange={(e) => updateItem(idx, 'qty', e.target.value)} type="number" min="1" placeholder="К-сть"
                        className="bg-white border border-gray-200 rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 text-center" />
                      <input value={row.sell_price} onChange={(e) => updateItem(idx, 'sell_price', e.target.value)} type="number" min="0" step="any" placeholder="Ціна"
                        className="bg-white border border-gray-200 rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 font-semibold text-right" />
                    </div>
                    {row.supplier_id && (
                      <div className="mt-1">
                        <input value={row.buy_price || ''} onChange={(e) => updateItem(idx, 'buy_price', e.target.value)} type="number" min="0" step="any" placeholder="Ціна закупівлі (грн)"
                          className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 font-semibold text-right" />
                      </div>
                    )}
                    <select value={row.supplier_id} onChange={(e) => updateItem(idx, 'supplier_id', e.target.value)}
                      className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400">
                      <option value="">Наявність на складі</option>
                      {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    {row.supplier_id && (
                      <input type="date" value={row.expected_date || ''} onChange={(e) => updateItem(idx, 'expected_date', e.target.value)}
                        className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400"
                        title="Очікувана дата надходження" />
                    )}
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto hidden md:block">
                <table className="w-full min-w-[1000px] table-fixed text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-gray-400 text-xs font-bold uppercase tracking-wider border-b border-gray-100">
                      <th className="px-3 py-3 w-[4%] text-center">#</th>
                      <th className="px-3 py-3 w-[28%]">Назва запчастини</th>
                      <th className="px-3 py-3 w-[15%]">Артикул / SKU</th>
                      <th className="px-3 py-3 w-[8%]">К-сть</th>
                      <th className="px-3 py-3 w-[12%]">Закупка (грн)</th>
                      <th className="px-3 py-3 w-[12%]">Роздріб (грн)</th>
                      <th className="px-3 py-3 w-[17%]">Постачальник</th>
                      <th className="px-3 py-3 w-[4%] text-center"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {items.map((row, idx) => (
                      <tr key={idx} className="hover:bg-gray-50/20 align-top">
                        <td className="px-3 py-3 text-center text-gray-400 font-mono text-xs">{idx + 1}</td>
                        <td className="px-3 py-3">
                          <ProductAutocomplete
                            value={row.name}
                            onChange={(val) => setItems((p) => p.map((r, i) => i === idx ? { ...r, name: val, product_id: null, stock: undefined } : r))}
                            onSelect={(p) => selectProduct(idx, p)}
                            placeholder="Введіть назву або артикул..."
                            className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-yellow-400"
                            required
                          />
                          {row.product_id && row.stock !== undefined && (
                            <span className={`mt-1 inline-block text-[10px] font-semibold ${row.stock > 0 ? 'text-green-600' : 'text-orange-500'}`}>
                              {row.stock > 0 ? `✓ На складі: ${row.stock}` : '⚠ Немає на складі — під замовлення'}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <input
                            value={row.sku}
                            onChange={(e) => updateItem(idx, 'sku', e.target.value)}
                            placeholder="Артикул..."
                            className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 font-mono"
                          />
                        </td>
                        <td className="px-3 py-3">
                          <input
                            value={row.qty}
                            onChange={(e) => updateItem(idx, 'qty', e.target.value)}
                            type="number"
                            min="1"
                            required
                            className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400"
                          />
                        </td>
                        <td className="px-3 py-3">
                          {row.supplier_id ? (
                            <input
                              value={row.buy_price || ''}
                              onChange={(e) => updateItem(idx, 'buy_price', e.target.value)}
                              type="number"
                              min="0"
                              step="any"
                              placeholder="Закупка"
                              className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 font-semibold text-right"
                            />
                          ) : (
                            <span className="text-gray-400 text-xs block text-center">-</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <input
                            value={row.sell_price}
                            onChange={(e) => updateItem(idx, 'sell_price', e.target.value)}
                            type="number"
                            min="0"
                            step="any"
                            required
                            className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 font-semibold"
                          />
                        </td>
                        <td className="px-3 py-3">
                          <select
                            value={row.supplier_id}
                            onChange={(e) => updateItem(idx, 'supplier_id', e.target.value)}
                            className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400"
                          >
                            <option value="">Наявність на складі</option>
                            {suppliers.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                          {row.supplier_id && (
                            <div className="mt-1.5">
                              <input
                                type="date"
                                value={row.expected_date || ''}
                                onChange={(e) => updateItem(idx, 'expected_date', e.target.value)}
                                className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400"
                                title="Очікувана дата надходження"
                              />
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-center">
                          {items.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeItem(idx)}
                              className="text-red-500 hover:text-red-700 hover:bg-red-50 p-1.5 rounded transition-colors"
                              title="Видалити"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Table Action Footer */}
              <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between bg-gray-50/50">
                <Button variant="secondary" size="sm" onClick={addItem} icon={<Plus size={12} />}>
                  Додати рядок
                </Button>
                
                {!isDesktop && (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setStep(selectedCustomer ? 2 : 1)}>Назад</Button>
                  <Button disabled={!hasValidItems} onClick={() => setStep(4)}>Далі</Button>
                </div>
                )}
              </div>
              {!isDesktop && !hasValidItems && (
                <p className="px-4 pb-3 text-xs text-orange-600">
                  Додайте назву хоча б однієї позиції, щоб перейти далі.
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
                  {discountKopMemo > 0 && (
                    <div className="flex justify-between text-red-600 font-semibold">
                      <span>Знижка{discountMode === 'pct' ? ` (${discount}%)` : ''}:</span>
                      <span>-{formatMoney(discountKopMemo)}</span>
                    </div>
                  )}
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
                <h4 className="font-bold text-gray-800 text-sm border-b border-gray-100 pb-2">Знижка та коментар</h4>
                
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-semibold text-gray-500">Знижка</label>
                      <div className="flex rounded-md overflow-hidden border border-gray-200">
                        {(['uah', 'pct'] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setDiscountMode(m)}
                            className={`px-2 py-0.5 text-xs font-bold transition-colors ${
                              discountMode === m ? 'bg-yellow-400 text-black' : 'bg-white text-gray-400 hover:bg-gray-50'
                            }`}
                          >
                            {m === 'uah' ? '₴' : '%'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <input
                      value={discount}
                      onChange={(e) => setDiscount(e.target.value)}
                      type="number"
                      min="0"
                      max={discountMode === 'pct' ? '100' : undefined}
                      step="any"
                      className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-yellow-400"
                    />
                  </div>
                </div>

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

            {/* Save Buttons Panel */}
            <div className="bg-white border border-gray-100 rounded-2xl p-4 md:p-6 shadow-sm flex flex-col sm:flex-row justify-between items-center gap-4 lg:sticky lg:bottom-4">
              {!isDesktop
                ? <Button variant="secondary" onClick={() => setStep(3)}>Назад до деталей</Button>
                : <span className="text-xs text-gray-400 hidden sm:block">Ctrl+S — {id ? 'зберегти зміни' : 'оформити замовлення'}</span>}

              <div className="flex gap-2 w-full sm:w-auto">
                {/* Кнопка «як чернетку» лише при СТВОРЕННІ — при редагуванні наявного замовлення вона не має сенсу */}
                {!id && (
                  <Button
                    variant="secondary"
                    disabled={saving}
                    className="flex-1 sm:flex-initial"
                    onClick={() => handleSave(true)}
                  >
                    Зберегти як Чернетку
                  </Button>
                )}
                <Button
                  disabled={saving}
                  className="flex-1 sm:flex-initial !bg-green-500 hover:!bg-green-600 text-white font-bold"
                  onClick={() => handleSave(false)}
                >
                  {id ? 'Зберегти зміни' : 'Оформити замовлення'}
                </Button>
              </div>
            </div>

          </div>
        )}

      </div>

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
                  <li key={item.id} className="flex gap-2 rounded-xl border border-gray-100 bg-gray-50 p-3 text-sm font-medium text-gray-800">
                    <span className="text-gray-400">{index + 1}.</span>
                    <span>{item.name}</span>
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

      <Modal open={templateModalOpen} onClose={() => setTemplateModalOpen(false)} title="Зберегти як шаблон" size="sm">
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Назва шаблону</label>
            <Input value={templateName} autoFocus placeholder="Напр. «ТО Kia Rio»"
              onChange={(e) => setTemplateName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitTemplate() }} />
          </div>
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="secondary" onClick={() => setTemplateModalOpen(false)}>Скасувати</Button>
            <Button type="button" onClick={submitTemplate}>Зберегти</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}
