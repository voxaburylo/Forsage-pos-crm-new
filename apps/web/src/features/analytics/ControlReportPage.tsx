import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Card } from '@/components/ui'
import { api } from '@/lib/api'
import { formatDate, formatDateTime, formatMoney } from '@/lib/utils'
import {
  COMPARE_ROWS, changePct, defaultPeriod, lossTotal, staleStockCost,
  type ControlLine, type ControlReport,
} from './controlReportModel'

type Tab = 'compare' | 'below' | 'low' | 'stale'

/** «Контроль» для власника: порівняння періодів, продажі нижче закупки, низька націнка, залежані товари. */
export default function ControlReportPage() {
  const [period, setPeriod] = useState(defaultPeriod)
  const [marginPct, setMarginPct] = useState(10)
  const [staleDays, setStaleDays] = useState(90)
  const [report, setReport] = useState<ControlReport | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<Tab>('compare')

  useEffect(() => {
    if (!period.from || !period.to || period.from > period.to) return
    let cancelled = false
    setLoading(true); setError('')
    const query = new URLSearchParams({ from: period.from, to: period.to, margin_pct: String(marginPct), stale_days: String(staleDays) })
    api.get<{ data: ControlReport }>('/api/v1/reports/control?' + query.toString(), { silent: true, timeoutMs: 60_000 })
      .then(({ data }) => { if (!cancelled) setReport(data) })
      .catch(() => { if (!cancelled) setError('Не вдалося побудувати звіт. Перевірте інтернет і спробуйте ще раз.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [period.from, period.to, marginPct, staleDays])

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'compare', label: 'Порівняння періодів' },
    { id: 'below', label: 'Нижче закупки', count: report?.below_cost.length },
    { id: 'low', label: `Націнка до ${marginPct}%`, count: report?.low_margin.length },
    { id: 'stale', label: 'Залежані товари', count: report?.stale.length },
  ]

  return (
    <Layout title="Контроль">
      <Card className="mb-3 flex flex-wrap items-end gap-3 text-sm">
        <label>З <input type="date" value={period.from} onChange={e => setPeriod(p => ({ ...p, from: e.target.value }))} className="ml-1 rounded-lg border border-gray-200 px-2 py-1.5" /></label>
        <label>По <input type="date" value={period.to} onChange={e => setPeriod(p => ({ ...p, to: e.target.value }))} className="ml-1 rounded-lg border border-gray-200 px-2 py-1.5" /></label>
        <label>Низька націнка до
          <select value={marginPct} onChange={e => setMarginPct(Number(e.target.value))} className="ml-1 rounded-lg border border-gray-200 px-2 py-1.5">
            {[5, 10, 15, 20, 30].map(v => <option key={v} value={v}>{v}%</option>)}
          </select>
        </label>
        <label>Без продажів
          <select value={staleDays} onChange={e => setStaleDays(Number(e.target.value))} className="ml-1 rounded-lg border border-gray-200 px-2 py-1.5">
            {[30, 60, 90, 180, 365].map(v => <option key={v} value={v}>{v} днів</option>)}
          </select>
        </label>
        {loading && <span className="text-gray-400">Оновлення…</span>}
      </Card>
      <div className="mb-3 flex flex-wrap gap-2">
        {tabs.map(t => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${tab === t.id ? 'bg-yellow-400 text-gray-900' : 'bg-white text-gray-600 ring-1 ring-gray-200'}`}>
            {t.label}{t.count !== undefined ? <span className="opacity-60"> {t.count}</span> : null}
          </button>
        ))}
      </div>
      {error && <Card className="text-sm text-red-600">{error}</Card>}
      {report && tab === 'compare' && <Compare report={report} />}
      {report && tab === 'below' && <Lines lines={report.below_cost} empty="Продажів нижче закупівельної ціни немає 👍"
        summary={`Втрата на цих рядках: ${formatMoney(-lossTotal(report.below_cost))}`} />}
      {report && tab === 'low' && <Lines lines={report.low_margin} empty="Продажів з низькою націнкою немає"
        summary={`Рядки з націнкою від 0 до ${report.margin_pct}% від ціни продажу`} />}
      {report && tab === 'stale' && <Stale report={report} />}
      <p className="mt-3 text-xs text-gray-400">
        Закупка рядка — ціна закупки на момент продажу. Рядки, де закупка не була відома, не враховуються. Показано до 300 рядків.
      </p>
    </Layout>
  )
}

function Compare({ report }: { report: ControlReport }) {
  return (
    <Card className="p-0">
      <div className="grid grid-cols-4 gap-2 border-b border-gray-100 px-4 py-2 text-xs text-gray-500">
        <span />
        <span className="text-right">{formatDate(report.period.from)} – {formatDate(report.period.to)}</span>
        <span className="text-right">{formatDate(report.previous_period.from)} – {formatDate(report.previous_period.to)}</span>
        <span className="text-right">Зміна</span>
      </div>
      {COMPARE_ROWS.map(row => {
        const current = report.current[row.key], previous = report.previous[row.key]
        const change = changePct(current, previous)
        const good = change === null || change === 0 ? null : (change > 0) === row.goodWhenUp
        return (
          <div key={row.key} className="grid grid-cols-4 gap-2 border-b border-gray-50 px-4 py-2.5 text-sm last:border-0">
            <span className="text-gray-700">{row.label}</span>
            <b className="text-right">{row.money ? formatMoney(current) : current}</b>
            <span className="text-right text-gray-500">{row.money ? formatMoney(previous) : previous}</span>
            <span className={`flex items-center justify-end gap-1 ${good === null ? 'text-gray-400' : good ? 'text-green-600' : 'text-red-600'}`}>
              {change === null ? '—' : <>{change > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}{change > 0 ? '+' : ''}{change}%</>}
            </span>
          </div>
        )
      })}
    </Card>
  )
}

function Lines({ lines, empty, summary }: { lines: ControlLine[]; empty: string; summary: string }) {
  if (!lines.length) return <Card className="text-sm text-gray-500">{empty}</Card>
  return (
    <Card className="p-0">
      <p className="border-b border-gray-100 px-4 py-2 text-xs text-gray-500">{summary}</p>
      {lines.map((line, index) => (
        <div key={line.sale_number + line.product_id + index} className="flex items-center justify-between gap-3 border-b border-gray-50 px-4 py-2 text-sm last:border-0">
          <div className="min-w-0">
            <Link to={`/products/${line.product_id}`} className="block truncate font-medium text-gray-800 hover:underline">{line.name}</Link>
            <p className="text-xs text-gray-500">{[line.sku, `чек ${line.sale_number}`, formatDateTime(line.completed_at), line.employee].filter(Boolean).join(' · ')}</p>
          </div>
          <div className="shrink-0 text-right text-xs">
            <p>{line.qty} шт · продано {formatMoney(line.total)}</p>
            <p className="text-gray-500">закупка {formatMoney(line.cost)}</p>
            <p className={line.margin < 0 ? 'font-semibold text-red-600' : 'text-amber-600'}>
              {line.margin < 0 ? 'збиток ' : 'націнка '}{formatMoney(Math.abs(line.margin))}{line.margin_pct !== null ? ` (${line.margin_pct}%)` : ''}
            </p>
          </div>
        </div>
      ))}
    </Card>
  )
}

function Stale({ report }: { report: ControlReport }) {
  if (!report.stale.length) return <Card className="text-sm text-gray-500">Залежаних товарів немає</Card>
  return (
    <Card className="p-0">
      <p className="border-b border-gray-100 px-4 py-2 text-xs text-gray-500">
        Є на складі, але не продавались {report.stale_days}+ днів. У них заморожено {formatMoney(staleStockCost(report.stale))} за закупкою.
      </p>
      {report.stale.map(row => (
        <div key={row.id} className="flex items-center justify-between gap-3 border-b border-gray-50 px-4 py-2 text-sm last:border-0">
          <div className="min-w-0">
            <Link to={`/products/${row.id}`} className="block truncate font-medium text-gray-800 hover:underline">{row.name}</Link>
            <p className="text-xs text-gray-500">{[row.sku, row.storage_bin && `комірка ${row.storage_bin}`, row.last_sale_at ? `остання продажа ${formatDate(row.last_sale_at)}` : 'жодної продажі'].filter(Boolean).join(' · ')}</p>
          </div>
          <div className="shrink-0 text-right text-xs">
            <p>{row.qty_on_hand} шт</p>
            <p className="text-gray-500">{formatMoney(row.stock_cost)}</p>
          </div>
        </div>
      ))}
    </Card>
  )
}
