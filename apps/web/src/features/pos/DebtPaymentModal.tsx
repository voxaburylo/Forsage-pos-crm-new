import { useState, useEffect } from 'react'
import { DollarSign, X } from 'lucide-react'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'
import { shiftApi } from './shiftApi'

interface Customer {
  id: string
  full_name: string | null
  phone: string
  debt_balance: number
}

interface Props {
  open: boolean
  onClose: () => void
  onPaid: () => void
}

export function DebtPaymentModal({ open, onClose, onPaid }: Props) {
  const [search, setSearch] = useState('')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Customer | null>(null)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<'cash' | 'card'>('cash')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      setSelected(null); setAmount(''); setMethod('cash'); setSearch(''); setCustomers([])
      return
    }
    setLoading(true)
    api.get<{ data: Customer[] }>('/api/v1/customers?has_debt=true&sort=debt&per_page=100')
      .then((r) => setCustomers((r.data ?? []).filter((c) => c.debt_balance > 0)))
      .catch(() => toast.error('Не вдалося завантажити список боргів'))
      .finally(() => setLoading(false))
  }, [open])

  useEffect(() => {
    if (!open || search.length < 2) return
    const timer = window.setTimeout(() => {
    setLoading(true)
    api.get<{ data: Customer[] }>(`/api/v1/customers?search=${encodeURIComponent(search)}&has_debt=true&per_page=50`)
      .then((r) => setCustomers(r.data?.filter((c) => c.debt_balance > 0) ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search, open])

  async function handlePay() {
    if (!selected) return
    const kopecks = Math.round(parseFloat(amount || '0') * 100)
    if (kopecks <= 0) { toast.error('Вкажіть суму'); return }
    if (kopecks > selected.debt_balance) { toast.error('Сума перевищує борг'); return }

    setSaving(true)
    try {
      const shift = await shiftApi.current().catch(() => null)
      const shiftId = (shift as any)?.data?.id ?? null
      await api.post(`/api/v1/customers/${selected.id}/pay-debt`, {
        amount: kopecks, method,
        shift_id: shiftId,
      })
      toast.success(`Борг оплачено: ${formatMoney(kopecks)}`)
      onPaid()
      onClose()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
    finally { setSaving(false) }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <DollarSign size={18} className="text-red-400" />
            <h2 className="text-white text-lg font-bold">Оплата боргу</h2>
          </div>
          <button onClick={onClose} aria-label="Закрити оплату боргу" className="text-gray-500 hover:text-white"><X size={20} /></button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-gray-400 text-xs mb-1 block">Пошук у списку боржників</label>
            <input type="text" autoFocus value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Телефон або ПІБ..."
              className="w-full bg-[#2C2C2C] text-white rounded-xl px-4 py-3 border border-gray-700 focus:outline-none focus:border-red-500 text-sm" />
          </div>

          {loading && <p className="text-gray-500 text-xs text-center">Пошук...</p>}

          {selected ? (
            <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-3">
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-white font-medium text-sm">{selected.full_name || '—'}</p>
                  <p className="text-gray-400 text-xs">{selected.phone}</p>
                </div>
                <div className="flex items-start gap-3 text-right">
                  <button onClick={() => { setSelected(null); setAmount('') }}
                    className="text-xs text-gray-400 hover:text-white">Змінити</button>
                  <div>
                  <p className="text-red-400 text-xs">Борг:</p>
                  <p className="text-red-400 font-bold text-lg">{formatMoney(selected.debt_balance)}</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <p className="mb-2 text-xs text-gray-500">
                {loading ? 'Завантаження...' : `Боржники (${customers.length}) — можна прокручувати та обрати без пошуку`}
              </p>
              <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
              {customers.map((c) => (
                <button key={c.id}
                  onClick={() => { setSelected(c); setAmount((c.debt_balance / 100).toFixed(2)) }}
                  className="w-full flex justify-between items-center px-3 py-2 rounded-xl bg-[#2C2C2C] hover:bg-gray-700 text-left">
                  <div>
                    <p className="text-white text-sm">{c.full_name || '—'}</p>
                    <p className="text-gray-400 text-xs">{c.phone}</p>
                  </div>
                  <span className="text-red-400 font-bold text-sm">{formatMoney(c.debt_balance)}</span>
                </button>
              ))}
              {!loading && customers.length === 0 && (
                <p className="py-6 text-center text-sm text-gray-500">Боргів не знайдено</p>
              )}
              </div>
            </div>
          )}

          {selected && (
            <>
              <div>
                <label className="text-gray-400 text-xs mb-1 block">Сума оплати (₴)</label>
                <input type="number" min="0.01" step="0.01" autoFocus value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handlePay() }}
                  className="w-full bg-[#2C2C2C] text-white text-2xl font-bold text-center rounded-xl px-4 py-3 border border-gray-700 focus:outline-none focus:border-red-500" />
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
                <button onClick={handlePay} disabled={saving || !amount}
                  className="flex-1 py-3 rounded-xl bg-red-500 text-white font-bold hover:bg-red-400 disabled:opacity-40">
                  {saving ? 'Обробка...' : 'ОПЛАТИТИ БОРГ'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
