import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { orderApi, type CreateOrderPayload, type OrderSource } from './orderApi'
import { customerApi } from '@/features/customers/customerApi'
import { customerVehiclesApi } from '@/features/customers/customerVehiclesApi'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Button, Input, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

interface Supplier { id: string; name: string }
interface CustomerOption { id: string; phone: string; full_name: string | null }
interface CustomerVehicle { id: string; brand: string; model: string; year: number | null; vin: string | null }

interface ItemRow {
  name:        string
  sku:         string
  qty:         string
  sell_price:  string
  supplier_id: string
}

const EMPTY_ITEM: ItemRow = { name: '', sku: '', qty: '1', sell_price: '0', supplier_id: '' }

const SOURCE_OPTIONS: { value: OrderSource; label: string }[] = [
  { value: 'walk_in',  label: 'Прийшов сам' },
  { value: 'phone',    label: 'Телефон' },
  { value: 'messenger', label: 'Месенджер' },
]

export default function OrderFormPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // Клієнт
  const [customerId, setCustomerId]           = useState('')
  const [customerSearch, setCustomerSearch]   = useState('')
  const [customerOptions, setCustomerOptions] = useState<CustomerOption[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null)

  // Деталі замовлення
  const [source, setSource]                   = useState<OrderSource>('walk_in')
  const [comment, setComment]                 = useState('')
  const [prepayment, setPrepayment]           = useState('0')
  const [prepaymentMethod, setPrepaymentMethod] = useState<'cash' | 'card' | 'transfer'>('cash')

  // Авто
  const [vehicleMake, setVehicleMake]   = useState('')
  const [vehicleModel, setVehicleModel] = useState('')
  const [vehicleYear, setVehicleYear]   = useState('')
  const [vehicleVin, setVehicleVin]     = useState('')

  // Авто клієнта
  const [vehicles, setVehicles]             = useState<CustomerVehicle[]>([])
  const [selectedVehicleId, setSelectedVehicleId] = useState('')

  // Постачальники (для позицій)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])

  // Позиції
  const [items, setItems] = useState<ItemRow[]>([{ ...EMPTY_ITEM }])
  const [saving, setSaving] = useState(false)

  // Якщо прийшли з чату — підтягуємо customer_id з query
  useEffect(() => {
    const qCustomerId = searchParams.get('customer_id')
    if (qCustomerId) setCustomerId(qCustomerId)
  }, [searchParams])

  useEffect(() => {
    api.get<{ data: Supplier[] }>('/api/v1/suppliers?per_page=200&is_active=true')
      .then((r) => setSuppliers((r as { data: Supplier[] }).data ?? []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (customerSearch.trim().length < 2) { setCustomerOptions([]); return }
    const t = setTimeout(() => {
      customerApi.list({ search: customerSearch.trim(), per_page: 8 })
        .then((r) => setCustomerOptions((r as { data: CustomerOption[] }).data ?? []))
        .catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [customerSearch])

  function selectCustomer(c: CustomerOption) {
    setSelectedCustomer(c)
    setCustomerId(c.id)
    setCustomerSearch(c.full_name ?? c.phone)
    setCustomerOptions([])
    setSelectedVehicleId('')
    customerVehiclesApi.list(c.id)
      .then((r) => setVehicles((r as any).data ?? []))
      .catch(() => {})
  }

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

  function addItem() { setItems((p) => [...p, { ...EMPTY_ITEM }]) }
  function removeItem(i: number) { setItems((p) => p.filter((_, idx) => idx !== i)) }
  function updateItem<K extends keyof ItemRow>(i: number, key: K, val: string) {
    setItems((p) => p.map((row, idx) => idx === i ? { ...row, [key]: val } : row))
  }

  const totalKop = items.reduce((s, row) => {
    return s + Math.round(parseFloat(row.sell_price || '0') * 100) * (parseFloat(row.qty || '1') || 1)
  }, 0)

  const prepaymentKop = Math.round(parseFloat(prepayment || '0') * 100)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const validItems = items.filter((row) => row.name.trim())
    if (validItems.length === 0) {
      toast.error('Додайте хоча б одну позицію з назвою')
      return
    }

    const vehicleInfo = (vehicleMake || vehicleModel || vehicleYear || vehicleVin)
      ? {
          make:  vehicleMake.trim()  || undefined,
          model: vehicleModel.trim() || undefined,
          year:  vehicleYear ? parseInt(vehicleYear) : undefined,
          vin:   vehicleVin.trim()   || undefined,
        }
      : null

    const payload: CreateOrderPayload = {
      customer_id:        customerId || null,
      source,
      vehicle_info:       vehicleInfo,
      comment:            comment.trim() || null,
      prepayment:         prepaymentKop,
      prepayment_method:  prepaymentKop > 0 ? prepaymentMethod : null,
      items: validItems.map((row) => ({
        name:        row.name.trim(),
        sku:         row.sku.trim() || null,
        qty:         parseFloat(row.qty) || 1,
        sell_price:  Math.round(parseFloat(row.sell_price || '0') * 100),
        buy_price:   0,
        supplier_id: row.supplier_id || null,
        source_type: row.supplier_id ? 'supplier' : 'warehouse',
      })),
    }

    setSaving(true)
    try {
      const result = await orderApi.create(payload)
      const orderId = (result as { data: { id: string } }).data.id
      toast.success('Замовлення створено')
      navigate('/orders/' + orderId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка збереження')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Layout title="Нове замовлення" onBack={() => navigate(-1)}>
      <form onSubmit={handleSubmit} className="max-w-3xl space-y-5">

        {/* Клієнт */}
        <Card>
          <h3 className="font-semibold text-gray-800 mb-4">Клієнт</h3>
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
            <p className="mt-2 text-sm text-green-600">
              Вибрано: {selectedCustomer.full_name ?? selectedCustomer.phone}
            </p>
          )}
        </Card>

        {/* Деталі */}
        <Card>
          <h3 className="font-semibold text-gray-800 mb-4">Деталі замовлення</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Канал звернення</label>
              <select value={source} onChange={(e) => setSource(e.target.value as OrderSource)}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300">
                {SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <Input
              label="Передоплата (грн)"
              type="number" min="0" step="0.01"
              value={prepayment}
              onChange={(e) => setPrepayment(e.target.value)}
            />
            {prepaymentKop > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Метод передоплати</label>
                <select value={prepaymentMethod} onChange={(e) => setPrepaymentMethod(e.target.value as any)}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300">
                  <option value="cash">Готівка</option>
                  <option value="card">Картка</option>
                  <option value="transfer">Переказ</option>
                </select>
              </div>
            )}
          </div>
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Коментар</label>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="Додаткова інформація..." rows={2}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300 resize-none"
            />
          </div>
        </Card>

        {/* Авто (необов'язково) */}
        <Card>
          <h3 className="font-semibold text-gray-800 mb-4">Автомобіль <span className="text-gray-400 font-normal text-sm">(необов'язково)</span></h3>
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
          <div className="grid grid-cols-2 gap-4">
            <Input label="Марка" value={vehicleMake} onChange={(e) => setVehicleMake(e.target.value)} placeholder="Toyota" />
            <Input label="Модель" value={vehicleModel} onChange={(e) => setVehicleModel(e.target.value)} placeholder="Camry" />
            <Input label="Рік" type="number" min="1900" max="2099" value={vehicleYear} onChange={(e) => setVehicleYear(e.target.value)} placeholder="2018" />
            <Input label="VIN" value={vehicleVin} onChange={(e) => setVehicleVin(e.target.value)} placeholder="WVWZZZ1JZ3W386752" />
          </div>
        </Card>

        {/* Позиції */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-800">Позиції</h3>
            <Button type="button" variant="secondary" size="sm" icon={<Plus size={14} />} onClick={addItem}>
              Додати позицію
            </Button>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_120px_70px_90px_140px_32px] gap-2 text-xs text-gray-500 font-medium px-1">
              <span>Назва / деталь</span>
              <span>Артикул / OEM</span>
              <span>Кіл-сть</span>
              <span>Ціна (грн)</span>
              <span>Постачальник</span>
              <span />
            </div>

            {items.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_70px_90px_140px_32px] gap-2 items-center">
                <input type="text" value={row.name} onChange={(e) => updateItem(i, 'name', e.target.value)}
                  placeholder="Фільтр масляний Toyota 1NZ" required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300 w-full"
                />
                <input type="text" value={row.sku} onChange={(e) => updateItem(i, 'sku', e.target.value)}
                  placeholder="90915-YZZD1"
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300 w-full"
                />
                <input type="number" min="1" step="any" value={row.qty} onChange={(e) => updateItem(i, 'qty', e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300 w-full text-center"
                />
                <input type="number" min="0" step="0.01" value={row.sell_price} onChange={(e) => updateItem(i, 'sell_price', e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300 w-full text-right"
                />
                <select value={row.supplier_id} onChange={(e) => updateItem(i, 'supplier_id', e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300 w-full">
                  <option value="">— Зі складу —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <button type="button" onClick={() => removeItem(i)} disabled={items.length === 1}
                  className="text-gray-400 hover:text-red-500 disabled:opacity-30 flex items-center justify-center">
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-4 border-t border-gray-100 flex justify-end gap-6 text-sm">
            {prepaymentKop > 0 && (
              <span className="text-gray-500">Передоплата: <span className="font-semibold text-blue-600">{formatMoney(prepaymentKop)}</span></span>
            )}
            <span className="text-gray-500">Загальна сума: <span className="font-bold text-gray-900">{formatMoney(totalKop)}</span></span>
          </div>
        </Card>

        <div className="flex gap-3 justify-end">
          <Button type="button" variant="secondary" onClick={() => navigate(-1)}>Скасувати</Button>
          <Button type="submit" loading={saving}>Створити замовлення</Button>
        </div>
      </form>
    </Layout>
  )
}
