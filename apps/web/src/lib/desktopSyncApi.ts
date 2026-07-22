import { api } from '@/lib/api'
import {
  desktopBridge,
  isDesktopRuntime,
  type DesktopBootstrapSnapshot,
  type DesktopSyncPullChanges,
  type DesktopSyncPullResult,
  type DesktopSyncPushResult,
} from '@/lib/desktopBridge'

const REFERENCE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
const DESKTOP_PUSH_BATCH_SIZE = 10

interface DesktopSyncOptions {
  includeReferences?: boolean
}

interface PushResponse {
  data: {
    results: DesktopSyncPushResult[]
  }
}

interface PullResponse {
  data: DesktopSyncPullChanges
}

let pushInProgress = false
let pullInProgress = false

export async function pushDesktopOutbox(limit = 50): Promise<{
  pushed: number
  failed: number
  pending: number
}> {
  if (!isDesktopRuntime() || pushInProgress) return { pushed: 0, failed: 0, pending: 0 }
  const desktop = desktopBridge()
  if (!desktop) return { pushed: 0, failed: 0, pending: 0 }

  const operations = await desktop.sync.listPending(limit)
  if (operations.length === 0) return { pushed: 0, failed: 0, pending: 0 }

  pushInProgress = true
  try {
    const response = await api.post<PushResponse>('/api/v1/sync/push', { operations }, undefined, {
      silent: true,
      timeoutMs: 60_000,
    })
    const results = response.data.results ?? []
    await desktop.sync.applyPushResults(results)
    return {
      pushed: results.filter((result) => result.status === 'synced').length,
      failed: results.filter((result) => result.status === 'failed').length,
      pending: Math.max(0, operations.length - results.length),
    }
  } catch (error) {
    await desktop.sync.markBatchFailed(
      operations.map((operation) => operation.sequence),
      error instanceof Error ? error.message : 'Помилка синхронізації desktop outbox',
    )
    throw error
  } finally {
    pushInProgress = false
  }
}

export async function pullDesktopChanges(options: DesktopSyncOptions = {}): Promise<DesktopSyncPullResult | null> {
  if (!isDesktopRuntime() || pullInProgress) return null
  const desktop = desktopBridge()
  if (!desktop) return null

  pullInProgress = true
  try {
    const state = await desktop.sync.getPullState()
    if (!state.cursor) {
      const snapshotResponse = await api.get<{ data: DesktopBootstrapSnapshot }>('/api/v1/sync/bootstrap', {
        silent: true,
        timeoutMs: 180_000,
      })
      const imported = await desktop.bootstrap.importSnapshot(snapshotResponse.data)
      return {
        applied_at: imported.imported_at,
        cursor: snapshotResponse.data.exported_at,
        counts: imported.counts,
      }
    }

    const params = new URLSearchParams()
    params.set('since', state.cursor)
    const referencesAreDue = !state.last_reference_sync_at
      || Date.now() - new Date(state.last_reference_sync_at).getTime() >= REFERENCE_REFRESH_INTERVAL_MS
    const shouldIncludeReferences = options.includeReferences === true && referencesAreDue
    if (shouldIncludeReferences) params.set('include_references', 'true')

    const query = params.size > 0 ? `?${params.toString()}` : ''
    const response = await api.get<PullResponse>(`/api/v1/sync/changes${query}`, {
      silent: true,
      timeoutMs: 120_000,
    })
    return desktop.sync.applyPullChanges(response.data)
  } catch (error) {
    await desktop.sync.markPullFailed(
      error instanceof Error ? error.message : 'Помилка завантаження змін у desktop базу',
    )
    throw error
  } finally {
    pullInProgress = false
  }
}

export async function syncDesktopNow(options: DesktopSyncOptions = {}): Promise<{
  pushed: number
  failed: number
  pending: number
  pulled: DesktopSyncPullResult | null
}> {
  // Спочатку швидко підтягуємо нові замовлення та інші серверні зміни.
  // Відправляємо локальну чергу невеликими порціями, щоб один великий пакет
  // не блокував IPC та елементи форми на кілька секунд.
  const pulled = await pullDesktopChanges(options)
  const pushed = await pushDesktopOutbox(DESKTOP_PUSH_BATCH_SIZE)
  return { ...pushed, pulled }
}
