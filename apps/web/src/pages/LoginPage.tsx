import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff } from 'lucide-react'
import { signIn, signInRemembered, signOut } from '@/lib/auth'
import { useAuthStore } from '@/stores/authStore'
import { homePathForRole } from '@/components/ProtectedRoute'
import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'

import { API_BASE_URL } from '@/lib/apiBaseUrl'
const PHONE_REGEX = /^\+?380\d{9}$/

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.startsWith('380')) return `+${digits}`
  if (digits.startsWith('80')) return `+3${digits}`
  if (digits.startsWith('0')) return `+38${digits}`
  return value
}

export default function LoginPage({ onUnlocked }: { onUnlocked?: () => void } = {}) {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const [remember, setRemember] = useState(false)
  const [pinMode, setPinMode] = useState(false)
  const [pinRequired, setPinRequired] = useState(true)
  const [savedName, setSavedName] = useState('')
  const canRemember = Boolean(desktopBridge()?.auth?.remember)
  useEffect(() => {
    if (!isDesktopRuntime()) return
    try { setPhone(localStorage.getItem('forsage:last-login-phone') ?? '') } catch { /* optional hint */ }
    let active = true
    void desktopBridge()?.auth?.rememberedStatus?.().then(status => {
      if (!active) return
      setPinRequired(status.pinRequired !== false)
      if (!status.available) return
      setPhone(status.phone ?? '')
      setSavedName(status.name ?? '')
      setPinMode(true)
    }).catch(() => {})
    return () => { active = false }
  }, [])
  const [showPassword, setShowPassword] = useState(false)
  const [phoneError, setPhoneError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('Входимо...')
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // У desktop вхід іде через локальну базу; сервер будити не потрібно.
  useEffect(() => {
    if (isDesktopRuntime()) return
    fetch(`${API_BASE_URL}/api/v1/health`, { signal: AbortSignal.timeout(30000) }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!loading) { setLoadingMsg('Входимо...'); return }
    if (isDesktopRuntime()) { setLoadingMsg('Перевіряємо локальну базу...'); return }
    const t1 = setTimeout(() => setLoadingMsg('Підключаємося до сервера...'), 4000)
    const t2 = setTimeout(() => setLoadingMsg('Сервер прогрівається, зачекайте...'), 10000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [loading])

  function validatePhone(value: string): boolean {
    const normalized = normalizePhone(value)
    if (!PHONE_REGEX.test(normalized)) {
      setPhoneError('Формат: +380XXXXXXXXX (10 цифр після +380)')
      return false
    }
    setPhoneError('')
    return true
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    const normalized = normalizePhone(phone)
    if (!validatePhone(phone)) return

    setLoading(true)
    try {
      const session = pinMode ? await signInRemembered(pin) : await signIn(normalized, password)
      if (!pinMode && remember) await desktopBridge()!.auth!.remember!(pin)
      if (isDesktopRuntime()) {
        try { localStorage.setItem('forsage:last-login-phone', normalized) } catch { /* optional hint */ }
      }
      setPassword('')
      setPin('')
      if (onUnlocked) onUnlocked()
      else navigate(homePathForRole(session.user.app_metadata?.role as string | undefined))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Помилка входу')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-10 w-full max-w-sm">

        <div className="text-center mb-8">
          <div className="text-4xl mb-3">⚡</div>
          <h1 className="text-2xl font-bold text-gray-900">Форсаж CRM</h1>
          <p className="text-gray-400 text-sm mt-1">Вхід до системи</p>
          {pinMode && <p className="mt-2 text-sm">{savedName} · {pinRequired ? 'Вхід за PIN на цьому ПК' : 'Збережений вхід на цьому ПК'}</p>}
          {!online && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
              Режим офлайн — вхід за збереженими даними цього ПК
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Номер телефону
            </label>
            <input
              type="tel"
              autoComplete="username"
              readOnly={pinMode || Boolean(onUnlocked)}
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value)
                if (phoneError) validatePhone(e.target.value)
              }}
              onBlur={() => validatePhone(phone)}
              placeholder="+380671234567"
              required
              autoFocus
              className={`w-full border rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors ${
                phoneError ? 'border-red-400 bg-red-50' : 'border-gray-300'
              }`}
            />
            {phoneError && (
              <p className="text-red-500 text-xs mt-1">{phoneError}</p>
            )}
          </div>

          {!pinMode && <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Пароль
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full border border-gray-300 rounded-lg pl-4 pr-12 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 focus:outline-none"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>}

          {canRemember && !pinMode && <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            Запам’ятати вхід на 24 години на цьому ПК
          </label>}
          {(pinMode || remember) && pinRequired && <div>
            <label className="block text-sm mb-1">{pinMode ? 'PIN-код' : 'Ваш PIN (або задайте 4 цифри, якщо PIN ще немає)'}</label>
            <input type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4}" maxLength={4} required
              value={pin} onChange={e => setPin(e.target.value.replace(/\D/g,''))}
              className="w-full border rounded-lg px-4 py-3 text-lg" />
            <p className="text-xs text-gray-500 mt-2">Після 5 хвилин бездіяльності — блокування. Після 5 помилок PIN потрібен пароль.</p>
          </div>}
          {(pinMode || remember) && !pinRequired && <p className="text-xs text-amber-700">PIN вимкнено в налаштуваннях цього ПК. Збережений вхід діє до 24 годин.</p>}
          {(pinMode || onUnlocked) && <button type="button" className="text-sm underline" onClick={() => {
            void signOut().then(() => {
              useAuthStore.getState().setSession(null)
              setPinMode(false); setPin(''); setError('')
              navigate('/login', { replace: true })
            })
              .catch(e => setError(String(e)))
          }}>Увійти з паролем / змінити користувача</button>}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-accent hover:bg-accent-dark text-black font-semibold py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? loadingMsg : 'Увійти'}
          </button>
        </form>

      </div>
    </div>
  )
}



