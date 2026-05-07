import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'

function Dashboard() {
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [counts, setCounts] = useState({ products: 0, customers: 0, suppliers: 0 })

  useEffect(() => {
    async function checkConnection() {
      try {
        const [p, c, s] = await Promise.all([
          supabase.from('products').select('*', { count: 'exact', head: true }),
          supabase.from('customers').select('*', { count: 'exact', head: true }),
          supabase.from('suppliers').select('*', { count: 'exact', head: true }),
        ])
        setCounts({
          products: p.count ?? 0,
          customers: c.count ?? 0,
          suppliers: s.count ?? 0,
        })
        setStatus('ok')
      } catch {
        setStatus('error')
      }
    }
    checkConnection()
  }, [])

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-10 text-center max-w-lg w-full">
        <div className="text-5xl mb-4">⚡</div>
        <h1 className="text-3xl font-bold text-gray-900 mb-1">Форсаж CRM</h1>
        <p className="text-gray-500 mb-8 text-sm">Система управління магазином автозапчастин</p>

        <div className="flex items-center justify-center gap-2 mb-8">
          {status === 'loading' && (
            <span className="text-gray-400 text-sm">Підключення до бази даних...</span>
          )}
          {status === 'ok' && (
            <>
              <span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span>
              <span className="text-green-600 text-sm font-medium">База даних підключена</span>
            </>
          )}
          {status === 'error' && (
            <>
              <span className="w-2 h-2 rounded-full bg-red-500 inline-block"></span>
              <span className="text-red-600 text-sm font-medium">Помилка підключення</span>
            </>
          )}
        </div>

        {status === 'ok' && (
          <div className="grid grid-cols-3 gap-4 mb-8">
            {[
              { label: 'Товари', value: counts.products },
              { label: 'Клієнти', value: counts.customers },
              { label: 'Постачальники', value: counts.suppliers },
            ].map(({ label, value }) => (
              <div key={label} className="bg-gray-50 rounded-xl p-4">
                <div className="text-2xl font-bold text-gray-900">{value}</div>
                <div className="text-xs text-gray-500 mt-1">{label}</div>
              </div>
            ))}
          </div>
        )}

        <div className="inline-block bg-yellow-400 text-black font-semibold px-6 py-2 rounded-lg text-sm">
          Фаза 1 — Розробка скелету
        </div>
      </div>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
