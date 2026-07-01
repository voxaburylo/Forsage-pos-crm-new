import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Plus, Trash2, Send, Copy,
  Star, Car, User, Save, ArrowRight, ScanLine, Search, MapPin
} from 'lucide-react'
import { api } from '@/lib/api'
import { customerApi } from '@/features/customers/customerApi'
import { customerVehiclesApi } from '@/features/customers/customerVehiclesApi'
import { orderApi, type CustomerOrder } from '@/features/orders/orderApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

// ─── Типи ────────────────────────────────────────────────────────────────────

interface Variant {
  brand: string
  price: string      // грн рядок
  notes: string
  is_recommended: boolean
  selected?: boolean // чи вибрано цей варіант для перенесення в замовлення
}

interface DraftItem {
  id?: string
  name: string
  sku: string
  qty: string
  sell_price: string
  is_draft_note: boolean   // true = просто нотатка без ціни
  variants: Variant[]
  expanded: boolean
}

interface Vehicle {
  id: string; brand: string; model: string; year: number | null; vin: string | null
}

interface CustomerOption {
  id: string; phone: string; full_name: string | null
}

interface Product {
  id: string
  sku: string
  name: string
  barcode: string | null
  retail_price: number
  qty_on_hand: number
  storage_bin: string | null
}

const EMPTY_ITEM: DraftItem = {
  name: '', sku: '', qty: '1', sell_price: '0',
  is_draft_note: true, variants: [], expanded: false,
}

const EMPTY_VARIANT: Variant = {
  brand: '', price: '0', notes: '', is_recommended: false, selected: false
}

