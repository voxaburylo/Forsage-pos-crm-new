import { useState, useEffect, useMemo } from 'react'
import { DollarSign, X } from 'lucide-react'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'
import { shiftApi } from './shiftApi'
import { desktopBridge } from '@/lib/desktopBridge'

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
    // Desktop: боржники з локальної бази (працює офлайн)
    const desktop = desktopBridge()
    if (desktop) {
      desktop.pos.listDebtors(200)
        .then((rows) => setCustomers(rows.map((c) => ({
          id: c.id, full_name: c.full_name, phone: c.phone ?? '', debt_balance: c.debt_balance,
        }))))
        .catch(() => toast.error('Не вдалося завантажити список боргів'))
        .finally(() => setLoading(false))
      return
    }
    api.get<{ data: Customer[] }>('/api/v1/customers?has_debt=true&sort=debt&per_page=200')
      .then((r) => setCustomers((r.data ?? []).filter((c) => c.debt_balance > 0)))
      .catch(() => toast.error('Не вдалося завантажити список боргів'))
      .finally(() => setLoading(false))
  }, [open])

  const visibleCustomers = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('uk-UA')
    if (!query) return customers
    return customers.filter((customer) =>
      customer.phone.includes(query)
      || (customer.full_name ?? '').toLocaleLowerCase('uk-UA').includes(query),
    )
  }, [customers, search])

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
      <div role="dialog" aria-modal="true" aria-label="Оплата боргу" className="relative mx-4 flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-gray-700 bg-[#1A1A1A] p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <DollarSign size={18} className="text-red-400" />
            <h2 className="text-white text-lg font-bold">Оплата боргу</h2>
          </div>
          <button onClick={onClose} aria-label="Закрити оплату боргу" className="text-gray-500 hover:text-white"><X size={20} /></button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="shrink-0">
            <label className="text-gray-400 text-xs mb-1 block">Пошук у списку боржників</label>
            <input type="text" autoFocus value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setSearch('') }}
              placeholder="Телефон або ім'я..."
              className="w-full bg-[#2C2C2C] text-white rounded-xl px-4 py-3 border border-gray-700 focus:outline-none focus:border-red-500 text-sm" />
          </div>

          <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[1.15fr_0.85fr]">
            <section className="flex min-h-0 flex-col rounded-xl border border-gray-800 bg-[#151515] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-white">Існуючі борги</p>
                <span className="rounded-full bg-red-900/30 px-2 py-0.5 text-xs font-bold text-red-300">{visibleCustomers.length}</span>
              </div>
              <p className="mb-2 text-xs text-gray-500">Прокрутіть список і виберіть клієнта</p>
              <div className="min-h-48 flex-1 space-y-1 overflow-y-auto pr-1 md:min-h-0">
                {loading && <p className="py-6 text-center text-xs text-gray-500">Завантаження боргів...</p>}
                {!loading && visibleCustomers.map((customer) => (
                  <button key={customer.id} type="button"
                    onClick={() => { setSelected(customer); setAmount((customer.debt_balance / 100).toFixed(2)) }}
                    className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left ${selected?.id === customer.id ? 'border-red-500 bg-red-900/25' : 'border-transparent bg-[#2C2C2C] hover:bg-gray-700'}`}>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">{customer.full_name || 'Без імені'}</p>
                      <p className="text-xs text-gray-400">{customer.phone}</p>
                    </div>
                    <span className="shrink-0 pl-3 text-sm font-bold text-red-400">{formatMoney(customer.debt_balance)}</span>
                  </button>
                ))}
                {!loading && visibleCustomers.length === 0 && (
                  <p className="py-8 text-center text-sm text-gray-500">Боргів не знайдено</p>
                )}
              </div>
            </section>

            <section className="min-h-0 overflow-y-auto rounded-xl border border-gray-800 bg-[#202020] p-4">
              {!selected ? (
                <div className="flex h-full min-h-48 flex-col items-center justify-center text-center">
                  <DollarSign size={28} className="mb-2 text-gray-600" />
                  <p className="text-sm font-semibold text-gray-300">Виберіть клієнта зі списку</p>
                  <p className="mt-1 text-xs text-gray-500">Тут з'явиться сума та спосіб оплати боргу</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-xl border border-red-500/30 bg-red-900/20 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">{selected.full_name || 'Без імені'}</p>
                        <p className="text-xs text-gray-400">{selected.phone}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xs text-red-400">Загальний борг</p>
                        <p className="text-lg font-bold text-red-400">{formatMoney(selected.debt_balance)}</p>
                      </div>
                    </div>
                  </div>

              <div>
                <label className="text-gray-400 text-xs mb-1 block">Сума оплати (₴)</label>
                <input type="number" min="0.01" step="0.01" autoFocus value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handlePay() }}
                  className="w-full bg-[#2C2C2C] text-white text-2xl font-bold text-center rounded-xl px-4 py-3 border border-gray-700 focus:outline-none focus:border-red-500" />
                  <button type="button" onClick={() => setAmount((selected.debt_balance / 100).toFixed(2))}
                    className="mt-2 text-xs font-semibold text-red-300 hover:text-red-200">
                    Погасити весь борг
                  </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setMethod('cash')}
                  className={`py-3 rounded-xl font-semibold text-sm transition-colors ${
                    method === 'cash'
                      ? 'bg-green-500 text-white' : 'bg-[#2C2C2C] text-gray-300 hover:bg-gray-700'
                  }`}>
                  💵 Готівка
                </button>
                <button type="button" onClick={() => setMethod('card')}
                  className={`py-3 rounded-xl font-semibold text-sm transition-colors ${
                    method === 'card'
                      ? 'bg-blue-500 text-white' : 'bg-[#2C2C2C] text-gray-300 hover:bg-gray-700'
                  }`}>
                  💳 Картка
                </button>
              </div>

              <div className="flex gap-3">
                <button type="button" onClick={handlePay} disabled={saving || !amount}
                  className="w-full rounded-xl bg-red-500 py-3 font-bold text-white hover:bg-red-400 disabled:opacity-40">
                  {saving ? 'Обробка...' : 'ОПЛАТИТИ БОРГ'}
                </button>
              </div>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
