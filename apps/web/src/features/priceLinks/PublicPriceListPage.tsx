import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Printer, Search } from 'lucide-react'
import { API_BASE_URL } from '@/lib/apiBaseUrl'
import { formatMoney } from '@/lib/utils'

export interface PublicPriceList {
  title: string
  shop: { name: string | null; phone: string | null; address: string | null }
  discount_pct: number
  created_at: string
  expires_at: string
  items: Array<{ id: string; name: string; sku: string | null; brand: string | null; photo_url: string | null; price: number; in_stock?: boolean }>
}

/** Сторінка прайсу для клієнта: без входу, лише перегляд і друк. */
export default function PublicPriceListPage() {
  const { token = '' } = useParams()
  const [list, setList] = useState<PublicPriceList | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(`${API_BASE_URL}/api/v1/public/price-list/${encodeURIComponent(token)}`)
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 404 ? 'Прайс не знайдено або термін його дії минув.' : 'Не вдалося відкрити прайс. Спробуйте пізніше.')
        return (await response.json()).data as PublicPriceList
      })
      .then(data => { if (!cancelled) setList(data) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Не вдалося відкрити прайс.') })
    return () => { cancelled = true }
  }, [token])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!list || !q) return list?.items ?? []
    return list.items.filter(item => [item.name, item.sku, item.brand].some(value => value?.toLowerCase().includes(q)))
  }, [list, search])

  if (error) return <div className="mx-auto max-w-xl p-8 text-center text-gray-600">{error}</div>
  if (!list) return <div className="mx-auto max-w-xl p-8 text-center text-gray-400">Завантаження…</div>

  return (
    <div className="mx-auto max-w-3xl bg-white p-4 text-gray-900 md:p-8">
      <header className="mb-4 border-b border-gray-200 pb-3">
        <p className="text-sm font-semibold text-yellow-600">{list.shop.name || 'Форсаж'}</p>
        <h1 className="text-xl font-bold">{list.title}</h1>
        <p className="mt-1 text-xs text-gray-500">
          {[list.shop.phone, list.shop.address].filter(Boolean).join(' · ')}
          {list.discount_pct > 0 && ` · ціни вже зі знижкою ${list.discount_pct}%`}
          {` · дійсний до ${new Date(list.expires_at).toLocaleDateString('uk-UA')}`}
        </p>
      </header>
      <div className="mb-3 flex gap-2 print:hidden">
        <label className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Пошук у прайсі" aria-label="Пошук у прайсі"
            className="w-full rounded-xl border border-gray-200 py-2 pl-9 pr-3 text-sm" />
        </label>
        <button type="button" onClick={() => window.print()} className="flex items-center gap-1 rounded-xl border border-gray-200 px-3 text-sm">
          <Printer size={16} /> Друк
        </button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
            <th className="py-2">Товар</th>
            <th className="py-2 text-right">Ціна</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(item => (
            <tr key={item.id} className="border-b border-gray-100 align-top">
              <td className="py-2 pr-3">
                <p className="font-medium">{item.name}</p>
                <p className="text-xs text-gray-500">
                  {[item.brand, item.sku].filter(Boolean).join(' · ')}
                  {item.in_stock !== undefined && (item.in_stock
                    ? <span className="ml-1 text-green-700">· є в наявності</span>
                    : <span className="ml-1 text-amber-700">· під замовлення</span>)}
                </p>
              </td>
              <td className="whitespace-nowrap py-2 text-right font-bold">{formatMoney(item.price)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!shown.length && <p className="py-6 text-center text-sm text-gray-400">Нічого не знайдено</p>}
      <p className="mt-4 text-xs text-gray-400">Ціни й наявність можуть змінюватися. Уточнюйте при замовленні.</p>
    </div>
  )
}
