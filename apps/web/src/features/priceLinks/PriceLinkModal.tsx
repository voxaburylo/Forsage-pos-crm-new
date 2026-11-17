import { useState } from 'react'
import { Copy, Link2 } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { API_BASE_URL } from '@/lib/apiBaseUrl'

/** Повна адреса прайсу для клієнта: у програмі на касі — адреса веб-версії, у браузері — поточний домен. */
export function priceLinkUrl(token: string, base = API_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : '')): string {
  return `${base.replace(/\/$/, '')}/p/${token}`
}

/** Створити посилання на прайс із вибраних товарів. Ціни на сторінці клієнта — не нижче закупки. */
export function PriceLinkModal({ open, productIds, onClose }: { open: boolean; productIds: string[]; onClose: () => void }) {
  const [title, setTitle] = useState('Прайс')
  const [discount, setDiscount] = useState(0)
  const [days, setDays] = useState(14)
  const [showStock, setShowStock] = useState(true)
  const [saving, setSaving] = useState(false)
  const [url, setUrl] = useState('')

  async function create() {
    if (saving) return
    setSaving(true)
    try {
      const { data } = await api.post<{ data: { token: string } }>('/api/v1/price-links', {
        title: title.trim() || 'Прайс', product_ids: productIds.slice(0, 500), discount_pct: discount, expires_days: days, show_stock: showStock,
      })
      setUrl(priceLinkUrl(data.token))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося створити посилання')
    } finally {
      setSaving(false)
    }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(url); toast.success('Посилання скопійовано') }
    catch { toast.error('Не вдалося скопіювати — виділіть посилання вручну') }
  }

  function close() { setUrl(''); onClose() }

  return (
    <Modal open={open} onClose={close} title="Прайс для клієнта">
      {!url ? (
        <div className="space-y-3 text-sm">
          <p className="text-gray-500">Клієнт побачить {Math.min(productIds.length, 500)} товарів: назву, артикул, бренд, ціну та наявність. Закупку й кількість на складі не видно. Ціна зі знижкою ніколи не буде нижчою за закупівельну.</p>
          {productIds.length > 500 && <p className="text-amber-700">В одне посилання входить не більше 500 товарів — решту не включено.</p>}
          <label className="block">Назва прайсу
            <input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2" />
          </label>
          <div className="flex gap-3">
            <label className="flex-1">Знижка, %
              <input type="number" min={0} max={50} value={discount} onChange={e => setDiscount(Math.max(0, Math.min(50, Number(e.target.value) || 0)))} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2" />
            </label>
            <label className="flex-1">Діє, днів
              <input type="number" min={1} max={90} value={days} onChange={e => setDays(Math.max(1, Math.min(90, Math.round(Number(e.target.value) || 1))))} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2" />
            </label>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={showStock} onChange={e => setShowStock(e.target.checked)} /> Показувати «є в наявності / під замовлення»
          </label>
          <Button onClick={create} loading={saving} icon={<Link2 size={16} />} className="w-full">Створити посилання</Button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-gray-500">Надішліть це посилання клієнту. Вимкнути його можна в будь-який момент, створивши нове або дочекавшись кінця терміну.</p>
          <input readOnly value={url} onFocus={e => e.currentTarget.select()} className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs" />
          <div className="flex gap-2">
            <Button onClick={copy} icon={<Copy size={16} />} className="flex-1">Копіювати</Button>
            <Button variant="secondary" onClick={close}>Готово</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
