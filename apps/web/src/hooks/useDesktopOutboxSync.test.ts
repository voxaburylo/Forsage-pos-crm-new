import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hasMeaningfulDesktopSyncChanges } from './useDesktopOutboxSync'

const syncApiSource = readFileSync(new URL('../lib/desktopSyncApi.ts', import.meta.url), 'utf8')
const offlineDbSource = readFileSync(new URL('../lib/offlineDB.ts', import.meta.url), 'utf8')
const syncHookSource = readFileSync(new URL('./useDesktopOutboxSync.ts', import.meta.url), 'utf8')
const browserSyncHookSource = readFileSync(new URL('./useOfflineSync.ts', import.meta.url), 'utf8')
const localSyncAgentSource = readFileSync(new URL('../components/LocalSyncAgent.tsx', import.meta.url), 'utf8')
const posPageSource = readFileSync(new URL('../features/pos/POSPage.tsx', import.meta.url), 'utf8')

describe('локальна каса відправляє резервну копію, але не забирає стан із сервера', () => {
  it('повідомляє лише про відправлені локальні зміни', () => {
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
    expect(hasMeaningfulDesktopSyncChanges({
      pushed: 1,
      pulled: { counts: {} },
    })).toBe(true)
    expect(hasMeaningfulDesktopSyncChanges({
      pushed: 0,
      pulled: { counts: { products: 1 } },
    })).toBe(false)
  })

  it('у звичайному циклі надсилає outbox і не викликає pull', () => {
    const syncNowSource = syncApiSource.slice(
      syncApiSource.indexOf('async function executeDesktopSyncCycle'),
    )
    const push = syncNowSource.indexOf('await pushDesktopOutbox')
    const pull = syncNowSource.indexOf('await pullDesktopChanges')

    expect(push).toBeGreaterThanOrEqual(0)
    expect(pull).toBe(-1)
    expect(syncNowSource).toContain('return { ...pushed, pulled: null }')
  })

  it('ділить один фоновий upload між одночасними таймерами', () => {
    expect(syncApiSource).toContain('let syncCycleInProgress: Promise<DesktopSyncCycleResult> | null = null')
    expect(syncApiSource).toContain('if (syncCycleInProgress) return syncCycleInProgress')
    expect(syncApiSource).toContain('const cycle = executeDesktopSyncCycle()')
    expect(syncApiSource).toContain('if (pushInProgress) return pushInProgress')
  })

  it('does not rebuild the browser catalogue on a periodic timer', () => {
    expect(browserSyncHookSource).toContain("if (!cursor) params.set('include_references', 'true')")
    expect(browserSyncHookSource).not.toContain('REFERENCE_REFRESH_INTERVAL_MS')
    expect(browserSyncHookSource).not.toContain('Date.now() - localState.last_reference_sync_at')
  })

  it('checks the reset generation for browser cache reads and desktop backup upload', () => {
    expect(browserSyncHookSource).toContain("params.set('reset_generation', String(state.reset_generation))")
    expect(browserSyncHookSource).not.toContain("'X-Sync-Reset-Generation': String(syncState.reset_generation)")
    expect(browserSyncHookSource).toContain('if (response.data.reset_required === true)')
    expect(syncApiSource).toContain('reset_generation: state.reset_generation')
    expect(syncApiSource).toContain('resetRequired: response.data.reset_required === true')
    expect(syncApiSource).not.toContain('await desktop.sync.applyPullChanges')
    expect(offlineDbSource).toContain('export async function resetOfflineSyncData')
  })

  it('web cache only reads a server snapshot and never sends browser receipts', () => {
    const syncNowSource = browserSyncHookSource.slice(browserSyncHookSource.indexOf('const syncNow'))
    const pull = syncNowSource.indexOf('await pullChanges(options.forceSnapshot)')
    const push = syncNowSource.indexOf('await pushPendingSales()')
    expect(pull).toBeGreaterThanOrEqual(0)
    expect(push).toBe(-1)
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



  it('does not use reference repair or server pull in the desktop hook', () => {
    const syncNowSource = syncHookSource.slice(syncHookSource.indexOf('const syncNow'))
    expect(syncNowSource).toContain('syncDesktopNow()')
    expect(syncNowSource).not.toContain('includeReferences')
    expect(syncHookSource).not.toContain('desktopReferencesNeedRepair')
    expect(syncHookSource).not.toContain('referenceRepairIsIdle')
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

  it('keeps old browser receipt history isolated, without sending it to the server', () => {
    expect(offlineDbSource).toContain("store.createIndex('by_scope', 'scope_key'")
    expect(offlineDbSource).toContain("index('by_scope').getAll(scopeKey)")
    expect(offlineDbSource).toContain("index('by_scope').count(scopeKey)")
    expect(browserSyncHookSource).not.toContain('getPendingSales(scopeKey)')
    expect(browserSyncHookSource).not.toContain('completePendingSaleSync(sale.offline_id, response.data, scopeKey)')
    expect(posPageSource).toContain('scope_key:      scopeKey')
  })

  it('has no server pull or bootstrap path left in the desktop client', () => {
    expect(syncApiSource).not.toContain('export async function pullDesktopChanges')
    expect(syncApiSource).not.toContain('applyPullChanges(')
    expect(syncApiSource).not.toContain('/api/v1/sync/bootstrap')
  })
})
