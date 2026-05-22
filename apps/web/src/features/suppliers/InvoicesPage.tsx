import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
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
  const [status, setStatus]     = useState('')
  const [page, setPage]         = useState(1)
  const [loading, setLoading]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await supplierApi.listInvoices({ status: status || undefined, page, per_page: 20 })
      setResult(data)
    } catch {
      toast.error('Помилка завантаження накладних')
    } finally {
      setLoading(false)
    }
  }, [status, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [status])

  const columns = [
    {
      key: 'num', header: '№',
      render: (inv: SupplyInvoice) => (
        <button onClick={() => navigate(`/suppliers/invoices/${inv.id}`)} className="text-left hover:text-yellow-600 font-mono text-sm">
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
      key: 'total', header: 'Сума', className: 'w-28 text-right',
      render: (inv: SupplyInvoice) => <span className="font-mono text-sm">{formatMoney(inv.total)}</span>,
    },
    {
      key: 'date', header: 'Дата', className: 'hidden md:table-cell w-32 text-sm text-gray-500',
      render: (inv: SupplyInvoice) => formatDate(inv.created_at),
    },
    {
      key: 'actions', header: '', className: 'w-16 text-right',
      render: (inv: SupplyInvoice) => (
        <button onClick={() => navigate(`/suppliers/invoices/${inv.id}`)}
          className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1">✎</button>
      ),
    },
  ]

  const total = result?.pagination?.total ?? 0
  const pages = result?.pagination?.total_pages ?? 1

  return (
    <Layout
      title={`Приходні накладні${total ? ` (${total})` : ''}`}
      onBack={() => navigate('/suppliers')}
      actions={
        <Button icon={<Plus size={16} />} onClick={() => navigate('/suppliers/invoices/new')}>
          Накладна
        </Button>
      }
    >
      <div className="mb-4 flex items-center gap-2">
        {['', 'draft', 'posted', 'cancelled'].map((s) => (
          <button key={s} onClick={() => setStatus(s)}
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
        <Table
          columns={columns}
          data={result?.data ?? []}
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
          <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between text-sm text-gray-500">
            <span>Показано {(page - 1) * 20 + 1}–{Math.min(page * 20, total)} з {total}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40 hover:border-gray-300">←</button>
              <span className="px-3 py-1 bg-gray-100 rounded-lg font-medium">{page} / {pages}</span>
              <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages}
                className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40 hover:border-gray-300">→</button>
            </div>
          </div>
        )}
      </Card>
    </Layout>
  )
}