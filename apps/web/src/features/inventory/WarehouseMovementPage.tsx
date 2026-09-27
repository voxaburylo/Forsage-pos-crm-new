import { useState, useEffect, useCallback } from 'react'
import { useScopedAction } from '@/hooks/useScopedAction'
import { useAuthStore } from '@/stores/authStore'
import { stockQuantity } from './documentInput'
import { useWarehouseRecovery, WarehouseRecoveryNotice } from './WarehouseRecovery'
import { useLatestRequest } from '@/hooks/useLatestRequest'
import { Search, Package, MapPin, Plus, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { productApi } from '@/features/products/productApi'
import { warehouseApi } from './warehouseApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

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
  const userId = useAuthStore(s => s.session?.user?.id)
  const action = useScopedAction(JSON.stringify(['movement', userId, page]))
  const submitting = action.busy
  const recovery = useWarehouseRecovery('movement')
  const [loadError, setLoadError] = useState('')
  const [searchError, setSearchError] = useState('')
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [formError, setFormError] = useState<string | null>(null)
  const requests = useLatestRequest([page, userId])
  const searchRequests = useLatestRequest([searchQuery, showForm, selectedProduct?.id, searchAttempt, userId])

  const fetchMovements = useCallback(async () => {
    const isCurrent = requests.begin()
    setLoading(true)
    setMovements([])
    setLoadError('')
    try {
      const result = await warehouseApi.listMovements({ page, per_page: 20 })
      if (!isCurrent()) return
      setMovements(result.data ?? [])
      setTotalPages(result.pagination?.total_pages ?? 1)
    } catch (error) {
      if (isCurrent()) setLoadError(error instanceof Error ? error.message : 'Не вдалося завантажити переміщення')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [page, requests, userId])

  useEffect(() => { fetchMovements() }, [fetchMovements])

  // Пошук завжди читає той самий локальний каталог, що каса та інвентаризація.
  useEffect(() => {
    const isCurrent = searchRequests.begin()
    setSearchResults([])
    setSearchError('')
    if (!showForm || selectedProduct || searchQuery.trim().length < 2) return
    const timer = setTimeout(async () => {
      try {
        const result = await productApi.list({ search: searchQuery.trim(), per_page: 8 })
        if (!isCurrent()) return
        setSearchResults(result.data.map((product) => ({
          id: product.id,
          name: product.name,
          sku: product.sku,
          storage_bin: product.storage_bin ?? null,
          qty_on_hand: product.qty_on_hand ?? 0,
        })))
      } catch {
        if (isCurrent()) { setSearchResults([]); setSearchError('Не вдалося виконати пошук товарів.') }
      }
    }, 180)
    return () => clearTimeout(timer)
  }, [searchQuery, showForm, selectedProduct, searchRequests, searchAttempt, userId])

  const handleSubmit = async () => {
    if (action.isBusy() || recovery.blocked || recovery.busy || !selectedProduct || !toBin.trim()) return
    const quantity = stockQuantity(qty)
    if (quantity === null) { setFormError('Немає додатного залишку для переміщення. Знайдіть товар повторно.'); return }
    const attempt = action.begin()
    if (!attempt) return
    setFormError(null)
    try {
      await warehouseApi.createMovement({
        product_id: selectedProduct.id,
        qty: quantity,
        from_bin: selectedProduct.storage_bin || null,
        to_bin: toBin.trim(),
        note: note.trim() || null,
      })
      if (!attempt.isCurrent()) return
      // reset
      setShowForm(false)
      setSelectedProduct(null)
      setSearchQuery('')
      setToBin('')
      setQty('')
      setNote('')
      fetchMovements()
      toast.success('Товар переміщено')
    } catch (e) {
      if (attempt.isCurrent()) { recovery.refresh(); setFormError(e instanceof Error ? e.message : 'Не вдалося зберегти переміщення') }
    } finally { attempt.finish() }
  }

  const recoveryNotice = <WarehouseRecoveryNotice recovery={recovery} disabled={submitting} onResolved={result => {
    if (result.committed) {
      setShowForm(false); setSelectedProduct(null); setSearchQuery(''); setToBin(''); setQty(''); setNote('')
    }
    setFormError(null)
    void fetchMovements()
  }} />
  const inputClass = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-yellow-400 focus:ring-2 focus:ring-yellow-100'

  return (
    <Layout
      title="Переміщення між комірками"
      actions={<Button disabled={submitting || recovery.blocked || recovery.busy} icon={<Plus size={16} />} onClick={() => { if (!action.isBusy()) setShowForm(true) }}>Нове переміщення</Button>}
    >
      <p className="mb-4 text-sm text-gray-500">
        Змінює комірку всього залишку товару. Кількість не списується; облік одного товару в кількох комірках поки не підтримується.
      </p>

      {!showForm && recoveryNotice}
      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Товар</th>
                <th className="px-4 py-3 font-semibold">Звідки</th>
                <th className="px-4 py-3 font-semibold">Куди</th>
                <th className="px-4 py-3 text-right font-semibold">Кількість</th>
                <th className="px-4 py-3 font-semibold">Примітка</th>
                <th className="px-4 py-3 font-semibold">Дата</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">Завантаження...</td></tr>
              )}
              {!loading && loadError && <tr><td colSpan={6} className="p-6 text-red-700"><div role="alert">{loadError}. <button type="button" className="underline" onClick={fetchMovements}>Повторити</button></div></td></tr>}
              {!loading && !loadError && movements.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">Переміщень ще немає</td></tr>
              )}
              {movements.map((m) => (
                <tr key={m.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Package size={15} className="text-gray-400" />
                      <div>
                        <div className="font-medium text-gray-900">{m.product_name}</div>
                        {m.product_sku && <div className="font-mono text-xs text-gray-400">{m.product_sku}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500"><span className="flex items-center gap-1"><MapPin size={13} />{m.from_bin || '—'}</span></td>
                  <td className="px-4 py-3 font-semibold text-gray-900"><span className="flex items-center gap-1"><MapPin size={13} className="text-yellow-500" />{m.to_bin}</span></td>
                  <td className="px-4 py-3 text-right font-mono font-semibold">{m.qty}</td>
                  <td className="px-4 py-3 text-gray-500">{m.note || '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-500">{new Date(m.created_at).toLocaleString('uk-UA')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1 || submitting || loading}><ChevronLeft size={16} /></Button>
          <span className="px-2 text-sm text-gray-500">{page} / {totalPages}</span>
          <Button variant="secondary" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages || submitting || loading || !!loadError}><ChevronRight size={16} /></Button>
        </div>
      )}

      <Modal open={showForm} onClose={() => { if (!action.isBusy()) setShowForm(false) }} title="Нове переміщення" size="sm">
        {recoveryNotice}
        <fieldset disabled={submitting || recovery.blocked || recovery.busy} className="space-y-4">
          {!selectedProduct ? (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Товар *</label>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-3 text-gray-400" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Назва або артикул..."
                  className={`${inputClass} pl-9`}
                />
              </div>
              {searchError && <p role="alert" className="text-sm text-red-700">{searchError} <button type="button" className="underline" onClick={() => setSearchAttempt(n => n + 1)}>Повторити пошук</button></p>}
              {searchResults.length > 0 && (
                <div className="mt-1 max-h-52 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg">
                  {searchResults.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => { setSelectedProduct(p); setQty(String(p.qty_on_hand)); setSearchResults([]); setFormError(null) }}
                      className="flex w-full items-center justify-between border-b border-gray-100 px-3 py-2.5 text-left text-sm last:border-0 hover:bg-yellow-50"
                    >
                      <span>{p.name} {p.sku && <span className="text-gray-400">({p.sku})</span>}</span>
                      <span className="text-xs text-gray-500">{p.storage_bin || 'Без комірки'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-xl border border-yellow-200 bg-yellow-50 p-3">
              <div>
                <div className="text-sm font-semibold text-gray-900">{selectedProduct.name}</div>
                <div className="mt-0.5 text-xs text-gray-600">
                  Зараз: {selectedProduct.storage_bin || 'без комірки'} · Залишок: {selectedProduct.qty_on_hand}
                </div>
              </div>
              <button type="button" aria-label="Змінити товар" onClick={() => { setSelectedProduct(null); setSearchQuery('') }} className="rounded p-1 text-gray-500 hover:bg-white">
                <X size={17} />
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Нова комірка *</label>
              <input aria-label="Нова комірка" value={toBin} onChange={(e) => setToBin(e.target.value)} placeholder="Напр. A-5" className={inputClass} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Увесь залишок</label>
              <input value={qty} readOnly type="number" className={`${inputClass} bg-gray-50`} />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Примітка</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Причина переміщення" className={inputClass} />
          </div>

          {formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}

          <div className="flex gap-2 pt-1">
            <Button className="flex-1" onClick={handleSubmit} disabled={!selectedProduct || !toBin.trim() || !qty} loading={submitting}>
              Перемістити товар
            </Button>
            <Button variant="secondary" onClick={() => setShowForm(false)}>Скасувати</Button>
          </div>
        </fieldset>
      </Modal>
    </Layout>
  )
}
