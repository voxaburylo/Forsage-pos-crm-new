import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { useAuthStore } from '@/stores/authStore'
import { useScopedAction } from '@/hooks/useScopedAction'
import { reconnectDesktopServer } from '@/lib/desktopServerConnection'

export function AiServerConnection({ onConnected }: { onConnected: () => void }) {
  const userId = useAuthStore(state => state.session?.user.id)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const action = useScopedAction(String(userId))
  useEffect(() => () => { controller.current?.abort() }, [userId])
  return <form className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3"
    onSubmit={async event => {
      event.preventDefault()
      const attempt = action.begin()
      if (!attempt) return
      const abort = new AbortController()
      controller.current = abort
      const entered = password
      setPassword(''); setError('')
      try {
        await reconnectDesktopServer(entered, abort.signal)
        if (attempt.isCurrent()) onConnected()
      } catch (reason) {
        if (attempt.isCurrent()) setError(reason instanceof Error ? reason.message : 'Не вдалося підключити ШІ.')
      } finally { if (controller.current === abort) controller.current = null; attempt.finish() }
    }}>
    <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-700">
      Пароль вашого акаунта
      <input type="password" autoComplete="current-password" value={password} disabled={action.busy}
        onChange={event => setPassword(event.target.value)} required maxLength={256}
        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" />
    </label>
    <Button type="submit" size="sm" loading={action.busy} disabled={!password.trim()}>Підключити ШІ</Button>
    <p className="basis-full text-xs text-gray-600">Без виходу з каси. Пароль не зберігається; накладна та вкладення залишаються на місці.</p>
    {error && <p role="alert" className="basis-full text-sm text-red-700">{error}</p>}
  </form>
}
