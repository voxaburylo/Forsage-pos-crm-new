import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, ClipboardList, Play, Trash2 } from 'lucide-react'
import { adminApi } from '@/features/admin/adminApi'
import { inventoryApi } from '@/features/inventory/inventoryApi'
import { useAuthStore } from '@/stores/authStore'
import { Layout } from '@/components/Layout'
import { Button, Card, Table, Badge, Modal, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatDate } from '@/lib/utils'

interface Session {
  id: string
  name: string
  status: 'draft' | 'in_progress' | 'completed'
  created_by: string
  created_at: string
  completed_at: string | null
}

const STATUS_BADGE: Record<string, { color: 'yellow' | 'blue' | 'green'; label: string }> = {
  draft: { color: 'yellow', label: 'Чернетка' },
  in_progress: { color: 'blue', label: 'Активна' },
  completed: { color: 'green', label: 'Завершена' },
}

const INVENTORY_LIST_TIMEOUT_MS = 10_000
const INVENTORY_START_TIMEOUT_MS = 30_000

/**
 * Обрана дата ревізії + поточний час.
 *
 * Раніше сюди йшла гола дата, тобто опівніч, і всі ревізії одного дня мали
 * однаковий created_at — список не міг їх упорядкувати, тож щойно створена
 * ревізія опинялась десь усередині й здавалась зниклою.
 */
function dateWithCurrentTime(day: string): string {
  const now = new Date()
  const stamp = new Date(`${day}T00:00:00`)
  if (Number.isNaN(stamp.getTime())) return now.toISOString()
  stamp.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds())
  return stamp.toISOString()
}

