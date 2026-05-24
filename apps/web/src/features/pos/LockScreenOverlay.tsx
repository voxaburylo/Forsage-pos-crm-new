import { useState } from 'react'
import { Lock, User } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { api } from '@/lib/api'

interface Props {
  onUnlock: () => void
}

const PIN_KEY = 'forsage_pos_locked'

export function isLocked(): boolean {
  return localStorage.getItem(PIN_KEY) === 'true'
}

export function setLocked(locked: boolean) {
  if (locked) localStorage.setItem(PIN_KEY, 'true')
  else localStorage.removeItem(PIN_KEY)
}

export function LockScreenOverlay({ onUnlock }: Props) {
  const session = useAuthStore((s) => s.session)
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)

  const name = session?.user?.user_metadata?.full_name ?? 'Касир'
  const role = session?.user?.user_metadata?.role ?? ''

  async function handleSubmit() {
    if (pin.length < 4) return
    setError(false)
    try {
      // Перевіряємо PIN через API
      const res = await api.post('/api/v1/auth/verify-pin', { pin }) as any
      if (res.data?.valid) {
        setLocked(false)
        onUnlock()
      } else {
        setError(true)
        setPin('')
      }
    } catch (err: any) {
      setError(true)
      setPin('')
      import('@/components/ui/Toast').then(({ toast }) => {
        toast.error(err?.message ?? 'Помилка зв\'язку з сервером при перевірці PIN')
      })
    }
  }

  function pressDigit(d: string) {
    if (pin.length >= 4) return
    const newPin = pin + d
    setPin(newPin)
    if (newPin.length === 4) {
      setTimeout(() => handleSubmit(), 200)
    }
  }

  function pressBackspace() {
    setPin(pin.slice(0, -1))
    setError(false)
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md">
      <div className="bg-white/10 backdrop-blur-lg border border-white/20 rounded-3xl p-8 w-full max-w-sm mx-4 shadow-2xl">
        {/* User info */}
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-yellow-400 rounded-full flex items-center justify-center mx-auto mb-3">
            <User size={32} className="text-black" />
          </div>
          <h2 className="text-white text-xl font-bold">{name}</h2>
          <p className="text-gray-400 text-sm capitalize">{role}</p>
        </div>

        {/* PIN dots */}
        <div className="flex justify-center gap-3 mb-6">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`w-4 h-4 rounded-full border-2 transition-all ${
              pin.length > i ? 'bg-yellow-400 border-yellow-400' : 'border-gray-500'
            }`} />
          ))}
        </div>

        {error && (
          <p className="text-red-400 text-sm text-center mb-3">Невірний PIN-код. Спробуйте ще раз.</p>
        )}

        {/* Numpad — сенсорні кнопки */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
            <button key={d} onClick={() => pressDigit(String(d))}
              className="rounded-xl bg-white/10 text-white text-2xl font-bold hover:bg-white/20 transition-colors active:bg-yellow-400 active:text-black"
              style={{ minHeight: 64 }}>
              {d}
            </button>
          ))}
          <button onClick={() => { setPin(''); setError(false) }}
            className="rounded-xl bg-white/5 text-gray-400 text-sm hover:bg-white/10 transition-colors"
            style={{ minHeight: 64 }}>
            Скинути
          </button>
          <button onClick={() => pressDigit('0')}
            className="rounded-xl bg-white/10 text-white text-2xl font-bold hover:bg-white/20 transition-colors active:bg-yellow-400 active:text-black"
            style={{ minHeight: 64 }}>
            0
          </button>
          <button onClick={pressBackspace}
            className="rounded-xl bg-white/5 text-gray-400 text-xl hover:bg-white/10 transition-colors"
            style={{ minHeight: 64 }}>
            ←
          </button>
        </div>

        {/* Кнопка підтвердження — для сенсорних екранів */}
        <button
          onClick={handleSubmit}
          disabled={pin.length < 4}
          className="w-full rounded-xl bg-yellow-400 hover:bg-yellow-300 disabled:opacity-30 text-black text-base font-bold transition-colors mb-3"
          style={{ minHeight: 52 }}
        >
          Розблокувати
        </button>

        <p className="text-gray-500 text-xs text-center">
          <Lock size={10} className="inline mr-1" />
          {pin.length === 0 ? 'Введіть 4-значний PIN-код' : `Введено: ${pin.length}/4`}
        </p>
      </div>
    </div>
  )
}
