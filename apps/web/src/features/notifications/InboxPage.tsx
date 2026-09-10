import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useLatestRequest } from '@/hooks/useLatestRequest'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { notificationLink } from './notificationLink'
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
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const userId = useAuthStore(state => state.session?.user.id)
  const gate = useLatestRequest(userId)
  const readOnly = !isDesktopRuntime()

  const load = useCallback(async () => {
    const isCurrent = gate.begin()
    setLoading(true)
    setItems([])
    setError('')
    try {
      const { data } = await api.get<{ data: Notification[] }>('/api/v1/notifications/inbox?limit=100')
      if (isCurrent()) setItems(data ?? [])
    } catch { if (isCurrent()) setError('Не вдалося завантажити сповіщення з сервера. Перевірте підключення та повторіть.') }
    finally { if (isCurrent()) setLoading(false) }
  }, [gate, userId])

  useEffect(() => { load() }, [load])

  async function markRead(id: string) {
    if (busy.current || readOnly) return
    busy.current = true; setSaving(true)
    try {
      await api.patch(`/api/v1/notifications/inbox/${encodeURIComponent(id)}/read`, {})
      await load()
    } catch { toast.error('Не вдалося позначити сповіщення прочитаним') }
    finally { busy.current = false; setSaving(false) }
  }

  async function markAllRead() {
    if (busy.current || readOnly) return
    busy.current = true; setSaving(true)
    try {
      await api.patch('/api/v1/notifications/inbox/read-all', {})
      await load()
      toast.success('Всі прочитано')
    } catch { toast.error('Не вдалося позначити сповіщення прочитаними') }
    finally { busy.current = false; setSaving(false) }
  }

  const unread = items.filter((n) => !n.is_read).length

  return (
    <Layout
      title="Сповіщення"
      actions={
        unread > 0 && !readOnly ? (
          <Button disabled={saving || loading} variant="secondary" size="sm" icon={<CheckCheck size={14} />} onClick={markAllRead}>
            Позначити всі прочитаними
          </Button>
        ) : undefined
      }
    >
      <p className="mb-3 text-xs text-gray-500">Останні 100 серверних сповіщень. Потрібен інтернет.{readOnly ? ' Веб-версія — тільки перегляд.' : ''}</p>
      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Завантаження...</div>
      ) : error ? <p role="alert" className="text-sm text-red-700">{error} <button onClick={load} className="underline">Повторити</button></p> : items.length === 0 ? (
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
                {notificationLink(n.link) && (
                  <Link to={notificationLink(n.link)!} aria-label="Відкрити пов'язаний документ" className="p-1 text-blue-500 hover:text-blue-700 rounded">
                    <ExternalLink size={14} />
                  </Link>
                )}
                {!n.is_read && !readOnly && (
                  <button disabled={saving || loading} aria-label="Позначити прочитаним" onClick={() => markRead(n.id)} className="p-1 text-gray-400 hover:text-green-600 rounded">
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
