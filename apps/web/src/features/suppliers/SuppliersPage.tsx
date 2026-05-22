import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Truck } from 'lucide-react'
import { supplierApi } from './supplierApi'
import type { Supplier, PaginatedSuppliers } from '@/types/supplier'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, SearchInput, Table } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

export default function SuppliersPage() {
  const navigate = useNavigate()
  const [result, setResult]     = useState<PaginatedSuppliers | null>(null)
  const [search, setSearch]     = useState('')
  const [page, setPage]         = useState(1)
  const [loading, setLoading]   = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await supplierApi.list({ search: search || undefined, page, per_page: 20 })
      setResult(data)
    } catch {
      toast.error('Помилка завантаження постачальників')
    } finally {
      setLoading(false)
    }
  }, [search, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [search])

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Видалити постачальника "${name}"?`)) return
    setDeleting(id)
    try {
      await supplierApi.delete(id)
      toast.success('Постачальника видалено')
      load()
    } catch {
      toast.error('Помилка видалення')
    } finally {
      setDeleting(null)
    }
  }

  const columns = [
    {
      key: 'name', header: 'Назва',
      render: (s: Supplier) => (
        <button onClick={() => navigate(`/suppliers/${s.id}`)} className="text-left hover:text-yellow-600 font-medium">
          {s.name}
        </button>
      ),
    },
    {
      key: 'contact', header: 'Контакт', className: 'hidden md:table-cell',
      render: (s: Supplier) => (
        <div className="text-sm text-gray-600">
          {s.contact_name && <div>{s.contact_name}</div>}
          {s.phone && <div className="text-xs">{s.phone}</div>}
        </div>
      ),
    },
    {
      key: 'email', header: 'Email', className: 'hidden lg:table-cell text-sm text-gray-500',
      render: (s: Supplier) => s.email ?? <span className="text-gray-300 italic">—</span>,
    },
    {
      key: 'status', header: 'Статус', className: 'w-24',
      render: (s: Supplier) => (
        <Badge color={s.is_active ? 'green' : 'red'}>{s.is_active ? 'Активний' : 'Неактивний'}</Badge>
      ),
    },
    {
      key: 'actions', header: '', className: 'w-20 text-right',
      render: (s: Supplier) => (
        <div className="flex justify-end gap-1">
          <button onClick={() => navigate(`/suppliers/${s.id}/edit`)}
            className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1">✎</button>
          <button onClick={() => handleDelete(s.id, s.name)} disabled={deleting === s.id}
            className="text-xs text-red-300 hover:text-red-500 px-2 py-1 disabled:opacity-40">✕</button>
        </div>
      ),
    },
  ]

  const total = result?.pagination?.total ?? 0
  const pages = result?.pagination?.total_pages ?? 1

  return (
    <Layout
      title={`Постачальники${total ? ` (${total})` : ''}`}
      actions={
        <Button icon={<Plus size={16} />} onClick={() => navigate('/suppliers/new')}>
          Додати
        </Button>
      }
    >
      <div className="mb-4 flex items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Пошук за назвою, контактом..." className="max-w-sm" />
      </div>

      <Card padding="none">
        <Table
          columns={columns}
          data={result?.data ?? []}
          keyFn={(s) => s.id}
          loading={loading}
          empty={
            <div className="flex flex-col items-center gap-2 text-gray-400 py-4">
              <Truck size={40} className="opacity-30" />
              <p className="text-sm">Постачальників не знайдено</p>
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