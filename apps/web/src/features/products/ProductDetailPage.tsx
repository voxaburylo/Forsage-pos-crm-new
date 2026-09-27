import { useEffect, useState, useCallback } from 'react'
import { useLatestRequest } from '@/hooks/useLatestRequest'
import { useScopedAction } from '@/hooks/useScopedAction'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { parseWriteoffQuantity } from '@/features/inventory/writeoffQuantity'
import { useNavigate, useParams } from 'react-router-dom'
import { Edit, Trash2, Clock, AlertTriangle, Trash, CheckCircle, XCircle, Barcode, Printer, Camera } from 'lucide-react'
import { productApi, type ProductCrossNumber } from './productApi'
import type { Product } from '@/types/product'
import { kopecksToHryvnia, stockStatus } from '@/types/product'
import { getSpecTemplate } from './productSpecs'
import { ProductPhotoUpload } from './ProductPhotoUpload'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, Modal, ConfirmDialog } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import {
  printLabels,
  loadProductLabelSettings,
  DEFAULT_BIN_LABEL,
} from '@/features/labels/LabelDesigner'
import { warehouseApi } from '@/features/inventory/warehouseApi'
import { useWarehouseRecovery, WarehouseRecoveryNotice } from '@/features/inventory/WarehouseRecovery'
import { canDeleteCatalog } from './catalogDeletePermissions'

import { useAuthStore } from '@/stores/authStore'

function settleOptional<T, F>(
  operation: Promise<T>,
  fallback: F,
  timeoutMs = 8_000,
): Promise<T | F> {
  return new Promise((resolve) => {
    let settled = false
    let timer = 0
    const finish = (value: T | F) => {
      if (settled) return
      settled = true
      if (timer) window.clearTimeout(timer)
      resolve(value)
    }
    timer = window.setTimeout(() => finish(fallback), timeoutMs)
    operation.then(finish).catch(() => finish(fallback))
  })
}

function StockBadge({ product }: { product: Product }) {
  const status = stockStatus(product)
  const map = {
    ok: { color: 'green' as const, icon: <CheckCircle size={14} />, label: 'Є в наявності' },
    low: { color: 'orange' as const, icon: <AlertTriangle size={14} />, label: 'Мало' },
    out: { color: 'red' as const, icon: <XCircle size={14} />, label: 'Нема' },
  }
  const { color, icon, label } = map[status]
  return (
    <Badge color={color} className="flex items-center gap-1 text-sm px-3 py-1">
      {icon} {label}
    </Badge>
  )
}

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>()
  return <ProductDetail key={id} />
}

