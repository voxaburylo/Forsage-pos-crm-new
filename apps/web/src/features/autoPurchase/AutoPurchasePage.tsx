import { useState, useEffect, useCallback, useRef } from 'react'
import { ShoppingBag, RefreshCw, Trash2, AlertTriangle, Plus, Search } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal, Input, ConfirmDialog } from '@/components/ui'
import { purchaseApi } from './purchaseApi'
import { useLatestRequest } from '@/hooks/useLatestRequest'
import { stockQuantity } from '@/features/inventory/documentInput'
import { toast } from '@/components/ui/Toast'
import { productApi } from '@/features/products/productApi'
import { supplierApi } from '@/features/suppliers/supplierApi'
import type { Product } from '@/types/product'

interface Suggestion {
  product_id: string
  product_name: string
  sku: string
  qty_on_hand: number
  reorder_point: number
  suggest_qty: number
  supplier_id: string | null
  supplier_name: string | null
  rule_id: string
}

interface Rule {
  id: string
  product: { id: string; sku: string; name: string; qty_on_hand: number; reorder_point: number } | null
  supplier: { id: string; name: string } | null
  min_qty: number
  max_qty: number
  is_active: boolean
}

interface SupplierOption { id: string; name: string }

export default function AutoPurchasePage() {
  const [tab, setTab] = useState<'suggestions' | 'rules'>('suggestions')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // Створення накладних
  const [generatingInvoices, setGeneratingInvoices] = useState(false)

  // Создание правила
  const [createOpen, setCreateOpen]       = useState(false)
  const [suppliers, setSuppliers]         = useState<SupplierOption[]>([])
  const [searchQ, setSearchQ]             = useState('')
  const [searchResults, setSearchResults] = useState<Product[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [pickedProduct, setPickedProduct] = useState<Product | null>(null)
  const [supplierId, setSupplierId]       = useState<string>('')
  const [minQty, setMinQty]               = useState('1')
  const [maxQty, setMaxQty]               = useState('10')
  const [creating, setCreating]           = useState(false)
  const busy = useRef(false)
  const requests = useLatestRequest(tab)
  const searches = useLatestRequest([searchQ, createOpen, pickedProduct?.id])

  const loadSuggestions = useCallback(async () => {
    const isCurrent = requests.begin()
    setLoading(true)
    setSuggestions([])
    setLoadError('')
    try {
      const { data } = await purchaseApi.suggestions()
      if (!isCurrent()) return
      setSuggestions(data ?? [])
    } catch (e) {
      if (isCurrent()) { const message = e instanceof Error ? e.message : 'Не вдалося завантажити пропозиції'; setLoadError(message); toast.error(message) }
    } finally { if (isCurrent()) setLoading(false) }
  }, [])

  const [confirmGenOpen, setConfirmGenOpen] = useState(false)

  const handleGenerateInvoices = async () => {
    if (busy.current || suggestions.length === 0 || loading) return
    busy.current = true
    setGeneratingInvoices(true)
    try {
      const { data } = await purchaseApi.generateInvoices()
      toast.success(`Успішно створено ${data.count} чернеток накладних`)
      loadSuggestions()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не вдалося згенерувати накладні')
    } finally {
      busy.current = false
      setGeneratingInvoices(false)
    }
  }

  const loadRules = useCallback(async () => {
    const isCurrent = requests.begin()
    setLoading(true)
    setRules([])
    setLoadError('')
    try {
      const { data } = await purchaseApi.listRules()
      if (!isCurrent()) return
      setRules(data ?? [])
    } catch (e) {
      if (isCurrent()) { const message = e instanceof Error ? e.message : 'Не вдалося завантажити правила'; setLoadError(message); toast.error(message) }
    } finally { if (isCurrent()) setLoading(false) }
  }, [])

  useEffect(() => {
    if (tab === 'suggestions') loadSuggestions()
    else loadRules()
  }, [tab, loadSuggestions, loadRules])

  // Подгрузка списка постачальників один раз при открытии модалки
  function openCreate() {
    setCreateOpen(true)
    setPickedProduct(null)
    setSearchQ(''); setSearchResults([])
    setSupplierId(''); setMinQty('1'); setMaxQty('10')
  }

  useEffect(() => {
    if (!createOpen) return
    let active = true
    setSuppliers([])
    void (async () => {
      const rows = new Map<string, SupplierOption>()
      for (let page = 1; active; page++) {
        const response = await supplierApi.list({ is_active: 'true', per_page: 100, page })
        if (!active) return
        const previous = rows.size
        for (const s of response.data) rows.set(s.id, { id: s.id, name: s.name })
        if (page >= response.pagination.total_pages) break
        if (rows.size === previous) throw new Error('Неповний список постачальників')
      }
      if (active) setSuppliers([...rows.values()])
    })().catch(() => { if (active) toast.error('Не вдалося завантажити постачальників') })
    return () => { active = false }
  }, [createOpen])

  // Debounce пошуку товара
  useEffect(() => {
    const isCurrent = searches.begin()
    setSearchResults([]); setSearchLoading(false)
    if (!createOpen || pickedProduct || !searchQ.trim()) return
    const t = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const { data } = await productApi.search(searchQ.trim(), 8)
        if (isCurrent()) setSearchResults(data)
      } catch { if (isCurrent()) setSearchResults([]) }
      finally { if (isCurrent()) setSearchLoading(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [searchQ, createOpen, pickedProduct, searches])

  async function handleCreate() {
    if (busy.current) return
    if (!pickedProduct) { toast.error('Виберіть товар'); return }
    const minN = stockQuantity(minQty), maxN = stockQuantity(maxQty)
    if (minN === null) { toast.error('Невірне мін. значення'); return }
    if (maxN === null) { toast.error('Невірне макс. значення'); return }
    if (maxN < minN) { toast.error('Макс має бути ≥ Мін'); return }

    busy.current = true
    setCreating(true)
    try {
      await purchaseApi.createRule({
        product_id:  pickedProduct.id,
        supplier_id: supplierId || null,
        min_qty:     minN,
        max_qty:     maxN,
      })
      toast.success('Правило створено')
      setCreateOpen(false)
      loadRules()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка створення')
    } finally { busy.current = false; setCreating(false) }
  }

  const [confirmDelRuleId, setConfirmDelRuleId] = useState<string | null>(null)

  async function doDeleteRule() {
    if (!confirmDelRuleId || busy.current) return
    busy.current = true
    try {
      await purchaseApi.deleteRule(confirmDelRuleId)
      toast.success('Правило видалено')
      loadRules()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
    finally { busy.current = false }
  }

  return (
    <Layout title="Автозакупки">
      <p className="mb-4 text-sm text-gray-500">Правила та залишки — з локальної бази. Враховуються відкриті чернетки приходу. Створення закупівлі не проводить накладну, не змінює залишок і не виконує оплату.</p>
      <div className="flex gap-2 mb-6">
        {(['suggestions', 'rules'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t ? 'bg-yellow-100 text-yellow-800 border border-yellow-300' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t === 'suggestions' ? `Пропозиції${suggestions.length > 0 ? ` (${suggestions.length})` : ''}` : 'Правила'}
          </button>
        ))}
        <div className="flex-1" />
        {tab === 'suggestions' && suggestions.length > 0 && (
          <Button
            size="sm"
            loading={generatingInvoices}
            icon={<ShoppingBag size={14} />}
            onClick={() => setConfirmGenOpen(true)}
          >
            Згенерувати закупівлі
          </Button>
        )}
        {tab === 'rules' && (
          <Button size="sm" icon={<Plus size={14} />} onClick={openCreate}>
            Нове правило
          </Button>
        )}
        <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />}
          onClick={tab === 'suggestions' ? loadSuggestions : loadRules}>
          Оновити
        </Button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Завантаження...</div>
      ) : loadError ? <p className="py-8 text-center text-red-700">{loadError}. Натисніть «Оновити» для повтору.</p> : tab === 'suggestions' ? (
        suggestions.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <ShoppingBag size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">Всі товари в нормі або правила не налаштовані</p>
          </div>
        ) : (
          <div className="space-y-2">
            {suggestions.map((s) => (
              <Card key={s.product_id}>
                <div className="flex items-center gap-4">
                  <AlertTriangle size={18} className="text-orange-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{s.product_name}</p>
                    <p className="text-xs text-gray-500">
                      Артикул: {s.sku} &nbsp;·&nbsp;
                      Залишок: <span className="text-red-600 font-medium">{s.qty_on_hand}</span> &nbsp;·&nbsp;
                      Поріг: {s.reorder_point}
                      {s.supplier_name && <> &nbsp;·&nbsp; Постачальник: {s.supplier_name}</>}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-blue-600">+{s.suggest_qty} шт</p>
                    <p className="text-[11px] text-gray-400">рекомендовано</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : (
        rules.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-sm">Немає правил. Додайте правило для товару щоб отримувати пропозиції закупки.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b">
                  <th className="pb-2 pr-4 font-medium">Товар</th>
                  <th className="pb-2 pr-4 font-medium">Постачальник</th>
                  <th className="pb-2 pr-4 font-medium">Мін / Макс</th>
                  <th className="pb-2 pr-4 font-medium">Статус</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rules.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="py-2 pr-4">
                      <p className="font-medium text-gray-900">{r.product?.name ?? '—'}</p>
                      <p className="text-xs text-gray-400">{r.product?.sku}</p>
                    </td>
                    <td className="py-2 pr-4 text-gray-600">{r.supplier?.name ?? '—'}</td>
                    <td className="py-2 pr-4 text-gray-600">{r.min_qty} / {r.max_qty}</td>
                    <td className="py-2 pr-4">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${r.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {r.is_active ? 'Активне' : 'Вимкнено'}
                      </span>
                    </td>
                    <td className="py-2">
                      <button onClick={() => setConfirmDelRuleId(r.id)} className="text-gray-400 hover:text-red-600 p-1 rounded">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Модалка створення правила */}
      <Modal
        open={createOpen}
        onClose={() => { if (!busy.current) setCreateOpen(false) }}
        title="Нове правило автозакупки"
        size="md"
      >
        <fieldset disabled={creating} className="space-y-4">
          {/* Вибір товара */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Товар *</label>
            {pickedProduct ? (
              <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-green-200 bg-green-50">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{pickedProduct.name}</p>
                  <p className="text-xs text-gray-500">
                    {pickedProduct.sku} · Залишок: {pickedProduct.qty_on_hand} · Поріг: {pickedProduct.reorder_point}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { setPickedProduct(null); setSearchQ('') }}
                  className="text-xs text-blue-600 hover:text-blue-800 shrink-0"
                >Змінити</button>
              </div>
            ) : (
              <>
                <Input
                  icon={<Search size={14} />}
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  placeholder="Артикул, назва, штрихкод..."
                  autoFocus
                />
                {(searchLoading || searchResults.length > 0) && (
                  <div className="mt-2 border border-gray-200 rounded-lg max-h-48 overflow-y-auto divide-y divide-gray-100">
                    {searchLoading ? (
                      <p className="text-xs text-gray-400 p-3 text-center">Пошук...</p>
                    ) : searchResults.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPickedProduct(p)}
                        className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"
                      >
                        <p className="text-sm font-medium text-gray-900 truncate">{p.name}</p>
                        <p className="text-xs text-gray-500">
                          {p.sku} · Залишок: {p.qty_on_hand}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Постачальник */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Постачальник</label>
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">— Не вказувати —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* Min/Max */}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Мінімум *"
              type="number"
              min="0"
              step="any"
              value={minQty}
              onChange={(e) => setMinQty(e.target.value)}
            />
            <Input
              label="Максимум *"
              type="number"
              min="0"
              step="any"
              value={maxQty}
              onChange={(e) => setMaxQty(e.target.value)}
              hint="Скільки докупати"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <Button
              type="button"
              loading={creating}
              disabled={!pickedProduct}
              onClick={handleCreate}
              className="flex-1"
            >
              Створити правило
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              Скасувати
            </Button>
          </div>
        </fieldset>
      </Modal>

      <ConfirmDialog
        open={confirmGenOpen}
        onClose={() => setConfirmGenOpen(false)}
        onConfirm={handleGenerateInvoices}
        title="Згенерувати накладні"
        message={`Створити чернетки приходних накладних для ${suggestions.length} пропозицій?`}
        confirmLabel="Згенерувати"
      />

      <ConfirmDialog
        open={confirmDelRuleId !== null}
        onClose={() => setConfirmDelRuleId(null)}
        onConfirm={doDeleteRule}
        title="Видалити правило"
        message="Правило автозакупки буде видалено."
        confirmLabel="Видалити"
        danger
      />
    </Layout>
  )
}
