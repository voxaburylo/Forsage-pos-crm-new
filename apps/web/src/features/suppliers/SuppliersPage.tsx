import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Truck, GitMerge } from 'lucide-react'
import { supplierApi } from './supplierApi'
import type { Supplier, PaginatedSuppliers } from '@/types/supplier'
import { Layout } from '@/components/Layout'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge, Card, SearchInput, Table, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

export default function SuppliersPage() {
  const session = useAuthStore((s) => s.session)
  const role = (session?.user?.app_metadata?.role as string) ?? 'cashier'
  const navigate = useNavigate()
  
  useEffect(() => {
    if (role === 'storekeeper') {
      navigate('/suppliers/invoices', { replace: true })
    }
  }, [role, navigate])
  const [result, setResult]     = useState<PaginatedSuppliers | null>(null)
  const [search, setSearch]     = useState('')
  const [page, setPage]         = useState(1)
  const [loading, setLoading]   = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergePrimary, setMergePrimary] = useState('')
  const [mergeDuplicate, setMergeDuplicate] = useState('')
  const [merging, setMerging] = useState(false)
  const [allSuppliers, setAllSuppliers] = useState<Supplier[]>([])
  const canManage = role === 'owner' || role === 'admin'

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

  // Повний список для вибору в злитті дублів
  function loadAllSuppliers() {
    supplierApi.list({ per_page: 500 }).then((r) => setAllSuppliers(r.data)).catch(() => {})
  }

  async function handleMerge() {
    if (!mergePrimary || !mergeDuplicate) { toast.error('Оберіть обох постачальників'); return }
    if (mergePrimary === mergeDuplicate) { toast.error('Це той самий постачальник'); return }
    setMerging(true)
    try {
      await supplierApi.merge(mergePrimary, mergeDuplicate)
      toast.success('Постачальників об’єднано')
      setMergeOpen(false)
      setMergePrimary(''); setMergeDuplicate('')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка об’єднання')
    } finally {
      setMerging(false)
    }
  }

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
        <div className="flex gap-2">
          {canManage && (
            <Button variant="outline" icon={<GitMerge size={16} />} className="hidden sm:inline-flex"
              onClick={() => { setMergeOpen(true); loadAllSuppliers() }}>
              Об’єднати дублі
            </Button>
          )}
          <Button icon={<Plus size={16} />} onClick={() => navigate('/suppliers/new')}>
            Додати
          </Button>
        </div>
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

      {/* Об'єднання дублів постачальників */}
      <Modal open={mergeOpen} onClose={() => setMergeOpen(false)} title="Об’єднати дублі постачальників" size="md">
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            Усі накладні, замовлення та борги дубліката перейдуть до основного постачальника. Дублікат буде прибрано зі списку.
          </p>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Залишити (основний)</label>
            <select value={mergePrimary} onChange={(e) => setMergePrimary(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400">
              <option value="">— Оберіть —</option>
              {allSuppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.phone ? ` (${s.phone})` : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Приєднати та видалити (дублікат)</label>
            <select value={mergeDuplicate} onChange={(e) => setMergeDuplicate(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400">
              <option value="">— Оберіть —</option>
              {allSuppliers.filter((s) => s.id !== mergePrimary).map((s) => <option key={s.id} value={s.id}>{s.name}{s.phone ? ` (${s.phone})` : ''}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setMergeOpen(false)}>Скасувати</Button>
            <Button loading={merging} onClick={handleMerge} disabled={!mergePrimary || !mergeDuplicate}>
              Об’єднати
            </Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}