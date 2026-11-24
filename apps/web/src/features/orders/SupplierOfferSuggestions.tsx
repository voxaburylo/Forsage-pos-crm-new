import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'

/**
 * 24.11.2026 (слово власника): товари постачальників з API (Омега) — «чернетка під замовлення».
 * Поки менеджер набирає артикул у бланку, показуємо, у кого він є: склад, кількість, строк і ціна. «Додати» кладе рядок
 * «під замовлення» з ціною продажу за сіткою націнок і закупкою постачальника. На склад магазину це не потрапляє.
 */
export interface SupplierOffer {
  supplier: string; supplier_id: string | null; external_id: string; number: string; brand: string | null; name: string; image_url: string | null
  retail_price: number; purchase_price?: number; total_qty: number; product_id: string | null
  stock: Array<{ warehouse: string; city: string | null; qty: number; days_to_ship: number | null }>
}
export interface SupplierOfferPick { offer: SupplierOffer; warehouse: SupplierOffer['stock'][number] | null }

/** Артикул чи схожий на нього запит: щонайменше 3 літери/цифри, і є хоч одна цифра. Звичайні слова не шукаємо. */
export function looksLikeArticle(query: string): boolean {
  const clean = query.replace(/[^\p{L}\p{N}]/gu, '')
  // Артикул може йти з пробілами («0 986 452 041»), а назва — це слова з літерами.
  const words = query.trim().split(/\s+/)
  return clean.length >= 3 && /\d/.test(clean) && words.filter(word => /\p{L}{3,}/u.test(word)).length <= 1
}

/** Дата «очікується» для рядка замовлення: сьогодні + днів до відправки (YYYY-MM-DD); без строку — ''. */
export function expectedDate(days: number | null | undefined, now = new Date()): string {
  if (days == null || !Number.isFinite(days)) return ''
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function SupplierOfferSuggestions({ query, onPick, showPurchase }: { query: string; onPick: (pick: SupplierOfferPick) => void; showPurchase: boolean }) {
  const [offers, setOffers] = useState<SupplierOffer[]>([])
  const [failed, setFailed] = useState(false)
  const needle = query.trim()

  useEffect(() => {
    if (!looksLikeArticle(needle)) { setOffers([]); setFailed(false); return }
    let cancelled = false
    const timer = window.setTimeout(() => {
      api.get<{ data: SupplierOffer[] }>('/api/v1/supplier-offers/search?q=' + encodeURIComponent(needle), { silent: true, timeoutMs: 10_000 })
        .then(answer => { if (!cancelled) { setOffers(answer.data); setFailed(false) } }, () => { if (!cancelled) { setOffers([]); setFailed(true) } })
    }, 350)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [needle])

  if (!offers.length) return failed ? <p className="mt-2 text-xs text-gray-400">Постачальників зараз не видно (немає інтернету чи звʼязку з сервером).</p> : null
  return (
    <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/40" data-supplier-offers>
      <p className="border-b border-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-900">У постачальників (під замовлення)</p>
      <ul className="divide-y divide-emerald-100">
        {offers.map(offer => (
          <li key={offer.supplier + offer.external_id} className="px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="min-w-0 break-words text-sm font-semibold text-gray-900">{offer.name}</p>
              <span className="shrink-0 text-sm font-bold">{formatMoney(offer.retail_price)}</span>
            </div>
            <p className="break-words text-xs text-gray-500">
              {[offer.supplier, offer.brand, offer.number, showPurchase && offer.purchase_price ? 'закупка ' + formatMoney(offer.purchase_price) : '',
                offer.product_id ? 'є така картка в програмі' : ''].filter(Boolean).join(' · ')}
            </p>
            {offer.stock.length === 0
              ? <p className="mt-1 text-xs text-red-700">Зараз немає на складах постачальника.</p>
              : (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {offer.stock.map(rest => (
                    <button key={rest.warehouse} type="button" onClick={() => onPick({ offer, warehouse: rest })}
                      className="rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-emerald-900 ring-1 ring-emerald-300 hover:bg-emerald-100">
                      {rest.warehouse} · {rest.qty} шт{rest.days_to_ship != null ? ` · ${rest.days_to_ship} дн.` : ''}
                    </button>
                  ))}
                </div>
              )}
          </li>
        ))}
      </ul>
    </div>
  )
}