function ProductDetail() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  // Закупівля/маржа — тільки власник/адмін/кладівник (сервер їх і не віддає іншим)
  const role = useAuthStore((s) => (s.session?.user?.app_metadata?.role as string) ?? 'cashier')
  const offlineMode = useAuthStore((s) => s.offlineMode)
  const photoRequests = useLatestRequest([id, offlineMode])
  const writes = useScopedAction(JSON.stringify([id, role, offlineMode]))
  const linksRequests = useLatestRequest([id, offlineMode])
  const canWrite = isDesktopRuntime() && ['owner', 'admin', 'manager', 'cashier', 'storekeeper'].includes(role)
  const canReserve = canWrite && role !== 'cashier'
  const reserveRecovery = useWarehouseRecovery('reserve', canReserve)
  const reserveRefresh = useLatestRequest([id, role, offlineMode])
  const canSeeMargin = ['owner', 'admin', 'storekeeper'].includes(role)
  const canDeleteProduct = canWrite && canDeleteCatalog(role)
  const [product, setProduct] = useState<Product | null>(null)
  const [history, setHistory] = useState<Array<{
    type: 'price_change' | 'sale' | 'return' | 'writeoff'
    date: string
    details: Record<string, unknown>
  }>>([])
  const [loading, setLoading] = useState(true)
  const [analogs, setAnalogs] = useState<{ grouped: Record<string, any[]> } | null>(null)
  const [crossNumbers, setCrossNumbers] = useState<ProductCrossNumber[]>([])
  const [crossPaste, setCrossPaste] = useState('')
  const [crossSource, setCrossSource] = useState('Внесено менеджером')
  const [linksLoading, setLinksLoading] = useState(true)
  const [linksError, setLinksError] = useState('')
  const [fitment, setFitment] = useState<{ grouped: Record<string, any[]> } | null>(null)
  const [cobuy, setCobuy] = useState<any[]>([])
  const [photoModalOpen, setPhotoModalOpen] = useState(false)
  const [savingPhoto, setSavingPhoto] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [printModalOpen, setPrintModalOpen] = useState(false)
  const [printCopies, setPrintCopies] = useState(1)

  
  const refreshLinks = useCallback(async () => {
    if (!id) return
    const isCurrent = linksRequests.begin()
    setLinksLoading(true)
    setLinksError('')
    try {
      const [matches, numbers] = await Promise.all([
        settleOptional(productApi.getAnalogs(id), null),
        settleOptional(productApi.getCrossNumbers(id), null),
      ])
      if (!isCurrent()) return
      if (!matches || !numbers) throw new Error('Не вдалося завантажити аналоги')
      setAnalogs(matches)
      setCrossNumbers(numbers.data)
    } catch {
      if (isCurrent()) setLinksError('Не вдалося оновити крос-номери та аналоги. Повторіть завантаження.')
    } finally {
      if (isCurrent()) setLinksLoading(false)
    }
  }, [id, linksRequests])

  useEffect(() => { void refreshLinks() }, [refreshLinks, offlineMode])

  const handleAddCrossNumbers = async () => {
    if (!id || !canWrite || linksLoading || linksError || uploadingPhoto) return
    const numbers = [...new Set(crossPaste.split(/[\r\n,;\t]+/).map(value => value.trim()).filter(Boolean))]
    if (!numbers.length) { toast.error('Вставте хоча б один номер'); return }
    const attempt = writes.begin()
    if (!attempt) return
    try {
      const { data } = await productApi.addCrossNumbers(id, numbers, crossSource.trim() || 'Внесено менеджером')
      if (!attempt.isCurrent()) return
      setCrossNumbers(data)
      setCrossPaste('')
      toast.success('Крос-номери збережено')
      await refreshLinks()
    } catch (error) {
      if (attempt.isCurrent()) toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти номери')
    } finally { attempt.finish() }
  }

  const handleRemoveCrossNumber = async (crossNumber: ProductCrossNumber) => {
    if (!id || !canWrite || linksLoading || linksError || uploadingPhoto || writes.isBusy()) return
    if (!confirm('Видалити номер ' + crossNumber.number + '?')) return
    const attempt = writes.begin()
    if (!attempt) return
    try {
      const { data } = await productApi.removeCrossNumber(id, crossNumber.id)
      if (!attempt.isCurrent()) return
      setCrossNumbers(data)
      toast.success('Номер видалено')
      await refreshLinks()
    } catch (error) {
      if (attempt.isCurrent()) toast.error(error instanceof Error ? error.message : 'Не вдалося видалити номер')
    } finally { attempt.finish() }
  }

  const copyCrossNumber = async (number: string) => {
    try {
      await navigator.clipboard.writeText(number)
      toast.success('Номер скопійовано')
    } catch {
      toast.error('Не вдалося скопіювати номер')
    }
  }

  async function handlePhotoUrl(url: string | null) {
    if (!product || !id || product.id !== id) throw new Error('Відкрийте картку товару повторно')
    if (!canWrite) throw new Error('Картка доступна лише для перегляду')
    const attempt = writes.begin()
    if (!attempt) throw new Error('Зачекайте завершення попереднього збереження')
    const isCurrent = photoRequests.begin()
    setSavingPhoto(true)
    try {
      await productApi.update(id, { photo_url: url ?? '' })
      if (isCurrent() && attempt.isCurrent()) setProduct(current => current?.id === id ? { ...current, photo_url: url } : current)
    } finally {
      if (isCurrent()) setSavingPhoto(false)
      attempt.finish()
    }
  }

  function handleSendToPrintQueue() {
    if (!product) return
    const queueItems = [{ id: product.id, copies: 1 }]

    const current = localStorage.getItem('forsage_labels_import')
    let queue: Array<{ id: string; copies: number }> = []
    if (current) {
      try {
        queue = JSON.parse(current)
        if (!Array.isArray(queue)) queue = []
      } catch {
        queue = []
      }
    }

    queueItems.forEach(item => {
      const existing = queue.find(q => q.id === item.id)
      if (existing) {
        existing.copies += item.copies
      } else {
        queue.push(item)
      }
    })

    localStorage.setItem('forsage_labels_import', JSON.stringify(queue))
    toast.success('Товар додано до черги друку. Перенаправлення...')
    setTimeout(() => {
      navigate('/labels')
    }, 800)
  }

  async function handlePrintBinLabel() {
    if (!product || !product.storage_bin) return
    try {
      const settings = await loadProductLabelSettings()
      const binSettings = settings.bin_settings || DEFAULT_BIN_LABEL
      await printLabels(binSettings as any, [{ label: product.storage_bin }], true)
      toast.success('Етикетку комірки відправлено на друк')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося надрукувати етикетку')
    }
  }

  useEffect(() => {
    if (!id) return
    let active = true
    setLoading(true)
    setPhotoModalOpen(false)
    setSavingPhoto(false)
    setUploadingPhoto(false)
    productApi.get(id).then(({ data }) => {
      if (!active) return
      setProduct(data)
      setLoading(false)
      return Promise.all([
        settleOptional(productApi.getHistory(id), { data: [] }),

        settleOptional(productApi.getFitment(id), null),
        settleOptional(productApi.getCobuy(id), []),
      ]).then(([{ data: hist }, fitmentData, cobuyData]) => {
        if (!active) return
        setHistory(hist as typeof history)

        setFitment(fitmentData)
        setCobuy(cobuyData)
      })
    }).catch(() => { if (active) navigate('/products') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [id, navigate, offlineMode])

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [reserveOpen, setReserveOpen] = useState(false)
  const [reserveQty, setReserveQty] = useState('1')
  async function handleReserve() {
    if (!product || !canReserve || uploadingPhoto || reserveRecovery.blocked || reserveRecovery.busy) return
    const qty = parseWriteoffQuantity(reserveQty)
    if (qty === null) { toast.error('Вкажіть коректну кількість, не більше трьох знаків після коми'); return }
    const attempt = writes.begin()
    if (!attempt) return
    try {
      await warehouseApi.createReserve({
        product_id: product.id, qty, customer_id: null, order_id: null, duration_days: 3,
      })
      if (!attempt.isCurrent()) return
      toast.success('Товар зарезервовано на 3 дні')
      setReserveOpen(false)
      setReserveQty('1')
      try {
        const data = await settleOptional(productApi.get(product.id), null)
        if (!attempt.isCurrent()) return
        if (data) setProduct(data.data)
        else toast.warning('Резерв збережено. Відкрийте картку повторно для оновлення залишку.')
      } catch {
        if (attempt.isCurrent()) toast.warning('Резерв збережено. Відкрийте картку повторно для оновлення залишку.')
      }
    } catch (e) {
      if (attempt.isCurrent()) { reserveRecovery.refresh(); toast.error(e instanceof Error ? e.message : 'Не вдалося зарезервувати') }
    } finally { attempt.finish() }
  }

  const reserveRecoveryNotice = <WarehouseRecoveryNotice recovery={reserveRecovery} disabled={writes.busy} onResolved={result => {
    if (result.committed) { setReserveOpen(false); setReserveQty('1') }
    if (!id) return
    const current = reserveRefresh.begin()
    void settleOptional(productApi.get(id), null).then(data => {
      if (!current()) return
      if (data) setProduct(data.data)
      else toast.warning('Відкрийте картку повторно для оновлення залишку.')
    })
  }} />

  async function handleDelete() {
    if (!product || !canDeleteProduct || uploadingPhoto) return false
    const attempt = writes.begin()
    if (!attempt) return false
    try {
      await productApi.delete(product.id)
      if (!attempt.isCurrent()) return false
      toast.success('Товар видалено')
      navigate('/products')
    } catch (e) {
      if (attempt.isCurrent()) toast.error(e instanceof Error ? e.message : 'Помилка')
      return false
    } finally { attempt.finish() }
  }

  async function handleGenerateBarcode() {
    if (!product || !canWrite || uploadingPhoto || writes.isBusy()) return
    if (product.barcode && !confirm('Замінити основний штрихкод товару на новий?')) return
    const attempt = writes.begin()
    if (!attempt) return
    try {
      const { data } = await productApi.generateBarcode(product.id)
      if (!attempt.isCurrent()) return
      setProduct(data)
      toast.success('Штрихкод згенеровано: ' + data.barcode)
    } catch (e) {
      if (attempt.isCurrent()) toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally { attempt.finish() }
  }

  if (loading || !product) return (
    <Layout>
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div>
    </Layout>
  )

  return (
    <Layout
      title={product.name}
      actions={
        <div className="flex gap-2 items-center">
          {product.is_active === false && <Badge color="red">🚫 Неактивний</Badge>}
          {canReserve && <Button variant="secondary" size="sm" disabled={writes.busy || uploadingPhoto} onClick={() => setReserveOpen(true)}>
            📌 Резерв
          </Button>}
          {canWrite && <Button variant="secondary" size="sm" disabled={writes.busy || uploadingPhoto} icon={<Edit size={14} />} onClick={() => navigate(`/products/${product.id}/edit`)}>
            Редагувати
          </Button>}
          {canDeleteProduct && (
<Button variant="danger" size="sm" disabled={writes.busy || uploadingPhoto} icon={<Trash2 size={14} />} onClick={() => setConfirmDeleteOpen(true)}>
              Видалити
            </Button>
          )}
        </div>
      }
    >
      <div className="max-w-3xl space-y-4">
        {!reserveOpen && canReserve && reserveRecoveryNotice}

        {/* Основна інфо */}
        <Card>
          <div className="flex items-start gap-5 mb-4">
            {/* Фото — клікабельне, з можливістю завантажити/змінити */}
            <div className="relative shrink-0 group">
              {product.photo_url ? (
                <img
                  src={product.photo_url}
                  alt={product.name}
                  className="w-28 h-28 object-cover rounded-xl border border-gray-200"
                />
              ) : (
                <div className="w-28 h-28 rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 flex items-center justify-center text-gray-400">
                  <Camera size={28} />
                </div>
              )}
              {canWrite && <button
                disabled={writes.busy || uploadingPhoto}
                onClick={() => setPhotoModalOpen(true)}
                className="absolute inset-0 w-full h-full flex items-center justify-center bg-black/0 group-hover:bg-black/40 rounded-xl transition-all"
              >
                <span className="opacity-0 group-hover:opacity-100 text-white text-xs font-medium bg-black/60 px-3 py-1.5 rounded-lg transition-all">
                  {product.photo_url ? 'Змінити фото' : 'Додати фото'}
                </span>
              </button>}
            </div>
            <div className="flex-1 flex items-start justify-between">
              <div>
                <p className="text-xs text-gray-400 mb-1">Артикул</p>
                <p className="font-mono font-semibold text-gray-800">{product.sku}</p>
              </div>
              <StockBadge product={product} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Категорія</p>
              <p className="text-sm text-gray-800">{product.category?.name ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Бренд</p>
              <p className="text-sm text-gray-800">{product.brand?.name ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1.5">Штрихкод</p>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 min-h-[48px]">
                  {product.barcode ? (
                    <>
                      <span className="text-lg font-mono font-bold text-gray-900 tracking-wider select-all">{product.barcode}</span>
                      <button onClick={() => { setPrintCopies(1); setPrintModalOpen(true); }}
                        className="ml-auto text-xs text-green-600 hover:text-green-800 flex items-center gap-1 font-medium shrink-0 px-2 py-1 rounded-lg hover:bg-green-50 transition-colors"
                        title="Друк етикетки">
                        <Printer size={14} /> Друк
                      </button>
                      <button onClick={handleSendToPrintQueue}
                        className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 font-medium shrink-0 px-2 py-1 rounded-lg hover:bg-blue-50 transition-colors"
                        title="Додати в чергу друку">
                        📥 В чергу
                      </button>
                    </>
                  ) : (
                    <span className="text-gray-400 text-sm italic">Не вказано</span>
                  )}
                </div>
                {canWrite && <button onClick={handleGenerateBarcode} disabled={writes.busy || uploadingPhoto}
                  className="self-start text-xs text-gray-500 hover:text-blue-600 flex items-center gap-1 font-medium px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-colors">
                  <Barcode size={14} /> Згенерувати штрихкод
                </button>}
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Одиниця</p>
              <p className="text-sm text-gray-800">{product.unit}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Місце зберігання</p>
              <div className="flex items-center gap-2">
                <p className="text-sm font-mono text-gray-800">{product.storage_bin ?? '—'}</p>
                {product.storage_bin && (
                  <button onClick={handlePrintBinLabel}
                    className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-0.5 font-medium ml-2"
                    title="Друк етикетки комірки">
                    <Printer size={12} /> Друк комірки
                  </button>
                )}
              </div>
            </div>
          </div>

          {product.notes && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <p className="text-xs text-gray-400 mb-0.5">Примітки</p>
              <p className="text-sm text-gray-700">{product.notes}</p>
            </div>
          )}
        </Card>

        <div className={`grid grid-cols-1 gap-4 ${canSeeMargin ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
          {canSeeMargin && (
            <Card>
              <p className="text-xs text-gray-400 mb-1">Закупівельна ціна</p>
              <p className="text-2xl font-bold text-gray-900">{kopecksToHryvnia(product.purchase_price)} ₴</p>
            </Card>
          )}
          <Card>
            <p className="text-xs text-gray-400 mb-1">Роздрібна ціна</p>
            <p className="text-2xl font-bold text-gray-900">{kopecksToHryvnia(product.retail_price)} ₴</p>
          </Card>
          <Card>
            <p className="text-xs text-gray-400 mb-1">Доступно / Залишок</p>
            <p className="text-2xl font-bold text-gray-950">{product.qty_available ?? product.qty_on_hand} {product.unit}</p>
            <p className="text-xs text-gray-500 mt-0.5">фіз: {product.qty_on_hand} {product.unit} | мін: {product.reorder_point} {product.unit}</p>
            {product.qty_reserved !== undefined && product.qty_reserved > 0 && (
              <p className="text-xs text-orange-600 mt-1 font-semibold">
                Зарезервовано: {product.qty_reserved} {product.unit}
              </p>
            )}
          </Card>
        </div>

        {/* Технічні характеристики */}
        {(() => {
          const tpl = getSpecTemplate(product.category?.name ?? '')
          const specs = product.specs
          if (!tpl || !specs || Object.keys(specs).length === 0) return null
          const filled = tpl.fields.filter((f) => specs[f.key])
          if (filled.length === 0) return null
          return (
            <Card>
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">{tpl.label}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
                {filled.map((f) => (
                  <div key={f.key}>
                    <p className="text-xs text-gray-400">{f.label}{f.unit ? ` (${f.unit})` : ''}</p>
                    <p className="text-sm font-semibold text-gray-900">{specs[f.key]}</p>
                  </div>
                ))}
              </div>
            </Card>
          )
        })()}

        {/* Маржа */}
        {canSeeMargin && product.purchase_price > 0 && (
          <Card>
            <p className="text-xs text-gray-400 mb-1">Маржа</p>
            <p className="text-xl font-bold text-green-600">
              {kopecksToHryvnia(product.retail_price - product.purchase_price)} ₴
              {' '}
              <span className="text-sm text-gray-500 font-normal">
                ({product.retail_price > 0 ? Math.round((1 - product.purchase_price / product.retail_price) * 100) + '%' : '—'})
              </span>
            </p>
          </Card>
        )}


        {/* Matches are derived from local cross-numbers, not independent cloud links. */}
        <Card>
          <h3 className="font-semibold text-gray-800 mb-2">Крос-номери та аналоги</h3>
          <p className="text-xs text-gray-500 mb-4">
            Аналоги визначаються за крос-номерами товарів. Додавайте лише перевірені номери сумісних деталей.
          </p>
          {linksLoading && <p role="status" className="text-sm text-gray-500 mb-3">Оновлюємо аналоги...</p>}
          {linksError && <div role="alert" className="text-sm text-amber-700 mb-3">
            {linksError} <Button size="sm" disabled={writes.busy} onClick={refreshLinks}>Оновити аналоги</Button>
          </div>}
          <fieldset disabled={writes.busy || uploadingPhoto || linksLoading || !!linksError} className="min-w-0">

          <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4 mb-5">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 mb-3">
              <div>
                <p className="text-sm font-semibold text-gray-900">Номери, за якими можна знайти цей товар</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {canWrite ? 'Вставте список з Excel, каталогу або повідомлення. Розділяйте номери новим рядком, комою чи крапкою з комою.' : 'Натисніть номер, щоб скопіювати. Зміни доступні в локальній програмі.'}
                </p>
              </div>
              {!linksLoading && !linksError && <Badge color="blue">{crossNumbers.length} номерів</Badge>}
            </div>

            {canWrite && <>
            <textarea
              value={crossPaste}
              onChange={(event) => setCrossPaste(event.target.value)}
              rows={4}
              placeholder={'Наприклад:\n96182220\n94788122\nOC90'}
              className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2.5 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />

            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 mt-2">
              <input
                value={crossSource}
                onChange={(event) => setCrossSource(event.target.value)}
                maxLength={200}
                placeholder="Джерело: постачальник, каталог..."
                className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
              <Button
                size="sm"
                onClick={handleAddCrossNumbers}
                disabled={writes.busy || !crossPaste.trim()}
              >
                {writes.busy ? 'Зберігаємо...' : 'Додати номери'}
              </Button>
            </div>

            </>}
            {crossNumbers.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {crossNumbers.map((crossNumber) => (
                  <div
                    key={crossNumber.id}
                    className="group flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white pl-2.5 pr-1.5 py-1.5 shadow-sm"
                    title={`${crossNumber.source} · ${crossNumber.number_type.toUpperCase()}`}
                  >
                    <span className="text-[9px] font-bold uppercase text-blue-600">
                      {crossNumber.number_type === 'oe' ? 'OE' : crossNumber.number_type === 'supplier' ? 'ПОСТ' : crossNumber.number_type === 'other' ? 'ІНШ' : 'КРОС'}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyCrossNumber(crossNumber.number)}
                      className="font-mono text-xs font-semibold text-gray-900 hover:text-blue-700"
                      title="Скопіювати номер"
                    >
                      {crossNumber.number}
                    </button>
                    {canWrite && <button
                      type="button"
                      onClick={() => handleRemoveCrossNumber(crossNumber)}
                      className="p-0.5 text-gray-300 hover:text-red-500 opacity-50 group-hover:opacity-100"
                      title="Видалити номер"
                    >
                      <Trash size={11} />
                    </button>}
                  </div>
                ))}
              </div>
            )}
          </div>

          </fieldset>
          <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">Пов’язані товари зі складу</p>

          {analogs && Object.keys(analogs.grouped).length > 0 && (
            <div className="space-y-4">
              {Object.entries(analogs.grouped).map(([tier, items]) =>
                (items as any[]).length > 0 && (
                  <div key={tier} className="mb-3 last:mb-0">
                    <p className="text-xs text-gray-400 uppercase font-bold mb-1">
                      {tier === 'original' ? 'Original' : tier === 'premium' ? 'Premium' : tier === 'standard' ? 'Standard' : 'Budget'}
                    </p>
                    <div className="space-y-1">
                      {(items as any[]).map((a: any) => (
                        <div key={a.id} className="flex items-center justify-between px-3 py-1.5 bg-gray-50 rounded-lg text-sm group hover:bg-gray-100 transition">
                          <div>
                            <button onClick={() => navigate('/products/' + a.id)} className="font-medium text-blue-600 hover:text-blue-800 text-xs">{a.name}</button>
                            <span className="text-[10px] text-gray-400 ml-2 font-mono">{a.sku}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-semibold text-xs">{a.retail_price != null ? kopecksToHryvnia(a.retail_price) + ' ₴' : '—'}</span>
                            <span className={'text-[10px] px-1.5 py-0.5 rounded-full ' + ((a.qty_available ?? a.qty_on_hand) > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')}>
                              {(a.qty_available ?? a.qty_on_hand) > 0 ? 'Є (' + (a.qty_available ?? a.qty_on_hand) + ')' : 'Нема'}
                            </span>

                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              )}
            </div>
          )}

          {!linksLoading && !linksError && (!analogs || Object.values(analogs.grouped).every(arr => (arr as any[]).length === 0)) && (
            <div className="text-xs text-center py-6 text-gray-400">
              За внесеними крос-номерами пов’язаних товарів не знайдено.
            </div>
          )}
        </Card>

        {/* Fitment — сумісність з авто */}
        {fitment && Object.keys(fitment.grouped).length > 0 && (
          <Card>
            <h3 className="font-semibold text-gray-800 mb-3">🚗 Сумісність з авто</h3>
            <div className="space-y-3">
              {Object.entries(fitment.grouped).map(([make, items]) => (
                <div key={make}>
                  <p className="text-sm font-bold text-gray-700 mb-1">{make}</p>
                  <div className="space-y-0.5">
                    {(items as any[]).map((f: any) => (
                      <div key={f.id} className="text-xs text-gray-600 px-2 py-1 bg-gray-50 rounded">
                        {f.model}
                        {f.year_from && ' (' + f.year_from + (f.year_to ? '-' + f.year_to : '') + ')'}
                        {f.engine_code && ' • Двигун: ' + f.engine_code}
                        {f.body_code && ' • Кузов: ' + f.body_code}
                        {f.source && <span className="text-gray-400 ml-1">[' + f.source + ']</span>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Co-buy — супутні товари */}
        {cobuy.length > 0 && (
          <Card>
            <h3 className="font-semibold text-gray-800 mb-3">🛒 Часто купують разом</h3>
            <div className="flex gap-2 overflow-x-auto pb-2">
              {cobuy.map((item: any) => (
                <button key={item.id} onClick={() => navigate('/products/' + item.id)}
                  className="flex flex-col items-center min-w-[120px] p-3 bg-gray-50 rounded-xl hover:bg-gray-100 text-center">
                  <span className="text-sm font-medium text-gray-800">{item.name}</span>
                  <span className="text-xs text-gray-400">{item.sku}</span>
                  <span className="text-sm font-bold text-yellow-600 mt-1">{kopecksToHryvnia(item.retail_price)} ₴</span>
                </button>
              ))}
            </div>
          </Card>
        )}

        {/* Історія товару */}
        {history.length > 0 && (
          <Card padding="none">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
              <Clock size={16} className="text-gray-400" />
              <h3 className="font-semibold text-gray-800 text-sm">Історія товару</h3>
            </div>
            <div className="divide-y divide-gray-50 max-h-96 overflow-y-auto">
              {history.map((h, i) => (
                <div key={i} className="px-6 py-2.5 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    {h.type === 'price_change' && <span className="text-blue-500">💰</span>}
                    {h.type === 'sale' && <span className="text-green-500">🛒</span>}
                    {h.type === 'return' && <span className="text-red-500">↩️</span>}
                    {h.type === 'writeoff' && <span className="text-orange-500">🗑️</span>}
                    <div>
                      {h.type === 'price_change' && (
                        <span>Ціна: {kopecksToHryvnia(Number(h.details.old_price))} → {kopecksToHryvnia(Number(h.details.new_price))} ₴</span>
                      )}
                      {h.type === 'sale' && (
                        <span>Продаж: {String(h.details.qty)} шт × {kopecksToHryvnia(Number(h.details.unit_price))} ₴</span>
                      )}
                      {h.type === 'return' && (
                        <span>Повернення: {String(h.details.qty)} шт на {kopecksToHryvnia(Number(h.details.total))} ₴</span>
                      )}
                      {h.type === 'writeoff' && (
                        <span>Списання: {String(h.details.qty)} шт</span>
                      )}
                      {(h.details as any).reason && <span className="text-gray-400 ml-1">({(h.details as any).reason})</span>}
                    </div>
                  </div>
                  <span className="text-gray-400 text-xs whitespace-nowrap ml-2">
                    {new Date(h.date).toLocaleDateString('uk-UA') + ' ' + new Date(h.date).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Модалка додавання/зміни фото */}
      <Modal
        open={photoModalOpen}
        onClose={() => { if (!uploadingPhoto && !savingPhoto) setPhotoModalOpen(false) }}
        title={product.photo_url ? 'Змінити фото товару' : 'Додати фото товару'}
        size="md"
      >
        <ProductPhotoUpload
          productId={product.id}
          currentPhotoUrl={product.photo_url ?? null}
          onPhotoUrl={handlePhotoUrl}
          onBusyChange={setUploadingPhoto}
          disabled={!canWrite || writes.busy}
        />
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-100">
          <p className="text-xs text-gray-400">
            {uploadingPhoto || savingPhoto ? 'Зберігаємо...' : 'Зміни зберігаються автоматично'}
          </p>
          <Button
            onClick={() => setPhotoModalOpen(false)}
            loading={uploadingPhoto || savingPhoto}
          >
            Готово
          </Button>
        </div>
      </Modal>

      {/* Модалка друку етикеток */}
      <Modal
        open={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        title="Друк етикетки"
        size="sm"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Кількість копій
            </label>
            <input
              type="number"
              min={1}
              max={999}
              value={printCopies}
              onChange={(e) => setPrintCopies(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-gray-100">
            <Button variant="secondary" onClick={() => setPrintModalOpen(false)}>
              Скасувати
            </Button>
            <Button
              onClick={async () => {
                try {
                  const settings = await loadProductLabelSettings()
                  const items = Array(printCopies).fill(product)
                  await printLabels(settings as any, items, false)
                  setPrintModalOpen(false)
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : 'Не вдалося надрукувати етикетки')
                }
              }}
            >
              Друкувати
            </Button>
          </div>
        </div>
      </Modal>

      {canDeleteProduct && (
        <ConfirmDialog
          open={confirmDeleteOpen}
          onClose={() => setConfirmDeleteOpen(false)}
          onConfirm={handleDelete}
          title="Видалити товар"
          message={<>Видалити товар <strong>{product.name}</strong>?</>}
          confirmLabel="Видалити"
          danger
        />
      )}

      <Modal open={reserveOpen && canReserve} onClose={() => { if (!writes.isBusy()) setReserveOpen(false) }} title="Зарезервувати товар" size="sm">
        {reserveRecoveryNotice}
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Резерв «{product.name}» на 3 дні. Клієнта можна додати пізніше в розділі «Склад → Резерви».
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Кількість</label>
            <input aria-label="Кількість резерву" type="text" inputMode="decimal" disabled={writes.busy || reserveRecovery.blocked || reserveRecovery.busy} value={reserveQty} onChange={(e) => setReserveQty(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" autoFocus />
          </div>
          <div className="flex gap-3">
            <Button className="flex-1" loading={writes.busy} disabled={reserveRecovery.blocked || reserveRecovery.busy} onClick={handleReserve}>Зарезервувати</Button>
            <Button variant="secondary" disabled={writes.busy} onClick={() => { if (!writes.isBusy()) setReserveOpen(false) }}>Скасувати</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}

