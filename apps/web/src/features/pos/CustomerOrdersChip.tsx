import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { formatMoney } from '@/lib/utils'
import { desktopBridge } from '@/lib/desktopBridge'
import { customerOrdersSummary, type CustomerOrderMoney } from './customerOrdersSummary'

/**
 * 22.11.2026 (етап 5 плану замовлень): щойно в чек вибрано клієнта, касир бачить його відкриті замовлення,
 * скільки вже внесено і скільки лишилось доплатити, а також борг. Натиск відкриває ці замовлення для видачі.
 * Лише читання; помилка читання не показується як «замовлень немає».
 */
export function CustomerOrdersChip({ customerId, phone, debtBalance }: { customerId: string; phone: string | null; debtBalance: number }) {
  const [, setSearchParams] = useSearchParams()
  const [state, setState] = useState<{ customerId: string; orders: CustomerOrderMoney[] | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    setState(null)
    // Перше читання, що не вдалося, показуємо як помилку; невдале оновлення лишає попередні дані.
    // Каса читає замовлення зі своєї бази; закриті відсіює підсумок. Без локальної бази плашки немає.
    const read = desktopBridge()?.orders?.listReady
    if (!read) return
    const load = (first: boolean) => read({ customer_id: customerId, limit: 50 })
      .then(rows => { if (!cancelled) setState({ customerId, orders: Array.isArray(rows) ? rows as CustomerOrderMoney[] : [] }) })
      .catch(() => { if (!cancelled && first) setState({ customerId, orders: null }) })
    void load(true)
    const refresh = () => { void load(false) }
    window.addEventListener('forsage:desktop-sync-completed', refresh)
    return () => { cancelled = true; window.removeEventListener('forsage:desktop-sync-completed', refresh) }
  }, [customerId])

  const debt = debtBalance > 0 ? <span className="text-red-400">Борг клієнта: {formatMoney(debtBalance)}</span> : null
  if (!state || state.customerId !== customerId) return debt ? <span className="text-[10px]">{debt}</span> : null
  if (state.orders === null) return <span className="text-[10px] text-amber-400">Замовлення клієнта не завантажились{debt ? ' · ' : ''}{debt}</span>
  const summary = customerOrdersSummary(state.orders)
  if (!summary.count) return debt ? <span className="text-[10px]">{debt}</span> : null
  const open = () => {
    const query = (phone ?? '').trim()
    if (query) setSearchParams(prev => { const next = new URLSearchParams(prev); next.set('customer', query); return next }, { replace: true })
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-[10px]">
      <button type="button" onClick={open} title="Показати замовлення цього клієнта"
        className="rounded bg-blue-900/60 px-1.5 py-0.5 font-semibold text-blue-200 underline decoration-dotted underline-offset-2 hover:bg-blue-800">
        Замовлень: {summary.count}{summary.ready ? ` · готові до видачі: ${summary.ready}` : ''}
      </button>
      {summary.paid > 0 && <span className="text-green-400">внесено {formatMoney(summary.paid)}</span>}
      {summary.due > 0 && <span className="text-yellow-300">доплатити {formatMoney(summary.due)}</span>}
      {debt}
    </span>
  )
}
