import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Plus, Trash2, Send, ChevronDown, ChevronUp,
  Star, Car, User, Save, ArrowRight, ScanLine,
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

const EMPTY_ITEM: DraftItem = {
  name: '', sku: '', qty: '1', sell_price: '0',
  is_draft_note: true, variants: [], expanded: false,
}

const EMPTY_VARIANT: Variant = {
  brand: '', price: '0', notes: '', is_recommended: false,
}

// ─── Компонент позиції ────────────────────────────────────────────────────────
function DraftItemRow({
  item, idx, onChange, onRemove,
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
    update({ variants: [...item.variants, { ...EMPTY_VARIANT }], expanded: true })
  }

  function updateVariant(vi: number, patch: Partial<Variant>) {
    const variants = item.variants.map((v, i) => i === vi ? { ...v, ...patch } : v)
    onChange(idx, { ...item, variants })
  }

  function removeVariant(vi: number) {
    update({ variants: item.variants.filter((_, i) => i !== vi) })
  }

  function toggleRecommended(vi: number) {
    const variants = item.variants.map((v, i) => ({ ...v, is_recommended: i === vi ? !v.is_recommended : false }))
    onChange(idx, { ...item, variants })
  }

  const bestPrice = item.variants.length > 0
    ? Math.min(...item.variants.map((v) => parseFloat(v.price || '0')))
    : parseFloat(item.sell_price || '0')

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      {/* Основна стрічка позиції */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-white">
        <span className="text-gray-400 text-sm font-mono w-6 shrink-0 text-center">{idx + 1}</span>

        <input
          placeholder="Назва деталі..."
          value={item.name}
          onChange={(e) => update({ name: e.target.value })}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
        />

        <input
          placeholder="Арт."
          value={item.sku}
          onChange={(e) => update({ sku: e.target.value })}
          className="w-28 border border-gray-200 rounded-lg px-2 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-yellow-300"
        />

        <input
          type="number" min="1"
          value={item.qty}
          onChange={(e) => update({ qty: e.target.value })}
          className="w-14 border border-gray-200 rounded-lg px-2 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-yellow-300"
        />

        {/* Ціна або "нотатка" */}
        {item.is_draft_note ? (
          <button
            onClick={() => update({ is_draft_note: false })}
            className="w-28 text-center text-xs text-gray-400 border border-dashed border-gray-300 rounded-lg px-2 py-2 hover:border-yellow-400 hover:text-yellow-600 transition-colors"
          >
            + ціна
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <input
              type="number" min="0" step="0.01"
              value={item.sell_price}
              onChange={(e) => update({ sell_price: e.target.value })}
              className="w-24 border border-gray-200 rounded-lg px-2 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-yellow-300"
            />
            <span className="text-xs text-gray-400">₴</span>
          </div>
        )}

        {/* Кнопка варіантів */}
        <button
          onClick={() => update({ expanded: !item.expanded })}
          className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            item.variants.length > 0
              ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
              : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
          }`}
        >
          {item.variants.length > 0 ? `${item.variants.length} вар.` : '+ вар.'}
          {item.expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>

        {bestPrice > 0 && item.variants.length > 0 && (
          <span className="text-xs font-semibold text-green-600 w-20 text-right shrink-0">
            від {formatMoney(Math.round(bestPrice * 100))}
          </span>
        )}

        <button onClick={() => onRemove(idx)} className="text-gray-300 hover:text-red-400 shrink-0">
          <Trash2 size={16} />
        </button>
      </div>

      {/* Варіанти виробників */}
      {item.expanded && (
        <div className="bg-gray-50 border-t border-gray-200 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Варіанти виробників
            </span>
            <button
              onClick={addVariant}
              className="text-xs text-yellow-600 hover:text-yellow-700 font-medium flex items-center gap-1"
            >
              <Plus size={13} /> Додати варіант
            </button>
          </div>

          {item.variants.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-2">
              Натисніть "+ Додати варіант" щоб запропонувати клієнту кілька варіантів
            </p>
          )}

          {item.variants.map((v, vi) => (
            <div key={vi} className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-gray-200">
              {/* Рекомендований */}
              <button
                onClick={() => toggleRecommended(vi)}
                title="Рекомендований варіант"
                className={v.is_recommended ? 'text-yellow-500' : 'text-gray-200 hover:text-yellow-300'}
              >
                <Star size={16} fill={v.is_recommended ? 'currentColor' : 'none'} />
              </button>

              <input
                placeholder="Виробник (Brembo, TRW...)"
                value={v.brand}
                onChange={(e) => updateVariant(vi, { brand: e.target.value })}
                className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
              />

              <div className="flex items-center gap-1">
                <input
                  type="number" min="0" step="0.01"
                  placeholder="Ціна"
                  value={v.price}
                  onChange={(e) => updateVariant(vi, { price: e.target.value })}
                  className="w-24 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-yellow-300"
                />
                <span className="text-xs text-gray-400">₴</span>
              </div>

              <input
                placeholder="Примітка..."
                value={v.notes}
                onChange={(e) => updateVariant(vi, { notes: e.target.value })}
                className="w-36 border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-yellow-300"
              />

              <button onClick={() => removeVariant(vi)} className="text-gray-300 hover:text-red-400">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Головна сторінка ─────────────────────────────────────────────────────────
export default function QuoteEditorPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const isNew = !id

  const [order, setOrder] = useState<CustomerOrder | null>(null)
  const [loading, setLoading] = useState(!isNew)

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

  // Позиції
  const [items, setItems] = useState<DraftItem[]>([{ ...EMPTY_ITEM, name: '' }])
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [sendingTg, setSendingTg] = useState(false)

  // Сканер штрихкоду (телефон картка клієнта)
  const [scanMode, setScanMode] = useState(false)
  const [scanInput, setScanInput] = useState('')
  const scanRef = useRef<HTMLInputElement>(null)

  const nameRef = useRef<HTMLInputElement>(null)

  // Завантаження існуючого замовлення
  useEffect(() => {
    if (!id) return
    orderApi.get(id).then((res) => {
      const o = (res as any).data as CustomerOrder
      setOrder(o)
      setComment(o.comment ?? '')
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
      }
      // Конвертуємо items
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
        })),
        expanded: (i.variants?.length ?? 0) > 0,
      })))
      setLoading(false)
    }).catch(() => { toast.error('Не вдалось завантажити'); navigate('/orders') })
  }, [id, navigate])

  // Якщо переданий customer_id — завантажуємо клієнта
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

  // Завантаження авто клієнта
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

  // Сканування штрихкоду картки клієнта
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
        toast.warning('Клієнта не знайдено за цим кодом')
      }
    } catch { toast.error('Помилка сканування') }
  }

  // Вибір авто зі списку → підставляємо дані
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

  function addItem() {
    setItems((prev) => [...prev, { ...EMPTY_ITEM }])
    setTimeout(() => nameRef.current?.focus(), 50)
  }

  const vehicleInfo = (vehicleMake || vehicleModel || vehicleVin)
    ? { make: vehicleMake || undefined, model: vehicleModel || undefined, year: vehicleYear ? parseInt(vehicleYear) : undefined, vin: vehicleVin || undefined }
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
          })),
        })),
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      if (isNew) {
        const result = await orderApi.create({ ...buildPayload(), source: 'walk_in' })
        const newId = (result as any).data.id
        toast.success('Чернетку збережено')
        navigate('/quotes/' + newId, { replace: true })
      } else {
        await api.put(`/api/v1/customer-orders/${id}/draft`, buildPayload())
        toast.success('Збережено')
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
      toast.success('КП відправлено в Telegram!')
    } catch (e: any) {
      const msg = e.message ?? 'Помилка'
      if (msg.includes('NO_TELEGRAM')) {
        toast.error('Клієнт не має Telegram-акаунта в системі')
      } else {
        toast.error(msg)
      }
    } finally { setSendingTg(false) }
  }

  async function handleConvertToOrder() {
    if (!id) return
    try {
      await orderApi.updateStatus(id, 'new')
      toast.success('Перенесено в замовлення!')
      navigate('/orders/' + id)
    } catch { toast.error('Помилка') }
  }

  const totalItems = items.filter((i) => i.name.trim())
  const hasVariants = totalItems.some((i) => i.variants.length > 0)

  if (loading) {
    return <Layout title="Чернетка"><div className="flex items-center justify-center h-64 text-gray-400">Завантаження...</div></Layout>
  }

  return (
    <Layout
      title={order?.kp_number ? `${order.kp_number}` : 'Нова чернетка / КП'}
      onBack={() => navigate('/orders')}
      actions={
        <div className="flex gap-2">
          {!isNew && (
            <>
              <Button
                variant="secondary"
                icon={<Send size={15} />}
                onClick={handleSendTelegram}
                loading={sendingTg}
              >
                Надіслати в TG
              </Button>
              <Button
                variant="secondary"
                icon={<ArrowRight size={15} />}
                onClick={handleConvertToOrder}
              >
                В замовлення
              </Button>
            </>
          )}
          <Button icon={<Save size={15} />} onClick={handleSave} loading={saving}>
            Зберегти
          </Button>
        </div>
      }
    >
      <div className="max-w-4xl space-y-5">

        {/* Клієнт + сканер */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-800">Клієнт</h3>
            <button
              onClick={() => { setScanMode(true); setTimeout(() => scanRef.current?.focus(), 100) }}
              className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium"
            >
              <ScanLine size={16} /> Сканувати картку
            </button>
          </div>

          {scanMode && (
            <div className="mb-4 flex gap-2 items-center bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
              <ScanLine size={18} className="text-blue-500 shrink-0" />
              <input
                ref={scanRef}
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && scanInput.trim()) handleBarcodeScan(scanInput.trim()) }}
                placeholder="Піднесіть сканер або введіть код картки..."
                className="flex-1 bg-transparent text-sm focus:outline-none text-blue-800 placeholder-blue-400"
                autoFocus
              />
              <button onClick={() => setScanMode(false)} className="text-blue-400 hover:text-blue-600 text-xs">
                Скасувати
              </button>
            </div>
          )}

          <div className="relative">
            <Input
              label="Пошук клієнта (ім'я або телефон)"
              value={customerSearch}
              onChange={(e) => {
                setCustomerSearch(e.target.value)
                if (!e.target.value) { setCustomerId(''); setSelectedCustomer(null) }
              }}
              placeholder="Введіть ім'я або телефон..."
            />
            {customerOptions.length > 0 && (
              <div className="absolute z-20 top-full mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
                {customerOptions.map((c) => (
                  <button key={c.id} type="button" onClick={() => selectCustomer(c)}
                    className="w-full text-left px-4 py-2.5 hover:bg-yellow-50 text-sm border-b border-gray-50 last:border-0">
                    <span className="font-medium text-gray-900">{c.full_name ?? '—'}</span>
                    <span className="text-gray-500 ml-2">{c.phone}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selectedCustomer && (
            <p className="mt-2 text-sm text-green-600 flex items-center gap-1.5">
              <User size={14} />
              {selectedCustomer.full_name ?? selectedCustomer.phone}
              {selectedCustomer.full_name && <span className="text-gray-400">{selectedCustomer.phone}</span>}
            </p>
          )}
        </Card>

        {/* Автомобіль */}
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Car size={16} className="text-gray-500" />
            <h3 className="font-semibold text-gray-800">Автомобіль</h3>
          </div>

          {vehicles.length > 0 && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">З гаража клієнта</label>
              <select
                value={selectedVehicleId}
                onChange={(e) => handleVehicleSelect(e.target.value)}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
              >
                <option value="">— Вибрати або ввести вручну —</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.brand} {v.model} {v.year ? `(${v.year})` : ''}{v.vin ? ` — ${v.vin}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Input label="Марка" value={vehicleMake} onChange={(e) => setVehicleMake(e.target.value)} placeholder="Toyota" />
            <Input label="Модель" value={vehicleModel} onChange={(e) => setVehicleModel(e.target.value)} placeholder="Camry" />
            <Input label="Рік" type="number" value={vehicleYear} onChange={(e) => setVehicleYear(e.target.value)} placeholder="2018" />
            <Input label="VIN" value={vehicleVin} onChange={(e) => setVehicleVin(e.target.value.toUpperCase())} placeholder="WVWZZZ..." />
          </div>
        </Card>

        {/* Список деталей */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-800">Список деталей</h3>
              <p className="text-xs text-gray-400 mt-0.5">Enter — нова позиція, ⭐ — рекомендований варіант</p>
            </div>
            <Button type="button" variant="secondary" size="sm" icon={<Plus size={14} />} onClick={addItem}>
              Додати
            </Button>
          </div>

          <div className="space-y-2">
            {/* Заголовок колонок */}
            <div className="grid grid-cols-[24px_1fr_112px_56px_112px_100px_100px_28px] gap-2 px-3 text-xs text-gray-400 font-medium hidden md:grid">
              <span>#</span>
              <span>Назва</span>
              <span>Артикул</span>
              <span>К-сть</span>
              <span>Ціна</span>
              <span>Варіанти</span>
              <span></span>
              <span></span>
            </div>

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

          {/* Підсумок */}
          {totalItems.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between text-sm text-gray-600">
              <span>{totalItems.length} позицій{hasVariants ? ` · ${totalItems.filter(i => i.variants.length > 0).length} з варіантами` : ''}</span>
            </div>
          )}
        </Card>

        {/* Коментар */}
        <Card>
          <label className="block text-sm font-medium text-gray-700 mb-2">Коментар / нотатки менеджера</label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Деталі розмови, побажання клієнта..."
            rows={3}
            className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300 resize-none"
          />
        </Card>

        {/* Дії */}
        <div className="flex gap-3 justify-end flex-wrap">
          {!isNew && (
            <Button
              variant="secondary"
              icon={<Send size={15} />}
              onClick={handleSendTelegram}
              loading={sendingTg}
            >
              Надіслати КП в Telegram
            </Button>
          )}
          {!isNew && (
            <Button variant="secondary" icon={<ArrowRight size={15} />} onClick={handleConvertToOrder}>
              Перевести в замовлення
            </Button>
          )}
          <Button icon={<Save size={15} />} onClick={handleSave} loading={saving}>
            {isNew ? 'Зберегти чернетку' : 'Зберегти зміни'}
          </Button>
        </div>
      </div>
    </Layout>
  )
}
