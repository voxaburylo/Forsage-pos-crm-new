import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { signIn } from '@/lib/auth'

const PHONE_REGEX = /^\+?380\d{9}$/

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.startsWith('380')) return `+${digits}`
  if (digits.startsWith('80')) return `+3${digits}`
  if (digits.startsWith('0')) return `+38${digits}`
  return value
}

export default function LoginPage() {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [phoneError, setPhoneError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

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
      await signIn(normalized, password)
      navigate('/dashboard')
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
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Номер телефону
            </label>
            <input
              type="tel"
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Пароль
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
            />
          </div>

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
            {loading ? 'Входимо...' : 'Увійти'}
          </button>
        </form>

      </div>
    </div>
  )
}
