import { useState, useEffect } from 'react'
import { DollarSign, Wallet, X } from 'lucide-react'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'
import { usePOSStore } from '@/stores/posStore'
import { useAuthStore } from '@/stores/authStore'
import { posCustomerMoneyApi } from './posCustomerMoneyApi'

interface MoneyCustomer {
  id: string
  full_name: string | null
  phone: string | null
  debt_balance: number
  deposit_balance?: number
}

interface Props {
  open: boolean
  onClose: () => void
  onPaid: () => void
  initialCustomer?: MoneyCustomer | null
}

// Одне касове вікно для боргу, поповнення і фактичної видачі коштів.
// Видавати кошти можуть лише касир або власник; менеджер тільки скасовує замовлення.
export function DebtPaymentModal({ open, onClose, onPaid, initialCustomer = null }: Props) {
  const [mode, setMode] = useState<'debt' | 'deposit' | 'payout'>('debt')
  const [search, setSearch] = useState('')
  const [customers, setCustomers] = useState<MoneyCustomer[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<MoneyCustomer | null>(null)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<'cash' | 'card'>('cash')
  const [saving, setSaving] = useState(false)
  const role = useAuthStore((state) => (state.session?.user?.app_metadata?.role as string) ?? 'cashier')
  const canPayout = role === 'cashier' || role === 'owner' || role === 'admin'
  const currentShift = usePOSStore((state) => state.currentShift)

  useEffect(() => {
    if (!open) {
      setSelected(null); setAmount(''); setMethod('cash'); setSearch(''); setCustomers([]); setMode('debt')
      return
    }
    if (initialCustomer) {
      const nextMode = initialCustomer.debt_balance > 0
        ? 'debt'
        : canPayout && (initialCustomer.deposit_balance ?? 0) > 0 ? 'payout' : 'deposit'
      setMode(nextMode)
      setSelected(initialCustomer)
      const available = nextMode === 'debt' ? initialCustomer.debt_balance : (initialCustomer.deposit_balance ?? 0)
      setAmount(available > 0 ? (available / 100).toFixed(2) : '')
    }
  }, [open, initialCustomer, canPayout])

  // Скан картки клієнта при відкритій модалці — одразу вибирає клієнта тут,
  // а не чіпляє його до чека
  useEffect(() => {
    if (!open) return
    const handler = (event: Event) => {
      const c = (event as CustomEvent<any>).detail
      if (!c?.id) return
      event.preventDefault()
      setSelected({
        id: c.id,
        full_name: c.full_name ?? null,
        phone: c.phone,
        debt_balance: c.debt_balance ?? 0,
        deposit_balance: c.deposit_balance ?? 0,
      })
      const available = mode === 'debt' ? (c.debt_balance ?? 0) : mode === 'payout' ? (c.deposit_balance ?? 0) : 0
      setAmount(available > 0 ? (available / 100).toFixed(2) : '')
      toast.success(`Картка клієнта: ${c.full_name ?? c.phone}`)
    }
    window.addEventListener('forsage:pos-customer-scanned', handler)
    return () => window.removeEventListener('forsage:pos-customer-scanned', handler)
  }, [open, mode])

  // Початковий список: для боргу — боржники, для рахунку — нічого (тільки пошук)
  useEffect(() => {
    if (!open) return
    if (initialCustomer) {
      setSelected(initialCustomer)
      const available = mode === 'debt'
        ? initialCustomer.debt_balance
        : mode === 'payout' ? (initialCustomer.deposit_balance ?? 0) : 0
      setAmount(available > 0 ? (available / 100).toFixed(2) : '')
    } else {
      setSelected(null)
      setAmount('')
    }
    if (mode === 'debt') {
      setLoading(true)
      posCustomerMoneyApi.listDebtors(100)
        .then((r) => setCustomers((r.data ?? []).filter((c) => c.debt_balance > 0)))
        .catch(() => toast.error('Не вдалося завантажити список боргів'))
        .finally(() => setLoading(false))
    } else {
      setCustomers([])
    }
  }, [open, mode, initialCustomer])

  useEffect(() => {
    if (!open || search.length < 2) return
    const timer = window.setTimeout(() => {
      setLoading(true)
      posCustomerMoneyApi.searchCustomers({ search, has_debt: mode === 'debt', limit: 50 })
        .then((r) => setCustomers(mode === 'debt' ? (r.data?.filter((c) => c.debt_balance > 0) ?? []) : mode === 'payout' ? (r.data?.filter((c) => (c.deposit_balance ?? 0) > 0) ?? []) : (r.data ?? [])))
        .catch(() => {})
        .finally(() => setLoading(false))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search, open, mode])

  async function handleSubmit() {
    if (!selected) return
    const kopecks = Math.round(parseFloat(amount || '0') * 100)
    if (kopecks <= 0) { toast.error('Вкажіть суму'); return }
    if (mode === 'debt' && kopecks > selected.debt_balance) { toast.error('Сума перевищує борг'); return }
    if (mode === 'payout' && kopecks > (selected.deposit_balance ?? 0)) {
      toast.error('Сума видачі перевищує кошти на рахунку клієнта')
      return
    }

    setSaving(true)
    try {
      const shiftId = currentShift?.id ?? null
      if (mode === 'debt') {
        await posCustomerMoneyApi.payDebt(selected.id, { amount: kopecks, method, shift_id: shiftId })
        toast.success(`Борг оплачено: ${formatMoney(kopecks)}`)
      } else if (mode === 'payout') {
        const res = await posCustomerMoneyApi.payOutDeposit(selected.id, {
          amount: kopecks, method, shift_id: shiftId,
          notes: 'Видача коштів клієнту після скасування замовлення',
        })
        toast.success(`Клієнту видано: ${formatMoney(kopecks)}. Залишок: ${formatMoney(res.data.balance)}`)
      } else {
        const res = await posCustomerMoneyApi.addDeposit(selected.id, { amount: kopecks, method, shift_id: shiftId })
        toast.success(`Рахунок поповнено: ${formatMoney(kopecks)}. Баланс: ${formatMoney(res.data.balance)}`)
      }
      onPaid()
      onClose()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
    finally { setSaving(false) }
  }

  if (!open) return null
  const isDebt = mode === 'debt'
  const isPayout = mode === 'payout'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {isDebt ? <DollarSign size={18} className="text-red-400" /> : <Wallet size={18} className={isPayout ? 'text-yellow-400' : 'text-emerald-400'} />}
            <h2 className="text-white text-lg font-bold">Гроші клієнта</h2>
          </div>
          <button onClick={onClose} aria-label="Закрити" className="text-gray-500 hover:text-white"><X size={20} /></button>
        </div>
        <div className={`mb-4 grid ${canPayout ? 'grid-cols-3' : 'grid-cols-2'} gap-2 rounded-xl bg-[#111] p-1`}>
          {([
            { id: 'debt', label: 'Закрити борг' },
            { id: 'deposit', label: 'Поповнити' },
            { id: 'payout', label: 'Видати' },
          ] as const).filter((tab) => tab.id !== 'payout' || canPayout).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMode(tab.id)}
              className={`rounded-lg px-2 py-2 text-xs font-bold transition ${
                mode === tab.id ? 'bg-yellow-400 text-black' : 'text-gray-400 hover:bg-[#2C2C2C] hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>


        <div className="mb-4 rounded-xl border border-yellow-700/40 bg-yellow-950/20 px-3 py-2 text-xs leading-relaxed text-yellow-100">
          {isPayout
            ? 'Видача зменшує єдиний баланс клієнта. Можна видати всю суму або лише частину.'
            : mode === 'deposit'
              ? <>Передоплату приймайте через <b>«Замовлення / передоплата»</b>, щоб гроші були прив’язані до замовлення.</>
              : 'Тут касир приймає повну або часткову оплату боргу клієнта.'}
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-gray-400 text-xs mb-1 block">
              {isDebt ? 'Пошук у списку боржників' : 'Пошук клієнта (телефон або ПІБ)'}
            </label>
            <input type="text" autoFocus value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Телефон або ПІБ..."
              data-scanner-ignore="true"
              className={`w-full bg-[#2C2C2C] text-white rounded-xl px-4 py-3 border border-gray-700 focus:outline-none text-sm ${
                isDebt ? 'focus:border-red-500' : 'focus:border-emerald-500'
              }`} />
          </div>

          {loading && <p className="text-gray-500 text-xs text-center">Пошук...</p>}

          {selected ? (
            <div className={`rounded-xl border p-3 ${isDebt ? 'bg-red-900/20 border-red-500/30' : isPayout ? 'bg-yellow-900/20 border-yellow-500/30' : 'bg-emerald-900/20 border-emerald-500/30'}`}>
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-white font-medium text-sm">{selected.full_name || '—'}</p>
                  <p className="text-gray-400 text-xs">{selected.phone}</p>
                </div>
                <div className="flex items-start gap-3 text-right">
                  <button onClick={() => { setSelected(null); setAmount('') }}
                    className="text-xs text-gray-400 hover:text-white">Змінити</button>
                  <div>
                    {isDebt ? (
                      <>
                        <p className="text-red-400 text-xs">Борг:</p>
                        <p className="text-red-400 font-bold text-lg">{formatMoney(selected.debt_balance)}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-emerald-400 text-xs">На рахунку:</p>
                        <p className="text-emerald-400 font-bold text-lg">{formatMoney(selected.deposit_balance ?? 0)}</p>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <p className="mb-2 text-xs text-gray-500">
                {loading
                  ? 'Завантаження...'
                  : isDebt
                    ? `Боржники (${customers.length}) — можна прокручувати та обрати без пошуку`
                    : (search.length < 2 ? 'Введіть телефон або ім\'я клієнта' : `Знайдено: ${customers.length}`)}
              </p>
              <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
                {customers.map((c) => (
                  <button key={c.id}
                    onClick={() => {
                      setSelected(c)
                      const available = isDebt ? c.debt_balance : isPayout ? (c.deposit_balance ?? 0) : 0
                      setAmount(available > 0 ? (available / 100).toFixed(2) : '')
                    }}
                    className="w-full flex justify-between items-center px-3 py-2 rounded-xl bg-[#2C2C2C] hover:bg-gray-700 text-left">
                    <div>
                      <p className="text-white text-sm">{c.full_name || '—'}</p>
                      <p className="text-gray-400 text-xs">{c.phone}</p>
                    </div>
                    {isDebt ? (
                      <span className="text-red-400 font-bold text-sm">{formatMoney(c.debt_balance)}</span>
                    ) : (
                      <span className="text-emerald-400 font-bold text-sm">{formatMoney(c.deposit_balance ?? 0)}</span>
                    )}
                  </button>
                ))}
                {!loading && customers.length === 0 && (isDebt || search.length >= 2) && (
                  <p className="py-6 text-center text-sm text-gray-500">{isDebt ? 'Боргів не знайдено' : 'Клієнтів не знайдено'}</p>
                )}
              </div>
            </div>
          )}

          {selected && (
            <>
              <div>
                <label className="text-gray-400 text-xs mb-1 block">
                  {isDebt ? 'Сума оплати боргу (₴)' : isPayout ? 'Сума видачі клієнту (₴)' : 'Сума поповнення (₴)'}
                </label>
                <input type="number" min="0.01" step="0.01" autoFocus value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
                  data-scanner-ignore="true"
                  className={`w-full bg-[#2C2C2C] text-white text-2xl font-bold text-center rounded-xl px-4 py-3 border border-gray-700 focus:outline-none ${
                    isDebt ? 'focus:border-red-500' : 'focus:border-emerald-500'
                  }`} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setMethod('cash')}
                  className={`py-3 rounded-xl font-semibold text-sm transition-colors ${
                    method === 'cash'
                      ? 'bg-green-500 text-white' : 'bg-[#2C2C2C] text-gray-300 hover:bg-gray-700'
                  }`}>
                  💵 Готівка
                </button>
                <button onClick={() => setMethod('card')}
                  className={`py-3 rounded-xl font-semibold text-sm transition-colors ${
                    method === 'card'
                      ? 'bg-blue-500 text-white' : 'bg-[#2C2C2C] text-gray-300 hover:bg-gray-700'
                  }`}>
                  💳 Картка
                </button>
              </div>

              <div className="flex gap-3">
                <button onClick={onClose}
                  className="flex-1 py-3 rounded-xl bg-[#2C2C2C] text-gray-300 font-semibold hover:bg-gray-700">
                  Скасувати
                </button>
                <button onClick={handleSubmit} disabled={saving || !amount}
                  className={`flex-1 py-3 rounded-xl text-white font-bold disabled:opacity-40 ${
                    isDebt ? 'bg-red-500 hover:bg-red-400' : isPayout ? 'bg-yellow-500 hover:bg-yellow-400 text-black' : 'bg-emerald-600 hover:bg-emerald-500'
                  }`}>
                  {saving ? 'Обробка...' : isDebt ? 'ОПЛАТИТИ БОРГ' : isPayout ? 'ВИДАТИ КЛІЄНТУ' : 'ПОПОВНИТИ РАХУНОК'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
