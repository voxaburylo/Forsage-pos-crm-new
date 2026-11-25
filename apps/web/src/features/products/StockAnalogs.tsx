import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardList, Link2, MapPin, ShoppingCart } from 'lucide-react'
import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { Card, Modal } from '@/components/ui'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { productApi } from './productApi'
import { SupplierCrossAnalogs } from './SupplierCrossAnalogs'
import { analogActions, analogOrderPath, analogReceiptPath, analogRows, analogStock, analogsInStock } from './analogModel'

type State = { rows: Product[] | null; error: boolean }

function useAnalogs(productId: string, enabled: boolean): State & { reload: () => void } {
  const [state, setState] = useState<State>({ rows: null, error: false })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let active = true
    setState({ rows: null, error: false })
    productApi.getAnalogs(productId).then(
      response => { if (active) setState({ rows: analogRows(productId, response), error: false }) },
      () => { if (active) setState({ rows: null, error: true }) },
    )
    return () => { active = false }
  }, [productId, enabled, attempt])
  const reload = useCallback(() => setAttempt(value => value + 1), [])
  return { ...state, reload }
}

function AnalogRows({ rows, error, reload, onLeave }: State & { reload: () => void; onLeave?: () => void }) {
  const navigate = useNavigate()
  const session = useAuthStore(state => state.session)
  const actions = analogActions(String(session?.user?.app_metadata?.role ?? ''), isDesktopRuntime())
  const go = (path: string) => { onLeave?.(); navigate(path) }
  if (error) return <p role="alert" className="py-3 text-sm text-amber-700">Не вдалося завантажити аналоги. <button type="button" className="font-semibold underline" onClick={reload}>Повторити</button></p>
  if (rows === null) return <p role="status" className="py-3 text-sm text-gray-500">Шукаємо аналоги…</p>
  if (rows.length === 0) return <p className="py-3 text-sm text-gray-500">Аналогів на складі немає. Аналоги шукаються за крос-номерами — перевірте, чи вони записані в картці.</p>
  return (
    <ul className="divide-y divide-gray-100" data-stock-analogs>
      {rows.map(product => {
        const qty = analogStock(product)
        return (
          <li key={product.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2" data-analog-row={product.id}>
            <div className="min-w-0 flex-1 basis-48">
              <button type="button" onClick={() => go('/products/' + product.id)} className="text-left text-sm font-medium text-blue-700 hover:text-blue-900">{product.name}</button>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-gray-500">
                <span className="font-mono">{product.sku}</span>
                {product.brand?.name && <span>{product.brand.name}</span>}
                {product.storage_bin && <span className="inline-flex items-center gap-0.5"><MapPin size={11} aria-hidden="true" />{product.storage_bin}</span>}
              </p>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${qty > 0 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}`}>
              {qty > 0 ? `Є ${qty} ${product.unit ?? ''}`.trim() : 'Немає'}
            </span>
            <span className="w-24 text-right text-sm font-semibold tabular-nums">{product.retail_price != null ? kopecksToHryvnia(product.retail_price) + ' ₴' : '—'}</span>
            {(actions.receipt || actions.order) && (
              <span className="flex gap-1.5">
                {actions.receipt && <button type="button" disabled={!product.is_service && qty <= 0} onClick={() => go(analogReceiptPath(product.id))}
                  title={qty > 0 || product.is_service ? 'Додати в чек на касі' : 'Немає в наявності'}
                  className="inline-flex items-center gap-1 rounded-lg bg-yellow-400 px-2.5 py-1.5 text-xs font-semibold text-black hover:bg-yellow-300 disabled:opacity-40">
                  <ShoppingCart size={13} aria-hidden="true" />У чек</button>}
                {actions.order && <button type="button" onClick={() => go(analogOrderPath(product.id))}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50">
                  <ClipboardList size={13} aria-hidden="true" />У замовлення</button>}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Картка товару: аналоги зі складу — вище списку номерів, щоб не гортати. */
export function StockAnalogsCard({ productId, sku }: { productId: string; sku?: string | null }) {
  const analogs = useAnalogs(productId, true)
  const inStock = analogs.rows ? analogsInStock(analogs.rows) : null
  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-gray-800">Аналоги на складі</h3>
        {analogs.rows && analogs.rows.length > 0 && <span className="text-xs text-gray-500">знайдено {analogs.rows.length}, у наявності {inStock}</span>}
      </div>
      <AnalogRows {...analogs} />
      {/* 25.11.2026: аналоги за кросами Омеги — і те, що є в нас, і те, що можна замовити. */}
      <SupplierCrossAnalogs sku={sku} />
    </Card>
  )
}

/** Список товарів: «Аналоги» — подивитись заміну зі складу, не відкриваючи картку. Шукає лише після натискання. */
export function AnalogsButton({ productId, name, sku }: { productId: string; name: string; sku?: string | null }) {
  const [open, setOpen] = useState(false)
  const analogs = useAnalogs(productId, open)
  return (
    <>
      <button type="button" onClick={event => { event.stopPropagation(); setOpen(true) }} aria-label={`Аналоги: ${name}`} title="Аналоги зі складу"
        className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-yellow-500">
        <Link2 size={12} aria-hidden="true" />Аналоги
      </button>
      {open && (
        <div onClick={event => event.stopPropagation()}>
          <Modal open onClose={() => setOpen(false)} title={`Аналоги: ${name}`} size="lg">
            <AnalogRows {...analogs} onLeave={() => setOpen(false)} />
            <SupplierCrossAnalogs sku={sku} onLeave={() => setOpen(false)} />
          </Modal>
        </div>
      )}
    </>
  )
}
