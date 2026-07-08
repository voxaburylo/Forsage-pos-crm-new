import { useState, useEffect } from 'react'
import { DollarSign, Wallet, X } from 'lucide-react'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'
import { shiftApi } from './shiftApi'

interface Customer {
  id: string
  full_name: string | null
  phone: string
  debt_balance: number
  deposit_balance?: number
}

interface Props {
  open: boolean
  onClose: () => void
  onPaid: () => void
}

// Дві грошові операції з клієнтом на касі: погашення боргу і поповнення
// рахунку (передплата). З рахунку потім оплачуються замовлення.
export function DebtPaymentModal({ open, onClose, onPaid }: Props) {
  const [mode, setMode] = useState<'debt' | 'deposit'>('debt')
  const [search, setSearch] = useState('')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Customer | null>(null)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<'cash' | 'card'>('cash')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      setSelected(null); setAmount(''); setMethod('cash'); setSearch(''); setCustomers([]); setMode('debt')
      return
    }
  }, [open])

  // Початковий список: для боргу — боржники, для рахунку — нічого (тільки пошук)
  useEffect(() => {
    if (!open) return
    setSelected(null)
    setAmount('')
    if (mode === 'debt') {
      setLoading(true)
      api.get<{ data: Customer[] }>('/api/v1/customers?has_debt=true&sort=debt&per_page=100')
        .then((r) => setCustomers((r.data ?? []).filter((c) => c.debt_balance > 0)))
        .catch(() => toast.error('Не вдалося завантажити список боргів'))
        .finally(() => setLoading(false))
    } else {
      setCustomers([])
    }
  }, [open, mode])

  useEffect(() => {
    if (!open || search.length < 2) return
    const timer = window.setTimeout(() => {
      setLoading(true)
      const url = mode === 'debt'
        ? `/api/v1/customers?search=${encodeURIComponent(search)}&has_debt=true&per_page=50`
        : `/api/v1/customers?search=${encodeURIComponent(search)}&per_page=50`
      api.get<{ data: Customer[] }>(url)
        .then((r) => setCustomers(mode === 'debt' ? (r.data?.filter((c) => c.debt_balance > 0) ?? []) : (r.data ?? [])))
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

    setSaving(true)
    try {
      const shift = await shiftApi.current().catch(() => null)
      const shiftId = (shift as any)?.data?.id ?? null
      if (mode === 'debt') {
        await api.post(`/api/v1/customers/${selected.id}/pay-debt`, {
          amount: kopecks, method,
          shift_id: shiftId,
        })
        toast.success(`Борг оплачено: ${formatMoney(kopecks)}`)
      } else {
        const res = await api.post<{ data: { balance: number } }>(`/api/v1/customers/${selected.id}/deposit`, {
          amount: kopecks, method,
          shift_id: shiftId,
        })
        toast.success(`Рахунок поповнено: ${formatMoney(kopecks)}. Баланс: ${formatMoney(res.data.balance)}`)
      }
      onPaid()
      onClose()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
    finally { setSaving(false) }
  }

  if (!open) return null
  const isDebt = mode === 'debt'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {isDebt ? <DollarSign size={18} className="text-red-400" /> : <Wallet size={18} className="text-emerald-400" />}
            <h2 className="text-white text-lg font-bold">{isDebt ? 'Оплата боргу' : 'Рахунок клієнта'}</h2>
          </div>
          <button onClick={onClose} aria-label="Закрити" className="text-gray-500 hover:text-white"><X size={20} /></button>
        </div>

        {/* Перемикач: борг / поповнення рахунку */}
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-[#2C2C2C] p-1">
          <button onClick={() => setMode('debt')}
            className={`py-2 rounded-lg text-sm font-semibold transition-colors ${
              isDebt ? 'bg-red-500/90 text-white' : 'text-gray-400 hover:text-white'
            }`}>
            Погасити борг
          </button>
          <button onClick={() => setMode('deposit')}
            className={`py-2 rounded-lg text-sm font-semibold transition-colors ${
              !isDebt ? 'bg-emerald-600 text-white' : 'text-gray-400 hover:text-white'
            }`}>
            Поповнити рахунок
          </button>
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
            <div className={`rounded-xl border p-3 ${isDebt ? 'bg-red-900/20 border-red-500/30' : 'bg-emerald-900/20 border-emerald-500/30'}`}>
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
                    onClick={() => { setSelected(c); if (isDebt) setAmount((c.debt_balance / 100).toFixed(2)) }}
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
                  {isDebt ? 'Сума оплати (₴)' : 'Сума поповнення (₴)'}
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
                    isDebt ? 'bg-red-500 hover:bg-red-400' : 'bg-emerald-600 hover:bg-emerald-500'
                  }`}>
                  {saving ? 'Обробка...' : isDebt ? 'ОПЛАТИТИ БОРГ' : 'ПОПОВНИТИ РАХУНОК'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
