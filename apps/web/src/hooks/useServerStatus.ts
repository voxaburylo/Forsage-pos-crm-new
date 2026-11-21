import { useState, useEffect, useRef } from 'react'
import { request } from '@/lib/api'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { canUseCloudBackground } from '@/lib/lanFirstRun'

const POLL_INTERVAL = 30_000
/** Поки зв'язку немає — перевіряємо частіше, щоб черга пішла одразу після повернення інтернету. */
const OFFLINE_POLL_INTERVAL = 10_000
/** Одна невдала перевірка — ще не «офлайн»: повторюємо швидко, щоб не смикати синхронізацію. */
const CONFIRM_FAILURE_DELAY = 3_000

/**
 * Скільки чекати відповіді, перш ніж вважати сервер недоступним.
 *
 * Було 5 секунд — і цього вистачало, поки бекенд не переїхав на Render, який
 * присипляє безкоштовний сервіс. Після ночі він прокидається 20-25 секунд
 * (заміряно 06.09.2026: перший запит 21,4 с). Каса вважала це «інтернету
 * немає» і не синхронізувалася весь день.
 *
 * 21.11.2026: Render виведено, сервер на Vercel прокидається за 1–3 с. 30 с очікування означали,
 * що обрив помічався лише за хвилину. Тепер 12 с, а «офлайн» — лише після двох невдач поспіль.
 */
const TIMEOUT_MS = 12_000

/** Пауза до наступної перевірки зв'язку. */
export function serverStatusDelay(online: boolean, failures: number): number {
  if (online && failures === 1) return CONFIRM_FAILURE_DELAY
  return online ? POLL_INTERVAL : OFFLINE_POLL_INTERVAL
}

export function useServerStatus() {
  // Before the device mode is known, a desktop must not start cloud jobs.
  // Native catalog/order actions do not depend on this cloud-health indicator.
  const [online, setOnline] = useState(() => !isDesktopRuntime() && navigator.onLine)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    let checking = false
    let activeController: AbortController | null = null
    let failures = 0
    let lastOnline = false

    async function check() {
      // Перевірка тепер довша за паузу між перевірками — не запускаємо другу
      // поверх першої, інакше на сплячому сервері вони почнуть накладатися.
      if (checking || cancelled) return
      checking = true
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        if (!await canUseCloudBackground() || !navigator.onLine) {
          failures = 2
          lastOnline = false
          if (!cancelled) setOnline(false)
          return
        }
        if (cancelled) return
        const controller = new AbortController()
        activeController = controller
        timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
        await request('/api/v1/health', { signal: controller.signal, silent: true } as any)
        failures = 0
        lastOnline = true
        if (!cancelled) setOnline(true)
      } catch {
        failures += 1
        if (failures >= 2 || !lastOnline) { lastOnline = false; if (!cancelled) setOnline(false) }
      } finally {
        if (timeout) clearTimeout(timeout)
        activeController = null
        checking = false
        if (!cancelled) timerRef.current = setTimeout(check, serverStatusDelay(lastOnline, failures))
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
      activeController?.abort()
      if (timerRef.current) clearTimeout(timerRef.current)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  return online
}
