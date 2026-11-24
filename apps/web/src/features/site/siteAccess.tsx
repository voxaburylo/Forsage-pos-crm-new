import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Save } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { errorText } from './siteGateway'

/**
 * Доступ до розділу «Сайт» (слово власника 24.11.2026: «ролі доступу до сайту я також можу надати»).
 * Власник бачить розділ завжди. Іншим доступ дає він сам, поіменно, у вкладці «Доступ»; список зберігає сервер,
 * тож діє однаково в програмі й у вебі з дому. Сервер перевіряє доступ сам — меню лише ховає чи показує пункт.
 */
const known = new Map<string, Promise<boolean>>()

function askAllowed(userId: string): Promise<boolean> {
  let answer = known.get(userId)
  if (!answer) {
    answer = api.get<{ data: { allowed: boolean } }>('/api/v1/site-admin/me', { silent: true, timeoutMs: 10_000 }).then(result => Boolean(result.data?.allowed), () => false)
    known.set(userId, answer)
  }
  return answer
}

/** allowed: null — ще питаємо. Власника не питаємо взагалі. */
export function useSiteSection(): { allowed: boolean | null; owner: boolean } {
  const session = useAuthStore(state => state.session)
  const userId = session?.user?.id ?? ''
  const owner = (session?.user?.app_metadata?.role as string | undefined) === 'owner'
  const [allowed, setAllowed] = useState<boolean | null>(owner ? true : null)
  useEffect(() => {
    if (owner) { setAllowed(true); return }
    if (!userId) { setAllowed(false); return }
    let alive = true
    void askAllowed(userId).then(value => { if (alive) setAllowed(value) })
    return () => { alive = false }
  }, [owner, userId])
  return { allowed, owner }
}

export function SiteGate({ children }: { children: React.ReactNode }) {
  const { allowed } = useSiteSection()
  if (allowed === null) return <p role="status" className="p-8 text-center text-sm text-gray-500">Завантажуємо…</p>
  return allowed ? <>{children}</> : <Navigate to="/" replace />
}

const ROLE_TEXT: Record<string, string> = { admin: 'Адміністратор', manager: 'Менеджер', cashier: 'Касир', storekeeper: 'Комірник', tire_worker: 'Шиномонтажник' }
interface StaffRow { id: string; full_name: string; role: string }

export function SiteAccessTab() {
  const [users, setUsers] = useState<StaffRow[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    api.get<{ data: { user_ids: string[]; users: StaffRow[] } }>('/api/v1/site-admin/access', { silent: true, timeoutMs: 15_000 })
      .then(answer => { if (alive) { setUsers(answer.data.users); setPicked(answer.data.user_ids) } }, reason => { if (alive) setError(errorText(reason, 'Не вдалося отримати список працівників')) })
    return () => { alive = false }
  }, [])

  async function save() {
    setBusy(true)
    try {
      const answer = await api.put<{ data: { user_ids: string[] } }>('/api/v1/site-admin/access', { user_ids: picked }, { silent: true, timeoutMs: 15_000 })
      setPicked(answer.data.user_ids); known.clear()
      toast.success('Доступ збережено')
    } catch (reason) { toast.error(errorText(reason)) } finally { setBusy(false) }
  }

  return (
    <Card>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Кому відкрито розділ «Сайт»</h2>
      <p className="mb-3 text-xs text-gray-500">Ви бачите розділ завжди. Відмічений працівник керує замовленнями сайту, описами й фото товарів, банерами, акціями, сторінками й налаштуваннями сайту. Ключ сайту, «Каталог для сайту» і цей список лишаються лише вам.</p>
      {error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>}
      {!users && !error && <p role="status" className="py-6 text-center text-sm text-gray-500">Завантажуємо…</p>}
      {users && (
        <>
          {users.length === 0 && <p className="text-sm text-gray-500">Інших працівників немає.</p>}
          <ul className="divide-y divide-gray-100" data-site-access>
            {users.map(user => (
              <li key={user.id}>
                <label className="flex cursor-pointer items-center gap-3 py-2.5 text-sm">
                  <input type="checkbox" role="switch" className="h-5 w-5 shrink-0 rounded border-gray-300 text-accent" checked={picked.includes(user.id)}
                    onChange={event => setPicked(current => event.target.checked ? [...current, user.id] : current.filter(id => id !== user.id))} />
                  <span className="min-w-0 break-words"><span className="font-medium text-gray-900">{user.full_name || 'Без імені'}</span>
                    <span className="text-gray-500"> · {ROLE_TEXT[user.role] ?? user.role}</span></span>
                </label>
              </li>
            ))}
          </ul>
          <Button className="mt-4" icon={<Save size={14} />} loading={busy} onClick={() => void save()}>Зберегти</Button>
        </>
      )}
    </Card>
  )
}
