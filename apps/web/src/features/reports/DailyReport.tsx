import { useEffect, useState } from 'react'
import { BarChart2, AlertTriangle, Users, TrendingUp } from 'lucide-react'
import { reportApi } from './reportApi'
import type { SalesPeriodReport, LowStockProduct, Debtor } from '@/types/report'
import { Layout } from '@/components/Layout'
import { Card, Table, Badge } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDateTime } from '@/lib/utils'

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', debt: 'Борг',
}

export default function DailyReport() {
  const [tab, setTab]               = useState<'today' | 'period' | 'lowstock' | 'debtors'>('today')
  const [dateFrom, setDateFrom]     = useState('')
  const [dateTo, setDateTo]         = useState('')
  const [report, setReport]         = useState<SalesPeriodReport | null>(null)
  const [lowStock, setLowStock]     = useState<LowStockProduct[]>([])
  const [debtors, setDebtors]       = useState<Debtor[]>([])
  const [loading, setLoading]       = useState(false)

  async function loadToday() {
    setLoading(true)
    try {
      const [{ data: summary }, { data: period }] = await Promise.all([
        reportApi.salesToday(),
        reportApi.salesPeriod(),
      ])
      setReport({ ...summary, sales: period.sales })
    } catch { toast.error('Помилка завантаження звіту') }
    finally { setLoading(false) }
  }

  async function loadPeriod() {
    setLoading(true)
    try {
      const { data } = await reportApi.salesPeriod(dateFrom || undefined, dateTo || undefined)
      setReport(data)
    } catch { toast.error('Помилка завантаження звіту') }
    finally { setLoading(false) }
  }

  async function loadLowStock() {
    setLoading(true)
    try {
      const { data } = await reportApi.lowStock()
      setLowStock(data)
    } catch { toast.error('Помилка завантаження') }
    finally { setLoading(false) }
  }

  async function loadDebtors() {
    setLoading(true)
    try {
      const { data } = await reportApi.debtors()
      setDebtors(data)
    } catch { toast.error('Помилка завантаження') }
    finally { setLoading(false) }
  }

  useEffect(() => {
    if (tab === 'today')    loadToday()
    if (tab === 'lowstock') loadLowStock()
    if (tab === 'debtors')  loadDebtors()
  }, [tab])  // eslint-disable-line react-hooks/exhaustive-deps

  const TABS = [
    { id: 'today',    label: 'Сьогодні',      icon: <TrendingUp size={16} /> },
    { id: 'period',   label: 'За період',      icon: <BarChart2 size={16} /> },
    { id: 'lowstock', label: 'Мало товару',    icon: <AlertTriangle size={16} /> },
    { id: 'debtors',  label: 'Боржники',       icon: <Users size={16} /> },
  ] as const

  return (
    <Layout title="Звіти">
      {/* Таби */}
      <div className="flex gap-2 mb-6">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-accent text-black' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Сьогодні / За період — summary + таблиця */}
      {(tab === 'today' || tab === 'period') && (
        <>
          {/* Фільтр дат для "За період" */}
          {tab === 'period' && (
            <Card className="mb-4">
              <div className="flex items-end gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Від</label>
                  <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">До</label>
                  <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                </div>
                <button onClick={loadPeriod}
                  className="bg-accent hover:bg-accent-dark text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors">
                  Показати
                </button>
              </div>
            </Card>
          )}

          {/* Картки-підсумки */}
          {report && (
            <>
              <div className="grid grid-cols-4 gap-4 mb-4">
                {[
                  { label: 'Продажів',  value: String(report.total_sales) },
                  { label: 'Виручка',   value: formatMoney(report.total_revenue) },
                  { label: 'Готівка',   value: formatMoney(report.by_method.cash) },
                  { label: 'Картка',    value: formatMoney(report.by_method.card) },
                ].map(({ label, value }) => (
                  <Card key={label}>
                    <p className="text-xs text-gray-400 mb-1">{label}</p>
                    <p className="text-xl font-bold text-gray-900">{value}</p>
                  </Card>
                ))}
              </div>

              {/* Таблиця продажів */}
              <Card padding="none">
                <Table
                  columns={[
                    { key: 'num',  header: 'Чек',     render: (s) => <span className="font-mono text-xs">#{s.sale_number}</span> },
                    { key: 'cust', header: 'Клієнт',  render: (s) => <span className="text-gray-600">{s.customer?.full_name ?? s.customer?.phone ?? '—'}</span> },
                    { key: 'pay',  header: 'Оплата',  render: (s) => <Badge color={s.payment_method === 'debt' ? 'red' : s.payment_method === 'card' ? 'blue' : 'green'}>{PAYMENT_LABELS[s.payment_method]}</Badge> },
                    { key: 'total', header: 'Сума', className: 'text-right', render: (s) => <span className="font-semibold">{formatMoney(s.total)}</span> },
                    { key: 'date', header: 'Час',     className: 'text-right', render: (s) => <span className="text-gray-400 text-xs">{formatDateTime(s.completed_at)}</span> },
                  ]}
                  data={report.sales}
                  keyFn={(s) => s.id}
                  loading={loading}
                  empty={<p className="text-gray-400 text-sm">Продажів немає</p>}
                />
              </Card>
            </>
          )}
        </>
      )}

      {/* Мало товару */}
      {tab === 'lowstock' && (
        <Card padding="none">
          <Table
            columns={[
              { key: 'sku',  header: 'Артикул', render: (p) => <span className="font-mono text-xs text-gray-600">{p.sku}</span> },
              { key: 'name', header: 'Назва',   render: (p) => <div><p className="font-medium">{p.name}</p><p className="text-xs text-gray-400">{p.category?.name}</p></div> },
              { key: 'brand', header: 'Бренд',  render: (p) => <span className="text-gray-500">{p.brand?.name ?? '—'}</span> },
              { key: 'qty',  header: 'Залишок', className: 'text-right', render: (p) => (
                <span className={p.qty_on_hand <= 0 ? 'text-red-600 font-bold' : 'text-orange-600 font-bold'}>
                  {p.qty_on_hand} {p.unit}
                </span>
              )},
              { key: 'min',  header: 'Мінімум', className: 'text-right', render: (p) => <span className="text-gray-400">{p.reorder_point} {p.unit}</span> },
            ]}
            data={lowStock}
            keyFn={(p) => p.id}
            loading={loading}
            empty={<p className="text-green-600 text-sm">Всі товари в нормі ✓</p>}
          />
        </Card>
      )}

      {/* Боржники */}
      {tab === 'debtors' && (
        <Card padding="none">
          <Table
            columns={[
              { key: 'phone', header: 'Телефон', render: (d) => <span className="font-mono">{d.phone}</span> },
              { key: 'name',  header: "Ім'я",    render: (d) => <span>{d.full_name ?? '—'}</span> },
              { key: 'debt',  header: 'Борг',    className: 'text-right', render: (d) => (
                <span className="font-bold text-red-600">{formatMoney(d.debt_balance)}</span>
              )},
            ]}
            data={debtors}
            keyFn={(d) => d.id}
            loading={loading}
            empty={<p className="text-green-600 text-sm">Боржників немає ✓</p>}
          />
        </Card>
      )}
    </Layout>
  )
}
