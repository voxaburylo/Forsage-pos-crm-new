import { useState, useEffect, useRef, useCallback } from 'react'
import { useDialogEscape } from '@/hooks/useDialogEscape'
import { DollarSign, Package, Wallet, X } from 'lucide-react'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'
import { usePOSStore } from '@/stores/posStore'
import { useAuthStore } from '@/stores/authStore'
import { posCustomerMoneyApi } from './posCustomerMoneyApi'
import { parseCustomerMoney } from '@/features/customers/customerUi'
import { customerApi } from '@/features/customers/customerApi'
import { desktopBridge } from '@/lib/desktopBridge'
import { ReadyOrdersPanel } from './ReadyOrdersPanel'
import { customerOrdersSummary } from './customerOrdersSummary'

interface MoneyCustomer {
  id: string
  full_name: string | null
  phone: string | null
  debt_balance: number
  deposit_balance?: number
}

export type CustomerMoneyMode = 'debt' | 'orders' | 'deposit' | 'payout'

interface Props {
  open: boolean
  onClose: () => void
  onPaid: () => void
  initialCustomer?: MoneyCustomer | null
  /** Яку вкладку відкрити (кнопка «Борг» чи «Замовлення» в чеку); без неї — за станом клієнта. */
  initialMode?: CustomerMoneyMode | null
}

/** 25.11.2026: початкова вкладка — явно вибрана, інакше борг, видача з рахунку або поповнення (як і раніше). */
export function initialSettlementMode(customer: MoneyCustomer, options: { requested?: CustomerMoneyMode | null; ordersAvailable: boolean; canPayout: boolean }): CustomerMoneyMode {
  const { requested, ordersAvailable, canPayout } = options
  if (requested === 'orders' && ordersAvailable) return 'orders'
  if (requested === 'payout' && canPayout) return 'payout'
  if (requested === 'debt' || requested === 'deposit') return requested
  if (customer.debt_balance > 0) return 'debt'
  return canPayout && (customer.deposit_balance ?? 0) > 0 ? 'payout' : 'deposit'
}

/** Сума, яку підставляємо у поле: весь борг або весь залишок рахунку; для поповнення й замовлень — порожньо. */
function availableFor(mode: CustomerMoneyMode, customer: MoneyCustomer | null): number {
  if (!customer) return 0
  return mode === 'debt' ? customer.debt_balance : mode === 'payout' ? (customer.deposit_balance ?? 0) : 0
}

// Одне касове вікно «Розрахунки клієнта»: борг, замовлення (передоплата, доплата, видача), поповнення і видача коштів.
// Видавати кошти можуть лише касир або власник; менеджер тільки скасовує замовлення.
/** Поповнення від 1000 грн підтверджується окремо. */
export const LARGE_TOP_UP_KOPECKS = 100_000

