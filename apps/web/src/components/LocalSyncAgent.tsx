import { useEffect, useRef } from 'react'
import { useOfflineSync } from '@/hooks/useOfflineSync'
import { useDesktopOutboxSync } from '@/hooks/useDesktopOutboxSync'
import { useServerStatus } from '@/hooks/useServerStatus'
import { toast } from '@/components/ui/Toast'

/** Скільки часу поспіль синхронізація має падати, перш ніж турбувати касира. */
const ERROR_TOAST_AFTER_MS = 5 * 60_000

/**
 * Один фоновий синхронізатор для всієї програми.
 * Дані в IndexedDB оновлюються навіть коли касова сторінка не відкрита.
 */
export function LocalSyncAgent() {
  const serverOnline = useServerStatus()
  useOfflineSync(serverOnline)
  const { lastError } = useDesktopOutboxSync(serverOnline)
  useDesktopSyncErrorNotice(lastError)
  return null
}

/**
 * Раніше `lastError` просто викидався — синхронізація могла падати тижнями, і
 * ніхто про це не дізнавався. Тепер помилка спливає, але НЕ на кожному тику:
 * інакше під час звичайного обриву звʼязку каса потоне в тостах. Постійний
 * стан показує індикатор у шапці, а тост потрібен лише щоб його помітили.
 */
function useDesktopSyncErrorNotice(lastError: string | null) {
  const failingSinceRef = useRef<number | null>(null)
  const notifiedRef = useRef(false)

  useEffect(() => {
    if (!lastError) {
      failingSinceRef.current = null
      notifiedRef.current = false
      return
    }
    if (failingSinceRef.current === null) {
      failingSinceRef.current = Date.now()
      return
    }
    if (notifiedRef.current) return
    if (Date.now() - failingSinceRef.current < ERROR_TOAST_AFTER_MS) return
    notifiedRef.current = true
    toast.error('Дані не відправляються на сервер. Натисніть індикатор у шапці, щоб переглянути')
  }, [lastError])
}
