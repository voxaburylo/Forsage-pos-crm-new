import { useState, useEffect, useCallback } from 'react'
import { useLatestRequest } from '@/hooks/useLatestRequest'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { INVOICE_LIST_STATE_KEY, readInvoiceListState, invoiceListQuery } from './invoiceListState'
import { Plus, FileText } from 'lucide-react'
import { supplierApi } from './supplierApi'
import type { SupplyInvoice, PaginatedInvoices } from '@/types/supplier'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, Table } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate } from '@/lib/utils'

const STATUS_BADGE: Record<string, 'yellow' | 'green' | 'red'> = {
  draft: 'yellow', posted: 'green', cancelled: 'red',
}
const STATUS_LABEL: Record<string, string> = {
  draft: 'Чернетка', posted: 'Проведено', cancelled: 'Скасовано',
}

export default function InvoicesPage() {
  const navigate = useNavigate()
  const [result, setResult]     = useState<PaginatedInvoices | null>(null)
  const [initialQuery] = useState(() => {
    try { return sessionStorage.getItem(INVOICE_LIST_STATE_KEY) || '' } catch { return '' }
  })
  const [params, setParams] = useSearchParams()
  const state = readInvoiceListState(params.toString() || initialQuery)
  const { status, page, search } = state
  const [searchInput, setSearchInput] = useState(search)
  const [pageInput, setPageInput] = useState(String(page))
  const changeView = useCallback((next: Partial<typeof state>) => {
    setParams(invoiceListQuery({ ...state, ...next }), { replace: true })
  }, [page, status, search, setParams])
  useEffect(() => {
    const query = invoiceListQuery(state)
    try { sessionStorage.setItem(INVOICE_LIST_STATE_KEY, query) } catch { /* Storage may be disabled. */ }
    if (!params.toString()) setParams(query, { replace: true })
  }, [page, status, search, setParams])
  useEffect(() => { setSearchInput(search) }, [search])
  useEffect(() => { setPageInput(String(page)) }, [page])
  useEffect(() => {
    if (searchInput.trim() === search) return
    const timer = window.setTimeout(() => changeView({ search: searchInput.trim(), page: 1 }), 300)
    return () => window.clearTimeout(timer)
  }, [searchInput, search, changeView])
  const [loading, setLoading]   = useState(false)
  const [loadError, setLoadError] = useState(false)

  const requests = useLatestRequest([status, page, search])
  const load = useCallback(async () => {
    const isCurrent = requests.begin()
    setLoading(true)
    setLoadError(false)
    try {
      const data = await supplierApi.listInvoices({ status: status || undefined, search: search || undefined, page, per_page: 20 })
      if (!isCurrent()) return
      const lastPage = Math.max(1, data.pagination.total_pages)
      if (page > lastPage) { changeView({ page: lastPage }); return }
      setResult(data)
    } catch {
      if (isCurrent()) { setLoadError(true); toast.error('Помилка завантаження накладних') }
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [status, page, search, changeView])

  useEffect(() => { load() }, [load])

  function openInvoice(inv: SupplyInvoice) {
    if (inv.id.startsWith('local-draft:')) {
      const key = decodeURIComponent(inv.id.slice('local-draft:'.length))
      navigate('/suppliers/invoices/new?resume=' + encodeURIComponent(key))
      return
    }
    navigate('/suppliers/invoices/' + inv.id)
  }
  const columns = [
    {
      key: 'num', header: '№',
      render: (inv: SupplyInvoice) => (
        <button onClick={() => openInvoice(inv)} className="text-left hover:text-yellow-600 font-mono text-sm">
          {inv.invoice_number ?? '—'}
        </button>
      ),
    },
    {
      key: 'supplier', header: 'Постачальник',
      render: (inv: SupplyInvoice) => (
        <span className="text-sm">{inv.supplier?.name ?? '—'}</span>
      ),
    },
    {
      key: 'status', header: 'Статус', className: 'w-24',
      render: (inv: SupplyInvoice) => (
        <Badge color={STATUS_BADGE[inv.status] ?? 'gray'}>{STATUS_LABEL[inv.status] ?? inv.status}</Badge>
      ),
    },
    {
      key: 'total', header: 'Сума', className: 'w-32 text-right',
      render: (inv: SupplyInvoice) => <span className="font-mono text-sm whitespace-nowrap">{formatMoney(inv.total)}</span>,
    },
    {
      key: 'date', header: 'Дата', className: 'hidden md:table-cell w-32 text-sm text-gray-500',
      render: (inv: SupplyInvoice) => formatDate(inv.created_at),
    },
    {
      key: 'actions', header: '', className: 'w-16 text-right',
      render: (inv: SupplyInvoice) => (
        <button onClick={() => openInvoice(inv)}
          className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1">✎</button>
      ),
    },
  ]

  const total = result?.pagination?.total ?? 0
  const pages = Math.max(1, result?.pagination?.total_pages ?? 1)
  function goToPage() {
    const value = Number(pageInput)
    if (!Number.isInteger(value) || value < 1 || value > pages) {
      toast.error(`Введіть номер сторінки від 1 до ${pages}`)
      return
    }
    changeView({ page: value })
  }

  return (
    <Layout
      title={`Приходні накладні${total ? ` (${total})` : ''}`}
      onBack={() => navigate('/receiving')}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button icon={<Plus size={16} />} onClick={() => navigate('/suppliers/invoices/new?fresh=' + Date.now())}>
            Приходна накладна
          </Button>
        </div>
      }
    >
      <div className="mb-4">
        <input aria-label="Знайти накладні за товаром" type="search" value={searchInput} maxLength={200}
          onChange={event => setSearchInput(event.target.value)} placeholder="Назва товару, штрихкод або артикул"
          className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm" />
        <p className="mt-1 text-xs text-gray-500">Пошук у товарах усіх накладних, а не лише цієї сторінки.</p>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {['', 'draft', 'posted', 'cancelled'].map((s) => (
          <button key={s} onClick={() => changeView({ status: s, page: 1 })}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              status === s
                ? 'bg-yellow-400 text-white font-medium'
                : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>
            {s === '' ? 'Всі' : STATUS_LABEL[s] ?? s}
          </button>
        ))}
      </div>

      <Card padding="none">
        {loadError && <div role="alert" className="p-4 text-red-600">Не вдалося завантажити накладні. <button type="button" onClick={load} className="underline">Повторити</button></div>}
        <Table
          columns={columns}
          data={loadError ? [] : result?.data ?? []}
          keyFn={(inv) => inv.id}
          loading={loading}
          empty={
            <div className="flex flex-col items-center gap-2 text-gray-400 py-4">
              <FileText size={40} className="opacity-30" />
              <p className="text-sm">Накладних не знайдено</p>
            </div>
          }
        />
        {pages > 1 && (
          <div className="border-t border-gray-100 px-4 py-3 flex flex-wrap gap-3 items-center justify-between text-sm text-gray-500">
            <span>{loading ? 'Завантаження…' : `Показано ${(page - 1) * 20 + 1}–${Math.min(page * 20, total)} з ${total}`}</span>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" aria-label="Попередня сторінка" onClick={() => changeView({ page: page - 1 })} disabled={loading || loadError || page === 1}
                className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40 hover:border-gray-300">←</button>
              <input aria-label="Номер сторінки" inputMode="numeric" value={pageInput}
                onChange={event => setPageInput(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (!loading && !loadError) goToPage() } }}
                className="w-16 px-2 py-1 border border-gray-200 rounded-lg text-center" />
              <span>з {pages}</span>
              <button type="button" onClick={goToPage} disabled={loading || loadError} className="px-2 py-1 border rounded-lg disabled:opacity-40">Перейти</button>
              <button type="button" aria-label="Наступна сторінка" onClick={() => changeView({ page: page + 1 })} disabled={loading || loadError || page >= pages}
                className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40 hover:border-gray-300">→</button>
            </div>
          </div>
        )}
      </Card>
    </Layout>
  )
}
