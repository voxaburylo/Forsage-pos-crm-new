import { useState } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'
import { toast } from '@/components/ui/Toast'
import { pinDigits } from '@/pages/PinQuickLogin'

/**
 * Етап 9 (рішення власника 22.11.2026): PIN із 4 цифр для швидкої зміни касира на головному ПК.
 * Пароль лишається основним входом: PIN діє лише після входу паролем цього ж дня на цьому ПК.
 * Значення PIN ніде не показується; поле лише задає новий.
 */
export function StaffPinControl({ userId, role }: { userId: string; role: string }) {
  const setPin = desktopBridge()?.staff?.setPin
  const [pin, setPinText] = useState('')
  const [busy, setBusy] = useState(false)
  if (!setPin || role === 'tire_worker') return null

  async function save() {
    if (busy || !setPin) return
    if (!/^\d{4}$/.test(pin)) { toast.error('PIN — рівно 4 цифри'); return }
    setBusy(true)
    try {
      await setPin(userId, pin)
      setPinText('')
      toast.success('PIN збережено. Діє після входу паролем сьогодні на цьому ПК.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Не вдалося зберегти PIN')
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-2 border-t border-gray-100 pt-3">
      <p className="text-sm font-medium text-gray-700">PIN для швидкого входу</p>
      <div className="flex flex-wrap items-center gap-3">
        <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} aria-label="Новий PIN із 4 цифр"
          value={pin} disabled={busy} placeholder="••••" onChange={event => setPinText(pinDigits(event.target.value))}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void save() } }}
          className="w-24 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-sm tracking-widest" />
        <button type="button" disabled={busy || pin.length !== 4} onClick={() => { void save() }}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          Зберегти PIN
        </button>
      </div>
      <p className="text-xs text-gray-500">Раз на день — вхід паролем, далі до кінця дня зміна касира за 4 цифрами. Після 3 невірних PIN — знову пароль.</p>
    </div>
  )
}
