import { useState, useEffect, useCallback } from 'react'
import { Bell, Check, CheckCheck, ExternalLink } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button } from '@/components/ui'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'

interface Notification {
  id: string
  event_type: string
  title: string
  body: string | null
  link: string | null
  is_read: boolean
  created_at: string
}

function timeAgo(dateStr: string) {
  const d = new Date(dateStr)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'щойно'
  if (diff < 3600) return `${Math.floor(diff / 60)} хв тому`
  if (diff < 86400) return `${Math.floor(diff / 3600)} год тому`
  return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })
}

export default function InboxPage() {
  const [items, setItems] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get<{ data: Notification[] }>('/api/v1/notifications/inbox?limit=100')
      setItems(data ?? [])
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function markRead(id: string) {
    await api.patch(`/api/v1/notifications/inbox/${id}/read`, {})
    setItems((prev) => prev.map((n) => n.id === id ? { ...n, is_read: true } : n))
  }

  async function markAllRead() {
    try {
      await api.patch('/api/v1/notifications/inbox/read-all', {})
      setItems((prev) => prev.map((n) => ({ ...n, is_read: true })))
      toast.success('Всі прочитано')
    } catch { toast.error('Помилка') }
  }

  const unread = items.filter((n) => !n.is_read).length

  return (
    <Layout
      title="Сповіщення"
      actions={
        unread > 0 ? (
          <Button variant="secondary" size="sm" icon={<CheckCheck size={14} />} onClick={markAllRead}>
            Прочитати всі ({unread})
          </Button>
        ) : undefined
      }
    >
      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Завантаження...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Bell size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Немає сповіщень</p>
        </div>
      ) : (
        <div className="max-w-2xl space-y-1">
          {items.map((n) => (
            <div
              key={n.id}
              className={`flex gap-3 p-4 rounded-xl border transition-colors ${
                n.is_read
                  ? 'bg-white border-gray-100 text-gray-500'
                  : 'bg-yellow-50 border-yellow-200'
              }`}
            >
              <Bell size={16} className={`mt-0.5 shrink-0 ${n.is_read ? 'text-gray-300' : 'text-yellow-500'}`} />
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${n.is_read ? 'text-gray-600' : 'text-gray-900'}`}>{n.title}</p>
                {n.body && <p className="text-xs text-gray-500 mt-0.5">{n.body}</p>}
                <p className="text-[11px] text-gray-400 mt-1">{timeAgo(n.created_at)}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {n.link && (
                  <a href={n.link} className="p-1 text-blue-500 hover:text-blue-700 rounded">
                    <ExternalLink size={14} />
                  </a>
                )}
                {!n.is_read && (
                  <button onClick={() => markRead(n.id)} className="p-1 text-gray-400 hover:text-green-600 rounded">
                    <Check size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Layout>
  )
}
