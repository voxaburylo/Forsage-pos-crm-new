import { api } from '@/lib/api'
import {
  desktopBridge,
  isDesktopRuntime,
  type DesktopSyncPullResult,
  type DesktopSyncPushResult,
  type DesktopSyncStatus,
  type DesktopSyncStuckOperation,
} from '@/lib/desktopBridge'

const DESKTOP_PUSH_BATCH_SIZE = 10

interface PushResponse {
  data: {
    results: DesktopSyncPushResult[]
    reset_required?: boolean
    reset_generation?: number
    reset_at?: string | null
  }
}

type DesktopPushResult = {
  pushed: number
  failed: number
  pending: number
  resetRequired: boolean
}
let pushExecutionActive = false
let pushInProgress: Promise<DesktopPushResult> | null = null
type DesktopSyncCycleResult = {
  pushed: number
  failed: number
  pending: number
  pulled: DesktopSyncPullResult | null
  resetRequired: boolean
}
let syncCycleInProgress: Promise<DesktopSyncCycleResult> | null = null

async function executeDesktopOutboxPush(limit = 50): Promise<DesktopPushResult> {
  if (!isDesktopRuntime() || pushExecutionActive) return { pushed: 0, failed: 0, pending: 0, resetRequired: false }
  const desktop = desktopBridge()
  if (!desktop) return { pushed: 0, failed: 0, pending: 0, resetRequired: false }

  pushExecutionActive = true
  try {
    const [operations, state] = await Promise.all([
      desktop.sync.listPending(limit),
      desktop.sync.getPullState(),
    ])
    if (operations.length === 0) return { pushed: 0, failed: 0, pending: 0, resetRequired: false }
    try {
      const response = await api.post<PushResponse>('/api/v1/sync/push', {
        reset_generation: state.reset_generation,
        operations,
      }, undefined, {
        silent: true,
        timeoutMs: 60_000,
      })
      const results = response.data.results ?? []
      await desktop.sync.applyPushResults(results)
      return {
        pushed: results.filter((result) => result.status === 'synced').length,
        failed: results.filter((result) => result.status === 'failed').length,
        pending: Math.max(0, operations.length - results.length),
        resetRequired: response.data.reset_required === true || results.some((result) => result.status === 'discarded'),
      }
    } catch (error) {
      await desktop.sync.markBatchFailed(
        operations.map((operation) => operation.sequence),
        error instanceof Error ? error.message : 'Помилка синхронізації desktop outbox',
      )
      throw error
    }
  } finally {
    pushExecutionActive = false
  }
}

export function pushDesktopOutbox(limit = 50): Promise<DesktopPushResult> {
  if (pushInProgress) return pushInProgress
  const operation = executeDesktopOutboxPush(limit)
  pushInProgress = operation
  const release = () => {
    if (pushInProgress === operation) pushInProgress = null
  }
  operation.then(release, release)
  return operation
}

export async function getDesktopSyncStatus(): Promise<DesktopSyncStatus | null> {
  if (!isDesktopRuntime()) return null
  const desktop = desktopBridge()
  if (!desktop?.sync.status) return null
  try {
    return await desktop.sync.status()
  } catch {
    return null
  }
}

export async function listDesktopStuckOperations(limit = 100): Promise<DesktopSyncStuckOperation[]> {
  const local = desktopBridge()?.sync.listStuck
  if (!isDesktopRuntime() || !local) return []
  try {
    return await local(limit)
  } catch {
    return []
  }
}
async function executeDesktopSyncCycle(): Promise<DesktopSyncCycleResult> {
  // Локальна база — єдине джерело. Це вигрузка документів, не відновлення
  // або повна перевірена резервна копія. Серверні дані назад не застосовуємо.
  const pushed = await pushDesktopOutbox(DESKTOP_PUSH_BATCH_SIZE)
  return { ...pushed, pulled: null }
}

export function syncDesktopNow(): Promise<DesktopSyncCycleResult> {
  // Timers, visibility events and explicit UI requests may fire together.
  // Every caller joins the same document upload, so one call never overtakes
  // another and the local working database is never read back from the server.
  if (syncCycleInProgress) return syncCycleInProgress

  const cycle = executeDesktopSyncCycle()
  syncCycleInProgress = cycle
  const release = () => {
    if (syncCycleInProgress === cycle) syncCycleInProgress = null
  }
  cycle.then(release, release)
  return cycle
}
