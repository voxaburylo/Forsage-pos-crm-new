import { useState, useEffect, useCallback } from 'react'
import { ArrowRightLeft, Search, Package, MapPin, Plus, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
import { useAuthStore } from '@/stores/authStore'

interface Movement {
  id: string
  product_id: string
  from_bin: string | null
  to_bin: string
  qty: number
  note: string | null
  created_at: string
  product_name: string
  product_sku: string
}

interface ProductSearchResult {
  id: string
  name: string
  sku: string | null
  storage_bin: string | null
  qty_on_hand: number
}

export default function WarehouseMovementPage() {
  const { session } = useAuthStore()
  const token = session?.access_token
  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:3001'
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }

  const [movements, setMovements] = useState<Movement[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)

  // Form state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ProductSearchResult[]>([])
  const [selectedProduct, setSelectedProduct] = useState<ProductSearchResult | null>(null)
  const [toBin, setToBin] = useState('')
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const fetchMovements = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${apiBase}/api/v1/warehouse/movements?page=${page}&per_page=20`, { headers })
      const json = await res.json()
      setMovements(json.data ?? [])
      setTotalPages(json.pagination?.total_pages ?? 1)
    } catch { /* */ }
    finally { setLoading(false) }
  }, [page, apiBase, token])

  useEffect(() => { fetchMovements() }, [fetchMovements])

  // Product search
  useEffect(() => {
    if (searchQuery.length < 2) { setSearchResults([]); return }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${apiBase}/api/v1/products?search=${encodeURIComponent(searchQuery)}&per_page=8`, { headers })
        const json = await res.json()
        setSearchResults((json.data ?? []).map((p: any) => ({
          id: p.id, name: p.name, sku: p.sku, storage_bin: p.storage_bin, qty_on_hand: p.qty_on_hand,
        })))
      } catch { /* */ }
    }, 300)
    return () => clearTimeout(t)
  }, [searchQuery])

  const handleSubmit = async () => {
    if (!selectedProduct || !toBin.trim() || !qty) return
    setSubmitting(true)
    setFormError(null)
    try {
      const res = await fetch(`${apiBase}/api/v1/warehouse/movements`, {
        method: 'POST', headers,
        body: JSON.stringify({
          product_id: selectedProduct.id,
          qty: parseFloat(qty),
          from_bin: selectedProduct.storage_bin || null,
          to_bin: toBin.trim(),
          note: note.trim() || null,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error?.message || `HTTP ${res.status}`)
      }
      // reset
      setShowForm(false)
      setSelectedProduct(null)
      setSearchQuery('')
      setToBin('')
      setQty('')
      setNote('')
      fetchMovements()
    } catch (e: any) {
      setFormError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0f1117' }}>
      <Sidebar />
      <main style={{ flex: 1, overflow: 'auto', padding: '32px', color: '#e4e4e7' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '48px', height: '48px', borderRadius: '12px',
              background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <ArrowRightLeft size={24} color="#fff" />
            </div>
            <div>
              <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0, color: '#f4f4f5' }}>Переміщення</h1>
              <p style={{ fontSize: '14px', color: '#71717a', margin: '4px 0 0' }}>
                Переміщення товарів між комірками складу
              </p>
            </div>
          </div>
          <button onClick={() => setShowForm(true)} style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '10px 20px', borderRadius: '10px', border: 'none',
            background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
            color: '#fff', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
          }}>
            <Plus size={16} /> Нове переміщення
          </button>
        </div>

        {/* Form Modal */}
        {showForm && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}>
            <div style={{
              background: '#1c1c22', borderRadius: '16px', padding: '28px',
              width: '480px', maxWidth: '95vw', border: '1px solid #27272a',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#f4f4f5', margin: 0 }}>Нове переміщення</h2>
                <button onClick={() => setShowForm(false)} style={{
                  background: 'none', border: 'none', cursor: 'pointer', color: '#71717a',
                }}><X size={20} /></button>
              </div>

              {/* Product search */}
              {!selectedProduct ? (
                <div style={{ marginBottom: '16px' }}>
                  <label style={labelStyle}>Товар</label>
                  <div style={{ position: 'relative' }}>
                    <Search size={16} style={{ position: 'absolute', left: '12px', top: '12px', color: '#52525b' }} />
                    <input
                      value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Пошук за назвою або артикулом..."
                      style={{ ...inputStyle, paddingLeft: '36px' }}
                    />
                  </div>
                  {searchResults.length > 0 && (
                    <div style={{
                      marginTop: '4px', background: '#27272a', borderRadius: '10px',
                      maxHeight: '200px', overflow: 'auto', border: '1px solid #3f3f46',
                    }}>
                      {searchResults.map((p) => (
                        <div key={p.id} onClick={() => { setSelectedProduct(p); setSearchResults([]) }}
                          style={{
                            padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #3f3f46',
                            fontSize: '14px', display: 'flex', justifyContent: 'space-between',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = '#3f3f46')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          <span>{p.name} {p.sku && <span style={{ color: '#71717a' }}>({p.sku})</span>}</span>
                          <span style={{ color: '#71717a', fontSize: '12px' }}>{p.storage_bin || '—'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{
                  padding: '12px 14px', background: '#27272a', borderRadius: '10px', marginBottom: '16px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '14px' }}>{selectedProduct.name}</div>
                    <div style={{ fontSize: '12px', color: '#71717a' }}>
                      Комірка: {selectedProduct.storage_bin || '—'} · Залишок: {selectedProduct.qty_on_hand}
                    </div>
                  </div>
                  <button onClick={() => { setSelectedProduct(null); setSearchQuery('') }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#71717a' }}
                  ><X size={16} /></button>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                <div>
                  <label style={labelStyle}>Куди (комірка)</label>
                  <input value={toBin} onChange={(e) => setToBin(e.target.value)} placeholder="A-5" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Кількість</label>
                  <input value={qty} onChange={(e) => setQty(e.target.value)} type="number" min="0.001" step="any" placeholder="1" style={inputStyle} />
                </div>
              </div>

              <div style={{ marginBottom: '20px' }}>
                <label style={labelStyle}>Примітка (необов'язково)</label>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Перенесли на полицю B" style={inputStyle} />
              </div>

              {formError && (
                <div style={{ color: '#ef4444', fontSize: '13px', marginBottom: '12px' }}>{formError}</div>
              )}

              <button onClick={handleSubmit} disabled={!selectedProduct || !toBin.trim() || !qty || submitting}
                style={{
                  width: '100%', padding: '12px', borderRadius: '10px', border: 'none',
                  background: selectedProduct && toBin && qty ? 'linear-gradient(135deg, #6366f1, #4f46e5)' : '#27272a',
                  color: '#fff', fontSize: '14px', fontWeight: 600, cursor: submitting ? 'wait' : 'pointer',
                }}>
                {submitting ? 'Обробка...' : 'Перемістити'}
              </button>
            </div>
          </div>
        )}

        {/* Movements Table */}
        <div style={{ borderRadius: '12px', overflow: 'hidden', border: '1px solid #27272a', background: '#18181b' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #27272a', background: '#1c1c22' }}>
                <th style={thStyle}>Товар</th>
                <th style={thStyle}>Звідки</th>
                <th style={thStyle}>Куди</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Кіл-ть</th>
                <th style={thStyle}>Примітка</th>
                <th style={thStyle}>Дата</th>
              </tr>
            </thead>
            <tbody>
              {movements.length === 0 && !loading && (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: '40px', color: '#52525b' }}>
                  Переміщень ще немає
                </td></tr>
              )}
              {movements.map((m) => (
                <tr key={m.id} style={{ borderBottom: '1px solid #1e1e24' }}>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Package size={14} color="#71717a" />
                      <div>
                        <div style={{ fontWeight: 500 }}>{m.product_name}</div>
                        {m.product_sku && <div style={{ fontSize: '12px', color: '#52525b', fontFamily: 'monospace' }}>{m.product_sku}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#a1a1aa' }}>
                      <MapPin size={12} /> {m.from_bin || '—'}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <MapPin size={12} color="#6366f1" />
                      <span style={{ fontWeight: 600, color: '#818cf8' }}>{m.to_bin}</span>
                    </div>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{m.qty}</td>
                  <td style={{ ...tdStyle, color: '#71717a', fontSize: '13px' }}>{m.note || '—'}</td>
                  <td style={{ ...tdStyle, color: '#71717a', fontSize: '13px' }}>
                    {new Date(m.created_at).toLocaleString('uk-UA')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '20px' }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              style={paginationBtnStyle}><ChevronLeft size={16} /></button>
            <span style={{ color: '#71717a', fontSize: '14px', lineHeight: '36px' }}>
              {page} / {totalPages}
            </span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              style={paginationBtnStyle}><ChevronRight size={16} /></button>
          </div>
        )}
      </main>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '12px', fontWeight: 600, color: '#a1a1aa',
  marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em',
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', borderRadius: '8px',
  border: '1px solid #3f3f46', background: '#27272a', color: '#e4e4e7',
  fontSize: '14px', outline: 'none', boxSizing: 'border-box',
}

const thStyle: React.CSSProperties = {
  padding: '12px 16px', textAlign: 'left', fontWeight: 600,
  fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#71717a',
}

const tdStyle: React.CSSProperties = { padding: '12px 16px' }

const paginationBtnStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: '8px', border: '1px solid #27272a',
  background: '#18181b', color: '#a1a1aa', cursor: 'pointer',
}
