import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useListViewState, useViewNavigation } from '@/hooks/useViewNavigation'
import { ShoppingCart } from 'lucide-react'
import { saleApi } from '@/features/pos/saleApi'
import type { Sale } from '@/types/sale'
import { Layout } from '@/components/Layout'
import { Card, Table, Badge, SearchInput, Button } from '@/components/ui'
import { PageNumberInput } from '@/components/ui/PageNumberInput'
import { formatMoney, formatDateTime } from '@/lib/utils'
import type { LocalSaleRecord } from '@/lib/offlineDB'
import { useLatestRequest } from '@/hooks/useLatestRequest'
import { useAuthStore } from '@/stores/authStore'
import { SaleDetailModal } from './SaleDetailModal'
import { emptySaleHistoryView, saleHistoryLink, saleHistoryRequest, type SaleHistoryView } from './saleHistoryView'

type SaleWithSync = Sale & { local_id?: string; server_id?: string | null; sync_status?: LocalSaleRecord['sync_status']; sync_error?: string | null }
const PAY_COLOR: Record<string, 'green' | 'blue' | 'red' | 'gray'> = { cash: 'green', card: 'blue', debt: 'red', mixed: 'gray', transfer: 'blue' }
const PAY_LABEL: Record<string, string> = { cash: 'Готівка', card: 'Картка', debt: 'Борг', mixed: 'Змішано', transfer: 'Переказ' }

