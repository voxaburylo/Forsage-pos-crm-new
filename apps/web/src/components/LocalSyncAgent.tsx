import { useEffect } from 'react'
import { useOfflineSync } from '@/hooks/useOfflineSync'
import { useDesktopOutboxSync } from '@/hooks/useDesktopOutboxSync'
import { useShiftBackups } from '@/hooks/useShiftBackups'
import { useTillLink } from '@/hooks/useTillLink'
import { useServerStatus } from '@/hooks/useServerStatus'

/**
 * Один фоновий синхронізатор для всієї програми.
 * Дані в IndexedDB оновлюються навіть коли касова сторінка не відкрита.
 */
export function LocalSyncAgent() {
  const serverOnline = useServerStatus()
  useOfflineSync(serverOnline)
  useShiftBackups(serverOnline)
  // Один зв'язок із сервером на команди й запити вебу: рідке опитування, часте — лише поки у вебі працюють.
  useTillLink(serverOnline)
  const { lastError } = useDesktopOutboxSync(serverOnline)
  // Keep a diagnostic trace, not a popup. The queue itself remains in SQLite.
  useEffect(() => {
    if (lastError) console.warn('[desktop-sync] ' + lastError)
  }, [lastError])
  return null
}
