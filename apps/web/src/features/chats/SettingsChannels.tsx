import { useState, useEffect, useRef } from 'react'
import { useLatestRequest } from '@/hooks/useLatestRequest'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
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
  telegram: 'Telegram',
}
const PLATFORM_COLORS: Record<string, string> = {
  telegram: 'blue',
}

export default function SettingsChannels() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState({ platform: 'telegram', name: '', token: '' })
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [deleting, setDeleting] = useState<Channel | null>(null)
  const busy = useRef(false)
  const user = useAuthStore(state => state.session?.user)
  const canEdit = isDesktopRuntime() && ['owner', 'admin'].includes(String(user?.app_metadata?.role))
  const gate = useLatestRequest(user?.id)
  function closeCreate() { if (!busy.current) { setModalOpen(false); setForm({ platform: 'telegram', name: '', token: '' }) } }

  async function load() {
    const isCurrent = gate.begin()
    setLoading(true)
    setChannels([]); setLoadError('')
    try {
      const { data } = await api.get<{ data: Channel[] }>('/api/v1/channels')
      if (isCurrent()) setChannels(data.filter((channel) => channel.platform === 'telegram'))
    } catch { if (isCurrent()) setLoadError('Не вдалося завантажити канали з сервера') }
    finally { if (isCurrent()) setLoading(false) }
  }

  useEffect(() => { load() }, [user?.id])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (busy.current || !canEdit) return
    if (!form.name.trim() || !form.token.trim()) { toast.error('Заповніть всі поля'); return }
    busy.current = true; setSaving(true)
    try {
      await api.post('/api/v1/channels', {
        platform: form.platform,
        name: form.name.trim(),
        credentials: { token: form.token.trim() },
      })
      toast.success('Канал створено')
      setModalOpen(false)
      setForm({ platform: 'telegram', name: '', token: '' })
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
    finally { busy.current = false; setSaving(false) }
  }

  async function toggleChannel(ch: Channel) {
    if (busy.current || !canEdit) return
    busy.current = true; setSaving(true)
    try {
      await api.put(`/api/v1/channels/${ch.id}`, { is_active: !ch.is_active })
      toast.success(ch.is_active ? 'Канал вимкнено' : 'Канал увімкнено')
      await load()
    } catch { toast.error('Помилка') }
    finally { busy.current = false; setSaving(false) }
  }

  async function deleteChannel(ch: Channel) {
    if (busy.current || !canEdit) return
    busy.current = true; setSaving(true)
    try {
      await api.delete(`/api/v1/channels/${ch.id}`)
      toast.success('Канал видалено')
      setDeleting(null)
      await load()
    } catch { toast.error('Помилка') }
    finally { busy.current = false; setSaving(false) }
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
        {ch.credentials?.token ? '••••••••' : '—'}
      </span>
    )},
    { key: 'status', header: 'Статус', className: 'w-20', render: (ch: Channel) => (
      <button
        disabled={!canEdit || saving || loading}
        onClick={() => toggleChannel(ch)}
        title={ch.is_active ? 'Вимкнути' : 'Увімкнути'}
        aria-label={`${ch.is_active ? 'Вимкнути' : 'Увімкнути'} канал ${ch.name}`}
      >
        {ch.is_active
          ? <ToggleRight size={20} className="text-green-500" />
          : <ToggleLeft size={20} className="text-gray-400" />}
      </button>
    )},
    { key: 'actions', header: '', className: 'w-12 text-right', render: (ch: Channel) => (
      <button
        disabled={!canEdit || saving || loading}
        onClick={() => setDeleting(ch)}
        className="text-red-400 hover:text-red-600"
        aria-label={`Видалити канал ${ch.name}`}
        title={`Видалити канал ${ch.name}`}
      >
        <Trash2 size={14} />
      </button>
    )},
  ]

  return (
    <Layout title="Канали зв'язку">
      <div className="max-w-3xl">
        <p className="mb-3 text-xs text-gray-500">Серверні канали Telegram — потрібен інтернет. На локальні залишки та касу не впливають.{!canEdit ? ' Тут доступний тільки перегляд.' : ''}</p>
        <div className="flex justify-end mb-4">
          <Button disabled={!canEdit || saving || loading || !!loadError} icon={<Plus size={16} />} onClick={() => setModalOpen(true)}>Додати канал</Button>
        </div>
        <Card padding="none">
          {loadError && <p role="alert" className="p-4 text-sm text-red-700">{loadError}. <button onClick={load} className="underline">Повторити</button></p>}
          <Table columns={columns} data={channels} keyFn={(ch) => ch.id} loading={loading}
            empty={<p className="text-gray-400 text-sm py-12 text-center">{loadError ? 'Дані не завантажено' : 'Канали не знайдено'}</p>} />
        </Card>
      </div>

      <Modal open={modalOpen} onClose={closeCreate} title="Додати канал" size="sm">
        <form onSubmit={handleCreate} className="space-y-4">
          <fieldset disabled={saving} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Платформа</label>
            <select value={form.platform}
              onChange={(e) => setForm((f) => ({ ...f, platform: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
              <option value="telegram">Telegram</option>
            </select>
          </div>
          <Input label="Назва каналу *" maxLength={200} value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Напр.: Telegram магазину" required />
          <Input label="Токен бота *" type="password" value={form.token}
            onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
            placeholder="123456:ABCdefGHIjklmNOpqrsTUVwxyz" required />
          <div className="flex gap-3 pt-2">
            <Button type="submit" loading={saving} className="flex-1">Створити</Button>
            <Button type="button" variant="secondary" onClick={closeCreate}>Скасувати</Button>
          </div>
          </fieldset>
        </form>
      </Modal>
      <Modal open={!!deleting} onClose={() => { if (!busy.current) setDeleting(null) }} title="Видалити канал?" size="sm">
        <p className="text-sm mb-4">Канал «{deleting?.name}» буде видалено. Робота пов'язаного бота припиниться.</p>
        <div className="flex gap-3">
          <Button loading={saving} onClick={() => { if (deleting) void deleteChannel(deleting) }}>Видалити</Button>
          <Button disabled={saving} variant="secondary" onClick={() => setDeleting(null)}>Скасувати</Button>
        </div>
      </Modal>
    </Layout>
  )
}
