import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Users, AlertTriangle } from 'lucide-react'
import { customerApi } from './customerApi'
import type { Customer, PaginatedCustomers } from '@/types/customer'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, SearchInput, Table } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

export default function CustomersPage() {
  const navigate = useNavigate()
  const [result, setResult]     = useState<PaginatedCustomers | null>(null)
  const [search, setSearch]     = useState('')
  const [hasDebt, setHasDebt]   = useState(false)
  const [page, setPage]         = useState(1)
  const [loading, setLoading]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await customerApi.list({
        search:   search || undefined,
        has_debt: hasDebt ? 'true' : undefined,
        page,
        per_page: 20,
      })
      setResult(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка завантаження')
    } finally {
      setLoading(false)
    }
  }, [search, hasDebt, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [search, hasDebt])

  async function handleDelete(c: Customer) {
    if (!confirm(`Видалити клієнта "${c.full_name ?? c.phone}"?`)) return
    try {
      await customerApi.delete(c.id)
      toast.success('Клієнта видалено')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    }
  }

  const columns = [
    {
      key: 'phone', header: 'Телефон', className: 'w-40',
      render: (c: Customer) => (
        <button
          onClick={() => navigate(`/customers/${c.id}`)}
          className="font-mono text-sm text-gray-800 hover:text-yellow-700 font-medium"
        >
          {c.phone}
        </button>
      ),
    },
    {
      key: 'name', header: 'Ім\'я',
      render: (c: Customer) => (
        <div>
          <span className="text-gray-900">{c.full_name ?? <span className="text-gray-400 italic">Без імені</span>}</span>
          {c.tags.length > 0 && (
            <div className="flex gap-1 mt-0.5">
              {c.tags.map((t) => <Badge key={t} color="blue" className="text-xs">{t}</Badge>)}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'debt', header: 'Борг', className: 'w-32 text-right',
      render: (c: Customer) => c.debt_balance > 0
        ? <span className="font-semibold text-red-600">{formatMoney(c.debt_balance)}</span>
        : <span className="text-gray-400">—</span>,
    },
    {
      key: 'actions', header: '', className: 'w-32 text-right',
      render: (c: Customer) => (
        <div className="flex items-center justify-end gap-2">
          <button onClick={() => navigate(`/customers/${c.id}/edit`)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Редагувати</button>
          <button onClick={() => handleDelete(c)} className="text-xs text-red-500 hover:text-red-700">Видалити</button>
        </div>
      ),
    },
  ]

  return (
    <Layout
      title={`Клієнти${result ? ` (${result.pagination.total})` : ''}`}
      actions={
        <Button icon={<Plus size={16} />} onClick={() => navigate('/customers/new')}>
          Новий клієнт
        </Button>
      }
    >
      <div className="flex gap-3 mb-4">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Пошук за телефоном або ім'ям..."
          className="flex-1"
        />
        <Button
          variant={hasDebt ? 'primary' : 'secondary'}
          onClick={() => setHasDebt(!hasDebt)}
          icon={<AlertTriangle size={14} />}
        >
          З боргом
        </Button>
      </div>

      <Card padding="none">
        <Table
          columns={columns}
          data={result?.data ?? []}
          keyFn={(c) => c.id}
          loading={loading}
          empty={
            <div className="flex flex-col items-center gap-2 text-gray-400">
              <Users size={40} className="opacity-30" />
              <p>Клієнтів не знайдено</p>
            </div>
          }
        />

        {result && result.pagination.total_pages > 1 && (
          <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between text-sm text-gray-500">
            <span>
              Показано {(page - 1) * 20 + 1}–{Math.min(page * 20, result.pagination.total)} з {result.pagination.total}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>←</Button>
              <span className="px-3 py-1 bg-gray-100 rounded-lg font-medium text-gray-700">{page} / {result.pagination.total_pages}</span>
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(result.pagination.total_pages, p + 1))} disabled={page === result.pagination.total_pages}>→</Button>
            </div>
          </div>
        )}
      </Card>
    </Layout>
  )
}
