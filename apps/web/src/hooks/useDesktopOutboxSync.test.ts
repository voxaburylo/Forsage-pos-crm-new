import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hasMeaningfulDesktopSyncChanges } from './useDesktopOutboxSync'

const syncApiSource = readFileSync(new URL('../lib/desktopSyncApi.ts', import.meta.url), 'utf8')

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
})
