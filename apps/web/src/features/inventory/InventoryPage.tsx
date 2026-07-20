import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, ClipboardList, Play, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
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

export default function InventoryPage() {
  const navigate = useNavigate()
  const { session } = useAuthStore()
  const role = (session?.user?.user_metadata?.role as string) ?? 'cashier'
  const canManage = ['owner', 'admin', 'storekeeper'].includes(role)
  const [sessions, setSessions] = useState<Session[]>([])
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [name, setName] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0])
  const [managerId, setManagerId] = useState('')
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [sessRes, usersRes] = await Promise.all([
        api.get<{ data: Session[] }>('/api/v1/inventory', {
          silent: true,
          timeoutMs: INVENTORY_LIST_TIMEOUT_MS,
        }),
        api.get<{ data: any[] }>('/api/v1/admin/staff-options', {
          silent: true,
          timeoutMs: INVENTORY_LIST_TIMEOUT_MS,
        }).catch(() => ({ data: [] })),
      ])
      setSessions(sessRes.data)
      setUsers(usersRes.data ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка завантаження')
    }
    finally { setLoading(false) }
  }

  useEffect(() => {
    load()
  }, [])

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
      const { data } = await api.post<{ data: Session }>(
        '/api/v1/inventory',
        {
          name: name.trim(),
          created_by: managerId || undefined,
          created_at: date ? new Date(date).toISOString() : undefined,
        },
        undefined,
        { silent: true, timeoutMs: INVENTORY_LIST_TIMEOUT_MS },
      )
      const started = await api.post<{ data: { total_products?: number } }>(
        `/api/v1/inventory/${data.id}/start`,
        {},
        undefined,
        { silent: true, timeoutMs: INVENTORY_START_TIMEOUT_MS },
      )
      toast.success(`Ревізію розпочато: ${started.data.total_products ?? 0} товарів у знімку`)
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
      const response = await api.post<{ data: { total_products?: number } }>(
        `/api/v1/inventory/${session.id}/start`,
        {},
        undefined,
        { silent: true, timeoutMs: INVENTORY_START_TIMEOUT_MS },
      )
      toast.success(`Ревізію розпочато: ${response.data.total_products ?? 0} товарів`)
      navigate(`/inventory/${session.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка')
    }
  }


  async function deleteEmptySession(session: Session) {
    if (!window.confirm(`Видалити порожню ревізію "${session.name}"?`)) return
    setDeletingId(session.id)
    try {
      await api.delete<void>(`/api/v1/inventory/${session.id}`)
      setSessions((prev) => prev.filter((item) => item.id !== session.id))
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
        </Card>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Нова ревізія" size="sm">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Під час великої ревізії призупиніть продажі, приходи та списання. На старті система зафіксує повний знімок активних складських товарів.
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
