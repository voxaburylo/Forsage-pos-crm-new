import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle, Camera, CheckCircle, ChevronDown, Copy, PackageCheck,
  RotateCcw, Search,
} from 'lucide-react'
import { api } from '@/lib/api'
import { productApi } from '@/features/products/productApi'
import { Layout } from '@/components/Layout'
import { Badge, Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { playErrorTone, playSuccessBeep, initAudio } from '@/lib/audioService'
import { CameraScanner } from '@/features/pos/CameraScanner'
import { useAuthStore } from '@/stores/authStore'
import { formatMoney } from '@/lib/utils'

interface ProductInfo {
  id: string
  sku: string
  name: string
  barcode: string | null
  unit: string
  qty_on_hand?: number
  retail_price: number
  purchase_price?: number
  storage_bin?: string | null
  inventory_item?: {
    id: string
    expected_stock: number
    counted_stock: number
    price_checked: boolean
    observed_retail_price: number | null
  } | null
}

interface InventoryItem {
  id: string
  product_id: string
  expected_stock: number
  counted_stock: number
  price_checked: boolean
  observed_retail_price: number | null
  updated_at: string
  product: ProductInfo | null
}

interface CountEntry {
  id: string
  product_id: string
  qty: number
  price_checked: boolean
  observed_retail_price: number | null
  created_at: string
  product: ProductInfo | null
}

interface Summary {
  total_products: number
  counted_products: number
  matching_products: number
  discrepancy_products: number
  price_checked_products: number
  price_mismatch_products: number
  participants: number
  total_expected_units: number
  total_counted_units: number
}

interface SessionData {
  id: string
  name: string
  status: 'draft' | 'in_progress' | 'completed'
  items: InventoryItem[]
  price_issues: Array<{
    id: string
    product_id: string
    observed_retail_price: number
    product: ProductInfo | null
  }>
  my_entries: CountEntry[]
  summary: Summary
}

export default function ActiveSession() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const authSession = useAuthStore((state) => state.session)
  const role = (authSession?.user?.user_metadata?.role as string) ?? 'cashier'
  const canComplete = ['owner', 'admin'].includes(role)

  const [session, setSession] = useState<SessionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ProductInfo[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<ProductInfo | null>(null)
  const [qty, setQty] = useState('1')
  const [priceStatus, setPriceStatus] = useState<'unchecked' | 'match' | 'mismatch'>('unchecked')
  const [observedPrice, setObservedPrice] = useState('')
  const [saving, setSaving] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [showRecent, setShowRecent] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  // Редагування цін товару прямо в сесії (без окремого вікна)
  const canEditPrice = ['owner', 'admin', 'manager', 'storekeeper'].includes(role)
  const [editRetail, setEditRetail] = useState('')
  const [editPurchase, setEditPurchase] = useState('')
  const [savingPrice, setSavingPrice] = useState(false)
  // Масові операції над вибраними товарами
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [massBusy, setMassBusy] = useState(false)

  function money2(kopecks: number | undefined | null): string {
    return ((Number(kopecks) || 0) / 100).toFixed(2)
  }

  async function savePrice() {
    if (!selected || !canEditPrice) return
    const retail = Math.round(parseFloat(String(editRetail).replace(',', '.')) * 100)
    const purchase = Math.round(parseFloat(String(editPurchase).replace(',', '.')) * 100)
    if (!Number.isFinite(retail) || retail < 0) { toast.error('Некоректна ціна продажу'); return }
    if (!Number.isFinite(purchase) || purchase < 0) { toast.error('Некоректна закупівельна ціна'); return }
    setSavingPrice(true)
    try {
      await productApi.update(selected.id, { retail_price: retail, purchase_price: purchase } as any)
      toast.success('Ціни товару оновлено')
      setSelected((cur) => cur ? { ...cur, retail_price: retail, purchase_price: purchase } : cur)
      playSuccessBeep()
      load(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося оновити ціни')
    } finally {
      setSavingPrice(false)
    }
  }

  // Порахувати роздрібну з націнки: швидкий % від закупки або за матрицею націнок.
  async function applyMarkupToEdit(kind: 'percent' | 'table', pct?: number) {
    const purchase = Math.round(parseFloat(String(editPurchase).replace(',', '.')) * 100)
    if (!Number.isFinite(purchase) || purchase <= 0) { toast.error('Спершу вкажіть закупівельну ціну'); return }
    if (kind === 'percent' && pct != null) {
      setEditRetail(money2(Math.round(purchase * (1 + pct / 100))))
      return
    }
    try {
      const { data } = await api.get<{ data: { retail_price: number } }>(
        `/api/v1/pricing/auto-retail?purchase=${purchase}`, { silent: true },
      )
      if (data?.retail_price) setEditRetail(money2(data.retail_price))
      else toast.error('Матриця націнок не налаштована для цього діапазону')
    } catch {
      toast.error('Не вдалося порахувати за таблицею')
    }
  }

  function toggleSelectId(productId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(productId)) next.delete(productId); else next.add(productId)
      return next
    })
  }

  // Скан/вибір товару → одразу додаємо рядок (+1), без картки й підтверджень.
  async function addProduct(product: ProductInfo) {
    if (!id) return
    initAudio()
    try {
      const response = await api.post<{ data: unknown; session: SessionData }>(
        `/api/v1/inventory/${id}/count`,
        { product_id: product.id, qty: 1, price_checked: true, observed_retail_price: null },
      )
      setSession(response.session)
      playSuccessBeep()
      setQuery(''); setSearchResults([])
      inputRef.current?.focus()
    } catch (error) {
      playErrorTone()
      toast.error(error instanceof Error ? error.message : 'Не вдалося додати товар')
    }
  }

  // Встановити абсолютну кількість рядка (редагування прямо в рядку).
  async function setItemQty(item: InventoryItem, value: string) {
    if (!id) return
    const qty = Number(String(value).replace(',', '.'))
    if (!Number.isFinite(qty) || qty < 0) { toast.error('Некоректна кількість'); return }
    if (qty === item.counted_stock) return
    try {
      await api.put(`/api/v1/inventory/${id}/items/${item.id}`, { counted_stock: qty })
      load(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося змінити кількість')
    }
  }

  // Встановити роздрібну ціну товару прямо з рядка.
  async function setItemRetail(item: InventoryItem, value: string) {
    if (!item.product || !canEditPrice) return
    const retail = Math.round(parseFloat(String(value).replace(',', '.')) * 100)
    if (!Number.isFinite(retail) || retail < 0) { toast.error('Некоректна ціна'); return }
    if (retail === item.product.retail_price) return
    try {
      await productApi.update(item.product.id, { retail_price: retail } as any)
      load(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося змінити ціну')
    }
  }

  // Націнка на рядок: швидкий % від закупки або за матрицею націнок.
  async function applyRowMarkup(item: InventoryItem, kind: 'percent' | 'table', pct?: number) {
    if (!item.product || !canEditPrice) return
    const purchase = item.product.purchase_price ?? 0
    if (purchase <= 0) { toast.error('У товару нема закупівельної ціни'); return }
    let retail: number
    if (kind === 'percent' && pct != null) {
      retail = Math.round(purchase * (1 + pct / 100))
    } else {
      try {
        const { data } = await api.get<{ data: { retail_price: number } }>(
          `/api/v1/pricing/auto-retail?purchase=${purchase}`, { silent: true },
        )
        if (!data?.retail_price) { toast.error('Матриця націнок не налаштована для цієї закупки'); return }
        retail = data.retail_price
      } catch { toast.error('Не вдалося порахувати за таблицею'); return }
    }
    try {
      await productApi.update(item.product.id, { retail_price: retail } as any)
      load(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка націнки')
    }
  }

  async function applyMassPrice(action: { type: 'percent' | 'amount' | 'markup' | 'markup_table'; value: number }) {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) { toast.error('Виберіть товари'); return }
    setMassBusy(true)
    try {
      await api.post('/api/v1/products/bulk-update', {
        product_ids: ids,
        updates: { retail_price_action: action },
      })
      toast.success(`Оновлено ${ids.length} товар(ів)`)
      setSelectedIds(new Set())
      load(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося оновити масово')
    } finally {
      setMassBusy(false)
    }
  }

  async function load(silent = false) {
    if (!id) return
    if (!silent) setLoading(true)
    try {
      const { data } = await api.get<{ data: SessionData }>(`/api/v1/inventory/${id}`, { silent })
      setSession(data)
    } catch {
      if (!silent) {
        toast.error('Не вдалося завантажити ревізію')
        navigate('/inventory')
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])
  useEffect(() => {
    if (!session || session.status !== 'in_progress') return
    const timer = window.setInterval(() => load(true), 8_000)
    return () => window.clearInterval(timer)
  }, [id, session?.status])

  useEffect(() => {
    const value = query.trim()
    if (selected || value.length < 2 || /^\d{6,}$/.test(value)) {
      setSearchResults([])
      return
    }
    const timer = window.setTimeout(async () => {
      setSearching(true)
      try {
        const { data } = await productApi.search(value, 12)
        setSearchResults(data as ProductInfo[])
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query, selected])

  const progress = useMemo(() => {
    const summary = session?.summary
    if (!summary?.total_products) return 0
    return Math.round(summary.counted_products / summary.total_products * 100)
  }, [session?.summary])

  // Рядки списку — товари, які вже додали (пораховані), найновіші зверху.
  const countedRows = useMemo(
    () => (session?.items ?? [])
      .filter((it) => (it.counted_stock ?? 0) > 0)
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')),
    [session?.items],
  )

  async function resolveCode(code: string) {
    if (!id || !code.trim()) return
    setSearching(true)
    initAudio()
    try {
      const { data } = await api.get<{ data: ProductInfo }>(
        `/api/v1/inventory/${id}/product?code=${encodeURIComponent(code.trim())}`,
      )
      await addProduct(data)
    } catch (error) {
      playErrorTone()
      toast.error(error instanceof Error ? error.message : 'Товар не знайдено')
      inputRef.current?.focus()
    } finally {
      setSearching(false)
    }
  }

  async function submitSearch(event: React.FormEvent) {
    event.preventDefault()
    if (searchResults[0]) await addProduct(searchResults[0])
    else await resolveCode(query)
  }

  async function saveCount() {
    if (!id || !selected) return
    const parsedQty = Number(String(qty).replace(',', '.'))
    if (!Number.isFinite(parsedQty) || parsedQty < 0) {
      toast.error('Кількість не може бути від’ємною')
      return
    }
    let observedKopecks: number | null = null
    if (priceStatus === 'unchecked') {
      toast.error('Перевірте ціну: збігається вона чи ні')
      return
    }
    if (priceStatus === 'mismatch') {
      const parsedPrice = Number(String(observedPrice).replace(',', '.'))
      if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
        toast.error('Вкажіть фактичну ціну з цінника')
        return
      }
      observedKopecks = Math.round(parsedPrice * 100)
    }

    setSaving(true)
    try {
      const response = await api.post<{ data: unknown; session: SessionData }>(
        `/api/v1/inventory/${id}/count`,
        {
          product_id: selected.id,
          qty: parsedQty,
          price_checked: priceStatus === 'match',
          observed_retail_price: observedKopecks,
        },
      )
      setSession(response.session)
      toast.success(`Додано ${parsedQty} ${selected.unit ?? 'шт'} · ${selected.name}`)
      playSuccessBeep()
      setSelected(null)
      setQty('1')
      setPriceStatus('unchecked')
      setObservedPrice('')
      inputRef.current?.focus()
    } catch (error) {
      playErrorTone()
      toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти підрахунок')
    } finally {
      setSaving(false)
    }
  }

  async function completeSession() {
    if (!id || !session || !canComplete) return
    const missing = Math.max(0, session.summary.total_products - session.summary.counted_products)
    const priceIssues = session.summary.price_mismatch_products ?? 0
    if (missing > 0 || priceIssues > 0) {
      const typed = prompt(
        `УВАГА!\nНе пораховано: ${missing} товарів.\nРозбіжностей цін: ${priceIssues}.\n`
        + 'Непораховані залишки стануть нульовими. Для підтвердження введіть ЗАВЕРШИТИ',
      )
      if (typed?.trim().toUpperCase() !== 'ЗАВЕРШИТИ') return
    } else if (!confirm('Завершити ревізію та застосувати всі фактичні залишки?')) {
      return
    }
    try {
      const response = await api.post<{ data: { items_updated: number } }>(`/api/v1/inventory/${id}/complete`, {
        confirm_unfinished: missing > 0,
        confirm_price_issues: priceIssues > 0,
      })
      toast.success(`Ревізію завершено. Оновлено ${response.data.items_updated} товарів.`)
      navigate('/inventory')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося завершити ревізію')
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(window.location.href)
    toast.success('Посилання для працівників скопійовано')
  }

  if (loading) {
    return <Layout title="Ревізія"><div className="py-12 text-center text-sm text-gray-400">Завантаження...</div></Layout>
  }
  if (!session) return null
  const isActive = session.status === 'in_progress'

  return (
    <Layout title={`Ревізія: ${session.name}`} onBack={() => navigate('/inventory')}>
      <div className="mx-auto max-w-5xl space-y-4 pb-24">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Badge color={session.status === 'completed' ? 'green' : session.status === 'draft' ? 'yellow' : 'blue'}>
                  {session.status === 'completed' ? 'Завершена' : session.status === 'draft' ? 'Чернетка' : 'Спільний підрахунок'}
                </Badge>
                {isActive && <span className="text-xs text-gray-500">Оновлення кожні 8 секунд</span>}
              </div>
              <p className="mt-2 text-sm text-gray-600">
                Пораховано товарів: <strong>{session.summary.counted_products}</strong> із {session.summary.total_products}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">Учасників: {session.summary.participants ?? 0}</p>
            </div>
            <Button size="sm" variant="outline" icon={<Copy size={14} />} onClick={copyLink}>
              Посилання працівникам
            </Button>
          </div>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full rounded-full bg-yellow-400 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-xs text-gray-500">
            <span>{progress}% каталогу</span>
            <span>Ціну перевірено: {session.summary.price_checked_products}</span>
          </div>
          {(session.summary.price_mismatch_products ?? 0) > 0 && (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-red-600">
              <AlertTriangle size={13} /> Не збігається цін: {session.summary.price_mismatch_products}
            </p>
          )}
        </Card>

        {isActive && (
          <Card>
            <p className="mb-2 text-sm font-semibold text-gray-900">Знайти товар</p>
            <form onSubmit={submitSearch} className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setSelected(null) }}
                  placeholder="Назва, артикул або штрихкод"
                  autoFocus
                  className="w-full rounded-xl border-2 border-yellow-400 bg-white py-3.5 pl-10 pr-3 text-base outline-none focus:border-yellow-500"
                />
                {searchResults.length > 0 && (
                  <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl">
                    {searchResults.map((product) => (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => addProduct(product)}
                        className="flex w-full items-center justify-between gap-3 border-b border-gray-100 px-3 py-3 text-left last:border-0 hover:bg-yellow-50"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-gray-900">{product.name}</p>
                          <p className="font-mono text-xs text-gray-500">{product.sku} {product.barcode ? `· ${product.barcode}` : ''}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-bold">{formatMoney(product.retail_price)}</p>
                          <p className="text-xs text-gray-500">{product.qty_on_hand ?? 0} {product.unit}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                className="flex w-13 shrink-0 items-center justify-center rounded-xl border border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200"
                aria-label="Сканувати камерою"
              >
                <Camera size={23} />
              </button>
              <Button type="submit" loading={searching} className="hidden sm:flex">Знайти</Button>
            </form>
          </Card>
        )}

        {selected && isActive && (
          <Card>
            <div className="border-b border-gray-100 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-gray-900">{selected.name}</h2>
                  <p className="mt-1 font-mono text-xs text-gray-500">
                    {selected.sku}{selected.barcode ? ` · ${selected.barcode}` : ''}
                  </p>
                  {selected.storage_bin && <p className="mt-1 text-xs text-blue-600">Комірка: {selected.storage_bin}</p>}
                </div>
                <button onClick={() => setSelected(null)} className="text-sm text-gray-400 hover:text-gray-700">Закрити</button>
              </div>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl bg-gray-50 p-3">
                <p className="text-xs text-gray-500">У програмі на старті</p>
                <p className="mt-1 text-xl font-bold">{selected.inventory_item?.expected_stock ?? selected.qty_on_hand ?? 0} {selected.unit}</p>
              </div>
              <div className="rounded-xl bg-blue-50 p-3">
                <p className="text-xs text-blue-600">Вже пораховано всіма</p>
                <p className="mt-1 text-xl font-bold text-blue-800">{selected.inventory_item?.counted_stock ?? 0} {selected.unit}</p>
              </div>
              <div className="rounded-xl bg-yellow-50 p-3">
                <p className="text-xs text-yellow-700">Ціна продажу</p>
                <p className="mt-1 text-xl font-bold text-yellow-900">{formatMoney(selected.retail_price)}</p>
              </div>
            </div>
            {(selected.inventory_item?.counted_stock ?? 0) > 0 && (
              <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Цей товар уже рахували. Додавайте кількість лише якщо це інша коробка, полиця або залишок, який ще не врахували.
              </div>
            )}

            <div className="mt-4">
              <label className="mb-1 block text-sm font-semibold text-gray-800">
                Скільки ви порахували у своїй коробці / на своїй полиці
              </label>
              <input
                id="inventory-qty"
                type="number"
                min="0"
                step="0.001"
                inputMode="decimal"
                value={qty}
                onChange={(event) => setQty(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') saveCount() }}
                className="w-full rounded-xl border-2 border-yellow-400 px-4 py-4 text-center text-3xl font-bold outline-none focus:border-yellow-500"
              />
              <div className="mt-2 grid grid-cols-4 gap-2">
                {[1, 2, 5, 10].map((value) => (
                  <button key={value} type="button" onClick={() => setQty(String(value))}
                    className="rounded-lg bg-gray-100 py-2 text-sm font-semibold hover:bg-gray-200">
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-gray-200 p-3">
              <p className="text-sm font-semibold text-gray-800">
                Ціна на товарі / ціннику збігається з {formatMoney(selected.retail_price)}?
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setPriceStatus('match'); setObservedPrice('') }}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                    priceStatus === 'match'
                      ? 'border-green-500 bg-green-50 text-green-700'
                      : 'border-gray-200 bg-white text-gray-600'
                  }`}>
                  ✓ Так, збігається
                </button>
                <button type="button" onClick={() => setPriceStatus('mismatch')}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                    priceStatus === 'mismatch'
                      ? 'border-red-500 bg-red-50 text-red-700'
                      : 'border-gray-200 bg-white text-gray-600'
                  }`}>
                  Ні, інша ціна
                </button>
              </div>
              {priceStatus === 'mismatch' && (
                <div className="mt-3">
                  <label className="mb-1 block text-xs text-red-600">Яка ціна вказана фактично, ₴</label>
                  <input type="number" min="0" step="0.01" inputMode="decimal" value={observedPrice}
                    onChange={(event) => setObservedPrice(event.target.value)}
                    className="w-full rounded-lg border border-red-300 px-3 py-2 text-lg font-bold outline-none focus:border-red-500" />
                </div>
              )}
            </div>

            {canEditPrice && (
              <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50/40 p-3">
                <p className="mb-2 text-sm font-semibold text-blue-900">Виправити ціни товару (тут, без окремого вікна)</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">Закупівельна, ₴</label>
                    <input type="number" min="0" step="0.01" inputMode="decimal" value={editPurchase}
                      onChange={(event) => setEditPurchase(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base font-semibold outline-none focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">Продажу, ₴</label>
                    <input type="number" min="0" step="0.01" inputMode="decimal" value={editRetail}
                      onChange={(event) => setEditRetail(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base font-bold outline-none focus:border-blue-500" />
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-gray-500">Націнка:</span>
                  {[20, 30, 50, 100].map((p) => (
                    <button key={p} type="button" onClick={() => applyMarkupToEdit('percent', p)}
                      className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-100">+{p}%</button>
                  ))}
                  <button type="button" onClick={() => applyMarkupToEdit('table')}
                    className="rounded-lg border border-blue-300 bg-white px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100">По таблиці</button>
                </div>
                <Button variant="outline" size="sm" onClick={savePrice} loading={savingPrice} className="mt-2 w-full">
                  Зберегти ціни товару
                </Button>
              </div>
            )}

            <Button onClick={saveCount} loading={saving} className="mt-4 w-full" icon={<PackageCheck size={17} />}>
              Додати мій підрахунок
            </Button>
          </Card>
        )}

        <CameraScanner
          open={cameraOpen}
          onClose={() => setCameraOpen(false)}
          onScan={(code) => {
            setCameraOpen(false)
            setQuery(code)
            resolveCode(code)
          }}
        />

        <Card padding="none">
          <button onClick={() => setShowRecent(!showRecent)}
            className="flex w-full items-center justify-between px-4 py-3 text-left">
            <span className="font-semibold text-gray-900">Додані товари ({countedRows.length})</span>
            <ChevronDown size={17} className={showRecent ? 'rotate-180' : ''} />
          </button>

          {canEditPrice && isActive && selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-yellow-50 px-4 py-2.5">
              <span className="text-xs font-semibold text-gray-700">Вибрано: {selectedIds.size}</span>
              <span className="text-xs text-gray-500">Масова націнка:</span>
              {[30, 50, 100].map((p) => (
                <button key={p} type="button" disabled={massBusy}
                  onClick={() => applyMassPrice({ type: 'markup', value: p })}
                  className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">+{p}%</button>
              ))}
              <button type="button" disabled={massBusy}
                onClick={() => applyMassPrice({ type: 'markup_table', value: 30 })}
                className="rounded-lg border border-blue-300 bg-white px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50">По таблиці</button>
              <button type="button" disabled={massBusy}
                onClick={() => { const v = prompt('Підняти ціну продажу на, %:', '10'); const n = Number(v); if (v != null && Number.isFinite(n)) applyMassPrice({ type: 'percent', value: n }) }}
                className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">Ціна +%</button>
              <button type="button" onClick={() => setSelectedIds(new Set())}
                className="ml-auto text-xs text-gray-500 hover:text-gray-800">Зняти вибір</button>
            </div>
          )}
          {showRecent && (
            <div className="divide-y divide-gray-100 border-t border-gray-100">
              {countedRows.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400">
                  Скануйте штрихкод або знайдіть товар — він з'явиться тут рядком.
                </p>
              ) : countedRows.map((item) => (
                <InventoryRow
                  key={item.id}
                  item={item}
                  isActive={isActive}
                  canEditPrice={canEditPrice}
                  selected={item.product?.id ? selectedIds.has(item.product.id) : false}
                  onToggleSelect={() => item.product?.id && toggleSelectId(item.product.id)}
                  onSetQty={(value) => setItemQty(item, value)}
                  onSetRetail={(value) => setItemRetail(item, value)}
                  onMarkup={(kind, pct) => applyRowMarkup(item, kind, pct)}
                  onRemove={() => setItemQty(item, '0')}
                />
              ))}
            </div>
          )}
        </Card>

        {session.price_issues.length > 0 && (
          <Card padding="none">
            <div className="border-b border-red-100 bg-red-50 px-4 py-3">
              <p className="flex items-center gap-2 font-semibold text-red-800">
                <AlertTriangle size={16} /> Ціни не збігаються ({session.price_issues.length})
              </p>
            </div>
            <div className="divide-y divide-gray-100">
              {session.price_issues.map((issue) => (
                <div key={issue.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-900">{issue.product?.name ?? 'Товар'}</p>
                    <p className="font-mono text-xs text-gray-500">{issue.product?.sku}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs text-gray-500">У програмі: {formatMoney(issue.product?.retail_price ?? 0)}</p>
                    <p className="font-bold text-red-600">На ціннику: {formatMoney(issue.observed_retail_price)}</p>
                    {canComplete && issue.product?.id && (
                      <button
                        type="button"
                        onClick={() => window.open(`/products/${issue.product!.id}/edit`, '_blank', 'noopener,noreferrer')}
                        className="mt-1 text-xs font-semibold text-blue-600 hover:underline"
                      >
                        Виправити товар
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {isActive && canComplete && (
          <div className="flex justify-end">
            <Button onClick={completeSession} icon={<CheckCircle size={16} />}>
              Завершити та застосувати залишки
            </Button>
          </div>
        )}
        {isActive && !canComplete && (
          <p className="text-center text-xs text-gray-500">Завершує ревізію власник або адміністратор.</p>
        )}
      </div>
    </Layout>
  )
}

// Один рядок товару в ревізії: кількість і ціна редагуються прямо тут.
// Поля неконтрольовані (defaultValue + key) — зберігаються на blur/Enter і
// не збивають фокус при фоновому оновленні кожні 8с.
function InventoryRow({
  item, isActive, canEditPrice, selected,
  onToggleSelect, onSetQty, onSetRetail, onMarkup, onRemove,
}: {
  item: InventoryItem
  isActive: boolean
  canEditPrice: boolean
  selected: boolean
  onToggleSelect: () => void
  onSetQty: (value: string) => void
  onSetRetail: (value: string) => void
  onMarkup: (kind: 'percent' | 'table', pct?: number) => void
  onRemove: () => void
}) {
  const retailStr = ((item.product?.retail_price ?? 0) / 100).toFixed(2)
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap">
      {canEditPrice && isActive && (
        <input type="checkbox" aria-label="Вибрати" checked={selected} onChange={onToggleSelect}
          className="h-4 w-4 shrink-0 rounded border-gray-300" />
      )}
      <div className="min-w-0 flex-1 basis-full sm:basis-auto">
        <p className="truncate text-sm font-medium text-gray-900">{item.product?.name ?? 'Товар'}</p>
        <p className="truncate font-mono text-[11px] text-gray-500">
          {item.product?.sku} · було {item.expected_stock}{item.product?.storage_bin ? ` · ${item.product.storage_bin}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="text-center">
          <span className="block text-[10px] text-gray-400">К-сть</span>
          <input key={`q-${item.counted_stock}`} type="number" min="0" step="0.001" inputMode="decimal"
            defaultValue={String(item.counted_stock)} disabled={!isActive}
            onBlur={(event) => onSetQty(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
            className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-center text-sm font-bold outline-none focus:border-yellow-500" />
        </div>
        {canEditPrice && (
          <div className="text-center">
            <span className="block text-[10px] text-gray-400">Ціна ₴</span>
            <input key={`p-${item.product?.retail_price}`} type="number" min="0" step="0.01" inputMode="decimal"
              defaultValue={retailStr} disabled={!isActive}
              onBlur={(event) => onSetRetail(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
              className="w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-right text-sm font-semibold outline-none focus:border-blue-500" />
          </div>
        )}
        {canEditPrice && isActive && (
          <div className="flex flex-col gap-0.5">
            <button type="button" onClick={() => onMarkup('percent', 30)}
              className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-gray-600 hover:bg-gray-100">+30%</button>
            <button type="button" onClick={() => onMarkup('table')}
              className="rounded border border-blue-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 hover:bg-blue-50">табл</button>
          </div>
        )}
        {isActive && (
          <button type="button" onClick={onRemove} aria-label="Прибрати"
            className="rounded-lg bg-red-50 p-1.5 text-red-600 hover:bg-red-100"><RotateCcw size={14} /></button>
        )}
      </div>
    </div>
  )
}
