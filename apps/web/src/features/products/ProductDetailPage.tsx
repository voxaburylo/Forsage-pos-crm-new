import { useEffect, useState, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Edit, Trash2, Clock, AlertTriangle, Search, Trash, CheckCircle, XCircle, Barcode, Printer, Camera } from 'lucide-react'
import { productApi } from './productApi'
import type { Product } from '@/types/product'
import { kopecksToHryvnia, stockStatus } from '@/types/product'
import { getSpecTemplate } from './productSpecs'
import { ProductPhotoUpload } from './ProductPhotoUpload'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, Modal, ConfirmDialog } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { printLabels, DEFAULT_LABEL, DEFAULT_BIN_LABEL } from '@/features/labels/LabelDesigner'
import { adminApi } from '@/features/admin/adminApi'
import { api } from '@/lib/api'

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
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const [product, setProduct] = useState<Product | null>(null)
  const [history, setHistory] = useState<Array<{
    type: 'price_change' | 'sale' | 'return' | 'writeoff'
    date: string
    details: Record<string, unknown>
  }>>([])
  const [loading, setLoading] = useState(true)
  const [analogs, setAnalogs] = useState<{ grouped: Record<string, any[]> } | null>(null)
  const [fitment, setFitment] = useState<{ grouped: Record<string, any[]> } | null>(null)
  const [cobuy, setCobuy] = useState<any[]>([])
  const [photoModalOpen, setPhotoModalOpen] = useState(false)
  const [savingPhoto, setSavingPhoto] = useState(false)
  const [printModalOpen, setPrintModalOpen] = useState(false)
  const [printCopies, setPrintCopies] = useState(1)

  
  // Inline Analogs state
  const [analogSearch, setAnalogSearch] = useState('')
  const [analogSearchLoading, setAnalogSearchLoading] = useState(false)
  const [analogSuggestions, setAnalogSuggestions] = useState<Product[]>([])
  const [selectedAnalogType, setSelectedAnalogType] = useState<'substitute' | 'oem' | 'cross'>('substitute')
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const suggestionsRef = useRef<HTMLDivElement>(null)

  // Close suggestions dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setSuggestionsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Auto-search for analog suggestions
  useEffect(() => {
    if (!analogSearch.trim()) {
      setAnalogSuggestions([])
      return
    }
    const delayDebounce = setTimeout(async () => {
      setAnalogSearchLoading(true)
      try {
        const { data } = await productApi.list({ search: analogSearch, per_page: 5 })
        // Filter out current product
        setAnalogSuggestions(((data as any).data || []).filter((p: any) => p.id !== id))
        setSuggestionsOpen(true)
      } catch (err) {
        console.error(err)
      } finally {
        setAnalogSearchLoading(false)
      }
    }, 300)
    return () => clearTimeout(delayDebounce)
  }, [analogSearch, id])

  const handleAddAnalog = async (analogProductId: string) => {
    if (!id) return
    try {
      await productApi.addAnalog(id, analogProductId, selectedAnalogType)
      toast.success('Аналог успішно додано')
      // Refresh analogs
      const analogsData = await productApi.getAnalogs(id).then(r => r as any).catch(() => null)
      if (analogsData) setAnalogs(analogsData as any)
      setAnalogSearch('')
      setSuggestionsOpen(false)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Помилка додавання аналога')
    }
  }

  const handleRemoveAnalog = async (analogId: string) => {
    if (!id) return
    if (!confirm('Ви впевнені, що хочете видалити цей аналог?')) return
    try {
      await productApi.removeAnalog(id, analogId)
      toast.success('Аналог видалено')
      // Refresh analogs
      const analogsData = await productApi.getAnalogs(id).then(r => r as any).catch(() => null)
      if (analogsData) setAnalogs(analogsData as any)
    } catch {
      toast.error('Помилка видалення аналога')
    }
  }

  async function handlePhotoUrl(url: string | null) {
    if (!product || !id) return
    setSavingPhoto(true)
    try {
      await productApi.update(id, { photo_url: url })
      setProduct({ ...product, photo_url: url })
      toast.success(url ? 'Фото збережено' : 'Фото видалено')
      setPhotoModalOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setSavingPhoto(false)
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
      const settingsRes = await adminApi.getSettings()
      const settings = settingsRes.data.label_settings || DEFAULT_LABEL
      const binSettings = settings.bin_settings || DEFAULT_BIN_LABEL
      printLabels(binSettings as any, [{ label: product.storage_bin }], true)
      toast.success('Етикетку комірки відправлено на друк')
    } catch {
      toast.error('Помилка друку')
    }
  }

  useEffect(() => {
    if (!id) return
    Promise.all([
      productApi.get(id),
      productApi.getHistory(id).catch(() => ({ data: [] })),
      productApi.getAnalogs(id).catch(() => null),
      productApi.getFitment(id).catch(() => null),
      productApi.getCobuy(id).catch(() => []),
    ]).then(([{ data }, { data: hist }, analogsData, fitmentData, cobuyData]) => {
      setProduct(data)
      setHistory(hist as typeof history)
      if (analogsData) setAnalogs(analogsData)
      if (fitmentData) setFitment(fitmentData)
      setCobuy(cobuyData)
    }).catch(() => navigate('/products')).finally(() => setLoading(false))
  }, [id, navigate])

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [reserveOpen, setReserveOpen] = useState(false)
  const [reserveQty, setReserveQty] = useState('1')
  const [reserving, setReserving] = useState(false)

  async function handleReserve() {
    if (!product) return
    const qty = parseFloat(reserveQty)
    if (isNaN(qty) || qty <= 0) { toast.error('Вкажіть коректну кількість'); return }
    setReserving(true)
    try {
      const expires = new Date(); expires.setDate(expires.getDate() + 3)
      await api.post('/api/v1/reserves', {
        product_id: product.id,
        qty,
        customer_id: null,
        order_id: null,
        expires_at: expires.toISOString(),
      })
      toast.success('Товар зарезервовано на 3 дні')
      setReserveOpen(false)
      setReserveQty('1')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не вдалося зарезервувати')
    } finally {
      setReserving(false)
    }
  }

  async function handleDelete() {
    if (!product) return
    try {
      await productApi.delete(product.id)
      toast.success('Товар видалено')
      navigate('/products')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    }
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
          <Button variant="secondary" size="sm" onClick={() => setReserveOpen(true)}>
            📌 Резерв
          </Button>
          <Button variant="secondary" size="sm" icon={<Edit size={14} />} onClick={() => navigate(`/products/${product.id}/edit`)}>
            Редагувати
          </Button>
          <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => setConfirmDeleteOpen(true)}>
            Видалити
          </Button>
        </div>
      }
    >
      <div className="max-w-3xl space-y-4">

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
              <button
                onClick={() => setPhotoModalOpen(true)}
                className="absolute inset-0 w-full h-full flex items-center justify-center bg-black/0 group-hover:bg-black/40 rounded-xl transition-all"
              >
                <span className="opacity-0 group-hover:opacity-100 text-white text-xs font-medium bg-black/60 px-3 py-1.5 rounded-lg transition-all">
                  {product.photo_url ? 'Змінити фото' : 'Додати фото'}
                </span>
              </button>
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
                <button onClick={async () => {
                  try {
                    const { data } = await productApi.generateBarcode(product.id)
                    setProduct(data)
                    toast.success('Штрих-код згенеровано: ' + data.barcode)
                  } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
                }}
                  className="self-start text-xs text-gray-500 hover:text-blue-600 flex items-center gap-1 font-medium px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-colors">
                  <Barcode size={14} /> Згенерувати штрихкод
                </button>
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
                    title="Друк етикетки ячейки">
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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <p className="text-xs text-gray-400 mb-1">Закупівельна ціна</p>
            <p className="text-2xl font-bold text-gray-900">{kopecksToHryvnia(product.purchase_price)} ₴</p>
          </Card>
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
        {product.purchase_price > 0 && (
          <Card>
            <p className="text-xs text-gray-400 mb-1">Маржа</p>
            <p className="text-xl font-bold text-green-600">
              {kopecksToHryvnia(product.retail_price - product.purchase_price)} ₴
              {' '}
              <span className="text-sm text-gray-500 font-normal">
                ({Math.round((1 - product.purchase_price / product.retail_price) * 100)}%)
              </span>
            </p>
          </Card>
        )}


                {/* ?Аналоги? */}
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <h3 className="font-semibold text-gray-800">🔗 Аналоги та крос-номери</h3>
            
            {/* Inline search bar for adding analogs */}
            <div className="relative flex items-center gap-2" ref={suggestionsRef}>
              <select
                value={selectedAnalogType}
                onChange={(e) => setSelectedAnalogType(e.target.value as any)}
                className="border border-gray-200 rounded-lg px-2 py-1 text-xs bg-gray-50 focus:outline-none"
              >
                <option value="substitute">Замінник</option>
                <option value="oem">Оригінал (OEM)</option>
                <option value="cross">Крос-номер</option>
              </select>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Додати аналог..."
                  value={analogSearch}
                  onChange={(e) => {
                    setAnalogSearch(e.target.value)
                    setSuggestionsOpen(true)
                  }}
                  className="border border-gray-200 rounded-lg pl-8 pr-3 py-1 text-xs w-48 focus:outline-none focus:ring-1 focus:ring-yellow-400"
                />
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                {analogSearchLoading && (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-gray-300 border-t-yellow-400 rounded-full animate-spin"></div>
                )}
              </div>

              {/* Suggestions Popup */}
              {suggestionsOpen && analogSuggestions.length > 0 && (
                <div className="absolute right-0 top-full mt-1 w-64 bg-white border border-gray-100 rounded-lg shadow-lg z-50 overflow-hidden divide-y divide-gray-50 animate-fadeIn">
                  {analogSuggestions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => handleAddAnalog(s.id)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 transition flex flex-col cursor-pointer"
                      type="button"
                    >
                      <span className="font-medium text-xs text-gray-800 truncate">{s.name}</span>
                      <span className="text-[10px] text-gray-400 font-mono">{s.sku} • {s.brand?.name || 'Без бренду'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

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
                            <button
                              onClick={() => handleRemoveAnalog(a.id)}
                              className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition p-0.5"
                              title="Видалити зв'язок аналога"
                              type="button"
                            >
                              <Trash size={12} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              )}
            </div>
          )}

          {(!analogs || Object.values(analogs.grouped).every(arr => (arr as any[]).length === 0)) && (
            <div className="text-xs text-center py-6 text-gray-400">
              Немає пов'язаних аналогів для цього товару. Використовуйте поле пошуку вище для швидкого додавання.
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
        onClose={() => setPhotoModalOpen(false)}
        title={product.photo_url ? 'Змінити фото товару' : 'Додати фото товару'}
        size="md"
      >
        <ProductPhotoUpload
          productId={product.id}
          currentPhotoUrl={product.photo_url ?? null}
          onPhotoUrl={handlePhotoUrl}
        />
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-100">
          <p className="text-xs text-gray-400">
            {savingPhoto ? 'Зберігаємо...' : 'Зміни зберігаються автоматично'}
          </p>
          <Button
            onClick={() => setPhotoModalOpen(false)}
            loading={savingPhoto}
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
                  const settingsRes = await adminApi.getSettings()
                  const settings = settingsRes.data.label_settings || DEFAULT_LABEL
                  const items = Array(printCopies).fill(product)
                  printLabels(settings as any, items, false)
                  setPrintModalOpen(false)
                } catch {
                  toast.error('Помилка друку')
                }
              }}
            >
              Друкувати
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        onConfirm={handleDelete}
        title="Видалити товар"
        message={<>Видалити товар <strong>{product.name}</strong>?</>}
        confirmLabel="Видалити"
        danger
      />

      <Modal open={reserveOpen} onClose={() => setReserveOpen(false)} title="Зарезервувати товар" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Резерв «{product.name}» на 3 дні. Клієнта можна додати пізніше в розділі «Склад → Резерви».
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Кількість</label>
            <input type="number" min={1} value={reserveQty} onChange={(e) => setReserveQty(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" autoFocus />
          </div>
          <div className="flex gap-3">
            <Button className="flex-1" loading={reserving} onClick={handleReserve}>Зарезервувати</Button>
            <Button variant="secondary" onClick={() => setReserveOpen(false)}>Скасувати</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}
