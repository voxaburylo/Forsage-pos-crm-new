import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Package, Users, Truck, Zap, AlertTriangle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Layout } from '@/components/Layout'
import { Card, Button } from '@/components/ui'

export default function DashboardPage() {
  const navigate = useNavigate()
  const [counts, setCounts] = useState({ products: 0, customers: 0, suppliers: 0, lowStock: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const [p, c, s, low] = await Promise.all([
        supabase.from('products').select('*', { count: 'exact', head: true }).is('deleted_at', null),
        supabase.from('customers').select('*', { count: 'exact', head: true }).is('deleted_at', null),
        supabase.from('suppliers').select('*', { count: 'exact', head: true }).is('deleted_at', null),
        supabase.from('products').select('*', { count: 'exact', head: true }).is('deleted_at', null).filter('qty_on_hand', 'lte', 'reorder_point'),
      ])
      setCounts({
        products: p.count ?? 0,
        customers: c.count ?? 0,
        suppliers: s.count ?? 0,
        lowStock: low.count ?? 0,
      })
      setLoading(false)
    }
    load()
  }, [])

  const cards = [
    { label: 'Товари', value: counts.products, icon: Package, href: '/products', color: 'text-blue-500' },
    { label: 'Клієнти', value: counts.customers, icon: Users, href: '/customers', color: 'text-purple-500' },
    { label: 'Постачальники', value: counts.suppliers, icon: Truck, href: '/suppliers', color: 'text-green-500' },
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
      {/* Статистика */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {cards.map(({ label, value, icon: Icon, href, color }) => (
          <button
            key={label}
            onClick={() => navigate(href)}
            className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 text-left hover:border-yellow-300 hover:shadow-md transition-all group"
          >
            <Icon size={28} className={`${color} mb-3`} />
            <div className="text-3xl font-bold text-gray-900">
              {loading ? '—' : value}
            </div>
            <div className="text-sm text-gray-500 mt-1 group-hover:text-gray-700">{label}</div>
          </button>
        ))}
      </div>

      {/* Попередження */}
      {!loading && counts.lowStock > 0 && (
        <Card className="border-orange-200 bg-orange-50">
          <div className="flex items-center gap-3">
            <AlertTriangle size={20} className="text-orange-500 shrink-0" />
            <div>
              <p className="font-semibold text-orange-800 text-sm">
                {counts.lowStock} товар{counts.lowStock > 1 ? 'ів' : ''} з низьким залишком
              </p>
              <p className="text-orange-600 text-xs mt-0.5">Залишок нижче мінімального рівня</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-orange-700 hover:bg-orange-100"
              onClick={() => navigate('/products?low_stock=true')}
            >
              Переглянути →
            </Button>
          </div>
        </Card>
      )}

      {/* Фаза розробки */}
      <Card className="mt-4">
        <p className="text-gray-400 text-sm text-center">
          🚧 Система в розробці — Фаза 2 завершена. Фаза 3 (Клієнти) — наступна.
        </p>
      </Card>
    </Layout>
  )
}
