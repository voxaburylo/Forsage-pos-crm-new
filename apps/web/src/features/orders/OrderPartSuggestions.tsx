import { useEffect, useState } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'
import { formatMoney } from '@/lib/utils'

export type OrderPartSuggestion = NonNullable<Awaited<ReturnType<NonNullable<NonNullable<NonNullable<ReturnType<typeof desktopBridge>>['orders']>['suggestParts']>>>>[number]

/**
 * 22.11.2026 (етап 3 плану): довідник запчастин «під замовлення». Поки менеджер набирає назву чи артикул,
 * показуємо те, що вже замовляли клієнтам (без картки на складі) — з останньою закупкою, ціною і постачальником.
 */
export function OrderPartSuggestions({ query, onPick }: { query: string; onPick: (part: OrderPartSuggestion) => void }) {
  const [parts, setParts] = useState<OrderPartSuggestion[]>([])
  const needle = query.trim()

  useEffect(() => {
    const suggest = desktopBridge()?.orders?.suggestParts
    if (!suggest || needle.length < 2) { setParts([]); return }
    let cancelled = false
    const timer = window.setTimeout(() => {
      suggest(needle).then(found => { if (!cancelled) setParts(found) }).catch(() => { if (!cancelled) setParts([]) })
    }, 200)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [needle])

  if (!parts.length) return null
  return (
    <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50/40">
      <p className="border-b border-blue-100 px-3 py-1.5 text-xs font-semibold text-blue-900">Раніше замовляли (немає на складі)</p>
      <ul className="divide-y divide-blue-100">
        {parts.map(part => (
          <li key={part.name + '|' + part.sku} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1 basis-48">
              <p className="break-words text-sm font-semibold text-gray-900">{part.name}</p>
              <p className="break-words text-xs text-gray-500">
                {[part.sku, part.supplier_name, part.buy_price > 0 ? `закупка ${formatMoney(part.buy_price)}` : ''].filter(Boolean).join(' · ')}
              </p>
            </div>
            <span className="text-sm font-bold">{part.sell_price > 0 ? formatMoney(part.sell_price) : '—'}</span>
            <button type="button" onClick={() => onPick(part)} className="rounded-lg bg-white px-3 py-2 text-sm font-semibold text-blue-800 ring-1 ring-blue-300 hover:bg-blue-100">Додати</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