export function DebtPaymentModal({ open, onClose, onPaid, initialCustomer = null, initialMode = null }: Props) {
  const [mode, setMode] = useState<CustomerMoneyMode>('debt')
  const [search, setSearch] = useState('')
  const [customers, setCustomers] = useState<MoneyCustomer[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<MoneyCustomer | null>(null)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<'cash' | 'card'>('cash')
  // Зняття з рахунку: видати клієнту або виправити помилкове поповнення (сторно).
  const [payoutReason, setPayoutReason] = useState<'payout' | 'reversal'>('payout')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const safeClose = () => { if (!busy.current) onClose() }
  useDialogEscape(open, safeClose, { disabled: saving })
  const role = useAuthStore((state) => (state.session?.user?.app_metadata?.role as string) ?? 'cashier')
  const canPayout = role === 'cashier' || role === 'owner' || role === 'admin'
  const currentShift = usePOSStore((state) => state.currentShift)
  // Замовлення каса читає зі своєї бази; без неї (веб) вкладки «Замовлення» немає.
  const ordersAvailable = Boolean(desktopBridge()?.orders?.listReady)
  const [orderSummary, setOrderSummary] = useState<{ customerId: string; count: number; due: number; ready: number } | null>(null)
  // Касир сам вибрав вкладку — не перемикаємо її, коли довантажились замовлення.
  const tabChosen = useRef(false)
  const selectedId = selected?.id ?? null

  const loadOrderSummary = useCallback(async (customerId: string) => {
    const read = desktopBridge()?.orders?.listReady
    if (!read) return null
    try {
      const rows = await read({ customer_id: customerId, limit: 50 })
      return { customerId, ...customerOrdersSummary(Array.isArray(rows) ? rows : []) }
    } catch { return null }
  }, [])

  useEffect(() => {
    setOrderSummary(null)
    if (!open || !selectedId) return
    let active = true
    void loadOrderSummary(selectedId).then((summary) => {
      if (!active || !summary) return
      setOrderSummary(summary)
      // Боргу немає, а відкриті замовлення є — одразу показуємо їх (якщо вкладку не вибрано явно).
      if (summary.count > 0 && !tabChosen.current) setMode((current) => current === 'deposit' || current === 'payout' ? 'orders' : current)
    })
    return () => { active = false }
  }, [open, selectedId, loadOrderSummary])

  /** Після оплати чи видачі замовлення оновлюємо підсумки та баланси клієнта у вікні. */
  async function refreshSelected() {
    if (!selectedId) return
    const id = selectedId
    void loadOrderSummary(id).then((summary) => { if (summary) setOrderSummary((current) => current === null || current.customerId === id ? summary : current) })
    try {
      const { data } = await customerApi.get(id)
      setSelected((current) => current?.id === id ? { ...current, debt_balance: Number(data.debt_balance) || 0, deposit_balance: Number(data.deposit_balance ?? 0) || 0 } : current)
    } catch { /* баланси оновляться при наступному відкритті */ }
    onPaid()
  }

  useEffect(() => {
    if (!open) {
      setSelected(null); setAmount(''); setMethod('cash'); setSearch(''); setCustomers([]); setMode('debt'); setPayoutReason('payout')
      tabChosen.current = false
      return
    }
    tabChosen.current = Boolean(initialMode)
    if (initialCustomer) {
      const nextMode = initialSettlementMode(initialCustomer, { requested: initialMode, ordersAvailable, canPayout })
      setMode(nextMode)
      setSelected(initialCustomer)
      const available = availableFor(nextMode, initialCustomer)
      setAmount(available > 0 ? (available / 100).toFixed(2) : '')
    } else if (initialMode) {
      setMode(initialSettlementMode({ id: '', full_name: null, phone: null, debt_balance: 0 }, { requested: initialMode, ordersAvailable, canPayout }))
    }
  }, [open, initialCustomer, initialMode, canPayout, ordersAvailable])

  // Скан картки клієнта при відкритій модалці — одразу вибирає клієнта тут,
  // а не чіпляє його до чека
  useEffect(() => {
    if (!open) return
    const handler = (event: Event) => {
      const c = (event as CustomEvent<any>).detail
      if (!c?.id) return
      event.preventDefault()
      if (busy.current) return
      setSelected({
        id: c.id,
        full_name: c.full_name ?? null,
        phone: c.phone,
        debt_balance: c.debt_balance ?? 0,
        deposit_balance: c.deposit_balance ?? 0,
      })
      const available = availableFor(mode, { id: c.id, full_name: null, phone: null, debt_balance: c.debt_balance ?? 0, deposit_balance: c.deposit_balance ?? 0 })
      setAmount(available > 0 ? (available / 100).toFixed(2) : '')
      toast.success(`Картка клієнта: ${c.full_name ?? c.phone}`)
    }
    window.addEventListener('forsage:pos-customer-scanned', handler)
    return () => window.removeEventListener('forsage:pos-customer-scanned', handler)
  }, [open, mode])

  // Search and initial debtors share one request lifetime.
  useEffect(() => {
    let active = true
    setCustomers([])
    setLoading(false)
    if (!open) return
    const query = search.trim()
    if (query.length < 2 && mode !== 'debt') return
    setLoading(true)
    const timer = window.setTimeout(() => {
      const promise = query.length >= 2
        ? posCustomerMoneyApi.searchCustomers({ search: query, has_debt: mode === 'debt', limit: 50 })
        : posCustomerMoneyApi.listDebtors(100)
      promise.then(({ data }) => {
        if (!active) return
        setCustomers(mode === 'debt' ? data.filter((c) => c.debt_balance > 0)
          : mode === 'payout' ? data.filter((c) => (c.deposit_balance ?? 0) > 0) : data)
      }).catch((error) => {
        if (active) toast.error(error instanceof Error ? error.message : 'Не вдалося знайти клієнта')
      }).finally(() => { if (active) setLoading(false) })
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [search, open, mode])

  async function handleSubmit() {
    if (!selected || busy.current) return
    const kopecks = parseCustomerMoney(amount)
    if (kopecks === null || kopecks <= 0) { toast.error('Вкажіть коректну суму'); return }
    if (mode === 'debt' && kopecks > selected.debt_balance) { toast.error('Сума перевищує борг'); return }
    if (mode === 'payout' && kopecks > (selected.deposit_balance ?? 0)) {
      toast.error('Сума видачі перевищує кошти на рахунку клієнта')
      return
    }
    // 16.11.2026: на рахунок клієнта помилково «внесли» 2760 грн, яких у касі не було. Велике поповнення —
    // лише після явного підтвердження, що гроші фактично отримано.
    if (mode === 'deposit' && kopecks >= LARGE_TOP_UP_KOPECKS
      && !confirm(`Поповнити рахунок клієнта «${selected.full_name || selected.phone}» на ${formatMoney(kopecks)} (${method === 'cash' ? 'готівкою — гроші мають бути в касі' : 'карткою'})?\n\nЯкщо клієнт грошей не вносив — натисніть «Скасувати».`)) return

    busy.current = true
    setSaving(true)
    try {
      const shiftId = currentShift?.id ?? null
      if (mode === 'debt') {
        await posCustomerMoneyApi.payDebt(selected.id, { amount: kopecks, method, shift_id: shiftId })
        toast.success(`Борг оплачено: ${formatMoney(kopecks)}`)
      } else if (mode === 'payout') {
        const res = await posCustomerMoneyApi.payOutDeposit(selected.id, {
          amount: kopecks, method, shift_id: shiftId,
          notes: payoutReason === 'reversal'
            ? 'Сторно помилкового поповнення рахунку клієнта (кошти клієнт не вносив)'
            : 'Видача коштів клієнту з його рахунку',
        })
        toast.success(payoutReason === 'reversal'
          ? `Помилкове поповнення скасовано: ${formatMoney(kopecks)}. Залишок: ${formatMoney(res.data.balance)}`
          : `Клієнту видано: ${formatMoney(kopecks)}. Залишок: ${formatMoney(res.data.balance)}`)
      } else {
        const res = await posCustomerMoneyApi.addDeposit(selected.id, { amount: kopecks, method, shift_id: shiftId })
        toast.success(`Рахунок поповнено: ${formatMoney(kopecks)}. Баланс: ${formatMoney(res.data.balance)}`)
      }
      onPaid()
      onClose()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
    finally { busy.current = false; setSaving(false) }
  }

  if (!open) return null
  const isDebt = mode === 'debt'
  const isPayout = mode === 'payout'
  const isOrders = mode === 'orders'
  const summary = orderSummary && orderSummary.customerId === selectedId ? orderSummary : null
  const tabs = ([
    { id: 'debt', label: 'Борг' },
    { id: 'orders', label: summary?.count ? `Замовлення (${summary.count})` : 'Замовлення' },
    { id: 'deposit', label: 'Поповнити' },
    { id: 'payout', label: 'Зняти з рахунку' },
  ] as const).filter((tab) => (tab.id !== 'payout' || canPayout) && (tab.id !== 'orders' || ordersAvailable))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={safeClose} />
      <div className={`relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full ${isOrders ? 'max-w-lg' : 'max-w-md'} mx-4 p-6 max-h-[calc(100dvh-2rem)] overflow-y-auto`}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {isDebt ? <DollarSign size={18} className="text-red-400" /> : isOrders ? <Package size={18} className="text-blue-300" /> : <Wallet size={18} className={isPayout ? 'text-yellow-400' : 'text-emerald-400'} />}
            <h2 className="text-white text-lg font-bold">Розрахунки клієнта</h2>
          </div>
          <button onClick={safeClose} disabled={saving} aria-label="Закрити" className="text-gray-500 hover:text-white"><X size={20} /></button>
        </div>
        <fieldset disabled={saving}>
        <div className={`mb-4 grid ${tabs.length === 4 ? 'grid-cols-4' : tabs.length === 3 ? 'grid-cols-3' : 'grid-cols-2'} gap-1.5 rounded-xl bg-[#111] p-1`}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              data-settlement-tab={tab.id}
              onClick={() => {
                tabChosen.current = true
                setMode(tab.id)
                const available = availableFor(tab.id, selected)
                setAmount(available > 0 ? (available / 100).toFixed(2) : '')
              }}
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
            ? (payoutReason === 'reversal'
              ? 'Сторно: якщо рахунок поповнили помилково (клієнт грошей не вносив). Баланс зменшиться, а в зміні буде видача тієї ж суми — це зніме зайвий прихід у касі.'
              : 'Видача зменшує баланс клієнта. Можна видати всю суму або лише частину.')
            : mode === 'deposit'
              ? <>Поповнення — гроші на рахунку клієнта, не привʼязані до замовлення. Передоплату за замовлення вносьте у вкладці <b>«Замовлення»</b>.</>
              : isOrders
                ? 'Передоплата, доплата й видача замовлень цього клієнта. «Видати товар» зʼявляється, коли все в замовленні прибуло.'
                : 'Тут касир приймає повну або часткову оплату боргу клієнта.'}
          {!canPayout && <p className="mt-1 text-yellow-300">Зняти кошти з рахунку може власник, адміністратор або касир.</p>}
        </div>
        {isPayout && (
          <div className="mb-4 grid grid-cols-2 gap-2">
            {([['payout', 'Видати клієнту'], ['reversal', 'Помилкове поповнення']] as const).map(([id, label]) => (
              <button key={id} type="button" onClick={() => setPayoutReason(id)}
                className={`rounded-xl py-2 text-sm font-semibold ${payoutReason === id ? 'bg-yellow-400 text-black' : 'bg-[#2C2C2C] text-gray-300 hover:bg-gray-700'}`}>
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-4">
          {/* Клієнта вже вибрано — пошук не потрібен; «Змінити» повертає його. */}
          {!selected && <div>
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
          </div>}

          {loading && !selected && <p className="text-gray-500 text-xs text-center">Пошук...</p>}

          {selected ? (
            <div className={`rounded-xl border p-3 ${isDebt ? 'bg-red-900/20 border-red-500/30' : isOrders ? 'bg-blue-900/20 border-blue-500/30' : isPayout ? 'bg-yellow-900/20 border-yellow-500/30' : 'bg-emerald-900/20 border-emerald-500/30'}`}>
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
                    ) : isOrders ? (
                      <>
                        <p className="text-blue-300 text-xs">Доплатити за замовлення:</p>
                        <p className="text-blue-200 font-bold text-lg">{summary ? formatMoney(summary.due) : '…'}</p>
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
              {/* Усе про гроші клієнта одним рядком, хоч би яка вкладка відкрита. */}
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-white/10 pt-2 text-[11px]" data-settlement-summary>
                <span className={selected.debt_balance > 0 ? 'text-red-300' : 'text-gray-500'}>Борг: {formatMoney(selected.debt_balance)}</span>
                <span className={(selected.deposit_balance ?? 0) > 0 ? 'text-emerald-300' : 'text-gray-500'}>На рахунку: {formatMoney(selected.deposit_balance ?? 0)}</span>
                {ordersAvailable && (summary
                  ? <span className={summary.count ? 'text-blue-300' : 'text-gray-500'}>Замовлень: {summary.count}{summary.ready ? ` · готові: ${summary.ready}` : ''}{summary.due ? ` · доплатити ${formatMoney(summary.due)}` : ''}</span>
                  : <span className="text-gray-500">Замовлення…</span>)}
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

          {selected && isOrders && (
            <>
              <div className="rounded-xl border border-gray-800 bg-[#151515]" data-settlement-orders>
                <ReadyOrdersPanel embeddedCustomerId={selected.id} onChanged={() => { void refreshSelected() }} />
              </div>
              <button type="button" onClick={safeClose}
                className="w-full py-3 rounded-xl bg-[#2C2C2C] text-gray-300 font-semibold hover:bg-gray-700">
                Готово
              </button>
            </>
          )}

          {selected && !isOrders && (
            <>
              <div>
                <label className="text-gray-400 text-xs mb-1 block">
                  {isDebt ? 'Сума оплати боргу (₴)' : isPayout ? (payoutReason === 'reversal' ? 'Сума помилкового поповнення (₴)' : 'Сума видачі клієнту (₴)') : 'Сума поповнення (₴)'}
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
                <button onClick={safeClose}
                  className="flex-1 py-3 rounded-xl bg-[#2C2C2C] text-gray-300 font-semibold hover:bg-gray-700">
                  Скасувати
                </button>
                <button onClick={handleSubmit} disabled={saving || !amount}
                  className={`flex-1 py-3 rounded-xl text-white font-bold disabled:opacity-40 ${
                    isDebt ? 'bg-red-500 hover:bg-red-400' : isPayout ? 'bg-yellow-500 hover:bg-yellow-400 text-black' : 'bg-emerald-600 hover:bg-emerald-500'
                  }`}>
                  {saving ? 'Обробка...' : isDebt ? 'ОПЛАТИТИ БОРГ' : isPayout ? (payoutReason === 'reversal' ? 'СКАСУВАТИ ПОПОВНЕННЯ' : 'ВИДАТИ КЛІЄНТУ') : 'ПОПОВНИТИ РАХУНОК'}
                </button>
              </div>
            </>
          )}
        </div>
        </fieldset>
      </div>
    </div>
  )
}
