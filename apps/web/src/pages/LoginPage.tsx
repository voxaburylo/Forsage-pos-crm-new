import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff } from 'lucide-react'
import { signIn, restoreDesktopSession, signOut } from '@/lib/auth'
import { useAuthStore } from '@/stores/authStore'
import { homePathForRole } from '@/components/ProtectedRoute'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { confirmDesktopUnlocked } from '@/lib/desktopAccessState'
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
  const [showPassword, setShowPassword] = useState(false)
  const [phoneError, setPhoneError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(isDesktopRuntime() && !onUnlocked)
  const submitting = useRef(false)
  useEffect(() => {
    if (!isDesktopRuntime()) {
      fetch(`${API_BASE_URL}/api/v1/health`, { signal: AbortSignal.timeout(30000) }).catch(() => {})
      return
    }
    try { setPhone(localStorage.getItem('forsage:last-login-phone') ?? '') } catch { /* optional hint */ }
    if (onUnlocked) {
      const currentPhone = useAuthStore.getState().session?.user.phone
      if (currentPhone) setPhone(currentPhone)
      return
    }
    let active = true
    void restoreDesktopSession().then(session => {
      if (!active) return
      if (session) {
        confirmDesktopUnlocked()
        navigate(homePathForRole(session.user.app_metadata?.role as string | undefined), { replace: true })
      }
    }).catch(() => {
      if (active) setError('Не вдалося перевірити збережений вхід. Введіть логін і пароль.')
    }).finally(() => { if (active) setRestoring(false) })
    return () => { active = false }
  }, [navigate, onUnlocked])

  function validatePhone(value: string): boolean {
    if (!PHONE_REGEX.test(normalizePhone(value))) {
      setPhoneError('Введіть номер телефону у форматі +380XXXXXXXXX')
      return false
    }
    setPhoneError('')
    return true
  }
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting.current || restoring) return
    setError('')
    if (!validatePhone(phone)) return
    submitting.current = true
    setLoading(true)
    try {
      const normalized = normalizePhone(phone)
      const session = await signIn(normalized, password)
      if (isDesktopRuntime()) {
        try { localStorage.setItem('forsage:last-login-phone', normalized) } catch { /* optional hint */ }
        confirmDesktopUnlocked()
      }
      setPassword('')
      if (onUnlocked) onUnlocked()
      else navigate(homePathForRole(session.user.app_metadata?.role as string | undefined), { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*?\[LOCAL_AUTH_[A-Z_]+\]\s*/, '') : 'Помилка входу')
    } finally {
      submitting.current = false
      setLoading(false)
    }
  }
  async function leave() {
    if (submitting.current) return
    submitting.current = true;setLoading(true)
    try { await signOut();navigate('/login', { replace: true }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Не вдалося вийти') }
    finally { submitting.current=false;setLoading(false) }
  }
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-10 w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">⚡</div>
          <h1 className="text-2xl font-bold text-gray-900">Форсаж CRM</h1>
          <p className="text-gray-400 text-sm mt-1">Вхід до системи</p>
        </div>
        {restoring ? <p className="text-center text-sm text-gray-500" role="status">Відновлюємо вхід…</p> :
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="login-phone" className="block text-sm font-medium text-gray-700 mb-1">Логін (номер телефону)</label>
            <input id="login-phone" type="tel" autoComplete="username" readOnly={Boolean(onUnlocked)} disabled={loading}
              value={phone} onChange={e=>{setPhone(e.target.value);if(phoneError)validatePhone(e.target.value)}}
              onBlur={()=>validatePhone(phone)} placeholder="+380671234567" required autoFocus
              className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            {phoneError && <p className="text-red-500 text-xs mt-1">{phoneError}</p>}
          </div>
          <div>
            <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 mb-1">Пароль</label>
            <div className="relative">
              <input id="login-password" type={showPassword?'text':'password'} autoComplete="current-password"
                disabled={loading} value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" required
                className="w-full border border-gray-300 rounded-lg pl-4 pr-12 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              <button type="button" disabled={loading} onClick={()=>setShowPassword(!showPassword)} tabIndex={-1}
                aria-label={showPassword?'Приховати пароль':'Показати пароль'} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                {showPassword?<EyeOff size={18}/>:<Eye size={18}/>}
              </button>
            </div>
          </div>
          {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>}
          <button type="submit" disabled={loading} className="w-full bg-accent hover:bg-accent-dark text-black font-semibold py-3 rounded-lg disabled:opacity-50">
            {loading?'Входимо…':'Увійти'}
          </button>
          {onUnlocked && <button type="button" disabled={loading} onClick={()=>{void leave()}} className="w-full text-sm text-gray-500">Вийти</button>}
        </form>}
      </div>
    </div>
  )
}



