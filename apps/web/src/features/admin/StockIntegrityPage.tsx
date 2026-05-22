import { useState, useCallback } from 'react'
import { ShieldCheck, AlertTriangle, RefreshCw, Package, MapPin, Clock } from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
import { useAuthStore } from '@/stores/authStore'

interface IntegrityItem {
  product_id: string
  product_name: string
  sku: string | null
  qty_on_hand: number
  storage_bin: string | null
  updated_at: string
}

interface CheckResult {
  data: IntegrityItem[]
  count: number
  checked_at: string
  status: 'ok' | 'issues_found'
}

export default function StockIntegrityPage() {
  const { session } = useAuthStore()
  const [result, setResult] = useState<CheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runCheck = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Використовуємо fetch напряму до нашого Express API
      const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:3001'
      const token = session?.access_token
      const res = await fetch(`${apiBase}/api/v1/admin/stock-integrity`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
        throw new Error(err?.error?.message || `HTTP ${res.status}`)
      }
      const json: CheckResult = await res.json()
      setResult(json)
    } catch (e: any) {
      setError(e.message || 'Помилка перевірки')
    } finally {
      setLoading(false)
    }
  }, [session?.access_token])

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0f1117' }}>
      <Sidebar />
      <main style={{ flex: 1, overflow: 'auto', padding: '32px', color: '#e4e4e7' }}>
        {/* Заголовок */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '48px', height: '48px', borderRadius: '12px',
              background: 'linear-gradient(135deg, #10b981, #059669)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <ShieldCheck size={24} color="#fff" />
            </div>
            <div>
              <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0, color: '#f4f4f5' }}>
                Цілісність залишків
              </h1>
              <p style={{ fontSize: '14px', color: '#71717a', margin: '4px 0 0' }}>
                Перевірка товарів з від'ємним залишком (qty_on_hand &lt; 0)
              </p>
            </div>
          </div>
          <button
            onClick={runCheck}
            disabled={loading}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '10px 20px', borderRadius: '10px', border: 'none',
              background: loading ? '#27272a' : 'linear-gradient(135deg, #10b981, #059669)',
              color: '#fff', fontSize: '14px', fontWeight: 600,
              cursor: loading ? 'wait' : 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            <RefreshCw size={16} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            {loading ? 'Перевірка...' : 'Перевірити зараз'}
          </button>
        </div>

        {/* Помилка */}
        {error && (
          <div style={{
            padding: '16px 20px', borderRadius: '12px',
            background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#fca5a5', marginBottom: '24px', fontSize: '14px',
          }}>
            <AlertTriangle size={16} style={{ display: 'inline', marginRight: '8px', verticalAlign: 'text-bottom' }} />
            {error}
          </div>
        )}

        {/* Результат: все добре */}
        {result && result.status === 'ok' && (
          <div style={{
            padding: '40px', borderRadius: '16px', textAlign: 'center',
            background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.08), rgba(5, 150, 105, 0.04))',
            border: '1px solid rgba(16, 185, 129, 0.2)',
          }}>
            <div style={{
              width: '80px', height: '80px', borderRadius: '50%', margin: '0 auto 20px',
              background: 'linear-gradient(135deg, #10b981, #059669)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <ShieldCheck size={40} color="#fff" />
            </div>
            <h2 style={{ fontSize: '22px', fontWeight: 700, color: '#10b981', margin: '0 0 8px' }}>
              Усе в порядку!
            </h2>
            <p style={{ fontSize: '14px', color: '#71717a', margin: 0 }}>
              Жоден товар не має від'ємного залишку.
              Перевірено: {new Date(result.checked_at).toLocaleString('uk-UA')}
            </p>
          </div>
        )}

        {/* Результат: є проблеми */}
        {result && result.status === 'issues_found' && (
          <>
            <div style={{
              padding: '16px 20px', borderRadius: '12px', marginBottom: '20px',
              background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.25)',
              display: 'flex', alignItems: 'center', gap: '12px',
            }}>
              <AlertTriangle size={20} color="#f59e0b" />
              <div>
                <span style={{ fontWeight: 600, color: '#fbbf24' }}>
                  Знайдено {result.count} товарів з від'ємним залишком
                </span>
                <span style={{ color: '#71717a', fontSize: '13px', marginLeft: '12px' }}>
                  {new Date(result.checked_at).toLocaleString('uk-UA')}
                </span>
              </div>
            </div>

            <div style={{
              borderRadius: '12px', overflow: 'hidden',
              border: '1px solid #27272a', background: '#18181b',
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #27272a', background: '#1c1c22' }}>
                    <th style={thStyle}>Товар</th>
                    <th style={thStyle}>Артикул</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Залишок</th>
                    <th style={thStyle}>Комірка</th>
                    <th style={thStyle}>Оновлено</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((item) => (
                    <tr key={item.product_id} style={{ borderBottom: '1px solid #1e1e24' }}>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Package size={14} color="#71717a" />
                          <span style={{ fontWeight: 500, color: '#e4e4e7' }}>{item.product_name}</span>
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ color: '#a1a1aa', fontFamily: 'monospace', fontSize: '13px' }}>
                          {item.sku || '—'}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <span style={{
                          padding: '3px 10px', borderRadius: '6px', fontWeight: 700,
                          fontSize: '13px', fontFamily: 'monospace',
                          background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444',
                        }}>
                          {item.qty_on_hand}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#a1a1aa' }}>
                          <MapPin size={12} />
                          {item.storage_bin || '—'}
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#71717a', fontSize: '13px' }}>
                          <Clock size={12} />
                          {new Date(item.updated_at).toLocaleString('uk-UA')}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Початковий стан: ще не перевіряли */}
        {!result && !error && !loading && (
          <div style={{
            padding: '60px 40px', borderRadius: '16px', textAlign: 'center',
            background: '#18181b', border: '1px solid #27272a',
          }}>
            <ShieldCheck size={48} color="#3f3f46" style={{ marginBottom: '16px' }} />
            <h3 style={{ fontSize: '18px', fontWeight: 600, color: '#71717a', margin: '0 0 8px' }}>
              Перевірка не запускалася
            </h3>
            <p style={{ fontSize: '14px', color: '#52525b', margin: '0 0 20px' }}>
              Натисніть «Перевірити зараз», щоб знайти товари з від'ємним залишком.
              <br />Автоматична перевірка запускається кожні 6 годин.
            </p>
          </div>
        )}

        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>
      </main>
    </div>
  )
}

const thStyle: React.CSSProperties = {
  padding: '12px 16px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: '12px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#71717a',
}

const tdStyle: React.CSSProperties = {
  padding: '12px 16px',
}
