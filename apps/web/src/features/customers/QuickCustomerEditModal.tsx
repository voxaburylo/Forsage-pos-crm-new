import { useCallback, useEffect, useId, useLayoutEffect, useState } from 'react'
import { Car, Copy, Plus, Save, Trash2 } from 'lucide-react'
import { Button, Input, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { TAGS, type Customer, type CustomerVehicle } from '@/types/customer'
import { posCustomerMoneyApi } from '@/features/pos/posCustomerMoneyApi'
import { CustomerBalances } from './CustomerBalances'
import { pricingApi, type PriceTier } from '@/features/admin/pricingApi'
import { customerApi } from './customerApi'
import { CustomerCardBarcodeField } from './CustomerCardBarcodeField'
import { customerVehiclesApi } from './customerVehiclesApi'
import { useScopedAction } from '@/hooks/useScopedAction'
import { useAuthStore } from '@/stores/authStore'
import { canEditCustomerCard, canManageCustomerDiscount, canManageCustomerFinancials, canManageCustomerStatus } from './customerEditPermissions'
import { customerEditorUpdate, customerEditorValues } from './customerEditorModel'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'

interface Props {
  customer: Customer | null
  open: boolean
  onClose: () => void
  onSaved: (customer: Customer) => void
  onVehiclesChanged?: (vehicles: CustomerVehicle[]) => void
  onDraftStateChange?: (state: { dirty: boolean; busy: boolean }) => void
}
type VehicleDraft = { id?: string; brand: string; model: string; year: string; vin: string; notes: string }
const EMPTY_CAR: VehicleDraft = { brand: '', model: '', year: '', vin: '', notes: '' }

export function QuickCustomerEditModal(props: Props) {
  const [draft, setDraft] = useState({ dirty: false, busy: false })
  useUnsavedChanges(props.open && draft.dirty, props.open && draft.busy)
  const onDraftStateChange = useCallback((state: typeof draft) => { setDraft(state); props.onDraftStateChange?.(state) }, [props.onDraftStateChange])
  return <CustomerEditor {...props} onDraftStateChange={onDraftStateChange} />
}

export function CustomerEditor({ customer, open, onClose, onSaved, onVehiclesChanged, onDraftStateChange, inline = false }: Props & { inline?: boolean }) {
  const role = useAuthStore((state) => state.session?.user?.app_metadata?.role as string | undefined)
  const userId = useAuthStore((state) => state.session?.user?.id ?? '')
  const canEdit = canEditCustomerCard(role)
  const canManageFinancials = canManageCustomerFinancials(role)
  const canManageStatus = canManageCustomerStatus(role)
  const [current, setCurrent] = useState<Customer | null>(null)
  const [form, setForm] = useState(() => customerEditorValues({}))
  const canManageDiscount = canManageCustomerDiscount(role, current?.loyalty_mode ?? 'discount')
  const [tiers, setTiers] = useState<PriceTier[]>([])
  const [cars, setCars] = useState<CustomerVehicle[]>([])
  const [car, setCar] = useState<VehicleDraft>(EMPTY_CAR)
  const [carBaseline, setCarBaseline] = useState(() => JSON.stringify(EMPTY_CAR))
  const [deposit, setDeposit] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const action = useScopedAction(`${open}:${customer?.id ?? ''}:${userId}:${role ?? ''}`)
  const [actionKind, setActionKind] = useState<'customer' | 'car' | null>(null)
  const saving = action.busy && actionKind === 'customer'
  const savingCar = action.busy && actionKind === 'car'
  const [carsState, setCarsState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [revision, setRevision] = useState(0)
  const [initialForm, setInitialForm] = useState('')
  const carSaveId = useId()
  const carSequenceId = useId()
  const carDirty = JSON.stringify(car) !== carBaseline
  const dirty = Boolean(current && (JSON.stringify(form) !== initialForm || carDirty))
  useLayoutEffect(() => { onDraftStateChange?.({ dirty, busy: action.busy }) }, [dirty, action.busy, onDraftStateChange])
  useEffect(() => () => { onDraftStateChange?.({ dirty: false, busy: false }) }, [onDraftStateChange])

  function fill(c: Customer) {
    setCurrent(c)
    const nextForm = customerEditorValues(c)
    setInitialForm(JSON.stringify(nextForm))
    setForm(nextForm)
  }

  useEffect(() => {
    if (!open || !customer) return
    let cancelled = false
    setCurrent(null)
    setLoadError('')
    setDeposit(null)
    setCars([])
    setCarsState('loading')
    setActionKind(null)
    setTiers([])
    setCar(EMPTY_CAR)
    setCarBaseline(JSON.stringify(EMPTY_CAR))
    setLoading(true)
    customerApi.get(customer.id).then(({ data }) => { if (!cancelled) fill(data) })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Не вдалося завантажити картку') })
      .finally(() => { if (!cancelled) setLoading(false) })
    customerVehiclesApi.list(customer.id).then(({ data }) => { if (!cancelled) { setCars(data); setCarsState('ready') } })
      .catch(() => { if (!cancelled) { setCarsState('error'); toast.error('Не вдалося завантажити автомобілі') } })
    if (canManageFinancials) pricingApi.listTiers().then(({ data }) => { if (!cancelled) setTiers(data) }).catch(() => {})
    posCustomerMoneyApi.getDeposit(customer.id).then(({ data }) => { if (!cancelled) setDeposit(data.balance) }).catch(() => {})
    return () => { cancelled = true }
  }, [canManageFinancials, customer?.id, userId, role, open, revision])

  function requestClose() {
    if (action.isBusy()) return
    if (!dirty || confirm('Закрити картку без збереження введених змін?')) onClose()
  }

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((old) => ({ ...old, [key]: value }))
  }

  function clearCar() {
    setCar(EMPTY_CAR)
    setCarBaseline(JSON.stringify(EMPTY_CAR))
  }

  function selectCar(item: CustomerVehicle) {
    if (action.isBusy() || car.id === item.id) return
    if (carDirty && !confirm('Перейти до іншого автомобіля без збереження введених змін автомобіля?')) return
    const selected = { id: item.id, brand: item.brand, model: item.model, year: item.year ? String(item.year) : '', vin: item.vin ?? '', notes: item.notes ?? '' }
    setCar(selected)
    setCarBaseline(JSON.stringify(selected))
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
    if (action.isBusy() || loading || !canEdit) return
    if (carDirty) {
      document.getElementById(carSaveId)?.focus()
      return
    }
    if (!current || !form.phone.trim()) { toast.error("Телефон обов'язковий"); return }
    const attempt = action.begin()
    if (!attempt) return
    setActionKind('customer')
    try {
      const { data } = await customerApi.update(current.id, customerEditorUpdate(current, form, role))
      if (!attempt.isCurrent()) return
      fill(data)
      onSaved(data)
      toast.success('Картку клієнта збережено')
      if (!inline) onClose()
    } catch (error) { if (attempt.isCurrent()) toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти клієнта') }
    finally { attempt.finish() }
  }

  async function saveCar() {
    if (!current || !canEdit || !carDirty) return
    if (action.isBusy() || loading || carsState !== 'ready') return
    if (!car.brand.trim() || !car.model.trim()) { toast.error('Вкажіть марку та модель'); return }
    if (car.year && (!Number.isInteger(Number(car.year)) || Number(car.year) < 1900 || Number(car.year) > new Date().getFullYear() + 1)) { toast.error('Вкажіть коректний рік автомобіля'); return }
    const attempt = action.begin()
    if (!attempt) return
    setActionKind('car')
    try {
      const body = { brand:car.brand.trim(), model:car.model.trim(), year:car.year ? Number(car.year) : null, vin:car.vin.trim().toUpperCase() || null, notes:car.notes.trim() || null }
      const result = car.id
        ? await customerVehiclesApi.update(current.id, car.id, body)
        : await customerVehiclesApi.create(current.id, body)
      if (!attempt.isCurrent()) return
      const nextCars = car.id ? cars.map((item) => item.id === car.id ? result.data : item) : [result.data, ...cars]
      setCars(nextCars)
      onVehiclesChanged?.(nextCars)
      clearCar()
      toast.success(car.id ? 'Автомобіль оновлено' : 'Автомобіль додано')
    } catch (error) { if (attempt.isCurrent()) toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти автомобіль') }
    finally { attempt.finish() }
  }

  async function deleteCar(item: CustomerVehicle) {
    if (!current || !canEdit || action.isBusy() || loading || carsState !== 'ready' || !confirm('Видалити ' + item.brand + ' ' + item.model + '?')) return
    const attempt = action.begin()
    if (!attempt) return
    setActionKind('car')
    try {
      await customerVehiclesApi.delete(current.id, item.id)
      if (!attempt.isCurrent()) return
      const nextCars = cars.filter((value) => value.id !== item.id)
      setCars(nextCars)
      onVehiclesChanged?.(nextCars)
      if (car.id === item.id) clearCar()
    } catch (error) { if (attempt.isCurrent()) toast.error(error instanceof Error ? error.message : 'Не вдалося видалити автомобіль') }
    finally { attempt.finish() }
  }

  const content = !current ? <div className="py-12 text-center text-sm text-gray-500"><p>{loadError || 'Завантаження...'}</p>{loadError && <Button variant="secondary" onClick={() => setRevision((n) => n + 1)}>Повторити</Button>}</div> :
    <form onSubmit={submit} className="space-y-5">
      {!inline && <CustomerBalances customer={current} deposit={deposit} />}
      <fieldset disabled={!canEdit || saving || savingCar || loading} className="space-y-5">
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
            {inline && <a href={`tel:${form.phone}`} className="mt-2 inline-block text-sm text-blue-600 hover:underline">Зателефонувати</a>}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Ім'я" value={form.full_name} onChange={(e)=>set('full_name',e.target.value)} />
            <Input label="Email" type="email" value={form.email} onChange={(e)=>set('email',e.target.value)} />
            <Input label="Дата народження" type="date" value={form.birth_date} onChange={(e)=>set('birth_date',e.target.value)} />
          </div>
          <CustomerCardBarcodeField value={form.card_barcode} onChange={(value) => set('card_barcode', value)} disabled={saving} />
          <div><p className="mb-2 text-sm font-medium text-gray-700">Теги</p><div className="flex flex-wrap gap-2">{Array.from(new Set([...TAGS, ...form.tags])).map((tag) => <button key={tag} type="button" aria-pressed={form.tags.includes(tag)} onClick={() => set('tags', form.tags.includes(tag) ? form.tags.filter((value) => value !== tag) : [...form.tags, tag])} className={`rounded-lg border px-3 py-1.5 text-sm ${form.tags.includes(tag) ? 'border-yellow-400 bg-yellow-100 text-yellow-800' : 'border-gray-200 bg-white text-gray-600'}`}>{tag}</button>)}</div></div>
          <div><label className="mb-1 block text-sm font-medium text-gray-700">Примітки</label><textarea value={form.notes} onChange={(e)=>set('notes',e.target.value)} rows={3} className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-yellow-300" /></div>
        </section>
        <section className="space-y-3 rounded-xl border border-yellow-100 bg-yellow-50/50 p-4">
          <h3 className="font-semibold text-gray-900">Бонуси, знижки та ціни</h3>
          {canManageStatus && (
            <label className="text-sm font-medium text-gray-700">Статус<select value={form.client_status} onChange={(e)=>set('client_status',e.target.value as 'client' | 'sto')} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-normal"><option value="client">Звичайний клієнт</option><option value="sto">СТО</option></select></label>
          )}
          {canManageFinancials ? <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Бонусів на рахунку, грн" type="number" min="0" step="0.01" value={form.bonus_balance} onChange={(e)=>set('bonus_balance',e.target.value)} />
            <Input label={form.loyalty_mode === 'cashback' ? 'Накопичення, %' : 'Персональна знижка, %'} type="number" min="0" max="100" step="any" value={form.discount_pct} onChange={(e)=>set('discount_pct',e.target.value)} />
            <label className="text-sm font-medium text-gray-700">Процент працює як<select value={form.loyalty_mode} onChange={(e)=>set('loyalty_mode',e.target.value as 'discount'|'cashback')} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-normal"><option value="discount">Знижка в касі</option><option value="cashback">Накопичення на рахунок</option></select></label>
          </div>
          {tiers.length > 0 && <label className="block text-sm font-medium text-gray-700">Ціновий рівень<select value={form.price_tier_id} onChange={(e)=>set('price_tier_id',e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-normal"><option value="">Персональна знижка з картки</option>{tiers.map((tier)=><option key={tier.id} value={tier.id}>{tier.name} (-{tier.discount_pct}%)</option>)}</select></label>}
          <p className="text-sm text-gray-600">{form.loyalty_mode === 'cashback'
            ? 'Ціна в чеку не зменшується: процент нараховується на рахунок.'
            : form.price_tier_id && tiers.some(tier => tier.id === form.price_tier_id)
              ? 'У касі діє знижка цінової групи. Щоб застосувати персональну — виберіть її у списку вище.'
              : 'У касі діє персональна знижка з цієї картки.'}</p>
          <details className="text-sm"><summary className="cursor-pointer text-gray-600">Додаткові позначки клієнта</summary>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <label>VIP рівень<select value={form.vip_level} onChange={(e) => set('vip_level', e.target.value as typeof form.vip_level)} className="mt-1 w-full rounded-lg border p-2"><option value="standard">Стандартний</option><option value="bronze">Бронзовий</option><option value="silver">Срібний</option><option value="gold">Золотий</option></select></label>
              <label>Ризик-профіль<select value={form.risk_profile} onChange={(e) => set('risk_profile', e.target.value as typeof form.risk_profile)} className="mt-1 w-full rounded-lg border p-2"><option value="low">Низький</option><option value="medium">Середній</option><option value="high">Високий</option></select></label>
            </div>
          </details>
          </> : (
            <div className="rounded-lg border border-yellow-200 bg-white px-3 py-2.5 text-sm text-gray-600">
              {canManageDiscount ? <Input label="Персональна знижка, %" type="number" min="0" max="100" step="any" value={form.discount_pct} onChange={(e) => set('discount_pct', e.target.value)} /> : <p>Цей клієнт накопичує кошти на рахунку. Процент накопичень змінює менеджер або адміністратор.</p>}
              {form.price_tier_id && <p className="mt-2">Знижка цінової групи має пріоритет над персональною. Цінову групу змінює менеджер.</p>}
              <p className="mt-2">Бонусний баланс і ціновий рівень змінює менеджер або адміністратор.</p>
            </div>
          )}
        </section>
      </div>
      <section className="rounded-xl border border-blue-100 bg-blue-50/40 p-4">
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-gray-900"><Car size={17}/> Автомобілі ({cars.length})</h3>
        <p className="mb-3 text-sm text-gray-600">Автомобіль зберігається окремо від контактів і знижок клієнта. Після цього збережіть зміни картки.</p>
        {carsState !== 'ready' && <p role="status" className="mb-3 text-sm text-gray-500">{carsState === 'loading' ? 'Завантажуємо автомобілі…' : 'Не вдалося завантажити автомобілі. Натисніть «Оновити дані» нижче.'}</p>}
        <fieldset disabled={carsState !== 'ready'} className="min-w-0">
        {cars.length > 0 && <div className="mb-4 grid gap-2 md:grid-cols-2">{cars.map((item)=><div key={item.id} className="flex items-center gap-2 rounded-lg border border-blue-100 bg-white p-3"><button type="button" onClick={()=>selectCar(item)} className="min-w-0 flex-1 text-left"><p className="truncate text-sm font-semibold">{item.brand} {item.model} {item.year ? '· ' + item.year : ''}</p><p className="truncate font-mono text-xs text-gray-500">{item.vin||'VIN не вказано'}</p></button><button type="button" onClick={()=>deleteCar(item)} className="p-2 text-gray-300 hover:text-red-500"><Trash2 size={15}/></button></div>)}</div>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input label="Марка *" value={car.brand} onChange={(e)=>setCar({...car,brand:e.target.value})}/>
          <Input label="Модель *" value={car.model} onChange={(e)=>setCar({...car,model:e.target.value})}/>
          <Input label="Рік" type="number" value={car.year} onChange={(e)=>setCar({...car,year:e.target.value})}/>
          <Input label="VIN" value={car.vin} maxLength={17} onChange={(e)=>setCar({...car,vin:e.target.value.toUpperCase()})}/>
          <Input label="Примітка" value={car.notes} onChange={(e)=>setCar({...car,notes:e.target.value})}/>
        </div>
        <div className="mt-3 flex gap-2"><Button id={carSaveId} type="button" disabled={!carDirty} variant="secondary" size="sm" loading={savingCar} icon={car.id?<Save size={14}/>:<Plus size={14}/>} onClick={saveCar}>{car.id?'Зберегти автомобіль':'Додати автомобіль'}</Button>{(carDirty||car.id)&&<Button type="button" variant="secondary" size="sm" onClick={clearCar}>Скасувати</Button>}</div>
        </fieldset>
      </section>
      <div className="sticky bottom-0 z-10 border-t border-gray-100 bg-white py-3">
        {carDirty && <p id={carSequenceId} role="status" className="mb-3 text-sm text-amber-800">Спочатку збережіть автомобіль або скасуйте його зміни. Потім збережіть картку клієнта.</p>}
        <div className="flex flex-wrap gap-3"><Button type="submit" disabled={carDirty} aria-describedby={carDirty ? carSequenceId : undefined} loading={saving} icon={<Save size={16}/>} className="flex-1">Зберегти картку</Button><Button type="button" variant="secondary" onClick={() => { if (!action.isBusy() && (!dirty || confirm('Завантажити свіжі дані? Незбережені зміни цієї картки буде втрачено.'))) setRevision((n) => n + 1) }}>Оновити дані</Button>{!inline && <Button type="button" variant="secondary" onClick={requestClose}>Закрити</Button>}</div>
      </div>
      </fieldset>
    </form>
  return inline ? content : <Modal open={open} onClose={requestClose} title="Картка клієнта" size="xl">{content}</Modal>
}
