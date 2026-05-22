import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, ClipboardList, Play } from 'lucide-react'
import { api } from '@/lib/api'
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

export default function InventoryPage() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const { data } = await api.get<{ data: Session[] }>('/api/v1/inventory')
      setSessions(data)
    } catch { toast.error('Помилка завантаження') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    try {
      const { data } = await api.post<{ data: Session }>('/api/v1/inventory', { name: name.trim() })
      toast.success('Сесію створено')
      setModalOpen(false)
      setName('')
      navigate(`/inventory/${data.id}`)
    } catch { toast.error('Помилка') }
    finally { setCreating(false) }
  }

  async function startSession(session: Session) {
    try {
      await api.post(`/api/v1/inventory/${session.id}/start`, {})
      toast.success('Ревізію розпочато')
      load()
    } catch { toast.error('Помилка') }
  }

  const columns = [
    { key: 'name', header: 'Назва', render: (s: Session) => (
      <div>
        <button onClick={() => navigate(`/inventory/${s.id}`)} className="font-medium text-gray-900 hover:text-yellow-700 text-left">
          {s.name}
        </button>
        <p className="text-xs text-gray-400">{formatDate(s.created_at)}</p>
      </div>
    )},
    { key: 'status', header: 'Статус', render: (s: Session) => {
      const b = STATUS_BADGE[s.status] ?? { color: 'gray' as const, label: s.status }
      return <Badge color={b.color}>{b.label}</Badge>
    }},
    { key: 'actions', header: '', className: 'w-32 text-right', render: (s: Session) => (
      s.status === 'draft' ? (
        <Button size="sm" variant="outline" icon={<Play size={14} />} onClick={() => startSession(s)}>Почати</Button>
      ) : s.status === 'in_progress' ? (
        <Button size="sm" variant="outline" icon={<ClipboardList size={14} />} onClick={() => navigate(`/inventory/${s.id}`)}>Відкрити</Button>
      ) : null
    )},
  ]

  return (
    <Layout title="Інвентаризація">
      <div className="max-w-3xl">
        <div className="flex justify-end mb-4">
          <Button icon={<Plus size={16} />} onClick={() => setModalOpen(true)}>Нова ревізія</Button>
        </div>
        <Card padding="none">
          <Table columns={columns} data={sessions} keyFn={(s) => s.id} loading={loading}
            empty={<p className="text-gray-400 text-sm py-12 text-center">Ревізій ще не було</p>} />
        </Card>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Нова ревізія" size="sm">
        <form onSubmit={handleCreate} className="space-y-4">
          <Input label="Назва ревізії *" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ревізія травень 2025" required autoFocus />
          <div className="flex gap-3">
            <Button type="submit" loading={creating} className="flex-1">Створити</Button>
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Скасувати</Button>
          </div>
        </form>
      </Modal>
    </Layout>
  )
}
