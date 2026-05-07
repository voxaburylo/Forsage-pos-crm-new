import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { signOut } from '@/lib/auth'

export default function DashboardPage() {
  const navigate = useNavigate()
  const [counts, setCounts] = useState({ products: 0, customers: 0, suppliers: 0 })

  useEffect(() => {
    async function load() {
      const [p, c, s] = await Promise.all([
        supabase.from('products').select('*', { count: 'exact', head: true }),
        supabase.from('customers').select('*', { count: 'exact', head: true }),
        supabase.from('suppliers').select('*', { count: 'exact', head: true }),
      ])
      setCounts({ products: p.count ?? 0, customers: c.count ?? 0, suppliers: s.count ?? 0 })
    }
    load()
  }, [])

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">⚡</span>
          <span className="font-bold text-gray-900">Форсаж CRM</span>
          <span className="bg-accent text-black text-xs font-semibold px-2 py-0.5 rounded">BETA</span>
        </div>
        <button
          onClick={handleSignOut}
          className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          Вийти
        </button>
      </header>

      <main className="max-w-4xl mx-auto p-6">
        <h2 className="text-xl font-bold text-gray-900 mb-6">Дашборд</h2>

        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Товари', value: counts.products, icon: '📦' },
            { label: 'Клієнти', value: counts.customers, icon: '👥' },
            { label: 'Постачальники', value: counts.suppliers, icon: '🚚' },
          ].map(({ label, value, icon }) => (
            <div key={label} className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
              <div className="text-3xl mb-2">{icon}</div>
              <div className="text-3xl font-bold text-gray-900">{value}</div>
              <div className="text-sm text-gray-500 mt-1">{label}</div>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <p className="text-gray-500 text-sm text-center">
            🚧 Система в розробці — Фаза 1. Модулі будуть додані поступово.
          </p>
        </div>
      </main>
    </div>
  )
}
