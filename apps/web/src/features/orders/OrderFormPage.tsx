import { useEffect, useState, useMemo } from 'react'
import { useNavigate, useSearchParams, useParams } from 'react-router-dom'
import { Plus, Trash2, User, Car, Check, ChevronRight, ArrowLeft, Search } from 'lucide-react'
import { orderApi, type CreateOrderPayload } from './orderApi'
import { ProductAutocomplete } from './ProductAutocomplete'
import { kopecksToHryvnia } from '@/types/product'
import { customerApi } from '@/features/customers/customerApi'
import { customerVehiclesApi } from '@/features/customers/customerVehiclesApi'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Button, Input, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
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

interface ItemRow {
  name:        string
  sku:         string
  qty:         string
  sell_price:  string
  supplier_id: string
  expected_date?: string
  product_id?: string | null
  stock?:      number
}

const EMPTY_ITEM: ItemRow = { name: '', sku: '', qty: '1', sell_price: '0', supplier_id: '', expected_date: '', product_id: null }

export default function OrderFormPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { id } = useParams()
  const [loading, setLoading] = useState(false)

  // Wizard state
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)

  // Step 1: Customer
  const [customerId, setCustomerId] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [defaultCustomers, setDefaultCustomers] = useState<Customer[]>([])
  const [searchedCustomers, setSearchedCustomers] = useState<Customer[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  
  // Inline Create Customer
  const [showAddCustomer, setShowAddCustomer] = useState(false)
  const [newCustName, setNewCustName] = useState('')
  const [newCustPhone, setNewCustPhone] = useState('')
  const [addingCustomer, setAddingCustomer] = useState(false)

  // Step 2: Vehicle
  const [vehicles, setVehicles] = useState<CustomerVehicle[]>([])
  const [selectedVehicle, setSelectedVehicle] = useState<CustomerVehicle | null>(null)

  // Inline Create Vehicle
  const [showAddVehicle, setShowAddVehicle] = useState(false)
  const [newVehBrand, setNewVehBrand] = useState('')
  const [newVehModel, setNewVehModel] = useState('')
  const [newVehYear, setNewVehYear] = useState('')
  const [newVehVin, setNewVehVin] = useState('')
  const [addingVehicle, setAddingVehicle] = useState(false)

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
              }
            })
            .catch(() => {})
        }
        
        // Set comment & urgency
        let cleanComment = o.comment ?? ''
        if (cleanComment.includes('[ТЕРМІНОВО]')) {
          setIsUrgent(true)
          cleanComment = cleanComment.replace('[ТЕРМІНОВО]', '').trim()
        }
        setComment(cleanComment)
        
        // Prepayment
        setPrepayment((o.prepayment / 100).toString())
        setPrepaymentMethod((o.prepayment_method as any) || 'cash')
        
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
          })))
        }
      })
      .catch(() => toast.error('Помилка завантаження замовлення'))
      .finally(() => setLoading(false))
  }, [id])

  // Step 3: Items
  const [items, setItems] = useState<ItemRow[]>([{ ...EMPTY_ITEM }])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])

  // Step 4: Summary & Checkout
  const [comment, setComment] = useState('')
  const [isUrgent, setIsUrgent] = useState(false)
  const [prepayment, setPrepayment] = useState('0')
  const [discount, setDiscount] = useState('0')
  const [prepaymentMethod, setPrepaymentMethod] = useState<'cash' | 'card' | 'transfer'>('cash')
  const [isFiscal, setIsFiscal] = useState(false)
  const [saving, setSaving] = useState(false)

  // Force isFiscal to true when card is selected
  useEffect(() => {
    if (prepaymentMethod === 'card') {
      setIsFiscal(true)
    } else {
      setIsFiscal(false)
    }
  }, [prepaymentMethod])

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
    customerApi.list({ per_page: 5 })
      .then((r) => setDefaultCustomers((r as any).data ?? []))
      .catch(() => {})

    api.get<{ data: Supplier[] }>('/api/v1/suppliers?per_page=200&is_active=true')
      .then((r) => setSuppliers((r as any).data ?? []))
      .catch(() => {})
  }, [])

  // Auto-search customers
  useEffect(() => {
    if (customerSearch.trim().length < 2) {
      setSearchedCustomers([])
      return
    }
    const t = setTimeout(() => {
      customerApi.list({ search: customerSearch.trim(), per_page: 8 })
        .then((r) => setSearchedCustomers((r as any).data ?? []))
        .catch(() => {})
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
        toast.success('Клієнта створено!')
        handleCustomerSelect(res.data)
      }
    } catch {
      toast.error('Помилка при створенні клієнта')
    } finally {
      setAddingCustomer(false)
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
        handleVehicleSelect(res.data)
      }
    } catch {
      toast.error('Помилка додавання автомобіля')
    } finally {
      setAddingVehicle(false)
    }
  }

  // Items manipulation
  function addItem() { setItems((p) => [...p, { ...EMPTY_ITEM }]) }
  function removeItem(i: number) { setItems((p) => p.filter((_, idx) => idx !== i)) }
  function updateItem<K extends keyof ItemRow>(i: number, key: K, val: ItemRow[K]) {
    setItems((p) => p.map((row, idx) => idx === i ? { ...row, [key]: val } : row))
  }

  // Підстановка товару з каталогу (ORD-1): SKU + ціна + залишок
  function selectProduct(i: number, p: { id: string; name: string; sku: string; retail_price: number; qty_on_hand: number; qty_available?: number }) {
    setItems((rows) => rows.map((row, idx) => idx === i ? {
      ...row,
      name: p.name,
      sku: p.sku ?? '',
      sell_price: kopecksToHryvnia(p.retail_price),
      product_id: p.id,
      stock: p.qty_available ?? p.qty_on_hand ?? 0,
    } : row))
  }

  const totalKop = useMemo(() => {
    return items.reduce((s, row) => {
      const price = parseFloat(row.sell_price || '0') || 0
      const qty = parseFloat(row.qty || '1') || 1
      return s + Math.round(price * 100) * qty
    }, 0)
  }, [items])

  // Сума до сплати та решта (ORD-5, ORD-6)
  const discountKopMemo = Math.round(parseFloat(discount || '0') * 100)
  const toPayKop = Math.max(0, totalKop - discountKopMemo)
  const prepaymentKopMemo = Math.round(parseFloat(prepayment || '0') * 100)
  const changeKop = Math.max(0, prepaymentKopMemo - toPayKop)

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

    // ORD-6: передоплата більша за суму — підтвердити видачу решти
    if (!asDraft && changeKop > 0) {
      if (!confirm(`Передоплата перевищує суму до сплати.\nРешта клієнту: ${formatMoney(changeKop)}\n\nЗафіксувати передоплату ${formatMoney(toPayKop)} та видати решту?`)) {
        return
      }
    }

    const vehicleInfo = selectedVehicle
      ? {
          make:  selectedVehicle.brand,
          model: selectedVehicle.model,
          year:  selectedVehicle.year ?? undefined,
          vin:   selectedVehicle.vin ?? undefined,
        }
      : null

    const finalComment = [
      isUrgent ? '[ТЕРМІНОВО]' : '',
      comment.trim(),
    ].filter(Boolean).join(' ')

    // Передоплату обмежуємо сумою до сплати — решта видається готівкою, а не «з'їдається» (ORD-6)
    const prepaymentKop = Math.min(prepaymentKopMemo, toPayKop)

    // Draft orders have 0 prepayment in backend typically
    const finalPrepayment = asDraft ? 0 : prepaymentKop

    const discountKop = Math.round(parseFloat(discount || '0') * 100)
    const payload: CreateOrderPayload = {
      customer_id: customerId || null,
      source: 'walk_in',
      vehicle_info: vehicleInfo,
      comment: finalComment || null,
      prepayment: finalPrepayment,
      prepayment_method: finalPrepayment > 0 ? prepaymentMethod : null,
      prepayment_is_fiscal: finalPrepayment > 0 ? isFiscal : false,
      discount_amount: discountKop,
      items: validItems.map((row) => ({
        name:        row.name.trim(),
        sku:         row.sku.trim() || null,
        product_id:  row.product_id || null,
        qty:         parseFloat(row.qty) || 1,
        sell_price:  Math.round(parseFloat(row.sell_price || '0') * 100),
        buy_price:   0,
        supplier_id: row.supplier_id || null,
        source_type: row.supplier_id ? 'supplier' : 'warehouse',
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
          // If order prepayment is 0, backend creates it as 'lead'. Let's promote it to 'new' since manager explicitly checked it out as Order.
          if (finalPrepayment === 0) {
            await orderApi.updateStatus(newOrder.id, 'new')
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

  // Customer List to show
  const customerList = customerSearch.trim().length >= 2 ? searchedCustomers : defaultCustomers

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
      <div className="max-w-4xl mx-auto space-y-6">
        
        {/* Step Indicator */}
        <div className="bg-white border border-gray-100 rounded-2xl p-4 md:p-6 shadow-sm flex items-center justify-between">
          {[
            { s: 1, label: 'Клієнт' },
            { s: 2, label: 'Автомобіль' },
            { s: 3, label: 'Запчастини' },
            { s: 4, label: 'Завершення' },
          ].map((item) => {
            const isActive = step === item.s
            const isCompleted = step > item.s
            return (
              <div key={item.s} className="flex items-center gap-2 flex-1 last:flex-initial">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm transition-colors ${
                  isActive ? 'bg-yellow-400 text-black' :
                  isCompleted ? 'bg-green-500 text-white' :
                  'bg-gray-100 text-gray-400'
                }`}>
                  {isCompleted ? <Check size={14} /> : item.s}
                </div>
                <span className={`text-xs md:text-sm font-semibold hidden sm:inline ${isActive ? 'text-gray-900' : 'text-gray-400'}`}>
                  {item.label}
                </span>
                {item.s < 4 && (
                  <div className="h-0.5 bg-gray-100 flex-1 mx-2 hidden sm:block" />
                )}
              </div>
            )
          })}
        </div>

        {/* ─────────────── STEP 1: SELECT CUSTOMER ─────────────── */}
        {step === 1 && (
          <div className="space-y-6">
            <Card className="max-w-2xl mx-auto">
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
              {customerList.length > 0 ? (
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
                    className="w-full border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-700 font-semibold py-3 px-4 rounded-xl text-center text-sm transition-all duration-200 cursor-pointer flex items-center justify-center gap-2"
                  >
                    👤 Пропустити вибір клієнта (Швидке замовлення)
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
                    <Input
                      label="Телефон клієнта"
                      value={newCustPhone}
                      onChange={(e) => setNewCustPhone(e.target.value)}
                      placeholder="0973829369"
                      required
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setShowAddCustomer(false)}>Скасувати</Button>
                    <Button type="submit" size="sm" disabled={addingCustomer}>Зберегти клієнта</Button>
                  </div>
                </form>
              )}
            </Card>
          </div>
        )}

        {/* ─────────────── STEP 2: SELECT VEHICLE ─────────────── */}
        {step === 2 && selectedCustomer && (
          <div className="space-y-6 max-w-2xl mx-auto">
            <Card>
              <div className="flex items-center gap-3 border-b border-gray-100 pb-4 mb-4">
                <Button size="sm" variant="ghost" onClick={() => setStep(1)} icon={<ArrowLeft size={14} />} />
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
                    <Input
                      label="VIN-код (17 знаків)"
                      value={newVehVin}
                      onChange={(e) => setNewVehVin(e.target.value.toUpperCase())}
                      placeholder="KNEDE241260000300"
                    />
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
          </div>
        )}

        {/* ─────────────── STEP 3: PARTS SPECIFICATION ─────────────── */}
        {step === 3 && (
          <div className="space-y-6">
            {/* Header info */}
            <div className="bg-white border border-gray-100 rounded-2xl p-4 md:p-6 shadow-sm flex flex-wrap justify-between items-center gap-4">
              <div className="flex items-center gap-3">
                <Button size="sm" variant="ghost" onClick={() => setStep(selectedCustomer ? 2 : 1)} icon={<ArrowLeft size={14} />} />
                <div>
                  <h3 className="font-bold text-gray-900">Специфікація замовлення</h3>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Клієнт: <span className="font-bold text-gray-700">{selectedCustomer ? (selectedCustomer.full_name ?? 'Без імені') : 'Гість'}</span>
                    {selectedCustomer && (
                      <> | Авто: <span className="font-bold text-gray-700">{selectedVehicle ? `${selectedVehicle.brand} ${selectedVehicle.model}${selectedVehicle.year ? ` (${selectedVehicle.year})` : ''}` : 'Не обрано'}</span>
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

            {/* Parts Table */}
            <Card padding="none">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-gray-400 text-xs font-bold uppercase tracking-wider border-b border-gray-100">
                      <th className="px-4 py-3 w-10 text-center">#</th>
                      <th className="px-4 py-3">Назва запчастини / роботи</th>
                      <th className="px-4 py-3 w-40">Артикул / SKU</th>
                      <th className="px-4 py-3 w-24">К-сть</th>
                      <th className="px-4 py-3 w-36">Ціна (грн)</th>
                      <th className="px-4 py-3 w-48">Постачальник</th>
                      <th className="px-4 py-3 w-10 text-center"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {items.map((row, idx) => (
                      <tr key={idx} className="hover:bg-gray-50/20">
                        <td className="px-4 py-3 text-center text-gray-400 font-mono text-xs">{idx + 1}</td>
                        <td className="px-4 py-3">
                          <ProductAutocomplete
                            value={row.name}
                            onChange={(val) => setItems((p) => p.map((r, i) => i === idx ? { ...r, name: val, product_id: null, stock: undefined } : r))}
                            onSelect={(p) => selectProduct(idx, p)}
                            placeholder="Введіть назву або артикул..."
                            required
                          />
                          {row.product_id && row.stock !== undefined && (
                            <span className={`mt-1 inline-block text-[10px] font-semibold ${row.stock > 0 ? 'text-green-600' : 'text-orange-500'}`}>
                              {row.stock > 0 ? `✓ На складі: ${row.stock}` : '⚠ Немає на складі — під замовлення'}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <input
                            value={row.sku}
                            onChange={(e) => updateItem(idx, 'sku', e.target.value)}
                            placeholder="Артикул..."
                            className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 font-mono"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <input
                            value={row.qty}
                            onChange={(e) => updateItem(idx, 'qty', e.target.value)}
                            type="number"
                            min="1"
                            required
                            className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400"
                          />
                        </td>
                        <td className="px-4 py-3">
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
                        <td className="px-4 py-3">
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
                        <td className="px-4 py-3 text-center">
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
                
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setStep(selectedCustomer ? 2 : 1)}>Назад</Button>
                  <Button onClick={() => {
                    const filled = items.filter(i => i.name.trim())
                    if (filled.length === 0) {
                      toast.error('Додайте хоча б одну позицію з назвою')
                    } else {
                      setStep(4)
                    }
                  }}>Далі</Button>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* ─────────────── STEP 4: SUMMARY & CHECKOUT ─────────────── */}
        {step === 4 && (
          <div className="space-y-6 max-w-3xl mx-auto">
            {/* Header info */}
            <div className="bg-white border border-gray-100 rounded-2xl p-4 md:p-6 shadow-sm flex items-center gap-3">
              <Button size="sm" variant="ghost" onClick={() => setStep(3)} icon={<ArrowLeft size={14} />} />
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
                          {selectedVehicle ? `${selectedVehicle.brand} ${selectedVehicle.model}` : 'Не прив\'язано'}
                        </span>
                      </div>
                    </>
                  )}
                  {selectedVehicle?.vin && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">VIN-код:</span>
                      <span className="font-mono text-xs text-gray-800">{selectedVehicle.vin}</span>
                    </div>
                  )}
                </div>

                <h4 className="font-bold text-gray-800 text-sm border-b border-gray-100 pb-2 pt-2">Сума замовлення</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Загальна сума товарів:</span>
                    <span className="font-semibold text-gray-800">{formatMoney(totalKop)}</span>
                  </div>
                  {parseFloat(discount) > 0 && (
                    <div className="flex justify-between text-red-600 font-semibold">
                      <span>Знижка:</span>
                      <span>-{formatMoney(Math.round(parseFloat(discount || '0') * 100))}</span>
                    </div>
                  )}
                  <div className="flex justify-between items-center border-t border-gray-100 pt-2">
                    <span className="text-gray-500 font-semibold">До сплати:</span>
                    <span className="text-xl font-extrabold text-yellow-600">
                      {formatMoney(Math.max(0, totalKop - Math.round(parseFloat(discount || '0') * 100)))}
                    </span>
                  </div>
                </div>
              </Card>

              {/* Checkout Actions & Prepayment */}
              <Card className="space-y-4">
                <h4 className="font-bold text-gray-800 text-sm border-b border-gray-100 pb-2">Оплата та Коментар</h4>
                
                {/* Prepayment Input */}
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <Input
                      label="Знижка на замовлення (грн)"
                      value={discount}
                      onChange={(e) => setDiscount(e.target.value)}
                      type="number"
                      min="0"
                      step="any"
                    />
                    <Input
                      label="Внести передоплату (грн)"
                      value={prepayment}
                      onChange={(e) => setPrepayment(e.target.value)}
                      type="number"
                      min="0"
                      step="any"
                    />
                  </div>
                  
                  {changeKop > 0 && (
                    <div className="bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 flex items-center justify-between">
                      <span className="text-xs font-semibold text-orange-700">↩️ Решта клієнту:</span>
                      <span className="text-sm font-bold text-orange-700">{formatMoney(changeKop)}</span>
                    </div>
                  )}

                  {parseFloat(prepayment) > 0 && (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 mb-1">Спосіб передоплати</label>
                        <div className="grid grid-cols-3 gap-2">
                          {(['cash', 'card', 'transfer'] as const).map((method) => (
                            <button
                              key={method}
                              type="button"
                              onClick={() => setPrepaymentMethod(method)}
                              className={`py-2 px-3 text-xs font-semibold rounded-lg border text-center transition-all ${
                                prepaymentMethod === method
                                  ? 'bg-yellow-400 border-yellow-400 text-black shadow-sm'
                                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                              }`}
                            >
                              {method === 'cash' ? 'Готівка' : method === 'card' ? 'Картка' : 'Переказ'}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="pt-2">
                        <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={isFiscal}
                            disabled={prepaymentMethod === 'card'}
                            onChange={(e) => setIsFiscal(e.target.checked)}
                            className="rounded text-yellow-500 focus:ring-yellow-400 h-4 w-4"
                          />
                          🧾 Фіскалізувати передоплату (ПРРО)
                        </label>
                        {prepaymentMethod === 'card' && (
                          <p className="text-[10px] text-blue-500 mt-1 italic">
                            * Оплата через термінал завжди фіскалізується в ПРРО
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Comment Box */}
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">Коментар до замовлення</label>
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
            <div className="bg-white border border-gray-100 rounded-2xl p-4 md:p-6 shadow-sm flex flex-col sm:flex-row justify-between items-center gap-4">
              <Button variant="secondary" onClick={() => setStep(3)}>Назад до деталей</Button>
              
              <div className="flex gap-2 w-full sm:w-auto">
                <Button
                  variant="secondary"
                  disabled={saving}
                  className="flex-1 sm:flex-initial"
                  onClick={() => handleSave(true)}
                >
                  Зберегти як Чернетку
                </Button>
                <Button
                  disabled={saving}
                  className="flex-1 sm:flex-initial !bg-green-500 hover:!bg-green-600 text-white font-bold"
                  onClick={() => handleSave(false)}
                >
                  Оформити замовлення
                </Button>
              </div>
            </div>

          </div>
        )}

      </div>
    </Layout>
  )
}
