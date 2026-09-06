import { useState, useEffect, useRef } from 'react'
import { request } from '@/lib/api'

const POLL_INTERVAL = 30_000

/**
 * Скільки чекати відповіді, перш ніж вважати сервер недоступним.
 *
 * Було 5 секунд — і цього вистачало, поки бекенд не переїхав на Render, який
 * присипляє безкоштовний сервіс. Після ночі він прокидається 20-25 секунд
 * (заміряно 06.09.2026: перший запит 21,4 с). Каса вважала це «інтернету
 * немає» і не синхронізувалася весь день.
 */
const TIMEOUT_MS = 30_000

export function useServerStatus() {
  const [online, setOnline] = useState(() => navigator.onLine)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    let checking = false

    async function check() {
      // Перевірка тепер довша за паузу між перевірками — не запускаємо другу
      // поверх першої, інакше на сплячому сервері вони почнуть накладатися.
      if (checking) return
      if (!navigator.onLine) {
        if (!cancelled) setOnline(false)
        if (!cancelled) timerRef.current = setTimeout(check, POLL_INTERVAL)
        return
      }
      checking = true
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
        await request('/api/v1/health', { signal: controller.signal, silent: true } as any)
        clearTimeout(timeout)
        if (!cancelled) setOnline(true)
      } catch {
        if (!cancelled) setOnline(false)
      } finally {
        checking = false
      }
      if (!cancelled) {
        timerRef.current = setTimeout(check, POLL_INTERVAL)
      }
    }

    const handleOffline = () => setOnline(false)
    const handleOnline = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      check()
    }
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    check()
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  return online
}
