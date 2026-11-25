import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { SupplierCrossAnswer } from '@/features/products/SupplierCrossAnalogs'
import { looksLikeArticle } from './SupplierOfferSuggestions'

/**
 * 25.11.2026 (власник: «хочу вже бачити товари, що завантажились: у програмі за артикулом, коли роблю замовлення,
 * знаходити ці товари, аналоги й крос-номери — щоб уже працювали»). У бланку замовлення під товарами постачальника —
 * аналоги з крос-номерів Омеги. Натиск на аналог підставляє його в пошук: видно наш склад і склади Омеги, можна додати.
 * Кроси докачуються фоном; для артикула, який шукають зараз, сервер бере їх у Омеги одразу (у межах ліміту).
 */
export function crossChips(answer: SupplierCrossAnswer | null) {
  if (!answer) return []
  return answer.crosses.slice(0, 24).map(cross => ({
    code: cross.code, brand: cross.brand,
    ours: cross.ours.reduce((sum, product) => sum + Math.max(0, product.qty_on_hand), 0),
    supplier: cross.supplier.reduce((sum, offer) => sum + Math.max(0, offer.total_qty), 0),
  }))
}

export function SupplierCrossHints({ query, onSearch }: { query: string; onSearch: (code: string) => void }) {
  const [answer, setAnswer] = useState<SupplierCrossAnswer | null>(null)
  const needle = query.trim()
  useEffect(() => {
    setAnswer(null)
    if (!looksLikeArticle(needle)) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      api.get<{ data: SupplierCrossAnswer }>('/api/v1/supplier-offers/crosses?q=' + encodeURIComponent(needle), { silent: true, timeoutMs: 40_000 })
        .then(response => { if (!cancelled) setAnswer(response.data) }, () => { /* без підказок аналогів */ })
    }, 600)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [needle])
  const chips = crossChips(answer)
  if (!chips.length) return answer?.pending ? <p className="mt-2 text-xs text-gray-400">Кроси для цього артикула ще завантажуються з Омеги.</p> : null
  return (
    <div className="mt-2 rounded-xl border border-blue-200 bg-blue-50/40 px-3 py-2" data-supplier-cross-hints>
      <p className="mb-1.5 text-xs font-semibold text-blue-900">Аналоги за кросами ({chips.length}{answer && answer.crosses.length > chips.length ? ` з ${answer.crosses.length}` : ''}) — натисніть, щоб знайти</p>
      <div className="flex flex-wrap gap-1.5">
        {chips.map(chip => (
          <button key={chip.code + '|' + chip.brand} type="button" onClick={() => onSearch(chip.code)} data-cross-chip={chip.code}
            className="rounded-lg bg-white px-2 py-1 text-left text-xs ring-1 ring-blue-200 hover:bg-blue-100">
            <span className="font-mono font-semibold text-gray-900">{chip.code}</span>
            {chip.brand && <span className="ml-1 text-gray-500">{chip.brand}</span>}
            {chip.ours > 0 && <span className="ml-1 font-semibold text-green-700">· у нас {chip.ours}</span>}
            {chip.supplier > 0 && <span className="ml-1 text-emerald-700">· Омега {chip.supplier}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
