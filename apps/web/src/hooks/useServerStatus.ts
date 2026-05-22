import { useState, useEffect, useRef } from 'react'
import { request } from '@/lib/api'

const POLL_INTERVAL = 30_000   // 30 сек
const TIMEOUT_MS    = 5_000    // 5 сек — вважаємо офлайн

export function useServerStatus() {
  const [online, setOnline] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    async function check() {
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

    check()
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return online
}
