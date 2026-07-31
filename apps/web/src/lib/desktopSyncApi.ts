import { api } from '@/lib/api'
import {
  desktopBridge,
  isDesktopRuntime,
  type DesktopBootstrapSnapshot,
  type DesktopSyncPullChanges,
  type DesktopSyncPullResult,
  type DesktopSyncPushResult,
  type DesktopSyncStatus,
} from '@/lib/desktopBridge'

const DESKTOP_PUSH_BATCH_SIZE = 10

interface DesktopSyncOptions {
  includeReferences?: boolean
  // Поки касир сканує/натискає кнопки, відповідь можна не застосовувати:
  // курсор не рухається, і та сама дельта безпечно прийде наступним циклом.
  canApplyPull?: (changes?: DesktopSyncPullChanges) => boolean
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
      try {
        const snapshotResponse = await api.get<{ data: DesktopBootstrapSnapshot }>('/api/v1/sync/bootstrap', {
          silent: true,
          timeoutMs: 180_000,
        })
        if (options.canApplyPull && !options.canApplyPull()) return null
        const imported = await desktop.bootstrap.importSnapshot(snapshotResponse.data)
        return {
          applied_at: imported.imported_at,
          cursor: snapshotResponse.data.exported_at,
          counts: imported.counts,
        }
      } catch (bootstrapError) {
        if ((bootstrapError as { status?: number })?.status !== 403) throw bootstrapError
        // Касир/менеджер/комірник не мають доступу до повного bootstrap із
        // зарплатами й закупочними даними. Для порожньої БД використовуємо
        // звичайний role-filtered pull із повними безпечними довідниками.
        const initialResponse = await api.get<PullResponse>('/api/v1/sync/changes?include_references=true', {
          silent: true,
          timeoutMs: 180_000,
        })
        if (options.canApplyPull && !options.canApplyPull(initialResponse.data)) return null
        return desktop.sync.applyPullChanges(initialResponse.data)
      }
    }

    const params = new URLSearchParams()
    params.set('since', state.cursor)
    // Повні довідники містять десятки тисяч товарів і штрихкодів. Їхнє
    // застосування в SQLite блокує головний Electron-процес. Автоматичний агент
    // ніколи не просить такий пакет; прапорець залишено тільки для окремого
    // контрольованого відновлення. Дельти надходять кожні кілька секунд.
    if (options.includeReferences === true) {
      params.set('include_references', 'true')
    }

    const query = params.size > 0 ? `?${params.toString()}` : ''
    const response = await api.get<PullResponse>(`/api/v1/sync/changes${query}`, {
      silent: true,
      timeoutMs: 120_000,
    })
    if (options.canApplyPull && !options.canApplyPull(response.data)) return null
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

export async function syncDesktopNow(options: DesktopSyncOptions = {}): Promise<{
  pushed: number
  failed: number
  pending: number
  pulled: DesktopSyncPullResult | null
}> {
  // Локальна база є джерелом робочих змін. Спочатку підтверджуємо outbox,
  // а вже потім рухаємо pull-cursor: інакше втрачена HTTP-відповідь могла
  // залишити dirty-рядок локально та назавжди перескочити серверний результат.
  const pushed = await pushDesktopOutbox(DESKTOP_PUSH_BATCH_SIZE)
  const pulled = await pullDesktopChanges(options)
  return { ...pushed, pulled }
}
