import { useEffect, useRef, useState } from 'react'
import { readPinRoster, signInByPin } from '@/lib/auth'
import type { Session } from '@supabase/supabase-js'

/** Чотири цифри — і вхід; усе інше в полі відкидаємо. */
export function pinDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, 4)
}

/**
 * Швидкий вхід за PIN на головному ПК (етап 9). 23.11.2026, рішення власника: «ввів свій PIN і зайшов —
 * навіщо когось вибирати». Поле одне; працівника визначає сам PIN. Діє для касирів і менеджерів, які сьогодні
 * вже входили паролем на цьому ПК; власник і адміністратор входять лише паролем. Поки таких немає — поля немає.
 */
export function PinQuickLogin({ onSignedIn, dark = false }: { onSignedIn: (session: Session) => void; dark?: boolean }) {
  const [available, setAvailable] = useState(false)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    void readPinRoster().then(list => { if (active) setAvailable(list.length > 0) })
    return () => { active = false }
  }, [])

  async function submit(value: string) {
    if (busy || value.length !== 4) return
    setBusy(true); setError('')
    try { onSignedIn(await signInByPin(value)) }
    catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'PIN не підійшов')
      setPin('')
      input.current?.focus()
    } finally { setBusy(false) }
  }

  if (!available) return null
  return (
    <section className={`mb-6 rounded-xl border p-4 ${dark ? 'border-gray-700 bg-[#0D0D0D]' : 'border-gray-200 bg-gray-50'}`} aria-label="Швидкий вхід за PIN">
      <label htmlFor="pin-quick" className={`mb-2 block text-sm font-medium ${dark ? 'text-gray-300' : 'text-gray-700'}`}>Швидкий вхід за PIN</label>
      <input id="pin-quick" ref={input} type="password" inputMode="numeric" autoComplete="off" maxLength={4} disabled={busy}
        value={pin} placeholder="••••" data-pin-input
        onChange={event => { const next = pinDigits(event.target.value); setPin(next); if (next.length === 4) void submit(next) }}
        className={`w-32 rounded-lg border px-4 py-3 text-center text-lg tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-accent ${dark ? 'border-gray-700 bg-[#1A1A1A] text-white' : 'border-gray-300'}`} />
      <p className={`mt-2 text-xs ${dark ? 'text-gray-500' : 'text-gray-500'}`}>Свій PIN — 4 цифри. Вранці перший вхід — паролем.</p>
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  )
}