export default function InventoryPage() {
  const navigate = useNavigate()
  const { session } = useAuthStore()
  const role = (session?.user?.app_metadata?.role as string) ?? 'cashier'
  const canManage = ['owner', 'admin', 'manager', 'cashier', 'storekeeper'].includes(role)
  const [sessions, setSessions] = useState<Session[]>([])
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [name, setName] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0])
  const [managerId, setManagerId] = useState('')
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  async function load() {
    setLoading(true)
    try {
      const [sessRes, usersRes] = await Promise.all([
        inventoryApi.listSessions({ page, per_page: 20 }, { silent: true, timeoutMs: INVENTORY_LIST_TIMEOUT_MS }),
        adminApi.listUsers().catch(() => ({ data: [] })),
      ])
      setSessions(sessRes.data)
      setTotal(sessRes.pagination.total)
      setTotalPages(sessRes.pagination.total_pages)
      setUsers(usersRes.data ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка завантаження')
    }
    finally { setLoading(false) }
  }

  useEffect(() => {
    void load()
    const refreshFromLocalPull = () => { void load() }
    window.addEventListener('forsage:desktop-sync-completed', refreshFromLocalPull)
    return () => window.removeEventListener('forsage:desktop-sync-completed', refreshFromLocalPull)
  }, [page])

  useEffect(() => {
    if (session?.user?.id && !managerId) {
      setManagerId(session.user.id)
    }
  }, [session, managerId])

  useEffect(() => {
    if (!date) return
    const formattedDate = date.split('-').reverse().join('.')
    const manager = users.find((u) => u.id === managerId)
    const suffix = manager ? ` (${manager.full_name})` : ''
    setName(`Ревізія від ${formattedDate}${suffix}`)
  }, [date, managerId, users])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    try {
      const { data } = await inventoryApi.createSession(
        {
          name: name.trim(),
          created_by: managerId || undefined,
          created_at: date ? dateWithCurrentTime(date) : undefined,
        },
        { silent: true, timeoutMs: INVENTORY_LIST_TIMEOUT_MS },
      )
      await inventoryApi.startSession(data.id, { silent: true, timeoutMs: INVENTORY_START_TIMEOUT_MS })
      toast.success('Ревізію розпочато. Скануйте тільки ті товари, які треба перерахувати.')
      setModalOpen(false)
      setName('')
      setDate(new Date().toISOString().split('T')[0])
      if (session?.user?.id) setManagerId(session.user.id)
      navigate(`/inventory/${data.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка')
    }
    finally { setCreating(false) }
  }

  async function startSession(session: Session) {
    try {
      await inventoryApi.startSession(session.id, { silent: true, timeoutMs: INVENTORY_START_TIMEOUT_MS })
      toast.success('Ревізію розпочато. Скануйте тільки ті товари, які треба перерахувати.')
      navigate(`/inventory/${session.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка')
    }
  }


  async function deleteEmptySession(session: Session) {
    if (!window.confirm(`Видалити порожню ревізію "${session.name}"?`)) return
    setDeletingId(session.id)
    try {
      await inventoryApi.deleteSession(session.id)
      if (sessions.length === 1 && page > 1) {
        setPage((current) => current - 1)
      } else {
        await load()
      }
      toast.success('Порожню ревізію видалено')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося видалити ревізію')
    } finally {
      setDeletingId(null)
    }
  }
  const columns = [
    { key: 'name', header: 'Назва', render: (s: Session) => {
      const creator = users.find((u) => u.id === s.created_by)
      const creatorName = creator ? creator.full_name : ''
      return (
        <div>
          <button onClick={() => navigate(`/inventory/${s.id}`)} className="font-medium text-gray-900 hover:text-yellow-700 text-left">
            {s.name}
          </button>
          <p className="text-xs text-gray-400">
            {formatDate(s.created_at)}
            {creatorName ? ` · ${creatorName}` : ''}
          </p>
        </div>
      )
    }},
    { key: 'status', header: 'Статус', render: (s: Session) => {
      const b = STATUS_BADGE[s.status] ?? { color: 'gray' as const, label: s.status }
      return <Badge color={b.color}>{b.label}</Badge>
    }},
    { key: 'actions', header: '', className: 'w-44 text-right', render: (s: Session) => (
      <div className="flex justify-end gap-1.5">
        {s.status === 'draft' && canManage ? (
          <Button size="sm" variant="outline" icon={<Play size={14} />} onClick={() => startSession(s)}>Почати</Button>
        ) : s.status === 'in_progress' ? (
          <Button size="sm" variant="outline" icon={<ClipboardList size={14} />} onClick={() => navigate(`/inventory/${s.id}`)}>Відкрити</Button>
        ) : null}
        {canManage && s.status !== 'completed' && (
          <button
            type="button"
            disabled={deletingId === s.id}
            title="Видалити порожню ревізію"
            onClick={() => deleteEmptySession(s)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-red-100 bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    )},
  ]

  const firstShown = total === 0 ? 0 : (page - 1) * 20 + 1
  const lastShown = Math.min(page * 20, total)
  return (
    <Layout title="Ревізія залишків">
      <div className="max-w-3xl">
        <p className="mb-4 text-sm text-gray-500">
          Звірте фактичну кількість товарів із залишками в системі. Розбіжності буде видно під час ревізії.
        </p>
        <div className="flex justify-end mb-4">
          {canManage && <Button icon={<Plus size={16} />} onClick={() => setModalOpen(true)}>Нова ревізія</Button>}
        </div>
        <Card padding="none">
          <Table columns={columns} data={sessions} keyFn={(s) => s.id} loading={loading}
            empty={<p className="text-gray-400 text-sm py-12 text-center">Ревізій ще не було</p>} />
          {totalPages > 1 && (
            <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between text-sm text-gray-500">
              <span>Показано {firstShown}–{lastShown} з {total}</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1}
                  className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40 hover:border-gray-300">←</button>
                <span className="px-3 py-1 bg-gray-100 rounded-lg font-medium">{page} / {totalPages}</span>
                <button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages}
                  className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40 hover:border-gray-300">→</button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Нова ревізія" size="sm">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Ревізія змінює тільки ті товари, які ви додали в цей підрахунок. Інші залишки не будуть обнулені або перезаписані.
          </div>
          <Input
            label="Дата ревізії *"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Відповідальний менеджер *</label>
            <select
              value={managerId}
              onChange={(e) => setManagerId(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              required
            >
              <option value="">Оберіть менеджера</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name} ({u.phone})
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Назва ревізії *"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ревізія травень 2025"
            required
          />
          <div className="flex gap-3 pt-2">
            <Button type="submit" loading={creating} className="flex-1">Створити</Button>
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Скасувати</Button>
          </div>
        </form>
      </Modal>
    </Layout>
  )
}
