import { useState, useEffect, useCallback } from 'react'
import { ShoppingCart } from 'lucide-react'
import { saleApi } from '@/features/pos/saleApi'
import type { Sale } from '@/types/sale'
import { Layout } from '@/components/Layout'
import { Card, Table, Badge, SearchInput } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDateTime } from '@/lib/utils'

const PAY_COLOR: Record<string, 'green' | 'blue' | 'red'> = {
  cash: 'green', card: 'blue', debt: 'red',
}
const PAY_LABEL: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', debt: 'Борг',
}

export default function SalesPage() {
  const [sales, setSales]     = useState<Sale[]>([])
  const [search, setSearch]   = useState('')
  const [page, setPage]       = useState(1)
  const [total, setTotal]     = useState(0)
  const [pages, setPages]     = useState(1)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string | number> = { page, per_page: 20 }
      if (search) params.sale_number = search
      const result = await saleApi.list(params)
      const r = result as unknown as { data: Sale[]; pagination: { total: number; total_pages: number } }
      setSales(r.data ?? [])
      setTotal(r.pagination?.total ?? 0)
      setPages(r.pagination?.total_pages ?? 1)
    } catch {
      toast.error('Помилка завантаження продажів')
    } finally {
      setLoading(false)
    }
  }, [page, search])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [search])

  const columns = [
    {
      key: 'num', header: 'Чек',
      render: (s: Sale) => <span className="font-mono text-xs text-gray-600">#{s.sale_number}</span>,
    },
    {
      key: 'customer', header: 'Клієнт',
      render: (s: Sale) => (
        <span className="text-gray-700">
          {s.customer?.full_name ?? s.customer?.phone ?? <span className="text-gray-400 italic">Анонім</span>}
        </span>
      ),
    },
    {
      key: 'pay', header: 'Оплата', className: 'w-24',
      render: (s: Sale) => (
        <Badge color={PAY_COLOR[s.payment_method] ?? 'gray'}>
          {PAY_LABEL[s.payment_method] ?? s.payment_method}
        </Badge>
      ),
    },
    {
      key: 'status', header: 'Статус', className: 'w-24',
      render: (s: Sale) => (
        <Badge color={s.status === 'returned' ? 'red' : s.status === 'completed' ? 'green' : 'gray'}>
          {s.status === 'returned' ? 'Повернено' : s.status === 'completed' ? 'Виконано' : s.status}
        </Badge>
      ),
    },
    {
      key: 'total', header: 'Сума', className: 'w-32 text-right',
      render: (s: Sale) => <span className="font-semibold">{formatMoney(s.total)}</span>,
    },
    {
      key: 'date', header: 'Дата', className: 'w-40 text-right',
      render: (s: Sale) => <span className="text-gray-400 text-xs">{formatDateTime(s.completed_at)}</span>,
    },
  ]

  return (
    <Layout title={`Продажі${total ? ` (${total})` : ''}`}>
      <div className="mb-4">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Пошук за номером чека..."
          className="max-w-sm"
        />
      </div>

      <Card padding="none">
        <Table
          columns={columns}
          data={sales}
          keyFn={(s) => s.id}
          loading={loading}
          empty={
            <div className="flex flex-col items-center gap-2 text-gray-400 py-4">
              <ShoppingCart size={40} className="opacity-30" />
              <p className="text-sm">Продажів не знайдено</p>
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
