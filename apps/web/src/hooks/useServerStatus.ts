import { useState, useEffect, useRef } from 'react'
import { request } from '@/lib/api'

const POLL_INTERVAL = 30_000   // 30 сек
const TIMEOUT_MS    = 5_000    // 5 сек — вважаємо офлайн

export function useServerStatus() {
  const [online, setOnline] = useState(() => navigator.onLine)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    async function check() {
      if (!navigator.onLine) {
        if (!cancelled) setOnline(false)
        if (!cancelled) timerRef.current = setTimeout(check, POLL_INTERVAL)
        return
      }
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
        await request('/api/v1/health', { signal: controller.signal, silent: true } as any)
        clearTimeout(timeout)
        if (!cancelled) setOnline(true)
      } catch {
        if (!cancelled) setOnline(false)
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
