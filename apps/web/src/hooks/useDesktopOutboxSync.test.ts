import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_REFERENCE_REPAIR_INTERVAL_MS,
  desktopReferencesNeedRepair,
  hasMeaningfulDesktopSyncChanges,
} from './useDesktopOutboxSync'

const syncApiSource = readFileSync(new URL('../lib/desktopSyncApi.ts', import.meta.url), 'utf8')
const offlineDbSource = readFileSync(new URL('../lib/offlineDB.ts', import.meta.url), 'utf8')
const syncHookSource = readFileSync(new URL('./useDesktopOutboxSync.ts', import.meta.url), 'utf8')
const browserSyncHookSource = readFileSync(new URL('./useOfflineSync.ts', import.meta.url), 'utf8')
const localSyncAgentSource = readFileSync(new URL('../components/LocalSyncAgent.tsx', import.meta.url), 'utf8')
const posPageSource = readFileSync(new URL('../features/pos/POSPage.tsx', import.meta.url), 'utf8')

describe('desktop sync UI notifications', () => {
  it('does not reload visible lists for unchanged periodic snapshots', () => {
    expect(hasMeaningfulDesktopSyncChanges({
      pushed: 0,
      pulled: {
        counts: {
          staff: 3,
          categories: 120,
          brands: 30,
          commission_rules: 2,
          settings: 1,
        },
      },
    })).toBe(false)
  })

  it('notifies after an outbox push or a real delta pull', () => {
    expect(hasMeaningfulDesktopSyncChanges({
      pushed: 1,
      pulled: { counts: {} },
    })).toBe(true)
    expect(hasMeaningfulDesktopSyncChanges({
      pushed: 0,
      pulled: { counts: { products: 1 } },
    })).toBe(true)
    expect(hasMeaningfulDesktopSyncChanges({
      pushed: 0,
      pulled: { counts: { deleted_categories: 1 } },
    })).toBe(true)
  })

  it('confirms local outbox before advancing the pull cursor', () => {
    const syncNowSource = syncApiSource.slice(
      syncApiSource.indexOf('async function executeDesktopSyncCycle'),
    )
    const push = syncNowSource.indexOf('await pushDesktopOutbox')
    const pull = syncNowSource.indexOf('await pullDesktopChanges')

    expect(push).toBeGreaterThanOrEqual(0)
    expect(pull).toBeGreaterThan(push)
  })

  it('shares one complete push-then-pull cycle across overlapping timers', () => {
    expect(syncApiSource).toContain('let syncCycleInProgress: Promise<DesktopSyncCycleResult> | null = null')
    expect(syncApiSource).toContain('if (syncCycleInProgress) return syncCycleInProgress')
    expect(syncApiSource).toContain('const cycle = executeDesktopSyncCycle(options)')
    expect(syncApiSource).toContain('if (pushInProgress) return pushInProgress')
  })

  it('never starts a full reference refresh in a visible working window', () => {
    const pullSource = syncApiSource.slice(
      syncApiSource.indexOf('export async function pullDesktopChanges'),
      syncApiSource.indexOf('export async function getDesktopSyncStatus'),
    )
    expect(pullSource).toContain("if (options.includeReferences === true)")
    expect(pullSource).not.toContain('referencesAreStale')
  })
  it('does not rebuild the browser catalogue on a periodic timer', () => {
    expect(browserSyncHookSource).toContain("if (!cursor) params.set('include_references', 'true')")
    expect(browserSyncHookSource).not.toContain('REFERENCE_REFRESH_INTERVAL_MS')
    expect(browserSyncHookSource).not.toContain('Date.now() - localState.last_reference_sync_at')
  })

  it('checks the reset generation before browser and desktop mutations', () => {
    expect(browserSyncHookSource).toContain("params.set('reset_generation', String(state.reset_generation))")
    expect(browserSyncHookSource).toContain("'X-Sync-Reset-Generation': String(syncState.reset_generation)")
    expect(browserSyncHookSource).toContain('if (response.data.reset_required === true)')
    expect(syncApiSource).toContain('reset_generation: state.reset_generation')
    expect(syncApiSource).toContain("params.set('reset_generation', String(state.reset_generation))")
    expect(syncApiSource).toContain('if (response.data.reset_required === true)')
    expect(offlineDbSource).toContain('export async function resetOfflineSyncData')
  })

  it('pulls the generation before sending pending browser receipts', () => {
    const syncNowSource = browserSyncHookSource.slice(browserSyncHookSource.indexOf('const syncNow'))
    const pull = syncNowSource.indexOf('await pullChanges(options.forceSnapshot)')
    const push = syncNowSource.indexOf('await pushPendingSales()')
    expect(pull).toBeGreaterThanOrEqual(0)
    expect(push).toBeGreaterThan(pull)
  })

  it('keeps the last usable browser snapshot until its replacement is complete', () => {
    const applySource = offlineDbSource.slice(offlineDbSource.indexOf('export async function applySyncChanges'))
    expect(applySource).not.toContain("tx.objectStore('products').clear()")
    expect(applySource).not.toContain("tx.objectStore('customers').clear()")
    expect(applySource).toContain("readStoreKeys('products')")
    expect(applySource).toContain('staleKeys(snapshotKeys.products')
    expect(applySource).toContain('changes.deleted_category_ids')
    expect(applySource).toContain('changes.deleted_brand_ids')
  })



  it('pushes outbox during user activity and never discards an already downloaded large pull', () => {
    const syncNowSource = syncHookSource.slice(syncHookSource.indexOf('const syncNow'))
    expect(syncNowSource).toContain('syncDesktopNow({ includeReferences, canStartPull })')
    expect(syncNowSource).not.toContain('if (!canStartPull())')
    expect(syncApiSource).toContain('if (options.canStartPull && !options.canStartPull()) return null')
    expect(syncApiSource).not.toContain('MAX_FOREGROUND_PULL_ROWS')
    expect(syncApiSource).not.toContain('canApplyPull(response.data)')
    expect(syncApiSource).toContain('const OUTBOX_HEARTBEAT_MS = 10_000')
    expect(syncApiSource).toContain('pushDesktopOutbox(DESKTOP_PUSH_BATCH_SIZE).catch')
  })

  it('keeps synchronization in the background without a floating panel', () => {
    expect(localSyncAgentSource).toContain('useOfflineSync(serverOnline)')
    expect(localSyncAgentSource).toContain('useDesktopOutboxSync(serverOnline)')
    expect(localSyncAgentSource).toContain('return null')
    expect(localSyncAgentSource).not.toContain('SyncStatusIndicator')
    expect(posPageSource).not.toContain('Синхронізація офлайн-продажів')
    expect(posPageSource).not.toContain('Є несинхронізовані офлайн-чеки')
    expect(posPageSource).toContain('ОФЛАЙН — продажі зберігаються локально')
  })

  it('repairs historical reference drift only after the repair interval', () => {
    const now = Date.UTC(2026, 7, 1, 12)
    expect(desktopReferencesNeedRepair(null, now)).toBe(true)
    expect(desktopReferencesNeedRepair('not-a-date', now)).toBe(true)
    expect(desktopReferencesNeedRepair(
      new Date(now - DESKTOP_REFERENCE_REPAIR_INTERVAL_MS + 1).toISOString(),
      now,
    )).toBe(false)
    expect(desktopReferencesNeedRepair(
      new Date(now - DESKTOP_REFERENCE_REPAIR_INTERVAL_MS).toISOString(),
      now,
    )).toBe(true)
    expect(syncHookSource).toContain('referenceRepairIsIdle')
    expect(syncHookSource).toContain('desktopReferencesNeedRepair(state.last_reference_sync_at)')
    expect(syncApiSource).toContain("desktopBridge()?.sync.listPending(1)")
  })

  it('isolates browser receipt queues and history by signed-in user', () => {
    expect(offlineDbSource).toContain("store.createIndex('by_scope', 'scope_key'")
    expect(offlineDbSource).toContain("index('by_scope').getAll(scopeKey)")
    expect(offlineDbSource).toContain("index('by_scope').count(scopeKey)")
    expect(browserSyncHookSource).toContain('getPendingSales(scopeKey)')
    expect(browserSyncHookSource).toContain('completePendingSaleSync(sale.offline_id, response.data, scopeKey)')
    expect(posPageSource).toContain('scope_key:      scopeKey')
  })

  it('bypasses the foreground gate when the server requires a generation reset', () => {
    expect(syncApiSource).toContain('? { ...pullOptions, canStartPull: undefined }')
  })
})
