import { useState, useEffect } from 'react'
import { Plus, Trash2, ToggleLeft, ToggleRight } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal, Input, Table, Badge } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

interface Channel {
  id: string
  name: string
  platform: string
  credentials: { token?: string }
  is_active: boolean
  created_at: string
}

const PLATFORM_LABELS: Record<string, string> = {
  telegram: 'Telegram', viber: 'Viber', whatsapp: 'WhatsApp',
}
const PLATFORM_COLORS: Record<string, string> = {
  telegram: 'blue', viber: 'purple', whatsapp: 'green',
}

export default function SettingsChannels() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState({ platform: 'telegram', name: '', token: '' })
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const { data } = await api.get<{ data: Channel[] }>('/api/v1/channels')
      setChannels(data)
    } catch { toast.error('Помилка завантаження') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || !form.token.trim()) { toast.error('Заповніть всі поля'); return }
    setSaving(true)
    try {
      await api.post('/api/v1/channels', {
        platform: form.platform,
        name: form.name.trim(),
        credentials: { token: form.token.trim() },
      })
      toast.success('Канал створено')
      setModalOpen(false)
      setForm({ platform: 'telegram', name: '', token: '' })
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
    finally { setSaving(false) }
  }

  async function toggleChannel(ch: Channel) {
    try {
      await api.put(`/api/v1/channels/${ch.id}`, { is_active: !ch.is_active })
      toast.success(ch.is_active ? 'Канал вимкнено' : 'Канал увімкнено')
      load()
    } catch { toast.error('Помилка') }
  }

  async function deleteChannel(ch: Channel) {
    if (!confirm(`Видалити канал "${ch.name}"? Боти та чати будуть видалені.`)) return
    try {
      await api.delete(`/api/v1/channels/${ch.id}`)
      toast.success('Канал видалено')
      load()
    } catch { toast.error('Помилка') }
  }

  const columns = [
    { key: 'name', header: 'Назва', render: (ch: Channel) => (
      <div className="flex items-center gap-2">
        <Badge color={PLATFORM_COLORS[ch.platform] as any}>{PLATFORM_LABELS[ch.platform] ?? ch.platform}</Badge>
        <span className="font-medium">{ch.name}</span>
      </div>
    )},
    { key: 'token', header: 'Токен', render: (ch: Channel) => (
      <span className="font-mono text-xs text-gray-400">
        {ch.credentials?.token ? `${ch.credentials.token.slice(0, 20)}...` : '—'}
      </span>
    )},
    { key: 'status', header: 'Статус', className: 'w-20', render: (ch: Channel) => (
      <button onClick={() => toggleChannel(ch)} title={ch.is_active ? 'Вимкнути' : 'Увімкнути'}>
        {ch.is_active
          ? <ToggleRight size={20} className="text-green-500" />
          : <ToggleLeft size={20} className="text-gray-400" />}
      </button>
    )},
    { key: 'actions', header: '', className: 'w-12 text-right', render: (ch: Channel) => (
      <button onClick={() => deleteChannel(ch)} className="text-red-400 hover:text-red-600">
        <Trash2 size={14} />
      </button>
    )},
  ]

  return (
    <Layout title="Канали зв'язку">
      <div className="max-w-3xl">
        <div className="flex justify-end mb-4">
          <Button icon={<Plus size={16} />} onClick={() => setModalOpen(true)}>Додати канал</Button>
        </div>
        <Card padding="none">
          <Table columns={columns} data={channels} keyFn={(ch) => ch.id} loading={loading}
            empty={<p className="text-gray-400 text-sm py-12 text-center">Канали не знайдено</p>} />
        </Card>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Додати канал" size="sm">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Платформа</label>
            <select value={form.platform}
              onChange={(e) => setForm((f) => ({ ...f, platform: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
              <option value="telegram">Telegram</option>
              <option value="viber" disabled>Viber (невдовзі)</option>
              <option value="whatsapp" disabled>WhatsApp (невдовзі)</option>
            </select>
          </div>
          <Input label="Назва каналу *" value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="ТГ Київстар / Viber Бізнес" required />
          <Input label="Токен бота *" value={form.token}
            onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
            placeholder="123456:ABCdefGHIjklmNOpqrsTUVwxyz" required />
          <div className="flex gap-3 pt-2">
            <Button type="submit" loading={saving} className="flex-1">Створити</Button>
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Скасувати</Button>
          </div>
        </form>
      </Modal>
    </Layout>
  )
}
