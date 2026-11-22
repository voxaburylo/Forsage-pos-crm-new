import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'
import { Card } from '@/components/ui'
import { pinDigits } from '@/pages/PinQuickLogin'

type Employee = { id: string; full_name: string; role: string; is_active?: boolean }

/**
 * 22.11.2026, рішення власника: «ПК выключен — только просмотр и смена той информации, которая не повлияет на
 * остатки (пин-код, пароль менеджера…)». Сервер зберігає зміну одразу, а головному ПК передає лише хеш —
 * каса застосує його, коли зʼявиться в мережі (до 7 днів).
 */
export function StaffSecretsOffline() {
  const [staff, setStaff] = useState<Employee[]>([])
  const [userId, setUserId] = useState('')
  const [pin, setPin] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void api.get<{ data: Employee[] }>('/api/v1/admin/users', { silent: true, timeoutMs: 15_000 })
      .then(result => { if (active) setStaff(result.data.filter(item => item.role !== 'tire_worker' && item.is_active !== false)) })
      .catch(() => { if (active) setStaff([]) })
    return () => { active = false }
  }, [])
  if (!staff.length) return null

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return
    setBusy(true)
    try { await action(); toast.success(done) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти') }
    finally { setBusy(false) }
  }
  const savePin = () => {
    if (!/^\d{4}$/.test(pin)) { toast.error('PIN — рівно 4 цифри'); return }
    void run(async () => { await api.post('/api/v1/auth/set-pin', { user_id: userId, pin }, undefined, { silent: true }); setPin('') },
      'PIN збережено. Головний ПК отримає його, щойно зʼявиться в мережі.')
  }
  const savePassword = () => {
    if (password.length < 8) { toast.error('Пароль — щонайменше 8 символів'); return }
    void run(async () => { await api.put(`/api/v1/admin/users/${userId}/password`, { password }, { silent: true }); setPassword('') },
      'Пароль змінено. Головний ПК отримає його, щойно зʼявиться в мережі.')
  }

  return (
    <div className="mx-auto max-w-lg pb-10">
      <Card>
        <div className="space-y-3 px-6 py-5" data-staff-secrets-offline>
          <h2 className="text-base font-semibold text-gray-900">PIN і пароль працівника</h2>
          <p className="text-sm text-gray-600">Це можна змінити й без головного ПК: залишків і грошей це не стосується. Каса отримає зміну, щойно зʼявиться в мережі.</p>
          <select value={userId} onChange={event => setUserId(event.target.value)} disabled={busy} aria-label="Працівник"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
            <option value="">— Оберіть працівника —</option>
            {staff.map(item => <option key={item.id} value={item.id}>{item.full_name}</option>)}
          </select>
          {userId && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} placeholder="Новий PIN" aria-label="Новий PIN"
                  value={pin} disabled={busy} onChange={event => setPin(pinDigits(event.target.value))}
                  className="w-32 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-sm tracking-widest" />
                <button type="button" onClick={savePin} disabled={busy || pin.length !== 4}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50">Зберегти PIN</button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input type="password" autoComplete="new-password" placeholder="Новий пароль (від 8 символів)" aria-label="Новий пароль"
                  value={password} disabled={busy} onChange={event => setPassword(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
                <button type="button" onClick={savePassword} disabled={busy || password.length < 8}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50">Змінити пароль</button>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
