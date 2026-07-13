import { useState, useEffect } from 'react'
import { customerApi } from './customerApi'
import type { Customer } from '@/types/customer'
import { Modal, Button, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { searchCustomersOffline } from '@/lib/offlineDB'
import { useAuthStore } from '@/stores/authStore'
import { pricingApi } from '@/features/admin/pricingApi'
import type { PriceTier } from '@/features/admin/pricingApi'
import { TAGS } from '@/types/customer'

interface Props {
  open: boolean
  offline?: boolean
  onClose: () => void
  onCreated: (customer: Customer) => void
}

type Mode = 'search' | 'create'

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

export function QuickCustomerModal({ open, offline = false, onClose, onCreated }: Props) {
  const scopeKey = useAuthStore((state) => state.session?.user?.id ?? '')
  const [mode, setMode]             = useState<Mode>('search')
  const [query, setQuery]           = useState('')
  const [results, setResults]       = useState<Customer[]>([])
  const [searching, setSearching]   = useState(false)

  const [phone, setPhone] = useState('')
  const [name, setName]   = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [cardBarcode, setCardBarcode] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [priceTierId, setPriceTierId] = useState('')
  const [discountPct, setDiscountPct] = useState('0')
  const [clientStatus, setClientStatus] = useState('client')
  const [carBrand, setCarBrand] = useState('')
  const [carModel, setCarModel] = useState('')
  const [carYear, setCarYear] = useState('')
  const [carVin, setCarVin] = useState('')
  const [carNotes, setCarNotes] = useState('')
  const [tiers, setTiers] = useState<PriceTier[]>([])
  const [saving, setSaving] = useState(false)
  const [recentPhones, setRecentPhones] = useState<string[]>([])

  // Reset state on open
  useEffect(() => {
    if (open) {
      setMode('search')
      setQuery('')
      setResults([])
      setPhone('')
      setName('')
      setEmail('')
      setNotes('')
      setCardBarcode('')
      setTags([])
      setPriceTierId('')
      setDiscountPct('0')
      setClientStatus('client')
      setCarBrand('')
      setCarModel('')
      setCarYear('')
      setCarVin('')
      setCarNotes('')
      setRecentPhones(getRecentItems('recent_phones'))
      if (!offline) pricingApi.listTiers().then((res) => setTiers(res.data)).catch(() => setTiers([]))
    }
  }, [open])

  useEffect(() => {
    if (offline) setMode('search')
  }, [offline])

  // Debounced search
  useEffect(() => {
    if (mode !== 'search' || query.trim().length < 2) {
      setResults([])
      return
    }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        if (offline) {
          setResults(await searchCustomersOffline(query.trim(), 6, scopeKey) as Customer[])
        } else {
          const r = await customerApi.list({ search: query.trim(), per_page: 6 })
          setResults((r as { data: Customer[] }).data ?? [])
        }
      } catch {
        setResults(await searchCustomersOffline(query.trim(), 6, scopeKey).catch(() => []) as Customer[])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query, mode, offline, scopeKey])

  function selectCustomer(c: Customer) {
    saveRecentItem('recent_phones', c.phone)
    onCreated(c)
    onClose()
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (offline) {
      toast.error('Створення нового клієнта потребує інтернету')
      return
    }
    if (!phone.trim()) { toast.error("Телефон обов'язковий"); return }
    if (!name.trim())  { toast.error("Ім'я обов'язкове"); return }
    setSaving(true)
    try {
      const hasVehicle = carVin.trim() || carBrand.trim() || carModel.trim()
      const result = await customerApi.create({
        phone: phone.trim(),
        full_name: name.trim(),
        email: email.trim() || undefined,
        notes: notes.trim() || undefined,
        tags,
        price_tier_id: priceTierId || null,
        discount_pct: Number(discountPct) || 0,
        client_status: clientStatus,
        card_barcode: cardBarcode.trim() || null,
        ...(hasVehicle ? {
          vehicle: {
            brand: carBrand.trim() || 'Авто',
            model: carModel.trim() || '—',
            year: carYear ? Number(carYear) : null,
            vin: carVin.trim().toUpperCase() || null,
            notes: carNotes.trim() || null,
          },
        } : {}),
      })
      const { data } = result
      toast.success(result.meta?.reused
        ? result.meta.vehicle_added ? 'Клієнт уже існував — автомобіль додано до його картки' : 'Клієнт уже є в базі — вибрано його картку'
        : result.meta?.vehicle_added ? 'Клієнта й автомобіль створено' : 'Клієнта створено')
      saveRecentItem('recent_phones', phone.trim())
      onCreated(data)
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Клієнт у чеку" size={mode === 'create' ? 'lg' : 'sm'}>
      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200 -mt-1">
        {((offline ? ['search'] : ['search', 'create']) as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={
              'px-4 py-2 text-sm font-medium border-b-2 transition-colors ' +
              (mode === m
                ? 'border-yellow-400 text-yellow-700'
                : 'border-transparent text-gray-500 hover:text-gray-700')
            }
          >
            {m === 'search' ? 'Знайти' : 'Новий клієнт'}
          </button>
        ))}
      </div>

      {mode === 'search' ? (
        <div className="space-y-3">
          {offline && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Офлайн: пошук серед клієнтів, збережених у браузері. Створення доступне після відновлення зв’язку.
            </div>
          )}
          <Input
            label="Ім'я або телефон"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Пошук клієнта..."
            autoFocus
          />

          {recentPhones.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1 items-center">
              <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">Нещодавні:</span>
              {recentPhones.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setQuery(p)}
                  className="text-[10px] bg-gray-100 hover:bg-yellow-100 text-gray-700 px-2 py-0.5 rounded-full transition font-mono border border-gray-200/50"
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          {searching && (
            <p className="text-sm text-gray-400 text-center py-2">Пошук...</p>
          )}

          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <div className="text-center py-4">
              <p className="text-sm text-gray-500 mb-3">Клієнта не знайдено</p>
              {!offline && (
                <Button variant="secondary" size="sm" onClick={() => {
                  setPhone(query.trim())
                  setMode('create')
                }}>
                  Створити нового
                </Button>
              )}
            </div>
          )}

          {results.length > 0 && (
            <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
              {results.map((c) => (
                <button
                  key={c.id}
                  onClick={() => selectCustomer(c)}
                  className="w-full text-left px-4 py-3 hover:bg-yellow-50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {c.full_name ?? '—'}
                      </p>
                      <p className="text-xs text-gray-500">{c.phone}</p>
                    </div>
                    <div className="text-right">
                      {c.price_tier && (
                        <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-medium">
                          {c.price_tier.name} -{c.price_tier.discount_pct}%
                        </span>
                      )}
                      {c.debt_balance > 0 && (
                        <p className="text-xs text-red-500 mt-0.5">
                          Борг: {(c.debt_balance / 100).toFixed(2)} грн
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {!offline && (
            <p className="text-xs text-gray-400 text-center">
              Або{' '}
              <button
                className="text-yellow-600 hover:underline"
                onClick={() => setMode('create')}
              >
                створіть нового клієнта
              </button>
            </p>
          )}
        </div>
      ) : (
        <form onSubmit={handleCreate} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
            <Input
              label="Телефон *"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+380671234567"
              autoFocus
              required
            />
            {recentPhones.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5 items-center">
                <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">Нещодавні:</span>
                {recentPhones.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPhone(p)}
                    className="text-[10px] bg-gray-100 hover:bg-yellow-100 text-gray-700 px-2 py-0.5 rounded-full transition font-mono border border-gray-200/50"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
            </div>
            <Input label="Ім'я *" value={name} onChange={(e) => setName(e.target.value)} placeholder="Іван Іваненко" required />
            <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="client@example.com" />
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Штрихкод картки</label>
              <div className="flex gap-2">
                <input value={cardBarcode} onChange={(e) => setCardBarcode(e.target.value.replace(/\s/g, ''))}
                  placeholder="Відскануйте або введіть"
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2.5 font-mono text-sm outline-none focus:ring-2 focus:ring-yellow-400" />
                <Button type="button" variant="secondary" size="sm" onClick={() => setCardBarcode('200' + String(Math.floor(Math.random() * 1_000_000_000)).padStart(10, '0'))}>
                  Згенерувати
                </Button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Статус клієнта</label>
              <select value={clientStatus} onChange={(e) => setClientStatus(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-yellow-400">
                <option value="client">Звичайний клієнт</option>
                <option value="sto">СТО</option>
              </select>
            </div>
            <Input label="Персональна знижка (%)" type="number" min="0" max="100" step="0.1"
              value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} />
            {tiers.length > 0 && (
              <div className="sm:col-span-2">
                <label className="mb-1 block text-sm font-medium text-gray-700">Ціновий рівень</label>
                <select value={priceTierId} onChange={(e) => setPriceTierId(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-yellow-400">
                  <option value="">Стандартна ціна (роздріб)</option>
                  {tiers.map((tier) => <option key={tier.id} value={tier.id}>{tier.name} (знижка {tier.discount_pct}%)</option>)}
                </select>
              </div>
            )}
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-gray-700">Теги</p>
            <div className="flex flex-wrap gap-2">
              {TAGS.map((tag) => (
                <button key={tag} type="button" onClick={() => setTags((current) => current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag])}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${tags.includes(tag) ? 'border-yellow-400 bg-yellow-100 text-yellow-800' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                  {tag}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4">
            <div className="mb-3">
              <p className="text-sm font-semibold text-gray-900">Автомобіль клієнта</p>
              <p className="text-xs text-gray-500">Якщо телефон уже є в базі, автомобіль додасться до існуючої картки.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Марка" value={carBrand} onChange={(e) => setCarBrand(e.target.value)} placeholder="Chevrolet" />
              <Input label="Модель" value={carModel} onChange={(e) => setCarModel(e.target.value)} placeholder="Lanos" />
              <Input label="Рік" type="number" min="1900" max="2100" value={carYear} onChange={(e) => setCarYear(e.target.value)} placeholder="2008" />
              <Input label="VIN" value={carVin} onChange={(e) => setCarVin(e.target.value.toUpperCase().replace(/\s/g, ''))} maxLength={17} placeholder="17 символів" />
              <div className="sm:col-span-2">
                <label className="mb-1 block text-sm font-medium text-gray-700">Примітка до автомобіля</label>
                <input value={carNotes} onChange={(e) => setCarNotes(e.target.value)} placeholder="Комплектація, особливості..."
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-yellow-400" />
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Примітки про клієнта</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Домовленості, побажання, важлива інформація..."
              className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-yellow-400" />
          </div>
          <div className="flex gap-3">
            <Button type="submit" loading={saving} className="flex-1">
              Створити й додати до чека
            </Button>
            <Button type="button" variant="secondary" onClick={() => setMode('search')}>
              Назад
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
