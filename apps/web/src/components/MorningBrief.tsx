import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Sun } from 'lucide-react'
import { desktopBridge } from '@/lib/desktopBridge'
import { businessDateKey, businessDateRangeUtc } from '@/lib/businessDate'
import { formatMoney } from '@/lib/utils'

export type MorningBriefData = {
  yesterdayRevenue: number | null
  negativeStock: number | null
  pendingSync: number | null
  lowStock: number | null
  debtTotal: number | null
  debtCustomers: number | null
}

/** Вчорашня дата за київським календарем (рядок YYYY-MM-DD). */
export function yesterdayKey(now = new Date()): string {
  return businessDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))
}

/**
 * 21.11.2026 (план: «ранкове зведення власнику»). Одним блоком на головній: вчорашня виручка, товари
 * в мінусі (на перерахунок), що не пішло на сервер, що закінчується, борги клієнтів. Лише читання.
 * Кожне число окремо: якщо одне не вдалося прочитати, показуємо «—», а не нуль.
 */
export function MorningBrief() {
  const [data, setData] = useState<MorningBriefData | null>(null)
  useEffect(() => {
    const desktop = desktopBridge()
    if (!desktop?.pos?.dashboardSummary) return
    let alive = true
    const day = yesterdayKey()
    const range = businessDateRangeUtc(day, day)
    const safe = <T,>(promise: Promise<T> | undefined) => (promise ?? Promise.reject(new Error('n/a'))).then(value => value, () => null)
    void Promise.all([
      safe(desktop.pos.dashboardSummary({ date_from: range.from, date_to: range.to })),
      safe(desktop.catalog?.negativeStock?.()),
      safe(desktop.getRuntimeInfo?.()),
    ]).then(([summary, negative, runtime]) => {
      if (!alive) return
      const s = summary as any
      setData({
        yesterdayRevenue: typeof s?.analytics?.total_revenue === 'number' ? s.analytics.total_revenue : null,
        negativeStock: Array.isArray(negative) ? negative.length : null,
        pendingSync: typeof runtime?.pendingOperations === 'number' ? runtime.pendingOperations : null,
        lowStock: typeof s?.low_stock === 'number' ? s.low_stock : null,
        debtTotal: typeof s?.debt?.total === 'number' ? s.debt.total : null,
        debtCustomers: typeof s?.debt?.count === 'number' ? s.debt.count : null,
      })
    })
    return () => { alive = false }
  }, [])
  if (!data) return null
  const show = (value: number | null, render: (value: number) => string) => value === null ? '—' : render(value)
  return (
    <section aria-label="Ранкове зведення" className="mb-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-900"><Sun size={16} /> Зведення на ранок</div>
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <div><div className="text-xs text-gray-500">Виручка вчора</div><div className="font-bold text-gray-900">{show(data.yesterdayRevenue, formatMoney)}</div></div>
        <Link to="/analytics/recount" className="hover:underline"><div className="text-xs text-gray-500">У мінусі (перерахувати)</div><div className={`font-bold ${data.negativeStock ? 'text-red-700' : 'text-gray-900'}`}>{show(data.negativeStock, n => `${n} тов.`)}</div></Link>
        <Link to="/settings?tab=network" className="hover:underline"><div className="text-xs text-gray-500">Не відправлено на сервер</div><div className={`font-bold ${data.pendingSync ? 'text-amber-800' : 'text-gray-900'}`}>{show(data.pendingSync, n => n ? `${n} операцій` : 'усе відправлено')}</div></Link>
        <Link to="/analytics/control" className="hover:underline"><div className="text-xs text-gray-500">Закінчуються</div><div className="font-bold text-gray-900">{show(data.lowStock, n => `${n} тов.`)}</div></Link>
        <Link to="/customers" className="hover:underline"><div className="text-xs text-gray-500">Борги клієнтів</div><div className="font-bold text-gray-900">{show(data.debtTotal, formatMoney)}{data.debtCustomers ? <span className="ml-1 text-xs font-normal text-gray-500">({data.debtCustomers})</span> : null}</div></Link>
      </div>
    </section>
  )
}
