import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Edit, Trash2, Clock, AlertTriangle, CheckCircle, XCircle, Barcode, Printer, Camera } from 'lucide-react'
import { productApi } from './productApi'
import type { Product } from '@/types/product'
import { kopecksToHryvnia, stockStatus } from '@/types/product'
import { getSpecTemplate } from './productSpecs'
import { ProductPhotoUpload } from './ProductPhotoUpload'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { printLabel } from './LabelPrinter'

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

  async function handlePhotoUrl(url: string | null) {
    if (!product || !id) return
    setSavingPhoto(true)
    try {
      await productApi.update(id, { photo_url: url ?? null } as any)
      setProduct({ ...product, photo_url: url ?? null })
      toast.success(url ? 'Фото збережено' : 'Фото видалено')
      setPhotoModalOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setSavingPhoto(false)
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

  async function handleDelete() {
    if (!product || !confirm(`Видалити товар "${product.name}"?`)) return
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
          <Button variant="secondary" size="sm" icon={<Edit size={14} />} onClick={() => navigate(`/products/${product.id}/edit`)}>
            Редагувати
          </Button>
          <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={handleDelete}>
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
              <p className="text-xs text-gray-400 mb-0.5">Штрихкод</p>
              <div className="flex items-center gap-2">
                <p className="text-sm font-mono text-gray-800">{product.barcode ?? '—'}</p>
                <button onClick={async () => {
                  try {
                    const { data } = await productApi.generateBarcode(product.id)
                    setProduct(data)
                    toast.success('Штрих-код згенеровано: ' + data.barcode)
                  } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
                }}
                  className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-0.5 font-medium">
                  <Barcode size={12} /> Згенерувати
                </button>
                {product.barcode && (
                  <button onClick={() => printLabel(product)}
                    className="text-xs text-green-600 hover:text-green-800 flex items-center gap-0.5 font-medium">
                    <Printer size={12} /> Друк
                  </button>
                )}
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Одиниця</p>
              <p className="text-sm text-gray-800">{product.unit}</p>
            </div>
          </div>

          {product.notes && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <p className="text-xs text-gray-400 mb-0.5">Примітки</p>
              <p className="text-sm text-gray-700">{product.notes}</p>
            </div>
          )}
        </Card>

        {/* Ціни та залишок */}
        <div className="grid grid-cols-3 gap-4">
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


        {/* Аналоги */}
        {analogs && Object.keys(analogs.grouped).length > 0 && (
          <Card>
            <h3 className="font-semibold text-gray-800 mb-3">Аналоги</h3>
            {Object.entries(analogs.grouped).map(([tier, items]) =>
              (items as any[]).length > 0 && (
                <div key={tier} className="mb-3 last:mb-0">
                  <p className="text-xs text-gray-400 uppercase font-bold mb-1">
                    {tier === 'original' ? '🏭 Оригінал' : tier === 'premium' ? '⭐ Premium' : tier === 'standard' ? '✅ Standard' : '💵 Budget'}
                  </p>
                  <div className="space-y-1">
                    {(items as any[]).map((a: any) => (
                      <div key={a.id} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg text-sm">
                        <div>
                          <button onClick={() => navigate('/products/' + a.id)} className="font-medium text-blue-600 hover:text-blue-800">{a.name}</button>
                          <span className="text-xs text-gray-400 ml-2">{a.sku}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-semibold">{a.retail_price != null ? kopecksToHryvnia(a.retail_price) + ' ₴' : '—'}</span>
                          <span className={'text-xs px-2 py-0.5 rounded-full ' + ((a.qty_available ?? a.qty_on_hand) > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')}>
                            {(a.qty_available ?? a.qty_on_hand) > 0 ? 'Є (' + (a.qty_available ?? a.qty_on_hand) + ')' : 'Нема'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            )}
          </Card>
        )}

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
        <div className="flex justify-end mt-4 pt-3 border-t border-gray-100">
          <Button
            variant="secondary"
            onClick={() => setPhotoModalOpen(false)}
            loading={savingPhoto}
          >
            Закрити
          </Button>
        </div>
      </Modal>
    </Layout>
  )
}
