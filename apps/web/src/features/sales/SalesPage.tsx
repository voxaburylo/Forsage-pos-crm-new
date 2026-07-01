import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ShoppingCart, RotateCcw, Printer } from 'lucide-react'
import { saleApi } from '@/features/pos/saleApi'
import { ReceiptPrint } from '@/features/pos/ReceiptPrint'
import type { Sale } from '@/types/sale'
import { Layout } from '@/components/Layout'
import { Card, Table, Badge, SearchInput, Modal, Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDateTime } from '@/lib/utils'

const PAY_COLOR: Record<string, 'green' | 'blue' | 'red' | 'gray'> = {
  cash: 'green', card: 'blue', debt: 'red', mixed: 'gray', transfer: 'blue',
}
const PAY_LABEL: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', debt: 'Борг', mixed: 'Змішано', transfer: 'Переказ',
}

export default function SalesPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [sales, setSales]     = useState<Sale[]>([])
  const [search, setSearch]   = useState(() => searchParams.get('search') ?? '')
  const [page, setPage]       = useState(1)
  const [total, setTotal]     = useState(0)
  const [pages, setPages]     = useState(1)
  const [loading, setLoading] = useState(false)

  // Картка продажу
  const [detail, setDetail]   = useState<Sale | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  async function openDetail(id: string) {
    setDetailLoading(true)
    setDetail(null)
    try {
      const { data } = await saleApi.get(id)
      setDetail(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не вдалося завантажити чек')
    } finally {
      setDetailLoading(false)
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string | number> = { page, per_page: 20 }
      if (search) params.search = search
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
      render: (s: Sale) => (
        <button onClick={() => openDetail(s.id)}
          className="font-mono text-xs text-yellow-700 hover:text-yellow-800 hover:underline font-semibold">
          #{s.sale_number}
        </button>
      ),
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
          placeholder="Пошук за чеком, телефоном або ім'ям клієнта..."
          className="max-w-sm"
        />
      </div>

      <Card padding="none">
        <div className="hidden md:block">
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
        </div>
        <div className="md:hidden divide-y divide-gray-100">
          {loading ? (
            <div className="py-12 text-center text-sm text-gray-400">Завантаження...</div>
          ) : sales.length === 0 ? (
            <div className="flex flex-col items-center gap-2 text-gray-400 py-12">
              <ShoppingCart size={36} className="opacity-30" />
              <p className="text-sm">Продажів не знайдено</p>
            </div>
          ) : sales.map((sale) => (
            <button
              key={sale.id}
              type="button"
              onClick={() => openDetail(sale.id)}
              className="w-full p-4 text-left hover:bg-gray-50 active:bg-gray-100 transition-colors"
              aria-label={`Відкрити чек #${sale.sale_number}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-xs font-bold text-yellow-700">#{sale.sale_number}</p>
                  <p className="mt-1 text-sm font-medium text-gray-800">
                    {sale.customer?.full_name ?? sale.customer?.phone ?? 'Анонім'}
                  </p>
                  <p className="mt-1 text-xs text-gray-400">{formatDateTime(sale.completed_at)}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-gray-900">{formatMoney(sale.total)}</p>
                  <div className="mt-1.5 flex justify-end gap-1">
                    <Badge color={PAY_COLOR[sale.payment_method] ?? 'gray'}>
                      {PAY_LABEL[sale.payment_method] ?? sale.payment_method}
                    </Badge>
                    <Badge color={sale.status === 'returned' ? 'red' : sale.status === 'completed' ? 'green' : 'gray'}>
                      {sale.status === 'returned' ? 'Повернено' : sale.status === 'completed' ? 'Виконано' : sale.status}
                    </Badge>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
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

      {/* Картка продажу */}
      <Modal
        open={detailLoading || !!detail}
        onClose={() => { setDetail(null); setDetailLoading(false) }}
        title={detail ? `Чек #${detail.sale_number}` : 'Завантаження...'}
        size="md"
      >
        {detailLoading && !detail ? (
          <div className="py-8 text-center text-gray-400 text-sm">Завантаження...</div>
        ) : detail ? (
          <div className="space-y-4">
            {/* Шапка */}
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-500">Дата</div>
              <div className="text-right text-gray-800">{formatDateTime(detail.completed_at)}</div>
              <div className="text-gray-500">Клієнт</div>
              <div className="text-right text-gray-800">{detail.customer?.full_name ?? detail.customer?.phone ?? 'Анонім'}</div>
              <div className="text-gray-500">Оплата</div>
              <div className="text-right">
                <Badge color={PAY_COLOR[detail.payment_method] ?? 'gray'}>
                  {PAY_LABEL[detail.payment_method] ?? detail.payment_method}
                </Badge>
              </div>
              <div className="text-gray-500">Статус</div>
              <div className="text-right">
                <Badge color={detail.status === 'returned' ? 'red' : detail.status === 'completed' ? 'green' : 'gray'}>
                  {detail.status === 'returned' ? 'Повернено' : detail.status === 'completed' ? 'Виконано' : detail.status}
                </Badge>
              </div>
            </div>

            {/* Позиції */}
            <div className="border border-gray-100 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-400 text-[11px] uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Товар</th>
                    <th className="px-3 py-2 text-right">К-сть</th>
                    <th className="px-3 py-2 text-right">Ціна</th>
                    <th className="px-3 py-2 text-right">Сума</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {(detail.sale_items ?? []).map((it) => (
                    <tr key={it.id}>
                      <td className="px-3 py-2 text-gray-800">{it.product?.name ?? it.product_id}</td>
                      <td className="px-3 py-2 text-right">{it.qty}</td>
                      <td className="px-3 py-2 text-right">{formatMoney(it.unit_price)}</td>
                      <td className="px-3 py-2 text-right font-medium">{formatMoney(it.total)}</td>
                    </tr>
                  ))}
                  {(detail.sale_items?.length ?? 0) === 0 && (
                    <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-400 text-xs">Позиції недоступні</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Підсумок */}
            <div className="flex justify-between items-center text-sm">
              {detail.discount > 0 && <span className="text-gray-500">Знижка: {formatMoney(detail.discount)}</span>}
              <span className="ml-auto font-bold text-gray-900">Разом: {formatMoney(detail.total)}</span>
            </div>

            {/* Дії */}
            <div className="flex gap-2 pt-2 border-t border-gray-100">
              {detail.status === 'completed' && (
                <Button icon={<RotateCcw size={15} />} className="flex-1"
                  onClick={() => navigate(`/returns?sale=${detail.sale_number}`)}>
                  Оформити повернення
                </Button>
              )}
              <Button variant="secondary" icon={<Printer size={15} />} onClick={() => window.print()}>
                Друк чека
              </Button>
              <Button variant="secondary" onClick={() => setDetail(null)}>Закрити</Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Прихований чек для друку (видно лише при window.print()) */}
      {detail && <ReceiptPrint sale={detail} />}
    </Layout>
  )
}
