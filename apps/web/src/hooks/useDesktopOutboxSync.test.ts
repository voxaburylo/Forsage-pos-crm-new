import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hasMeaningfulDesktopSyncChanges } from './useDesktopOutboxSync'

const syncApiSource = readFileSync(new URL('../lib/desktopSyncApi.ts', import.meta.url), 'utf8')
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
      syncApiSource.indexOf('export async function syncDesktopNow'),
    )
    const push = syncNowSource.indexOf('await pushDesktopOutbox')
    const pull = syncNowSource.indexOf('await pullDesktopChanges')

    expect(push).toBeGreaterThanOrEqual(0)
    expect(pull).toBeGreaterThan(push)
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
})
