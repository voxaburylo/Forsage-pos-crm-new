import { useEffect, useRef, useState } from 'react'
import { readPinRoster, signInByPin } from '@/lib/auth'
import type { Session } from '@supabase/supabase-js'

type RosterEntry = { id: string; full_name: string; role: string }

/** Чотири цифри — і вхід; усе інше в полі відкидаємо. */
export function pinDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, 4)
}

/**
 * Етап 9 (рішення власника 22.11.2026 «быстрый вход по пин»): на головному ПК касир повертається за 4 цифрами.
 * Список — лише ті, хто сьогодні вже входив паролем на цьому ПК і має PIN; решта входить паролем.
 */
export function PinQuickLogin({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const [chosen, setChosen] = useState<RosterEntry | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    void readPinRoster().then(list => {
      if (!active) return
      setRoster(list)
    })
    return () => { active = false }
  }, [])
  useEffect(() => { if (chosen) input.current?.focus() }, [chosen])

  async function submit(value: string) {
    if (!chosen || busy || value.length !== 4) return
    setBusy(true); setError('')
    try { onSignedIn(await signInByPin(chosen.id, value)) }
    catch (err) {
      const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Невірний PIN-код'
      setError(message)
      setPin('')
      // Після кількох помилок працівника прибрано зі списку — оновлюємо його.
      void readPinRoster().then(list => {
        setRoster(list)
        if (!list.some(entry => entry.id === chosen.id)) setChosen(null)
      })
      input.current?.focus()
    } finally { setBusy(false) }
  }

  if (!roster.length) return null
  return (
    <section className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4" aria-label="Швидкий вхід за PIN">
      <p className="mb-2 text-sm font-medium text-gray-700">Швидкий вхід за PIN</p>
      <div className="flex flex-wrap gap-2">
        {roster.map(entry => (
          <button key={entry.id} type="button" disabled={busy} onClick={() => { setChosen(entry); setPin(''); setError('') }}
            className={`rounded-lg border px-3 py-2 text-sm ${chosen?.id === entry.id ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white text-gray-800 hover:bg-gray-100'}`}>
            {entry.full_name}
          </button>
        ))}
      </div>
      {chosen && (
        <div className="mt-3">
          <label htmlFor="pin-quick" className="mb-1 block text-xs text-gray-500">PIN для «{chosen.full_name}»</label>
          <input id="pin-quick" ref={input} type="password" inputMode="numeric" autoComplete="off" maxLength={4} disabled={busy}
            value={pin} placeholder="••••"
            onChange={event => { const next = pinDigits(event.target.value); setPin(next); if (next.length === 4) void submit(next) }}
            className="w-32 rounded-lg border border-gray-300 px-4 py-3 text-center text-lg tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  )
}
