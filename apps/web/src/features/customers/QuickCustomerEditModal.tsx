import { useEffect, useRef, useState } from 'react'
import { Car, Copy, Plus, Save, Trash2 } from 'lucide-react'
import { Button, Input, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import type { Customer, CustomerVehicle } from '@/types/customer'
import { posCustomerMoneyApi } from '@/features/pos/posCustomerMoneyApi'
import { CustomerBalances } from './CustomerBalances'
import { parseCustomerMoney } from './customerUi'
import { pricingApi, type PriceTier } from '@/features/admin/pricingApi'
import { customerApi } from './customerApi'
import { customerVehiclesApi } from './customerVehiclesApi'
import { useAuthStore } from '@/stores/authStore'
import { buildRoleSafeCustomerUpdate, canManageCustomerFinancials } from './customerEditPermissions'

interface Props {
  customer: Customer | null
  open: boolean
  onClose: () => void
  onSaved: (customer: Customer) => void
}
type VehicleDraft = { id?: string; brand: string; model: string; year: string; vin: string; notes: string }
const EMPTY_CAR: VehicleDraft = { brand: '', model: '', year: '', vin: '', notes: '' }

export function QuickCustomerEditModal({ customer, open, onClose, onSaved }: Props) {
  const role = useAuthStore((state) => state.session?.user?.app_metadata?.role as string | undefined)
  const canManageFinancials = canManageCustomerFinancials(role)
  const [current, setCurrent] = useState<Customer | null>(null)
  const [form, setForm] = useState({ phone:'', full_name:'', email:'', birth_date:'', card_barcode:'', notes:'', discount_pct:'0', bonus_balance:'0', client_status:'client', loyalty_mode:'discount' as 'discount'|'cashback', price_tier_id:'', vip_level:'standard', risk_profile:'low' })
  const [tiers, setTiers] = useState<PriceTier[]>([])
  const [cars, setCars] = useState<CustomerVehicle[]>([])
  const [car, setCar] = useState<VehicleDraft>(EMPTY_CAR)
  const [deposit, setDeposit] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savingCar, setSavingCar] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [revision, setRevision] = useState(0)
  const initialForm = useRef('')
  const busy = useRef(false)

  function fill(c: Customer) {
    setCurrent(c)
    const nextForm = {
      phone:c.phone ?? '', full_name:c.full_name ?? '', email:c.email ?? '',
      birth_date:(c.birth_date ?? '').slice(0, 10), card_barcode:c.card_barcode ?? '', notes:c.notes ?? '',
      discount_pct:String(c.discount_pct ?? 0),
      bonus_balance:((c.bonus_balance ?? 0) / 100).toFixed(2),
      client_status:c.client_status ?? 'client',
      loyalty_mode:c.loyalty_mode ?? 'discount',
      price_tier_id:c.price_tier_id ?? '',
      vip_level:c.vip_level ?? 'standard', risk_profile:c.risk_profile ?? 'low',
    }
    initialForm.current = JSON.stringify(nextForm)
    setForm(nextForm)
  }

  useEffect(() => {
    if (!open || !customer) return
    let cancelled = false
    setCurrent(null)
    setLoadError('')
    setDeposit(null)
    setCars([])
    setTiers([])
    setCar(EMPTY_CAR)
    setLoading(true)
    customerApi.get(customer.id).then(({ data }) => { if (!cancelled) fill(data) })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Не вдалося завантажити картку') })
      .finally(() => { if (!cancelled) setLoading(false) })
    customerVehiclesApi.list(customer.id).then(({ data }) => { if (!cancelled) setCars(data) })
      .catch(() => { if (!cancelled) toast.error('Не вдалося завантажити автомобілі') })
    if (canManageFinancials) pricingApi.listTiers().then(({ data }) => { if (!cancelled) setTiers(data) }).catch(() => {})
    posCustomerMoneyApi.getDeposit(customer.id).then(({ data }) => { if (!cancelled) setDeposit(data.balance) }).catch(() => {})
    return () => { cancelled = true }
  }, [canManageFinancials, customer?.id, open, revision])

  function requestClose() {
    if (busy.current || savingCar) return
    const dirty = current && (JSON.stringify(form) !== initialForm.current || JSON.stringify(car) !== JSON.stringify(EMPTY_CAR))
    if (!dirty || confirm('Закрити картку без збереження введених змін?')) onClose()
  }

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((old) => ({ ...old, [key]: value }))
  }

  async function copyText(value: string, label: string) {
    const clean = value.trim()
    if (!clean) return
    try {
      await navigator.clipboard.writeText(clean)
      toast.success(`${label} скопійовано`)
    } catch {
      toast.error('Не вдалося скопіювати')
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy.current || loading || savingCar) return
    if (JSON.stringify(car) !== JSON.stringify(EMPTY_CAR)) { toast.error('Спочатку збережіть автомобіль або скасуйте його редагування'); return }
    if (!current || !form.phone.trim()) { toast.error("Телефон обов'язковий"); return }
    const bonus = parseCustomerMoney(form.bonus_balance)
    const discount = Number(form.discount_pct.replace(',', '.'))
    if (canManageFinancials && bonus === null) { toast.error('Некоректний баланс бонусів'); return }
    if (canManageFinancials && (!Number.isFinite(discount) || discount < 0 || discount > 100)) { toast.error('Знижка має бути від 0 до 100%'); return }
    busy.current = true
    setSaving(true)
    try {
      const update = buildRoleSafeCustomerUpdate(role, {
        phone:form.phone.trim(), full_name:form.full_name.trim(), email:form.email.trim(), birth_date:form.birth_date || null,
        card_barcode:form.card_barcode.replace(/\s/g, '') || null, notes:form.notes.trim(),
      }, {
        discount_pct:discount, client_status:form.client_status,
        loyalty_mode:form.loyalty_mode, price_tier_id:form.price_tier_id || null,
        vip_level:form.vip_level, risk_profile:form.risk_profile,
      })
      const bonusChanged = canManageFinancials && bonus !== null && bonus !== current.bonus_balance
      const { data } = await customerApi.update(current.id, {
        ...update,
        expected_updated_at: current.updated_at,
        ...(bonusChanged ? { bonus_balance: bonus!, expected_bonus_balance: current.bonus_balance, bonus_description: 'Ручне коригування у картці клієнта' } : {}),
      })
      onSaved(data)
      toast.success('Картку клієнта збережено')
      onClose()
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти клієнта') }
    finally { busy.current = false; setSaving(false) }
  }

  async function saveCar() {
    if (!current) return
    if (savingCar || busy.current) return
    if (!car.brand.trim() || !car.model.trim()) { toast.error('Вкажіть марку та модель'); return }
    if (car.year && (!Number.isInteger(Number(car.year)) || Number(car.year) < 1900 || Number(car.year) > new Date().getFullYear() + 1)) { toast.error('Вкажіть коректний рік автомобіля'); return }
    setSavingCar(true)
    try {
      const body = { brand:car.brand.trim(), model:car.model.trim(), year:car.year ? Number(car.year) : null, vin:car.vin.trim().toUpperCase() || null, notes:car.notes.trim() || null }
      const result = car.id
        ? await customerVehiclesApi.update(current.id, car.id, body)
        : await customerVehiclesApi.create(current.id, body)
      setCars((list) => car.id ? list.map((item) => item.id === car.id ? result.data : item) : [result.data, ...list])
      setCar(EMPTY_CAR)
      toast.success(car.id ? 'Автомобіль оновлено' : 'Автомобіль додано')
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти автомобіль') }
    finally { setSavingCar(false) }
  }

  async function deleteCar(item: CustomerVehicle) {
    if (!current || !confirm('Видалити ' + item.brand + ' ' + item.model + '?')) return
    try {
      await customerVehiclesApi.delete(current.id, item.id)
      setCars((list) => list.filter((value) => value.id !== item.id))
      if (car.id === item.id) setCar(EMPTY_CAR)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Не вдалося видалити автомобіль') }
  }

  return <Modal open={open} onClose={requestClose} title="Картка клієнта" size="xl">
    {!current ? <div className="py-12 text-center text-sm text-gray-500"><p>{loadError || 'Завантаження...'}</p>{loadError && <Button variant="secondary" onClick={() => setRevision((n) => n + 1)}>Повторити</Button>}</div> :
    <form onSubmit={submit} className="space-y-5">
      <CustomerBalances customer={current} deposit={deposit} />
      <fieldset disabled={saving || savingCar || loading} className="space-y-5">
      {loading && <p className="text-xs text-gray-400">Оновлюємо дані з локальної бази...</p>}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <section className="space-y-3 rounded-xl border border-gray-100 bg-gray-50/60 p-4">
          <h3 className="font-semibold text-gray-900">Контакти та картка</h3>
          <div className="rounded-xl border border-blue-100 bg-white p-3 shadow-sm">
            <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-gray-400">Телефон *</label>
            <div className="flex gap-2">
              <input value={form.phone} onChange={(e)=>set('phone',e.target.value)} required className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2.5 font-mono text-xl font-extrabold text-gray-900 outline-none focus:ring-2 focus:ring-yellow-300" />
              <button type="button" onClick={() => copyText(form.phone, 'Телефон')} className="rounded-lg border border-gray-200 px-3 text-gray-500 hover:bg-yellow-50 hover:text-yellow-700" title="Копіювати телефон"><Copy size={18}/></button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Ім'я" value={form.full_name} onChange={(e)=>set('full_name',e.target.value)} />
            <Input label="Email" type="email" value={form.email} onChange={(e)=>set('email',e.target.value)} />
            <Input label="Дата народження" type="date" value={form.birth_date} onChange={(e)=>set('birth_date',e.target.value)} />
            <Input label="Штрихкод картки" value={form.card_barcode} onChange={(e)=>set('card_barcode',e.target.value.replace(/\s/g,''))} placeholder="Скануйте або введіть" />
          </div>
          <div><label className="mb-1 block text-sm font-medium text-gray-700">Примітки</label><textarea value={form.notes} onChange={(e)=>set('notes',e.target.value)} rows={3} className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-yellow-300" /></div>
        </section>
        <section className="space-y-3 rounded-xl border border-yellow-100 bg-yellow-50/50 p-4">
          <h3 className="font-semibold text-gray-900">Бонуси, знижки та ціни</h3>
          {canManageFinancials ? <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Бонусів на рахунку, грн" type="number" min="0" step="0.01" value={form.bonus_balance} onChange={(e)=>set('bonus_balance',e.target.value)} />
            <Input label="Персональний процент, %" type="number" min="0" max="100" step="0.1" value={form.discount_pct} onChange={(e)=>set('discount_pct',e.target.value)} />
            <label className="text-sm font-medium text-gray-700">Статус<select value={form.client_status} onChange={(e)=>set('client_status',e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-normal"><option value="client">Звичайний клієнт</option><option value="sto">СТО</option></select></label>
            <label className="text-sm font-medium text-gray-700">Процент працює як<select value={form.loyalty_mode} onChange={(e)=>set('loyalty_mode',e.target.value as 'discount'|'cashback')} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-normal"><option value="discount">Знижка в касі</option><option value="cashback">Накопичення на рахунок</option></select></label>
          </div>
          {tiers.length > 0 && <label className="block text-sm font-medium text-gray-700">Ціновий рівень<select value={form.price_tier_id} onChange={(e)=>set('price_tier_id',e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-normal"><option value="">Стандартна ціна</option>{tiers.map((tier)=><option key={tier.id} value={tier.id}>{tier.name} (-{tier.discount_pct}%)</option>)}</select></label>}
          <details className="text-sm"><summary className="cursor-pointer text-gray-600">Додаткові позначки клієнта</summary>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <label>VIP рівень<select value={form.vip_level} onChange={(e) => set('vip_level', e.target.value)} className="mt-1 w-full rounded-lg border p-2"><option value="standard">Стандартний</option><option value="bronze">Бронзовий</option><option value="silver">Срібний</option><option value="gold">Золотий</option></select></label>
              <label>Ризик-профіль<select value={form.risk_profile} onChange={(e) => set('risk_profile', e.target.value)} className="mt-1 w-full rounded-lg border p-2"><option value="low">Низький</option><option value="medium">Середній</option><option value="high">Високий</option></select></label>
            </div>
          </details>
          </> : (
            <div className="rounded-lg border border-yellow-200 bg-white px-3 py-2.5 text-sm text-gray-600">
              Касир може змінювати контакти, штрихкод картки, дату народження та автомобілі. Бонуси, знижки, статус і ціновий рівень змінює менеджер або адміністратор.
            </div>
          )}
        </section>
      </div>
      <section className="rounded-xl border border-blue-100 bg-blue-50/40 p-4">
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-gray-900"><Car size={17}/> Автомобілі ({cars.length})</h3>
        {cars.length > 0 && <div className="mb-4 grid gap-2 md:grid-cols-2">{cars.map((item)=><div key={item.id} className="flex items-center gap-2 rounded-lg border border-blue-100 bg-white p-3"><button type="button" onClick={()=>setCar({id:item.id,brand:item.brand,model:item.model,year:item.year?String(item.year):'',vin:item.vin??'',notes:item.notes??''})} className="min-w-0 flex-1 text-left"><p className="truncate text-sm font-semibold">{item.brand} {item.model} {item.year ? '· ' + item.year : ''}</p><p className="truncate font-mono text-xs text-gray-500">{item.vin||'VIN не вказано'}</p></button><button type="button" onClick={()=>deleteCar(item)} className="p-2 text-gray-300 hover:text-red-500"><Trash2 size={15}/></button></div>)}</div>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input label="Марка *" value={car.brand} onChange={(e)=>setCar({...car,brand:e.target.value})}/>
          <Input label="Модель *" value={car.model} onChange={(e)=>setCar({...car,model:e.target.value})}/>
          <Input label="Рік" type="number" value={car.year} onChange={(e)=>setCar({...car,year:e.target.value})}/>
          <Input label="VIN" value={car.vin} maxLength={17} onChange={(e)=>setCar({...car,vin:e.target.value.toUpperCase()})}/>
          <Input label="Примітка" value={car.notes} onChange={(e)=>setCar({...car,notes:e.target.value})}/>
        </div>
        <div className="mt-3 flex gap-2"><Button type="button" variant="secondary" size="sm" loading={savingCar} icon={car.id?<Save size={14}/>:<Plus size={14}/>} onClick={saveCar}>{car.id?'Зберегти автомобіль':'Додати автомобіль'}</Button>{car.id&&<Button type="button" variant="secondary" size="sm" onClick={()=>setCar(EMPTY_CAR)}>Скасувати</Button>}</div>
      </section>
      <div className="flex flex-wrap gap-3 border-t border-gray-100 pt-4"><Button type="submit" loading={saving} icon={<Save size={16}/>} className="flex-1">Зберегти картку</Button><Button type="button" variant="secondary" onClick={() => { if (confirm('Завантажити свіжі дані? Незбережені зміни цієї картки буде втрачено.')) setRevision((n) => n + 1) }}>Оновити дані</Button><Button type="button" variant="secondary" onClick={requestClose}>Закрити</Button></div>
      </fieldset>
    </form>}
  </Modal>
}
