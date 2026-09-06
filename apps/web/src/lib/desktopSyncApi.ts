import { api } from '@/lib/api'
import {
  desktopBridge,
  isDesktopRuntime,
  type DesktopBootstrapSnapshot,
  type DesktopSyncPullChanges,
  type DesktopSyncPullResult,
  type DesktopSyncPullState,
  type DesktopSyncPushResult,
  type DesktopSyncStatus,
  type DesktopSyncStuckOperation,
} from '@/lib/desktopBridge'

const DESKTOP_PUSH_BATCH_SIZE = 10

interface DesktopSyncOptions {
  /**
   * Залишено для сумісності з ручним аварійним відновленням. Звичайний цикл
   * синхронізації його не використовує: сервер є резервною копією, а не
   * другим джерелом залишків.
   */
  includeReferences?: boolean
  canStartPull?: () => boolean
}

interface PushResponse {
  data: {
    results: DesktopSyncPushResult[]
    reset_required?: boolean
    reset_generation?: number
    reset_at?: string | null
  }
}

interface PullResponse {
  data: DesktopSyncPullChanges
}

type DesktopPushResult = {
  pushed: number
  failed: number
  pending: number
  resetRequired: boolean
}
let pushExecutionActive = false
let pushInProgress: Promise<DesktopPushResult> | null = null
let pullInProgress = false
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

type DesktopRuntimeApi = NonNullable<ReturnType<typeof desktopBridge>>

async function resetDesktopGenerationIfNeeded(
  desktop: DesktopRuntimeApi,
  state: DesktopSyncPullState,
  payload: DesktopBootstrapSnapshot | DesktopSyncPullChanges,
): Promise<void> {
  if (!Number.isSafeInteger(payload.reset_generation)) return
  const generation = Number(payload.reset_generation)
  if (generation === state.reset_generation) return
  const cursor = 'exported_at' in payload ? payload.exported_at : payload.cursor
  await desktop.sync.applyPullChanges({
    tenant_id: payload.tenant_id,
    cursor,
    reset_required: true,
    reset_generation: generation,
    reset_at: payload.reset_at,
  })
}

async function loadInitialDesktopData(
  desktop: DesktopRuntimeApi,
  state: DesktopSyncPullState,
): Promise<DesktopSyncPullResult> {
  try {
    const snapshotResponse = await api.get<{ data: DesktopBootstrapSnapshot }>('/api/v1/sync/bootstrap', {
      silent: true,
      timeoutMs: 180_000,
    })
    await resetDesktopGenerationIfNeeded(desktop, state, snapshotResponse.data)
    const imported = await desktop.bootstrap.importSnapshot(snapshotResponse.data)
    return {
      applied_at: imported.imported_at,
      cursor: snapshotResponse.data.exported_at,
      counts: imported.counts,
    }
  } catch (bootstrapError) {
    if ((bootstrapError as { status?: number })?.status !== 403) throw bootstrapError
    // Restricted roles receive the role-filtered full snapshot.
    const fetchInitial = (generation: number) => api.get<PullResponse>(
      `/api/v1/sync/changes?include_references=true&reset_generation=${generation}`,
      {
        silent: true,
        timeoutMs: 180_000,
      },
    )
    let currentState = state
    let initialResponse = await fetchInitial(currentState.reset_generation)
    if (initialResponse.data.reset_required === true) {
      await desktop.sync.applyPullChanges(initialResponse.data)
      currentState = await desktop.sync.getPullState()
      initialResponse = await fetchInitial(currentState.reset_generation)
      if (initialResponse.data.reset_required === true) {
        throw new Error('DESKTOP_SYNC_RESET_LOOP')
      }
    }
    await resetDesktopGenerationIfNeeded(desktop, currentState, initialResponse.data)
    return desktop.sync.applyPullChanges(initialResponse.data)
  }
}

export async function pullDesktopChanges(options: DesktopSyncOptions = {}): Promise<DesktopSyncPullResult | null> {
  if (!isDesktopRuntime() || pullInProgress) return null
  const desktop = desktopBridge()
  if (!desktop) return null
  if (options.canStartPull && !options.canStartPull()) return null

  pullInProgress = true
  try {
    const state = await desktop.sync.getPullState()
    if (!state.cursor) {
      return loadInitialDesktopData(desktop, state)
    }

    const params = new URLSearchParams()
    params.set('since', state.cursor)
    params.set('reset_generation', String(state.reset_generation))
    // Повний довідник тепер застосовується в Electron порціями. Прапорець
    // залишається явним, доки сервер не почне віддавати звичайні дельти
    // довідників разом із tombstone-ідентифікаторами.
    if (options.includeReferences === true) {
      params.set('include_references', 'true')
    }

    const query = params.size > 0 ? `?${params.toString()}` : ''
    const response = await api.get<PullResponse>(`/api/v1/sync/changes${query}`, {
      silent: true,
      timeoutMs: 120_000,
    })
    if (response.data.reset_required === true) {
      await desktop.sync.applyPullChanges(response.data)
      const resetState = await desktop.sync.getPullState()
      return loadInitialDesktopData(desktop, resetState)
    }
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

export async function listDesktopStuckOperations(limit = 100): Promise<DesktopSyncStuckOperation[]> {
  const local = desktopBridge()?.sync.listStuck
  if (!isDesktopRuntime() || !local) return []
  try {
    return await local(limit)
  } catch {
    return []
  }
}



async function executeDesktopSyncCycle(options: DesktopSyncOptions): Promise<DesktopSyncCycleResult> {
  // Робоча база одна — локальна база каси. Сервер одержує лише її резервну
  // копію через outbox. Автоматичний pull тут заборонено: навіть «акуратний»
  // pull здатен повернути старий серверний залишок і знову створити другу
  // точку правди. Відновлення з серверної копії можливе лише окремою,
  // усвідомленою дією власника, не цим фоновим циклом.
  const pushed = await pushDesktopOutbox(DESKTOP_PUSH_BATCH_SIZE)
  void options
  return { ...pushed, pulled: null }
}

export function syncDesktopNow(options: DesktopSyncOptions = {}): Promise<DesktopSyncCycleResult> {
  // Timers, visibility events and explicit UI requests may fire together.
  // Every caller joins the same backup upload, so one call never overtakes
  // another and the local working database is never read back from the server.
  if (syncCycleInProgress) return syncCycleInProgress

  const cycle = executeDesktopSyncCycle(options)
  syncCycleInProgress = cycle
  const release = () => {
    if (syncCycleInProgress === cycle) syncCycleInProgress = null
  }
  cycle.then(release, release)
  return cycle
}
