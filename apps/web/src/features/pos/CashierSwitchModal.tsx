import { useEffect, useRef, useState } from 'react'
import { UserRound } from 'lucide-react'
import { useDialogEscape } from '@/hooks/useDialogEscape'
import { canSignInByPassword, signInByPassword } from '@/lib/auth'
import { confirmDesktopUnlocked } from '@/lib/desktopAccessState'
import { toast } from '@/components/ui/Toast'
import { PinQuickLogin } from '@/pages/PinQuickLogin'

/** Кнопка «Змінити касира» є лише в програмі на головному чи окремому ПК, не на ПК менеджера і не у вебі. */
export function useCashierSwitchAvailable(): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let active = true
    void canSignInByPassword().then(value => { if (active) setAvailable(value) }).catch(() => {})
    return () => { active = false }
  }, [])
  return available
}

/**
 * Швидка зміна касира: новий касир вводить свій пароль (або PIN, якщо сьогодні вже входив паролем), без виходу з каси.
 * Зміна (касова зміна з готівкою) у кожного касира своя — як і при звичайному вході.
 */
export function CashierSwitchModal({ currentName, onClose }: { currentName: string; onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useDialogEscape(true, () => { if (!loading) onClose() })
  useEffect(() => { inputRef.current?.focus() }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (loading || !password) return
    setLoading(true)
    setError('')
    try {
      const session = await signInByPassword(password)
      confirmDesktopUnlocked()
      const name = String(session.user.user_metadata?.full_name ?? '').trim()
      toast.success(name ? `Касир: ${name}` : 'Касира змінено')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*?\[LOCAL_AUTH_[A-Z_]+\]\s*/, '') : 'Не вдалося змінити касира')
      setPassword('')
      inputRef.current?.focus()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Змінити касира" data-cashier-switch
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => { if (!loading) onClose() }}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-gray-700 bg-[#1A1A1A] p-6 shadow-2xl animate-slide-up">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-yellow-400/15 text-yellow-400"><UserRound size={20} /></span>
          <div>
            <h2 className="text-lg font-bold text-white">Змінити касира</h2>
            {currentName && <p className="text-xs text-gray-500">Зараз: {currentName}</p>}
          </div>
        </div>
        {/* Етап 9: хто сьогодні вже входив паролем на цьому ПК — повертається за своїм PIN, нікого не вибираючи. */}
        <PinQuickLogin dark onSignedIn={session => {
          confirmDesktopUnlocked()
          const name = String(session.user.user_metadata?.full_name ?? '').trim()
          toast.success(name ? `Касир: ${name}` : 'Касира змінено')
          onClose()
        }} />
        <label htmlFor="cashier-switch-password" className="mb-1 block text-sm text-gray-400">Пароль нового касира</label>
        <input id="cashier-switch-password" ref={inputRef} type="password" autoComplete="off" value={password}
          disabled={loading} onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl border border-gray-700 bg-[#0D0D0D] px-4 py-3 text-lg text-white focus:border-yellow-400 focus:outline-none" />
        {error && <p role="alert" className="mt-2 text-sm text-red-400">{error}</p>}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} disabled={loading}
            className="flex-1 rounded-xl bg-gray-800 py-3 text-sm font-semibold text-gray-300 hover:text-white">Скасувати</button>
          <button type="submit" disabled={loading || !password}
            className="flex-1 rounded-xl bg-yellow-400 py-3 text-sm font-bold text-black hover:bg-yellow-300 disabled:opacity-50">
            {loading ? 'Перевіряємо…' : 'Увійти'}
          </button>
        </div>
      </form>
    </div>
  )
}
