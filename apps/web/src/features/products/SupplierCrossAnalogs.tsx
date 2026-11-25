import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'

/**
 * 25.11.2026 (власник: «хочу використовувати крос-номери Омеги для підбору аналогів — там велика база»).
 * Аналоги за кросами постачальника: спершу те, що є в нас на складі, потім те, що є в Омеги (під замовлення),
 * потім просто номери-аналоги. Кроси сервер бере в Омеги на вимогу (у межах ліміту запитів) і зберігає.
 */
export interface SupplierCross {
  code: string; brand: string; replacement_type: string | null
  ours: Array<{ id: string; name: string; sku: string | null; qty_on_hand: number; retail_price: number }>
  supplier: Array<{ external_id: string; number: string; brand: string | null; name: string; image_url: string | null; retail_price: number; purchase_price?: number; total_qty: number }>
}
export interface SupplierCrossAnswer { query: string; crosses: SupplierCross[]; pending: boolean }

export function crossSummary(answer: SupplierCrossAnswer): string {
  const ours = answer.crosses.filter(cross => cross.ours.some(p => p.qty_on_hand > 0)).length
  const supplier = answer.crosses.filter(cross => cross.supplier.length > 0).length
  return `кросів ${answer.crosses.length}` + (ours ? ` · у нас є ${ours}` : '') + (supplier ? ` · в Омеги є ${supplier}` : '')
}

export function SupplierCrossAnalogs({ sku, onLeave }: { sku: string | null | undefined; onLeave?: () => void }) {
  const navigate = useNavigate()
  const [state, setState] = useState<{ answer: SupplierCrossAnswer | null; error: boolean }>({ answer: null, error: false })
  const [attempt, setAttempt] = useState(0)
  const query = String(sku ?? '').trim()
  useEffect(() => {
    if (query.replace(/[^\p{L}\p{N}]/gu, '').length < 3) return
    let active = true
    setState({ answer: null, error: false })
    api.get<{ data: SupplierCrossAnswer }>('/api/v1/supplier-offers/crosses?q=' + encodeURIComponent(query), { silent: true, timeoutMs: 40_000 })
      .then(response => { if (active) setState({ answer: response.data, error: false }) }, () => { if (active) setState({ answer: null, error: true }) })
    return () => { active = false }
  }, [query, attempt])
  if (query.replace(/[^\p{L}\p{N}]/gu, '').length < 3) return null
  const { answer, error } = state
  return (
    <div className="mt-3 border-t border-gray-100 pt-3" data-supplier-crosses>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-gray-800">Аналоги за кросами Омеги</h4>
        {answer && answer.crosses.length > 0 && <span className="text-xs text-gray-500">{crossSummary(answer)}</span>}
      </div>
      {error && <p role="status" className="text-sm text-amber-700">Не вдалося отримати кроси Омеги. <button type="button" className="font-semibold underline" onClick={() => setAttempt(value => value + 1)}>Повторити</button></p>}
      {!error && !answer && <p role="status" className="text-sm text-gray-500">Питаємо кроси в Омеги…</p>}
      {answer && answer.crosses.length === 0 && (
        <p className="text-sm text-gray-500">{answer.pending
          ? 'Кроси Омеги ще не завантажено (ліміт запитів на цю годину). Відкрийте пізніше.'
          : 'Омега не знає аналогів для цього артикула (або цього артикула немає в її прайсі).'}</p>
      )}
      {answer && answer.crosses.length > 0 && (
        <ul className="max-h-80 divide-y divide-gray-100 overflow-y-auto">
          {answer.crosses.map(cross => (
            <li key={cross.code + '|' + cross.brand} className="py-2 text-sm" data-supplier-cross={cross.code}>
              <p className="flex flex-wrap items-center gap-x-2">
                <span className="font-mono font-semibold text-gray-900">{cross.code}</span>
                {cross.brand && <span className="text-gray-600">{cross.brand}</span>}
                {cross.replacement_type && <span className="text-xs text-gray-400">{cross.replacement_type}</span>}
              </p>
              {cross.ours.map(product => (
                <button key={product.id} type="button" onClick={() => { onLeave?.(); navigate('/products/' + product.id) }}
                  className="mt-1 flex w-full flex-wrap items-center gap-2 rounded-lg bg-green-50 px-2 py-1 text-left text-xs hover:bg-green-100">
                  <span className="font-semibold text-green-800">{product.qty_on_hand > 0 ? `У нас: ${product.qty_on_hand} шт` : 'У нас: немає'}</span>
                  <span className="min-w-0 flex-1 truncate text-gray-800">{product.name}</span>
                  <span className="font-semibold tabular-nums">{formatMoney(product.retail_price)}</span>
                </button>
              ))}
              {cross.supplier.map(offer => (
                <p key={offer.external_id} className="mt-1 flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50/60 px-2 py-1 text-xs">
                  <span className="font-semibold text-emerald-800">Омега: {offer.total_qty} шт</span>
                  <span className="min-w-0 flex-1 truncate text-gray-800">{offer.name}{offer.brand ? ' · ' + offer.brand : ''}</span>
                  <span className="font-semibold tabular-nums">{formatMoney(offer.retail_price)}</span>
                  {offer.purchase_price != null && <span className="text-gray-500">закупка {formatMoney(offer.purchase_price)}</span>}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
