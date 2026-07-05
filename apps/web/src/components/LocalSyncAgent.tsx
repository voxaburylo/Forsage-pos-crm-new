import { useOfflineSync } from '@/hooks/useOfflineSync'
import { useServerStatus } from '@/hooks/useServerStatus'

/**
 * Один фоновий синхронізатор для всієї програми.
 * Дані в IndexedDB оновлюються навіть коли касова сторінка не відкрита.
 */
export function LocalSyncAgent() {
  const serverOnline = useServerStatus()
  useOfflineSync(serverOnline)
  return null
}