// ─── Компонент позиції чернетки ──────────────────────────────────────────────
function DraftItemRow({
  item, idx, onChange, onRemove
}: {
  item: DraftItem
  idx: number
  onChange: (idx: number, updated: DraftItem) => void
  onRemove: (idx: number) => void
}) {
  function update(patch: Partial<DraftItem>) {
    onChange(idx, { ...item, ...patch })
  }

  function addVariant() {
    update({ variants: [...item.variants, { ...EMPTY_VARIANT, selected: item.variants.length === 0 }], expanded: true })
  }

  function updateVariant(vi: number, patch: Partial<Variant>) {
    let variants = item.variants.map((v, i) => i === vi ? { ...v, ...patch } : v)
    if (patch.selected) {
      // Маркуємо інші варіанти як невибрані
      variants = variants.map((v, i) => i === vi ? v : { ...v, selected: false })
    }
    onChange(idx, { ...item, variants })
  }

  function removeVariant(vi: number) {
    update({ variants: item.variants.filter((_, i) => i !== vi) })
  }

  function toggleRecommended(vi: number) {
    const variants = item.variants.map((v, i) => ({ ...v, is_recommended: i === vi ? !v.is_recommended : false }))
    onChange(idx, { ...item, variants })
  }

  return (
    <div className="border border-gray-700 rounded-xl overflow-hidden shadow-sm bg-gray-800 text-white mb-2">
      {/* Шапка/ Desktop рядок */}
      <div className="flex flex-col md:flex-row md:items-center gap-2 px-3 py-2 bg-gray-750 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <span className="text-gray-400 text-xs font-mono w-5 text-center">{idx + 1}</span>
          <input
            placeholder="Назва запчастини..."
            value={item.name}
            onChange={(e) => update({ name: e.target.value })}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs focus:outline-none text-white w-48"
          />
        </div>

        <div className="flex items-center gap-2 justify-between flex-1">
          <input
            placeholder="Артикул"
            value={item.sku}
            onChange={(e) => update({ sku: e.target.value })}
            className="w-24 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs text-center font-mono focus:outline-none text-white"
          />

          <input
            type="number" min="1"
            value={item.qty}
            onChange={(e) => update({ qty: e.target.value })}
            className="w-10 bg-gray-900 border border-gray-700 rounded-lg px-1.5 py-1 text-xs text-center focus:outline-none text-white"
          />

          {item.is_draft_note ? (
            <button
              onClick={() => update({ is_draft_note: false })}
              className="text-[10px] text-yellow-400 border border-dashed border-yellow-500/50 rounded px-2 py-1 hover:bg-yellow-500/10 transition-colors"
            >
              + ціна
            </button>
          ) : (
            <div className="flex items-center gap-0.5">
              <input
                type="number" min="0" step="0.01"
                value={item.sell_price}
                onChange={(e) => update({ sell_price: e.target.value })}
                className="w-16 bg-gray-900 border border-gray-700 rounded-lg px-1.5 py-1 text-xs text-right focus:outline-none text-white"
              />
              <span className="text-[10px] text-gray-400">₴</span>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => update({ expanded: !item.expanded })}
              className={`px-1.5 py-1 rounded text-[10px] font-medium transition-colors ${
                item.variants.length > 0
                  ? 'bg-yellow-900/60 text-yellow-300'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              {item.variants.length > 0 ? `${item.variants.length} вар.` : '+ вар.'}
            </button>

            <button onClick={() => onRemove(idx)} className="text-gray-400 hover:text-red-400">
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* Варіанти */}
      {item.expanded && (
        <div className="bg-gray-900/40 p-3 border-t border-gray-700 space-y-2">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Варіанти брендів:</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<Plus size={10} />}
              onClick={addVariant}
            >
              Додати варіант
            </Button>
          </div>

          {item.variants.length === 0 && (
            <p className="text-[11px] text-gray-500 py-1.5 text-center">Немає варіантів. Додайте вручну або знайдіть у каталозі.</p>
          )}

          {item.variants.map((v, vi) => (
            <div key={vi} className="grid grid-cols-[20px_1fr_90px_20px_20px] gap-2 items-center bg-gray-800/80 p-2 rounded-lg border border-gray-750">
              {/* Radio button для вибору */}
              <input
                type="radio"
                name={`item-variant-${idx}`}
                checked={!!v.selected}
                onChange={() => updateVariant(vi, { selected: true })}
                className="w-3.5 h-3.5 accent-yellow-500"
              />
              
              <input
                placeholder="Виробник / Бренд"
                value={v.brand}
                onChange={(e) => updateVariant(vi, { brand: e.target.value })}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white"
              />

              <div className="flex items-center gap-0.5">
                <input
                  type="number" min="0" step="0.01"
                  placeholder="Ціна"
                  value={v.price}
                  onChange={(e) => updateVariant(vi, { price: e.target.value })}
                  className="w-16 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-right text-white"
                />
                <span className="text-[10px] text-gray-400">₴</span>
              </div>

              <button
                type="button"
                onClick={() => toggleRecommended(vi)}
                className={`p-1 rounded transition-colors ${v.is_recommended ? 'text-yellow-400' : 'text-gray-500 hover:text-gray-400'}`}
              >
                <Star size={12} fill={v.is_recommended ? 'currentColor' : 'none'} />
              </button>

              <button type="button" onClick={() => removeVariant(vi)} className="text-gray-500 hover:text-red-400 p-1">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Основний екран ──────────────────────────────────────────────────────────
export default function QuoteEditorPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const isNew = !id

  const [order, setOrder] = useState<CustomerOrder | null>(null)
  const [loading, setLoading] = useState(!isNew)

  // Робочий режим: чернетка або пряме замовлення
  const [mode, setMode] = useState<'draft' | 'direct'>('draft')

  // Клієнт
  const [customerId, setCustomerId] = useState(searchParams.get('customer_id') ?? '')
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerOptions, setCustomerOptions] = useState<CustomerOption[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null)

  // Авто
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [selectedVehicleId, setSelectedVehicleId] = useState('')
  const [vehicleVin, setVehicleVin] = useState('')
  const [vehicleMake, setVehicleMake] = useState('')
  const [vehicleModel, setVehicleModel] = useState('')
  const [vehicleYear, setVehicleYear] = useState('')
  const [vehicleLicensePlate, setVehicleLicensePlate] = useState('')

  // Сортований пошук деталей (Каталог)
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogResults, setCatalogResults] = useState<Product[]>([])
  const [searchingCatalog, setSearchingCatalog] = useState(false)
  const [analogs, setAnalogs] = useState<Record<string, Product[]>>({})

  // Позиції
  const [items, setItems] = useState<DraftItem[]>([{ ...EMPTY_ITEM, name: '' }])
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [sendingTg, setSendingTg] = useState(false)

  // Сканер штрихкоду
  const [scanMode, setScanMode] = useState(false)
  const [scanInput, setScanInput] = useState('')
  const scanRef = useRef<HTMLInputElement>(null)

  const nameRef = useRef<HTMLInputElement>(null)

  // Відображення модалки для конвертації
  const [showConvertModal, setShowConvertModal] = useState(false)

  // Завантаження існуючого замовлення
  useEffect(() => {
    if (!id) return
    orderApi.get(id).then((res) => {
      const o = (res as any).data as CustomerOrder
      setOrder(o)
      setComment(o.comment ?? '')
      
      // Якщо це не чернетка, переводимо в режим direct
      if ((o.status as string) !== 'lead' && (o.status as string) !== 'quoted') {
        setMode('direct')
      }

      if (o.customer) {
        setSelectedCustomer({ id: o.customer.id, phone: o.customer.phone ?? '', full_name: o.customer.full_name ?? null })
        setCustomerId(o.customer.id)
        setCustomerSearch(o.customer.full_name ?? o.customer.phone ?? '')
      }
      if (o.vehicle_info) {
        const v = o.vehicle_info as any
        setVehicleMake(v.make ?? '')
        setVehicleModel(v.model ?? '')
        setVehicleYear(v.year ? String(v.year) : '')
        setVehicleVin(v.vin ?? '')
        setVehicleLicensePlate(v.license_plate ?? '')
      }
      // Конвертуємо позиції
      setItems(o.items.map((i: any) => ({
        id: i.id,
        name: i.name,
        sku: i.sku ?? '',
        qty: String(i.qty),
        sell_price: String((i.sell_price / 100).toFixed(2)),
        is_draft_note: i.is_draft_note ?? false,
        variants: (i.variants ?? []).map((v: any) => ({
          brand: v.brand,
          price: String((v.price / 100).toFixed(2)),
          notes: v.notes ?? '',
          is_recommended: v.is_recommended ?? false,
          selected: v.selected ?? false
        })),
        expanded: (i.variants?.length ?? 0) > 0,
      })))
      setLoading(false)
    }).catch(() => { toast.error('Не вдалось завантажити'); navigate('/orders') })
  }, [id, navigate])

  // Якщо customer_id у рядку запиту
  useEffect(() => {
    const cid = searchParams.get('customer_id')
    if (!cid) return
    customerApi.get(cid).then((r) => {
      const c = (r as any).data
      setSelectedCustomer({ id: c.id, phone: c.phone, full_name: c.full_name })
      setCustomerId(c.id)
      setCustomerSearch(c.full_name ?? c.phone)
    }).catch(() => {})
  }, [searchParams])

  // Завантаження автомобілів клієнта
  useEffect(() => {
    if (!customerId) { setVehicles([]); return }
    customerVehiclesApi.list(customerId).then((r) => setVehicles((r as any).data ?? [])).catch(() => {})
  }, [customerId])

  // Пошук клієнта
  useEffect(() => {
    if (customerSearch.trim().length < 2) { setCustomerOptions([]); return }
    const t = setTimeout(() => {
      customerApi.list({ search: customerSearch.trim(), per_page: 6 })
        .then((r) => setCustomerOptions((r as any).data ?? []))
        .catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [customerSearch])

  function selectCustomer(c: CustomerOption) {
    setSelectedCustomer(c)
    setCustomerId(c.id)
    setCustomerSearch(c.full_name ?? c.phone)
    setCustomerOptions([])
  }

  // Сканування картки клієнта
  async function handleBarcodeScan(code: string) {
    setScanInput('')
    setScanMode(false)
    try {
      const res = await api.get<any>(`/api/v1/search/barcode/${code}`)
      const result = (res as any).data
      if (result?.type === 'customer') {
        const c = result.data
        selectCustomer({ id: c.id, phone: c.phone, full_name: c.full_name })
        toast.success(`Клієнт знайдений: ${c.full_name ?? c.phone}`)
      } else {
        toast.warning('Клієнта не знайдено')
      }
    } catch { toast.error('Помилка сканування') }
  }

  // Вибір авто зі списку
  function handleVehicleSelect(vehicleId: string) {
    setSelectedVehicleId(vehicleId)
    const v = vehicles.find((v) => v.id === vehicleId)
    if (v) {
      setVehicleMake(v.brand)
      setVehicleModel(v.model)
      setVehicleYear(v.year ? String(v.year) : '')
      setVehicleVin(v.vin ?? '')
    }
  }

  // Пошук деталей у Каталозі
  async function handleCatalogSearch() {
    if (!catalogQuery.trim()) return
    setSearchingCatalog(true)
    try {
      // Гібридний пошук: і власний склад, і чорнова номенклатура (прайси постачальників)
      const { data } = await api.get<{ data: { warehouse: Product[]; supplier_catalog: any[] } }>(
        `/api/v1/search/hybrid?q=${encodeURIComponent(catalogQuery.trim())}&limit=20`,
      )
      // Склад: спершу те, що в наявності
      const warehouse = (data?.warehouse ?? []).sort((a, b) => {
        return (b.qty_on_hand > 0 ? 1 : 0) - (a.qty_on_hand > 0 ? 1 : 0)
      })
      // Каталог-підказки (замовні) — у вигляді Product-подібних позицій, в кінці списку
      const catalog = (data?.supplier_catalog ?? []).map((s: any) => ({
        id: `catalog:${s.id}`,
        name: s.name,
        sku: s.sku ?? '',
        retail_price: s.price_kopecks ?? 0,
        qty_on_hand: 0,
        storage_bin: null,
      } as unknown as Product))
      setCatalogResults([...warehouse, ...catalog])
    } catch {
      toast.error('Помилка пошуку деталей')
    } finally {
      setSearchingCatalog(false)
    }
  }

  // Отримання аналогів для конкретної деталі
  async function loadAnalogs(productId: string) {
    if (productId.startsWith('catalog:')) return  // замовні позиції аналогів не мають
    try {
      const { data } = await api.get<any>(`/api/v1/products/${productId}/analogs`)
      const list = Array.isArray(data) ? data : data?.analogs ?? data?.data ?? []
      setAnalogs((prev) => ({ ...prev, [productId]: list }))
    } catch {
      toast.error('Не вдалось завантажити аналоги')
    }
  }

  // Додати товар з каталогу безпосередньо в замовлення/чернетку
  function addProductToWorkspace(product: Product, toPositionIdx?: number) {
    if (mode === 'direct') {
      // Пряме додавання в замовлення
      const newItem: DraftItem = {
        name: product.name,
        sku: product.sku,
        qty: '1',
        sell_price: String((product.retail_price / 100).toFixed(2)),
        is_draft_note: false,
        variants: [],
        expanded: false
      }
      
      setItems((prev) => {
        const filtered = prev.filter((i) => i.name.trim() !== '')
        return [...filtered, newItem]
      })
      toast.success(`Додано в замовлення: ${product.name}`)
    } else {
      // Додавання як варіант до чернетки
      if (toPositionIdx !== undefined && items[toPositionIdx]) {
        // Додаємо варіант до існуючої позиції чернетки
        const target = items[toPositionIdx]
        const newVariant: Variant = {
          brand: product.sku.split('-')[0] || 'Каталог',
          price: String((product.retail_price / 100).toFixed(2)),
          notes: product.storage_bin ? `Склад ячейка: ${product.storage_bin}` : '',
          is_recommended: false,
          selected: target.variants.length === 0
        }
        
        const updated = {
          ...target,
          variants: [...target.variants, newVariant],
          expanded: true
        }
        setItems((prev) => prev.map((v, j) => j === toPositionIdx ? updated : v))
        toast.success(`Додано варіант до позиції №${toPositionIdx + 1}`)
      } else {
        // Створюємо нову позицію чернетки з цим першим варіантом
        const newItem: DraftItem = {
          name: product.name,
          sku: product.sku,
          qty: '1',
          sell_price: '0',
          is_draft_note: true,
          variants: [{
            brand: product.sku.split('-')[0] || 'Каталог',
            price: String((product.retail_price / 100).toFixed(2)),
            notes: product.storage_bin ? `Ячейка: ${product.storage_bin}` : '',
            is_recommended: true,
            selected: true
          }],
          expanded: true
        }
        setItems((prev) => {
          const filtered = prev.filter((i) => i.name.trim() !== '')
          return [...filtered, newItem]
        })
        toast.success(`Створено нову позицію з варіантом: ${product.name}`)
      }
    }
  }

  function addItem() {
    setItems((prev) => [...prev, { ...EMPTY_ITEM, name: '' }])
    setTimeout(() => nameRef.current?.focus(), 50)
  }

  const vehicleInfo = (vehicleMake || vehicleModel || vehicleVin || vehicleLicensePlate)
    ? { 
        make: vehicleMake || undefined, 
        model: vehicleModel || undefined, 
        year: vehicleYear ? parseInt(vehicleYear) : undefined, 
        vin: vehicleVin || undefined,
        license_plate: vehicleLicensePlate || undefined 
      }
    : null

  function buildPayload() {
    return {
      customer_id: customerId || null,
      vehicle_info: vehicleInfo,
      comment: comment.trim() || null,
      items: items
        .filter((i) => i.name.trim())
        .map((i) => ({
          name: i.name.trim(),
          sku: i.sku.trim() || null,
          qty: parseInt(i.qty) || 1,
          sell_price: i.is_draft_note ? 0 : Math.round(parseFloat(i.sell_price || '0') * 100),
          buy_price: 0,
          source_type: 'supplier' as const,
          is_draft_note: i.is_draft_note,
          variants: i.variants.map((v) => ({
            brand: v.brand,
            price: Math.round(parseFloat(v.price || '0') * 100),
            notes: v.notes || null,
            is_recommended: v.is_recommended,
            selected: v.selected || false
          })),
        })),
    }
  }

  async function handleSave() {
    if (!items.some((item) => item.name.trim())) {
      toast.error('Додайте хоча б одну позицію з назвою')
      nameRef.current?.focus()
      return
    }
    setSaving(true)
    try {
      const payload = buildPayload()
      if (isNew) {
        // Створення нового запису
        const res = await orderApi.create({ 
          ...payload, 
          source: 'walk_in',
          prepayment: 0 
        })
        const newId = (res as any).data.id
        toast.success(mode === 'direct' ? 'Замовлення створено' : 'Чернетку збережено')
        navigate('/quotes/' + newId, { replace: true })
      } else {
        // Збереження змін
        await api.put(`/api/v1/customer-orders/${id}/draft`, payload)
        toast.success('Зміни збережено!')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка збереження')
    } finally { setSaving(false) }
  }

  async function handleSendTelegram() {
    if (!id) { toast.error('Спочатку збережіть чернетку'); return }
    setSendingTg(true)
    try {
      await api.post(`/api/v1/customer-orders/${id}/send-telegram`, {})
      toast.success('КП успішно відправлено в Telegram!')
    } catch (e: any) {
      const msg = e.message ?? 'Помилка'
      if (msg.includes('NO_TELEGRAM')) {
        toast.error('У клієнта немає Telegram-акаунта в системі')
      } else {
        toast.error(msg)
      }
    } finally { setSendingTg(false) }
  }

  // Конвертація чернетки в замовлення з відправкою на бэкенд
  async function handleConvertSubmit() {
    if (!id) return
    
    // Перевіряємо чи всі позиції з варіантами мають обраний варіант
    const payloadItems = items
      .filter((i) => i.name.trim())
      .map((item) => {
        const selected = item.variants.find((v) => v.selected)
        if (item.variants.length > 0 && !selected) {
          return null
        }
        return {
          item_id: item.id!,
          selected_variant: selected
            ? {
                brand: selected.brand,
                price: Math.round(parseFloat(selected.price) * 100),
                sku: item.sku || null,
                product_id: null
              }
            : {
                brand: null,
                price: Math.round(parseFloat(item.sell_price || '0') * 100),
                sku: item.sku || null,
                product_id: null
              }
        }
      })

    if (payloadItems.includes(null)) {
      toast.error('Будь ласка, оберіть бренд для кожної позиції в чернечці')
      return
    }

    try {
      const res = await api.post(`/api/v1/customer-orders/${id}/convert`, {
        items: payloadItems
      })
      const newOrderId = (res as any).data.id
      toast.success('Чернетку успішно конвертовано в замовлення!')
      setShowConvertModal(false)
      navigate('/orders/' + newOrderId)
    } catch (e: any) {
      toast.error(e.message ?? 'Помилка конвертації')
    }
  }

  const totalItems = items.filter((i) => i.name.trim())
  const hasVariants = totalItems.some((i) => i.variants.length > 0)

  if (loading) {
    return <Layout title="Завантаження..."><div className="flex items-center justify-center h-64 text-gray-400">Завантаження...</div></Layout>
  }

  return (
    <Layout
      title={order?.kp_number ? `Робота з ${order.kp_number}` : 'Робочий стіл менеджера подбору'}
      onBack={() => navigate('/orders')}
    >
      <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-start">
        
        {/* ЛЕВА КОЛОНКА (3 cols): Клієнт та Авто */}
        <div className="md:col-span-3 space-y-4">
          
          {/* Картка клієнта */}
          <Card>
            <div className="flex items-center justify-between mb-4 border-b border-gray-700 pb-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Клієнт</h3>
              <button
                onClick={() => { setScanMode(true); setTimeout(() => scanRef.current?.focus(), 100) }}
                className="flex items-center gap-1 text-[10px] text-yellow-500 hover:text-yellow-400 font-medium"
              >
                <ScanLine size={13} /> Картка
              </button>
            </div>

            {scanMode && (
              <div className="mb-3 flex gap-2 items-center bg-gray-900 border border-gray-700 rounded-lg px-2 py-1">
                <ScanLine size={14} className="text-yellow-500 shrink-0" />
                <input
                  ref={scanRef}
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && scanInput.trim()) handleBarcodeScan(scanInput.trim()) }}
                  placeholder="Код картки..."
                  className="flex-1 bg-transparent text-xs focus:outline-none text-white"
                />
              </div>
            )}

            <div className="relative">
              <Input
                label="Пошук клієнта"
                value={customerSearch}
                onChange={(e) => {
                  setCustomerSearch(e.target.value)
                  if (!e.target.value) { setCustomerId(''); setSelectedCustomer(null) }
                }}
                placeholder="Ім'я або телефон..."
              />
              {customerOptions.length > 0 && (
                <div className="absolute z-20 top-full mt-1 w-full bg-gray-900 border border-gray-700 rounded-xl shadow-lg overflow-hidden">
                  {customerOptions.map((c) => (
                    <button key={c.id} type="button" onClick={() => selectCustomer(c)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-800 text-xs border-b border-gray-850 last:border-0 text-white">
                      <div className="font-semibold">{c.full_name ?? 'Без імені'}</div>
                      <div className="text-gray-400 text-[10px]">{c.phone}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedCustomer && (
              <div className="mt-3 bg-gray-900/60 p-2 rounded-lg border border-gray-700">
                <p className="text-xs font-semibold text-green-400 flex items-center gap-1.5">
                  <User size={13} />
                  {selectedCustomer.full_name ?? selectedCustomer.phone}
                </p>
                {selectedCustomer.full_name && <p className="text-[10px] text-gray-500 mt-0.5">{selectedCustomer.phone}</p>}
              </div>
            )}
          </Card>

          {/* Гараж автомобілів */}
          <Card>
            <div className="flex items-center gap-2 mb-3 border-b border-gray-700 pb-2">
              <Car size={14} className="text-gray-400" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Автомобіль</h3>
            </div>

            {vehicles.length > 0 && (
              <div className="mb-3">
                <select
                  value={selectedVehicleId}
                  onChange={(e) => handleVehicleSelect(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none"
                >
                  <option value="">— Гараж клієнта —</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.brand} {v.model} {v.year ? `(${v.year})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-2.5">
              <Input label="Марка" value={vehicleMake} onChange={(e) => setVehicleMake(e.target.value)} placeholder="Toyota" />
              <Input label="Модель" value={vehicleModel} onChange={(e) => setVehicleModel(e.target.value)} placeholder="Camry" />
              <Input label="Рік" type="number" value={vehicleYear} onChange={(e) => setVehicleYear(e.target.value)} placeholder="2018" />
              <Input label="VIN-код" value={vehicleVin} onChange={(e) => setVehicleVin(e.target.value.toUpperCase())} placeholder="JTDK..." />
              <Input label="Держномер" value={vehicleLicensePlate} onChange={(e) => setVehicleLicensePlate(e.target.value.toUpperCase())} placeholder="AA1111AA" />
            </div>
          </Card>
        </div>

        {/* ЦЕНТРАЛЬНА КОЛОНКА (4 cols): Пошук запчастини в Каталозі */}
        <div className="md:col-span-4 space-y-4">
          <Card>
            <div className="flex items-center gap-2 mb-3 border-b border-gray-700 pb-2">
              <Search size={14} className="text-gray-400" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Каталог деталей</h3>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={catalogQuery}
                onChange={(e) => setCatalogQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCatalogSearch() }}
                placeholder="Шукати за артикулом / назвою..."
                className="flex-1 bg-gray-900 border border-gray-700 text-white text-xs rounded-lg px-3 py-2 
                           focus:outline-none focus:border-yellow-500"
              />
              <Button onClick={handleCatalogSearch} loading={searchingCatalog} size="sm">
                Пошук
              </Button>
            </div>

            <div className="mt-4 space-y-2 max-h-[500px] overflow-y-auto pr-1">
              {catalogResults.length === 0 && !searchingCatalog && (
                <div className="text-center py-8 text-gray-500 text-xs">
                  Введіть OEM або артикул деталі для пошуку
                </div>
              )}

              {catalogResults.map((product) => {
                const isLocalStock = product.qty_on_hand > 0
                return (
                  <div key={product.id} className={`p-2.5 rounded-lg border text-xs transition-colors ${
                    isLocalStock ? 'bg-green-950/40 border-green-900/60' : 'bg-gray-900 border-gray-750'
                  }`}>
                    <div className="flex justify-between items-start gap-1">
                      <div>
                        <div className="font-semibold text-white">{product.name}</div>
                        <div className="text-[10px] text-gray-400 mt-0.5">Арт: {product.sku}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-yellow-400">{formatMoney(product.retail_price)} ₴</div>
                        {isLocalStock ? (
                          <div className="text-[10px] text-green-400 font-medium">В наявності: {product.qty_on_hand} шт</div>
                        ) : (
                          <div className="text-[10px] text-gray-500">Під замовлення</div>
                        )}
                      </div>
                    </div>

                    <div className="flex justify-between items-center mt-2 pt-2 border-t border-gray-800">
                      <div>
                        {product.storage_bin && (
                          <span className="text-[9px] bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded flex items-center gap-0.5 w-max">
                            <MapPin size={9} /> {product.storage_bin}
                          </span>
                        )}
                      </div>
                      
                      <div className="flex gap-1">
                        {/* Кнопка аналогів */}
                        <button
                          type="button"
                          onClick={() => loadAnalogs(product.id)}
                          className="px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-[10px] rounded text-gray-300"
                        >
                          Аналоги
                        </button>
                        
                        {/* Додавання до КП як варіант */}
                        {mode === 'draft' && items.length > 0 && (
                          <select
                            onChange={(e) => {
                              if (e.target.value !== '') {
                                addProductToWorkspace(product, parseInt(e.target.value))
                                e.target.value = ''
                              }
                            }}
                            className="bg-yellow-600 hover:bg-yellow-500 text-white font-medium text-[10px] px-1.5 py-0.5 rounded cursor-pointer outline-none"
                          >
                            <option value="">+ варіант</option>
                            {items.map((_, i) => (
                              <option key={i} value={i}>Поз. {i + 1}</option>
                            ))}
                          </select>
                        )}

                        <button
                          type="button"
                          onClick={() => addProductToWorkspace(product)}
                          className="px-2 py-0.5 bg-yellow-600 hover:bg-yellow-500 text-white text-[10px] rounded font-medium"
                        >
                          {mode === 'direct' ? '+ додати' : '+ нова поз.'}
                        </button>
                      </div>
                    </div>

                    {/* Показ аналогів */}
                    {analogs[product.id] && (
                      <div className="mt-2.5 pt-2 border-t border-dashed border-gray-700 bg-gray-950/20 p-1.5 rounded-lg space-y-1">
                        <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1">Аналоги / Кросси:</div>
                        {analogs[product.id].length === 0 && <div className="text-[10px] text-gray-500">Аналогів не знайдено</div>}
                        {analogs[product.id].map((an) => (
                          <div key={an.id} className="flex justify-between items-center py-1 border-b border-gray-850/50 last:border-0 text-[10px]">
                            <span className="text-gray-300">{an.name} ({an.sku.split('-')[0]})</span>
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-yellow-400">{formatMoney(an.retail_price)} ₴</span>
                              <button
                                onClick={() => addProductToWorkspace(an)}
                                className="bg-gray-800 hover:bg-gray-700 text-white px-1.5 py-0.5 rounded text-[9px]"
                              >
                                Додати
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
        </div>

        {/* ПРАВА КОЛОНКА (5 cols): Чернетка або пряме замовлення */}
        <div className="md:col-span-5 space-y-4">
          <Card>
            <div className="flex items-center justify-between mb-4 border-b border-gray-700 pb-3">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setMode('draft')}
                  className={`px-3 py-1 text-xs rounded-lg font-semibold transition-colors ${
                    mode === 'draft'
                      ? 'bg-yellow-600 text-white'
                      : 'bg-gray-900 text-gray-400 border border-gray-750 hover:bg-gray-800'
                  }`}
                >
                  Чернетка (КП)
                </button>
                <button
                  type="button"
                  onClick={() => setMode('direct')}
                  className={`px-3 py-1 text-xs rounded-lg font-semibold transition-colors ${
                    mode === 'direct'
                      ? 'bg-yellow-600 text-white'
                      : 'bg-gray-900 text-gray-400 border border-gray-750 hover:bg-gray-800'
                  }`}
                >
                  Пряме Замовлення
                </button>
              </div>

              <Button type="button" variant="secondary" size="sm" icon={<Plus size={12} />} onClick={addItem}>
                Додати поз.
              </Button>
            </div>

            <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
              {items.map((item, idx) => (
                <DraftItemRow
                  key={idx}
                  item={item}
                  idx={idx}
                  onChange={(i, updated) => setItems((prev) => prev.map((v, j) => j === i ? updated : v))}
                  onRemove={(i) => setItems((prev) => prev.filter((_, j) => j !== i))}
                />
              ))}
            </div>

            {totalItems.length > 0 && (
              <div className="mt-4 pt-3 border-t border-gray-700 text-xs text-gray-400 flex justify-between items-center">
                <span>{totalItems.length} позицій {mode === 'draft' && hasVariants ? `· ${totalItems.filter(i => i.variants.length > 0).length} з варіантами` : ''}</span>
                {mode === 'direct' && (
                  <span className="text-white font-bold text-sm">
                    Разом: {formatMoney(totalItems.reduce((acc, it) => acc + (parseFloat(it.sell_price) * parseInt(it.qty) * 100), 0))} ₴
                  </span>
                )}
              </div>
            )}
          </Card>

          {/* Нотатки */}
          <Card>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">Коментар менеджера</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Деталі розмови, зауваження до підбору..."
              rows={3}
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-yellow-500 text-white resize-none"
            />
          </Card>

          {/* Панель Дій */}
          <div className="flex gap-2 justify-end flex-wrap">
            <Button
              variant="secondary"
              icon={<Copy size={14} />}
              onClick={() => {
                const cust = selectedCustomer?.full_name || customerSearch
                const veh = [vehicleMake, vehicleModel, vehicleYear].filter(Boolean).join(' ')
                const lines = ['Комерційна пропозиція']
                if (cust) lines.push('Клієнт: ' + cust)
                if (veh || vehicleVin) lines.push('Авто: ' + veh + (vehicleVin ? ` (${vehicleVin})` : ''))
                lines.push('')
                let total = 0
                totalItems.forEach((it, i) => {
                  const qty = parseInt(it.qty) || 1
                  const price = parseFloat(it.sell_price) || 0
                  total += qty * price
                  lines.push(`${i + 1}. ${it.name} — ${qty} шт` + (price > 0 ? ` × ${price.toFixed(2)} = ${(qty * price).toFixed(2)} грн` : ''))
                })
                lines.push('', `Разом: ${total.toFixed(2)} грн`)
                if (comment.trim()) lines.push('', comment.trim())
                navigator.clipboard.writeText(lines.join('\n'))
                  .then(() => toast.success('КП скопійовано — вставте в месенджер'))
                  .catch(() => toast.error('Не вдалося скопіювати'))
              }}
            >
              Скопіювати текстом
            </Button>
            {!isNew && mode === 'draft' && (
              <Button
                variant="secondary"
                icon={<Send size={14} />}
                onClick={handleSendTelegram}
                loading={sendingTg}
              >
                КП в Telegram
              </Button>
            )}
            {!isNew && mode === 'draft' && (
              <Button
                variant="secondary"
                icon={<ArrowRight size={14} />}
                onClick={() => setShowConvertModal(true)}
              >
                Конвертувати в замовлення
              </Button>
            )}
            <Button icon={<Save size={14} />} onClick={handleSave} loading={saving}>
              {isNew ? (mode === 'direct' ? 'Створити замовлення' : 'Зберегти чернетку') : 'Зберегти зміни'}
            </Button>
          </div>
        </div>

      </div>

      {/* Модалка вибору варіантів при конвертації чернетки */}
      {showConvertModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] p-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 w-full max-w-lg shadow-2xl">
            <h3 className="text-white font-semibold text-sm mb-2">Підтвердження вибору брендів</h3>
            <p className="text-xs text-gray-400 mb-4">Будь ласка, вкажіть бренд для кожної позиції чернетки перед створенням замовлення:</p>

            <div className="space-y-4 max-h-[350px] overflow-y-auto pr-1 mb-5">
              {items.filter((i) => i.name.trim()).map((item, idx) => {
                return (
                  <div key={idx} className="bg-gray-900 p-3 rounded-lg border border-gray-700 text-xs">
                    <div className="font-semibold text-white mb-2">{idx + 1}. {item.name}</div>
                    
                    {item.variants.length === 0 ? (
                      <div className="flex justify-between items-center text-gray-400">
                        <span>За замовчуванням (без брендів)</span>
                        <span className="font-bold text-yellow-400">{item.sell_price} ₴</span>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {item.variants.map((v, vi) => (
                          <label key={vi} className="flex items-center justify-between p-2 rounded bg-gray-800 hover:bg-gray-750 cursor-pointer">
                            <div className="flex items-center gap-2">
                              <input
                                type="radio"
                                name={`convert-variant-${idx}`}
                                checked={!!v.selected}
                                onChange={() => {
                                  const updatedVariants = item.variants.map((v2, i2) => i2 === vi ? { ...v2, selected: true } : { ...v2, selected: false })
                                  setItems((prev) => prev.map((it, j) => j === idx ? { ...it, variants: updatedVariants } : it))
                                }}
                                className="w-3.5 h-3.5 accent-yellow-500"
                              />
                              <span className="text-white font-medium">{v.brand}</span>
                              {v.notes && <span className="text-[10px] text-gray-500">· {v.notes}</span>}
                            </div>
                            <span className="font-bold text-yellow-400">{v.price} ₴</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowConvertModal(false)}
                className="flex-1"
              >
                Скасувати
              </Button>
              <Button
                type="button"
                onClick={handleConvertSubmit}
                className="flex-1 bg-green-600 hover:bg-green-500 text-white"
              >
                Створити замовлення
              </Button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