export default function SalesPage() {
  const { open } = useViewNavigation('/sales')
  const [searchParams, setSearchParams] = useSearchParams()
  const scopeKey = useAuthStore((state) => state.session?.user?.id ?? '')
  const [savedView, setView] = useListViewState<SaleHistoryView>('sales:list:v2', emptySaleHistoryView)
  const link = saleHistoryLink(searchParams)
  const enteringLink = link !== null && savedView.sourceLink !== searchParams.toString()
  const view = enteringLink ? { ...savedView, ...link } : savedView
  const { search, productSearch, productId, sellerId, sellerLabel, dateFrom, dateTo, unitPrice, includeReturns, page } = view
  const loadDelay = useRef(0)
  const pendingLoad = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    if (!enteringLink) return
    setView(previous => ({ ...previous, ...saleHistoryLink(searchParams) }))
  }, [enteringLink, searchParams, setView])
  function changeFilters(patch: Partial<SaleHistoryView>, debounce = false) {
    clearTimeout(pendingLoad.current)
    requests.invalidate()
    loadDelay.current = debounce ? 250 : 0
    setView(previous => ({ ...previous, ...patch, page: 1, sourceLink: '' }))
    if (searchParams.size) setSearchParams({}, { replace: true })
  }
  const setPage = (page: number) => {
    loadDelay.current = 0
    setView(previous => ({ ...previous, page }))
  }
  const request = saleHistoryRequest(view)
  const requestKey = JSON.stringify([request.params, request.error, scopeKey, search, productSearch, unitPrice])
  const [resultState, setResultState] = useState<{ key: string; data: SaleWithSync[]; total: number; pages: number } | null>(null)
  const [errorState, setErrorState] = useState<{ key: string; message: string } | null>(null)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const result = resultState?.key === requestKey ? resultState : null
  const sales = result?.data ?? []
  const total = result?.total ?? 0
  const pages = result?.pages ?? 1
  const error = request.error || (errorState?.key === requestKey ? errorState.message : '')
  const loading = !error && (loadingKey === requestKey || result === null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const requests = useLatestRequest(requestKey)
  const load = useCallback(async () => {
    clearTimeout(pendingLoad.current)
    const isCurrent = requests.begin()
    const { params, error } = saleHistoryRequest(view)
    setErrorState(null)
    if (error) { setLoadingKey(null); return }
    setLoadingKey(requestKey)
    try {
      const response = await saleApi.list(params, { silent: true })
      if (!isCurrent()) return
      const r = response as { data: Sale[]; pagination: { total: number; total_pages: number } }
      const maximum = Math.max(1, r.pagination.total_pages)
      if (page > maximum) { setView(previous => ({ ...previous, page: maximum })); return }
      setResultState({ key: requestKey, data: r.data, total: r.pagination.total, pages: maximum })
    } catch (e) {
      if (isCurrent()) setErrorState({ key: requestKey, message: e instanceof Error ? e.message : 'Помилка завантаження продажів' })
    } finally { if (isCurrent()) setLoadingKey(null) }
    // The key contains every filter/user. Equivalent view objects must not trigger duplicate reads.
  }, [requestKey, requests, setView])
  useEffect(() => {
    const delay = loadDelay.current
    loadDelay.current = 0
    if (!delay) { void load(); return }
    const timer = setTimeout(() => { void load() }, delay)
    pendingLoad.current = timer
    return () => clearTimeout(timer)
  }, [load])
  useEffect(() => { setDetailId(null) }, [scopeKey])

  const columns = [
    { key: 'num', header: 'Чек', render: (s: SaleWithSync) => <button onClick={() => setDetailId(s.id)} className="font-mono text-xs text-yellow-700 hover:underline font-semibold">#{s.sale_number}</button> },
    { key: 'customer', header: 'Клієнт', render: (s: SaleWithSync) => <span className="text-gray-700">{s.customer?.full_name ?? s.customer?.phone ?? <span className="text-gray-400 italic">Анонім</span>}</span> },
    { key: 'pay', header: 'Оплата', className: 'w-24', render: (s: SaleWithSync) => <Badge color={PAY_COLOR[s.payment_method] ?? 'gray'}>{PAY_LABEL[s.payment_method] ?? s.payment_method}</Badge> },
    { key: 'status', header: 'Статус', className: 'w-24', render: (s: SaleWithSync) => <Badge color={s.sync_status === 'failed' ? 'red' : s.sync_status === 'pending' ? 'orange' : s.status === 'returned' ? 'red' : s.status === 'completed' ? 'green' : 'gray'}>{s.sync_status === 'failed' ? 'Помилка синхр.' : s.sync_status === 'pending' ? 'Очікує синхр.' : s.status === 'returned' ? 'Повернено' : s.status === 'completed' ? 'Виконано' : s.status}</Badge> },
    { key: 'total', header: 'Сума чека', className: 'w-32 text-right', render: (s: SaleWithSync) => <span className="font-semibold">{formatMoney(s.total)}</span> },
    { key: 'date', header: 'Дата', className: 'w-40 text-right', render: (s: SaleWithSync) => <span className="text-gray-400 text-xs">{formatDateTime(s.completed_at ?? s.created_at)}</span> },
  ]
  const empty = <div className="flex flex-col items-center gap-2 text-gray-400 py-8"><ShoppingCart size={36} className="opacity-30" /><p className="text-sm">Продажів не знайдено</p></div>

  return <Layout title={'Продажі' + (total ? ' (' + total + ')' : '')}>
    <div className="mb-4 space-y-3">
      <SearchInput value={search} debounceMs={0} onChange={value => changeFilters({ search: value }, true)} placeholder="Чек, клієнт, VIN або товар…" className="max-w-lg" />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-[minmax(16rem,2fr)_1fr_1fr_1fr] gap-3">
        <label className="text-xs text-gray-500">Товар, артикул або штрихкод
          <input aria-label="Товар, артикул або штрихкод" value={productSearch} maxLength={200} onChange={e => changeFilters({ productSearch: e.target.value, productId: '' }, true)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900" />
        </label>
        <label className="text-xs text-gray-500">{includeReturns ? 'Продаж / повернення від' : 'Продаж від'}
          <input aria-label="Продаж від" type="date" value={dateFrom} onChange={e => changeFilters({ dateFrom: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900" />
        </label>
        <label className="text-xs text-gray-500">{includeReturns ? 'Продаж / повернення до' : 'Продаж до'}
          <input aria-label="Продаж до" type="date" value={dateTo} onChange={e => changeFilters({ dateTo: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900" />
        </label>
        <label className="text-xs text-gray-500">Ціна одиниці в чеку, ₴
          <input aria-label="Ціна одиниці в чеку, ₴" inputMode="decimal" value={unitPrice} onChange={e => changeFilters({ unitPrice: e.target.value }, true)} placeholder="Наприклад, 1170" className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900" />
        </label>
      </div>
      {includeReturns && <p className="text-xs text-gray-500">Із звіту «Продані товари»: чеки продажів та повернень вибраного товару за цей період. Суми нижче — повні суми чеків, не підсумок товару.{productId ? ' Зіставлення за карткою товару, включно з архівною.' : ''}</p>}
      {sellerId && <label className="flex items-center gap-2 text-xs text-gray-500">Продавець зі звіту
        <select aria-label="Продавець зі звіту" value={sellerId} onChange={e => changeFilters({ sellerId: e.target.value, sellerLabel: '' })} className="rounded-lg border border-gray-200 p-2 text-gray-900">
          <option value={sellerId}>{sellerLabel || (sellerId === '__unknown__' ? 'Не визначено' : 'Вибраний продавець')}</option><option value="">Усі продавці</option>
        </select>
      </label>}
    </div>
    <Card padding="none">
      {error ? <div role="alert" className="p-5 text-sm text-red-700"><p>{error}</p>{!request.error && <Button variant="secondary" className="mt-3" onClick={() => void load()}>Повторити</Button>}</div> : <>
        <div className="hidden md:block"><Table columns={columns} data={sales} keyFn={s => s.id} loading={loading} empty={empty} /></div>
        <div className="md:hidden divide-y divide-gray-100">
          {loading ? <div className="py-12 text-center text-sm text-gray-400">Завантаження...</div> : sales.length === 0 ? empty : sales.map(sale => <button key={sale.id} type="button" onClick={() => setDetailId(sale.id)} className="w-full p-4 text-left hover:bg-gray-50" aria-label={'Відкрити чек #' + sale.sale_number}>
            <div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs font-bold text-yellow-700">#{sale.sale_number}</p><p className="mt-1 text-sm text-gray-800">{sale.customer?.full_name ?? sale.customer?.phone ?? 'Анонім'}</p><p className="mt-1 text-xs text-gray-400">{formatDateTime(sale.completed_at ?? sale.created_at)}</p></div><div className="text-right"><p className="font-bold">{formatMoney(sale.total)}</p><div className="mt-1.5 flex justify-end gap-1"><Badge color={PAY_COLOR[sale.payment_method] ?? 'gray'}>{PAY_LABEL[sale.payment_method] ?? sale.payment_method}</Badge><Badge color={sale.status === 'returned' ? 'red' : sale.status === 'completed' ? 'green' : 'gray'}>{sale.status === 'returned' ? 'Повернено' : sale.status === 'completed' ? 'Виконано' : sale.status}</Badge></div></div></div>
          </button>)}
        </div>
      </>}
      {!error && result && pages > 1 && <div className="border-t border-gray-100 px-4 py-3 flex flex-wrap gap-3 items-center justify-between text-sm text-gray-500">
        <span>Показано {(page - 1) * 20 + 1}–{Math.min(page * 20, total)} з {total}</span>
        <div className="flex items-center gap-2">
          <button aria-label="Попередня сторінка" onClick={() => setPage(Math.max(1, page - 1))} disabled={loading || page === 1} className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40">←</button>
          <PageNumberInput page={page} pages={pages} disabled={loading} onPage={setPage} />
          <button aria-label="Наступна сторінка" onClick={() => setPage(Math.min(pages, page + 1))} disabled={loading || page === pages} className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40">→</button>
        </div>
      </div>}
    </Card>
    <SaleDetailModal saleId={detailId} onClose={() => setDetailId(null)} onReturn={sale => open('/returns?sale=' + encodeURIComponent(sale.sale_number))} />
  </Layout>
}
