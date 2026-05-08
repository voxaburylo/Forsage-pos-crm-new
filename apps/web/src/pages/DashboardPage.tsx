import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Package, Users, Truck, Zap, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card, Button } from '@/components/ui'
import { formatMoney } from '@/lib/utils'

interface DashStats {
  products:   number
  customers:  number
  suppliers:  number
  lowStock:   number
  todayRevenue: number
  todaySales:   number
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const [stats, setStats]   = useState<DashStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        // Усі дані йдуть через наш backend API, не напряму до Supabase
        const [prodResp, custResp, lowResp, todayResp] = await Promise.all([
          api.get<{ pagination: { total: number } }>('/api/v1/products?per_page=1'),
          api.get<{ pagination: { total: number } }>('/api/v1/customers?per_page=1'),
          api.get<{ data: unknown[] }>('/api/v1/reports/products/low-stock'),
          api.get<{ data: { total_sales: number; total_revenue: number } }>('/api/v1/reports/sales/today'),
        ])

        setStats({
          products:     (prodResp as { pagination: { total: number } }).pagination?.total ?? 0,
          customers:    (custResp as { pagination: { total: number } }).pagination?.total ?? 0,
          suppliers:    0,
          lowStock:     (lowResp as { data: unknown[] }).data?.length ?? 0,
          todaySales:   (todayResp as { data: { total_sales: number; total_revenue: number } }).data?.total_sales ?? 0,
          todayRevenue: (todayResp as { data: { total_sales: number; total_revenue: number } }).data?.total_revenue ?? 0,
        })
      } catch {
        // Якщо API недоступний — показуємо нулі
        setStats({ products: 0, customers: 0, suppliers: 0, lowStock: 0, todaySales: 0, todayRevenue: 0 })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const cards = [
    { label: 'Товари',       value: stats?.products  ?? 0, icon: Package, href: '/products',  color: 'text-blue-500' },
    { label: 'Клієнти',      value: stats?.customers ?? 0, icon: Users,   href: '/customers', color: 'text-purple-500' },
    { label: 'Постачальники', value: stats?.suppliers ?? 0, icon: Truck,   href: '/suppliers', color: 'text-green-500' },
  ]

  return (
    <Layout
      title="Дашборд"
      actions={
        <Button icon={<Zap size={16} />} onClick={() => navigate('/pos')} size="lg">
          Відкрити касу
        </Button>
      }
    >
      {/* Сьогодні */}
      {!loading && stats && (stats.todaySales > 0 || stats.todayRevenue > 0) && (
        <Card className="mb-6 bg-green-50 border-green-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-green-700 font-medium">Сьогодні</p>
              <p className="text-2xl font-bold text-green-800">{formatMoney(stats.todayRevenue)}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-green-600">{stats.todaySales} продаж(ів)</p>
              <Button variant="ghost" size="sm" className="text-green-700 mt-1" onClick={() => navigate('/reports')}>
                Детально →
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Статистика */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {cards.map(({ label, value, icon: Icon, href, color }) => (
          <button key={label} onClick={() => navigate(href)}
            className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 text-left hover:border-yellow-300 hover:shadow-md transition-all group">
            <Icon size={28} className={`${color} mb-3`} />
            <div className="text-3xl font-bold text-gray-900">{loading ? '—' : value}</div>
            <div className="text-sm text-gray-500 mt-1 group-hover:text-gray-700">{label}</div>
          </button>
        ))}
      </div>

      {/* Попередження — мало товару */}
      {!loading && (stats?.lowStock ?? 0) > 0 && (
        <Card className="border-orange-200 bg-orange-50">
          <div className="flex items-center gap-3">
            <AlertTriangle size={20} className="text-orange-500 shrink-0" />
            <div>
              <p className="font-semibold text-orange-800 text-sm">
                {stats!.lowStock} товар{stats!.lowStock > 1 ? 'ів' : ''} з низьким залишком
              </p>
              <p className="text-orange-600 text-xs mt-0.5">Залишок нижче мінімального рівня</p>
            </div>
            <Button variant="ghost" size="sm" className="ml-auto text-orange-700 hover:bg-orange-100"
              onClick={() => navigate('/products?low_stock=true')}>
              Переглянути →
            </Button>
          </div>
        </Card>
      )}
    </Layout>
  )
}
