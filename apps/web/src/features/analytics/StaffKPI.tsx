import { useState, useEffect, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card, Button, Modal, Input, Badge } from '@/components/ui'
import { formatMoney } from '@/lib/utils'
import { adminApi, AdminUser } from '@/features/admin/adminApi'
import { useAuthStore } from '@/stores/authStore'
import { Target, TrendingUp, TrendingDown, Plus, Printer, Loader2, Award, Calendar, BarChart3 } from 'lucide-react'

interface KPIStaff {
  manager_id: string
  manager_name: string
  total_revenue: number
  receipt_count: number
  average_receipt: number
  total_discounts: number
  discount_pct: number
  returns_count: number
  returns_amount: number
}

interface KPITargets {
  sales_revenue?: number
  sales_count?: number
  orders_count?: number
  avg_check?: number
}

interface KPICalculationResult {
  user_id: string
  period: string
  fact: {
    sales_revenue: number
    sales_count: number
    orders_count: number
    avg_check: number
  }
  targets: KPITargets
}

type PeriodType = 'month' | 'quarter'

function getPrevPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number)
  const d = new Date(year, month - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function StaffKPI() {
  const session = useAuthStore((s) => s.session)
  const userRole = session?.user?.user_metadata?.role as string | undefined
  const currentUserId = session?.user?.id

  const isOwnerOrAdmin = ['owner', 'admin'].includes(userRole ?? '')

  // Режими табів: 'leaderboard' | 'progress'
  const [activeTab, setActiveTab] = useState<'leaderboard' | 'progress'>('leaderboard')

  // Стан для таба Лідерборд
  const [leaderboardItems, setLeaderboardItems] = useState<KPIStaff[]>([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)
  const [leaderboardPeriod, setLeaderboardPeriod] = useState<PeriodType>('month')

  // Стан для таба Цілі та Прогрес
  const [users, setUsers] = useState<AdminUser[]>([])
  const [selectedUserId, setSelectedUserId] = useState<string>('')
  const [period, setPeriod] = useState<string>(() => new Date().toISOString().slice(0, 7))
  const [currentKPI, setCurrentKPI] = useState<KPICalculationResult | null>(null)
  const [prevKPI, setPrevKPI] = useState<KPICalculationResult | null>(null)
  const [kpiLoading, setKpiLoading] = useState(false)

  // Модальне вікно встановлення цілей
  const [showTargetModal, setShowTargetModal] = useState(false)
  const [targetRevenueInput, setTargetRevenueInput] = useState('')
  const [targetSalesCountInput, setTargetSalesCountInput] = useState('')
  const [targetOrdersCountInput, setTargetOrdersCountInput] = useState('')
  const [targetAvgCheckInput, setTargetAvgCheckInput] = useState('')
  const [savingTargets, setSavingTargets] = useState(false)

  const range = useMemo(() => {
    const now = new Date()
    const end = now.toISOString().split('T')[0]
    if (leaderboardPeriod === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      return { startDate: start.toISOString().split('T')[0], endDate: end }
    }
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1)
    return { startDate: start.toISOString().split('T')[0], endDate: end }
  }, [leaderboardPeriod])

  // Завантаження лідерборду
  useEffect(() => {
    if (activeTab !== 'leaderboard') return
    setLeaderboardLoading(true)
    api.get<{ data: KPIStaff[] }>(`/api/v1/analytics/staff-kpi?startDate=${range.startDate}&endDate=${range.endDate}`)
      .then((res) => setLeaderboardItems(res.data))
      .catch(() => {})
      .finally(() => setLeaderboardLoading(false))
  }, [range, activeTab])

  // Завантаження списку працівників
  useEffect(() => {
    if (!isOwnerOrAdmin) {
      if (currentUserId) setSelectedUserId(currentUserId)
      return
    }
    adminApi.listUsers()
      .then((res) => {
        const activeUsers = res.data.filter((u: AdminUser) => u.is_active)
        setUsers(activeUsers)
        if (activeUsers.length > 0 && !selectedUserId) {
          setSelectedUserId(activeUsers[0].id)
        }
      })
      .catch(() => {})
  }, [isOwnerOrAdmin, currentUserId])

  // Завантаження розрахунку KPI
  useEffect(() => {
    if (activeTab !== 'progress' || !selectedUserId || !period) return
    setKpiLoading(true)
    
    const prevPeriod = getPrevPeriod(period)

    Promise.all([
      api.get<{ data: KPICalculationResult }>(`/api/v1/analytics/kpi/calculate?user_id=${selectedUserId}&period=${period}`),
      api.get<{ data: KPICalculationResult }>(`/api/v1/analytics/kpi/calculate?user_id=${selectedUserId}&period=${prevPeriod}`).catch(() => ({ data: null }))
    ])
      .then(([currRes, prevRes]) => {
        setCurrentKPI(currRes.data)
        setPrevKPI(prevRes.data)
      })
      .catch(() => {
        setCurrentKPI(null)
        setPrevKPI(null)
      })
      .finally(() => setKpiLoading(false))
  }, [selectedUserId, period, activeTab])

  const selectedUser = useMemo(() => {
    if (isOwnerOrAdmin) return users.find((u) => u.id === selectedUserId)
    return { full_name: session?.user?.user_metadata?.full_name || 'Я', email: session?.user?.email }
  }, [users, selectedUserId, isOwnerOrAdmin, session])

  // Відкриття модалки встановлення цілей
  const openTargetsModal = () => {
    if (!currentKPI) return
    const t = currentKPI.targets
    setTargetRevenueInput(t.sales_revenue ? (t.sales_revenue / 100).toString() : '')
    setTargetSalesCountInput(t.sales_count ? t.sales_count.toString() : '')
    setTargetOrdersCountInput(t.orders_count ? t.orders_count.toString() : '')
    setTargetAvgCheckInput(t.avg_check ? (t.avg_check / 100).toString() : '')
    setShowTargetModal(true)
  }

  // Збереження цілей
  const handleSaveTargets = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedUserId || !period) return
    setSavingTargets(true)

    const revenueVal = Math.round(parseFloat(targetRevenueInput || '0') * 100)
    const salesCountVal = parseInt(targetSalesCountInput || '0', 10)
    const ordersCountVal = parseInt(targetOrdersCountInput || '0', 10)
    const avgCheckVal = Math.round(parseFloat(targetAvgCheckInput || '0') * 100)

    try {
      await api.post('/api/v1/analytics/kpi/targets', {
        user_id: selectedUserId,
        period,
        targets: [
          { metric_type: 'sales_revenue', target_value: revenueVal },
          { metric_type: 'sales_count', target_value: salesCountVal },
          { metric_type: 'orders_count', target_value: ordersCountVal },
          { metric_type: 'avg_check', target_value: avgCheckVal }
        ]
      })
      setShowTargetModal(false)
      // Перезавантажуємо розрахунок
      const currRes = await api.get<{ data: KPICalculationResult }>(`/api/v1/analytics/kpi/calculate?user_id=${selectedUserId}&period=${period}`)
      setCurrentKPI(currRes.data)
    } catch {
      alert('Помилка при збереженні цілей')
    } finally {
      setSavingTargets(false)
    }
  }

  // Друк звіту KPI
  const handlePrint = () => {
    if (!currentKPI || !selectedUser) return
    const printWindow = window.open('', '_blank', 'width=800,height=600')
    if (!printWindow) return

    const html = `
      <html>
        <head>
          <title>Звіт KPI - ${selectedUser.full_name || selectedUser.email}</title>
          <style>
            body { font-family: system-ui, sans-serif; padding: 40px; color: #111827; }
            h1 { font-size: 24px; font-weight: bold; margin-bottom: 5px; }
            .subtitle { font-size: 14px; color: #6b7280; margin-bottom: 30px; }
            .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 40px; }
            .card { border: 1px solid #e5e7eb; padding: 20px; border-radius: 12px; background: #fafafa; }
            .card-title { font-size: 12px; font-weight: 600; color: #4b5563; text-transform: uppercase; margin-bottom: 10px; }
            .val-group { display: flex; justify-content: space-between; align-items: baseline; }
            .fact { font-size: 20px; font-weight: bold; }
            .target { font-size: 14px; color: #6b7280; }
            .pct { font-size: 14px; font-weight: 600; color: #059669; margin-top: 5px; }
            .progress-bar-bg { background-color: #e5e7eb; height: 8px; border-radius: 4px; overflow: hidden; margin-top: 10px; }
            .progress-bar-fill { background-color: #10b981; height: 100%; }
          </style>
        </head>
        <body>
          <h1>Звіт з виконання цілей KPI</h1>
          <div class="subtitle">Співробітник: <strong>${selectedUser.full_name || selectedUser.email}</strong> | Період: ${period}</div>
          
          <div class="grid">
            <div class="card">
              <div class="card-title">Виторг</div>
              <div class="val-group">
                <span class="fact">${formatMoney(currentKPI.fact.sales_revenue)}</span>
                <span class="target">Ціль: ${currentKPI.targets.sales_revenue ? formatMoney(currentKPI.targets.sales_revenue) : 'немає'}</span>
              </div>
              ${currentKPI.targets.sales_revenue ? `
                <div class="pct">${Math.round(currentKPI.fact.sales_revenue / currentKPI.targets.sales_revenue * 100)}% виконання</div>
                <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${Math.min(100, Math.round(currentKPI.fact.sales_revenue / currentKPI.targets.sales_revenue * 100))}%"></div></div>
              ` : ''}
            </div>

            <div class="card">
              <div class="card-title">Кількість чеків</div>
              <div class="val-group">
                <span class="fact">${currentKPI.fact.sales_count}</span>
                <span class="target">Ціль: ${currentKPI.targets.sales_count ?? 'немає'}</span>
              </div>
              ${currentKPI.targets.sales_count ? `
                <div class="pct">${Math.round(currentKPI.fact.sales_count / currentKPI.targets.sales_count * 100)}% виконання</div>
                <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${Math.min(100, Math.round(currentKPI.fact.sales_count / currentKPI.targets.sales_count * 100))}%"></div></div>
              ` : ''}
            </div>

            <div class="card">
              <div class="card-title">Кількість замовлень</div>
              <div class="val-group">
                <span class="fact">${currentKPI.fact.orders_count}</span>
                <span class="target">Ціль: ${currentKPI.targets.orders_count ?? 'немає'}</span>
              </div>
              ${currentKPI.targets.orders_count ? `
                <div class="pct">${Math.round(currentKPI.fact.orders_count / currentKPI.targets.orders_count * 100)}% виконання</div>
                <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${Math.min(100, Math.round(currentKPI.fact.orders_count / currentKPI.targets.orders_count * 100))}%"></div></div>
              ` : ''}
            </div>

            <div class="card">
              <div class="card-title">Середній чек</div>
              <div class="val-group">
                <span class="fact">${formatMoney(currentKPI.fact.avg_check)}</span>
                <span class="target">Ціль: ${currentKPI.targets.avg_check ? formatMoney(currentKPI.targets.avg_check) : 'немає'}</span>
              </div>
              ${currentKPI.targets.avg_check ? `
                <div class="pct">${Math.round(currentKPI.fact.avg_check / currentKPI.targets.avg_check * 100)}% виконання</div>
                <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${Math.min(100, Math.round(currentKPI.fact.avg_check / currentKPI.targets.avg_check * 100))}%"></div></div>
              ` : ''}
            </div>
          </div>

          <div style="font-size: 11px; color: #9ca3af; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 20px;">
            Звіт згенеровано касовою системою Forsage POS CRM
          </div>

          <script>
            window.onload = function() { window.print(); window.close(); }
          </script>
        </body>
      </html>
    `
    printWindow.document.write(html)
    printWindow.document.close()
  }

  // Обчислення відсотка виконання та кольору прогрес-бару
  const getProgressStyles = (fact: number, target: number | undefined) => {
    if (!target || target <= 0) return { pct: 0, colorClass: 'bg-gray-200', textClass: 'text-gray-500' }
    const pct = Math.round((fact / target) * 100)
    let colorClass = 'bg-red-500'
    let textClass = 'text-red-600'

    if (pct >= 100) {
      colorClass = 'bg-emerald-500'
      textClass = 'text-emerald-600'
    } else if (pct >= 50) {
      colorClass = 'bg-yellow-500'
      textClass = 'text-yellow-600'
    }
    return { pct, colorClass, textClass }
  }

  // Обчислення тренду
  const renderTrend = (curr: number, prev: number | undefined) => {
    if (prev === undefined || prev === 0) return null
    const diffPct = Math.round(((curr - prev) / prev) * 100)
    if (diffPct > 0) {
      return (
        <span className="flex items-center gap-0.5 text-xs font-semibold text-emerald-600">
          <TrendingUp size={14} /> +{diffPct}%
        </span>
      )
    } else if (diffPct < 0) {
      return (
        <span className="flex items-center gap-0.5 text-xs font-semibold text-red-600">
          <TrendingDown size={14} /> {diffPct}%
        </span>
      )
    }
    return <span className="text-xs text-gray-500 font-medium">Без змін</span>
  }

  const hasAnyTargets = currentKPI && Object.keys(currentKPI.targets).length > 0

  return (
    <Layout title="KPI персоналу">
      <div className="max-w-5xl space-y-5">
        
        {/* Таб перемикач */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setActiveTab('leaderboard')}
            className={`flex items-center gap-2 px-5 py-3 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'leaderboard'
                ? 'border-yellow-400 text-yellow-500'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <BarChart3 size={16} /> Лідерборд
          </button>
          <button
            onClick={() => setActiveTab('progress')}
            className={`flex items-center gap-2 px-5 py-3 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'progress'
                ? 'border-yellow-400 text-yellow-500'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Target size={16} /> Цілі та Прогрес
          </button>
        </div>

        {/* Таб Лідерборд */}
        {activeTab === 'leaderboard' && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <button onClick={() => setLeaderboardPeriod('month')}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${leaderboardPeriod === 'month' ? 'bg-yellow-400 text-black' : 'bg-white border border-gray-200 text-gray-600'}`}>
                Цей місяць
              </button>
              <button onClick={() => setLeaderboardPeriod('quarter')}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${leaderboardPeriod === 'quarter' ? 'bg-yellow-400 text-black' : 'bg-white border border-gray-200 text-gray-600'}`}>
                3 місяці
              </button>
              <span className="text-sm text-gray-400 self-center ml-auto">{range.startDate} — {range.endDate}</span>
            </div>

            {leaderboardItems.length > 1 && (
              <Card>
                <h3 className="text-sm font-semibold text-gray-800 mb-4">Виторг по співробітниках</h3>
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={leaderboardItems} margin={{ top: 5, right: 5, left: -10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="manager_name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => (v / 100).toFixed(0)} />
                      <Tooltip formatter={(v: number) => [formatMoney(v), 'Виторг']} />
                      <Bar dataKey="total_revenue" fill="#3B82F6" radius={[4, 4, 0, 0]} maxBarSize={50} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            )}

            <Card padding="none">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr className="text-xs text-gray-500 uppercase">
                    <th className="text-left px-4 py-3">Співробітник</th>
                    <th className="text-right px-3 py-3">Виторг</th>
                    <th className="text-right px-3 py-3">Чеків</th>
                    <th className="text-right px-3 py-3">Середній</th>
                    <th className="text-right px-3 py-3">Знижки</th>
                    <th className="text-right px-3 py-3">Повернення</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {leaderboardLoading ? (
                    <tr><td colSpan={6} className="text-center text-gray-400 py-8">Завантаження...</td></tr>
                  ) : leaderboardItems.length === 0 ? (
                    <tr><td colSpan={6} className="text-center text-gray-400 py-8">Немає даних</td></tr>
                  ) : leaderboardItems.map((mgr) => {
                    const discountTooHigh = mgr.discount_pct > 5
                    return (
                      <tr key={mgr.manager_id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{mgr.manager_name}</td>
                        <td className="px-3 py-3 text-right font-semibold">{formatMoney(mgr.total_revenue)}</td>
                        <td className="px-3 py-3 text-right">{mgr.receipt_count}</td>
                        <td className="px-3 py-3 text-right">{formatMoney(mgr.average_receipt)}</td>
                        <td className={`px-3 py-3 text-right font-medium ${discountTooHigh ? 'text-red-600 bg-red-50' : 'text-gray-700'}`}>
                          {formatMoney(mgr.total_discounts)}
                          {discountTooHigh && <span className="block text-[10px] text-red-500">{mgr.discount_pct}% від виторгу</span>}
                        </td>
                        <td className="px-3 py-3 text-right text-gray-600">
                          {mgr.returns_count > 0 ? `${mgr.returns_count} / ${formatMoney(mgr.returns_amount)}` : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {/* Таб Цілі та Прогрес */}
        {activeTab === 'progress' && (
          <div className="space-y-5">
            
            {/* Фільтри та керування */}
            <div className="flex flex-wrap items-center justify-between gap-4 bg-gray-50 border border-gray-100 rounded-xl p-4">
              <div className="flex flex-wrap items-center gap-3">
                {isOwnerOrAdmin && users.length > 0 && (
                  <div className="flex flex-col">
                    <label className="text-gray-400 text-xs mb-1 font-medium">Співробітник</label>
                    <select
                      value={selectedUserId}
                      onChange={(e) => setSelectedUserId(e.target.value)}
                      className="bg-white border border-gray-300 text-gray-700 px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-yellow-400"
                    >
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                      ))}
                    </select>
                  </div>
                )}
                
                <div className="flex flex-col">
                  <label className="text-gray-400 text-xs mb-1 font-medium">Місяць</label>
                  <input
                    type="month"
                    value={period}
                    onChange={(e) => setPeriod(e.target.value)}
                    className="bg-white border border-gray-300 text-gray-700 px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-yellow-400"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button variant="secondary" icon={<Printer size={16} />} onClick={handlePrint} disabled={!currentKPI}>
                  Друк звіту
                </Button>
                {isOwnerOrAdmin && (
                  <Button variant="primary" icon={<Plus size={16} />} onClick={openTargetsModal} disabled={!currentKPI}>
                    Встановити цілі
                  </Button>
                )}
              </div>
            </div>

            {/* Тіло KPI */}
            {kpiLoading ? (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-2">
                <Loader2 className="animate-spin text-gray-400" size={32} />
                <span>Йде розрахунок KPI...</span>
              </div>
            ) : !currentKPI ? (
              <div className="text-center text-gray-400 py-16">
                Дані для розрахунку відсутні або виникла помилка
              </div>
            ) : (
              <div className="space-y-6">
                
                {/* Заголовок звіту працівника */}
                <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                  <div className="flex items-center gap-3">
                    <Award className="text-yellow-400" size={24} />
                    <div>
                      <h2 className="text-lg font-bold text-gray-800">
                        Виконання KPI цілей для: {selectedUser?.full_name || selectedUser?.email}
                      </h2>
                      <p className="text-gray-400 text-xs">
                        Період: {period} (минулий період: {getPrevPeriod(period)})
                      </p>
                    </div>
                  </div>
                  {!hasAnyTargets && (
                    <Badge color="red">Цілі не встановлено</Badge>
                  )}
                </div>

                {/* Сітка карток */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  
                  {/* 1. Виторг */}
                  <Card>
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-gray-400 text-xs font-semibold uppercase">Виторг (₴)</span>
                      {renderTrend(currentKPI.fact.sales_revenue, prevKPI?.fact?.sales_revenue)}
                    </div>
                    <div className="flex justify-between items-baseline mb-4">
                      <span className="text-2xl font-bold text-gray-900">{formatMoney(currentKPI.fact.sales_revenue)}</span>
                      <span className="text-sm text-gray-500 font-medium">
                        Ціль: {currentKPI.targets.sales_revenue ? formatMoney(currentKPI.targets.sales_revenue) : '—'}
                      </span>
                    </div>
                    {currentKPI.targets.sales_revenue ? (() => {
                      const { pct, colorClass, textClass } = getProgressStyles(currentKPI.fact.sales_revenue, currentKPI.targets.sales_revenue)
                      return (
                        <div>
                          <div className="flex justify-between text-xs font-semibold mb-1">
                            <span className={textClass}>{pct}% виконано</span>
                          </div>
                          <div className="w-full bg-gray-100 h-2.5 rounded-full overflow-hidden">
                            <div className={`h-full ${colorClass}`} style={{ width: `${Math.min(100, pct)}%` }}></div>
                          </div>
                        </div>
                      )
                    })() : (
                      <p className="text-xs text-gray-400 italic">Цільовий виторг не задано</p>
                    )}
                  </Card>

                  {/* 2. Кількість чеків */}
                  <Card>
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-gray-400 text-xs font-semibold uppercase">Кількість чеків</span>
                      {renderTrend(currentKPI.fact.sales_count, prevKPI?.fact?.sales_count)}
                    </div>
                    <div className="flex justify-between items-baseline mb-4">
                      <span className="text-2xl font-bold text-gray-900">{currentKPI.fact.sales_count}</span>
                      <span className="text-sm text-gray-500 font-medium">
                        Ціль: {currentKPI.targets.sales_count ?? '—'}
                      </span>
                    </div>
                    {currentKPI.targets.sales_count ? (() => {
                      const { pct, colorClass, textClass } = getProgressStyles(currentKPI.fact.sales_count, currentKPI.targets.sales_count)
                      return (
                        <div>
                          <div className="flex justify-between text-xs font-semibold mb-1">
                            <span className={textClass}>{pct}% виконано</span>
                          </div>
                          <div className="w-full bg-gray-100 h-2.5 rounded-full overflow-hidden">
                            <div className={`h-full ${colorClass}`} style={{ width: `${Math.min(100, pct)}%` }}></div>
                          </div>
                        </div>
                      )
                    })() : (
                      <p className="text-xs text-gray-400 italic">Цільову кількість чеків не задано</p>
                    )}
                  </Card>

                  {/* 3. Кількість замовлень */}
                  <Card>
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-gray-400 text-xs font-semibold uppercase">Кількість замовлень</span>
                      {renderTrend(currentKPI.fact.orders_count, prevKPI?.fact?.orders_count)}
                    </div>
                    <div className="flex justify-between items-baseline mb-4">
                      <span className="text-2xl font-bold text-gray-900">{currentKPI.fact.orders_count}</span>
                      <span className="text-sm text-gray-500 font-medium">
                        Ціль: {currentKPI.targets.orders_count ?? '—'}
                      </span>
                    </div>
                    {currentKPI.targets.orders_count ? (() => {
                      const { pct, colorClass, textClass } = getProgressStyles(currentKPI.fact.orders_count, currentKPI.targets.orders_count)
                      return (
                        <div>
                          <div className="flex justify-between text-xs font-semibold mb-1">
                            <span className={textClass}>{pct}% виконано</span>
                          </div>
                          <div className="w-full bg-gray-100 h-2.5 rounded-full overflow-hidden">
                            <div className={`h-full ${colorClass}`} style={{ width: `${Math.min(100, pct)}%` }}></div>
                          </div>
                        </div>
                      )
                    })() : (
                      <p className="text-xs text-gray-400 italic">Цільову кількість замовлень не задано</p>
                    )}
                  </Card>

                  {/* 4. Середній чек */}
                  <Card>
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-gray-400 text-xs font-semibold uppercase">Середній чек</span>
                      {renderTrend(currentKPI.fact.avg_check, prevKPI?.fact?.avg_check)}
                    </div>
                    <div className="flex justify-between items-baseline mb-4">
                      <span className="text-2xl font-bold text-gray-900">{formatMoney(currentKPI.fact.avg_check)}</span>
                      <span className="text-sm text-gray-500 font-medium">
                        Ціль: {currentKPI.targets.avg_check ? formatMoney(currentKPI.targets.avg_check) : '—'}
                      </span>
                    </div>
                    {currentKPI.targets.avg_check ? (() => {
                      const { pct, colorClass, textClass } = getProgressStyles(currentKPI.fact.avg_check, currentKPI.targets.avg_check)
                      return (
                        <div>
                          <div className="flex justify-between text-xs font-semibold mb-1">
                            <span className={textClass}>{pct}% виконано</span>
                          </div>
                          <div className="w-full bg-gray-100 h-2.5 rounded-full overflow-hidden">
                            <div className={`h-full ${colorClass}`} style={{ width: `${Math.min(100, pct)}%` }}></div>
                          </div>
                        </div>
                      )
                    })() : (
                      <p className="text-xs text-gray-400 italic">Цільовий середній чек не задано</p>
                    )}
                  </Card>

                </div>

              </div>
            )}

          </div>
        )}

      </div>

      {/* Модальне вікно встановлення цілей */}
      <Modal
        open={showTargetModal}
        onClose={() => setShowTargetModal(false)}
        title={`Встановити цілі KPI — ${selectedUser?.full_name || selectedUser?.email}`}
        size="sm"
      >
        <form onSubmit={handleSaveTargets} className="space-y-4">
          <div className="flex items-center gap-2 text-xs text-gray-400 font-semibold bg-gray-50 p-2.5 rounded-xl border border-gray-100">
            <Calendar size={15} />
            <span>Період планування: {period}</span>
          </div>

          <div className="space-y-3.5">
            <div>
              <label className="text-xs text-gray-500 mb-1 font-semibold block">Цільовий виторг (₴)</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={targetRevenueInput}
                onChange={(e) => setTargetRevenueInput(e.target.value)}
                placeholder="наприклад: 100000.00"
              />
            </div>

            <div>
              <label className="text-xs text-gray-500 mb-1 font-semibold block">Цільова кількість чеків</label>
              <Input
                type="number"
                step="1"
                min="0"
                value={targetSalesCountInput}
                onChange={(e) => setTargetSalesCountInput(e.target.value)}
                placeholder="наприклад: 200"
              />
            </div>

            <div>
              <label className="text-xs text-gray-500 mb-1 font-semibold block">Цільова кількість замовлень</label>
              <Input
                type="number"
                step="1"
                min="0"
                value={targetOrdersCountInput}
                onChange={(e) => setTargetOrdersCountInput(e.target.value)}
                placeholder="наприклад: 50"
              />
            </div>

            <div>
              <label className="text-xs text-gray-500 mb-1 font-semibold block">Цільовий середній чек (₴)</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={targetAvgCheckInput}
                onChange={(e) => setTargetAvgCheckInput(e.target.value)}
                placeholder="наприклад: 500.00"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={() => setShowTargetModal(false)}
            >
              Скасувати
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="flex-1"
              loading={savingTargets}
            >
              Зберегти
            </Button>
          </div>
        </form>
      </Modal>

    </Layout>
  )
}
