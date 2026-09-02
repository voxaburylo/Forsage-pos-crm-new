import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { syncHealthLabel, syncSeverity } from '@/hooks/useDesktopSyncHealth'
import type { DesktopSyncStatus } from '@/lib/desktopBridge'

const layoutSource = readFileSync(new URL('./Layout.tsx', import.meta.url), 'utf8')
const posPageSource = readFileSync(new URL('../features/pos/POSPage.tsx', import.meta.url), 'utf8')
const localSyncAgentSource = readFileSync(new URL('./LocalSyncAgent.tsx', import.meta.url), 'utf8')

function status(overrides: Partial<DesktopSyncStatus> = {}): DesktopSyncStatus {
  return {
    pending: 0,
    retrying: 0,
    stuck: 0,
    total: 0,
    oldest_created_at: null,
    last_error: null,
    pull_last_success_at: null,
    pull_last_error: null,
    ...overrides,
  }
}

describe('desktop sync health severity', () => {
  it('stays silent while everything is synchronized', () => {
    expect(syncSeverity(null)).toBe('clean')
    expect(syncSeverity(status())).toBe('clean')
  })

  it('warns about work still waiting in the queue', () => {
    expect(syncSeverity(status({ pending: 2, total: 2 }))).toBe('pending')
    expect(syncSeverity(status({ retrying: 1, total: 1 }))).toBe('pending')
  })

  it('treats exhausted operations as the loudest state', () => {
    // Застряглі мають перебивати «чекає відправки»: вони самі вже не поїдуть.
    expect(syncSeverity(status({ pending: 9, stuck: 1, total: 10 }))).toBe('stuck')
  })

  it('labels the queue in words a cashier can act on', () => {
    expect(syncHealthLabel(status({ stuck: 3, pending: 5, total: 8 }))).toBe('3 не відправлено')
    expect(syncHealthLabel(status({ pending: 2, retrying: 1, total: 3 }))).toBe('3 чекає відправки')
  })
})

describe('sync health indicator wiring', () => {
  it('is mounted both in the shared header and in the cash register', () => {
    // Каса має власну темну шапку і НЕ використовує Layout, тому індикатор
    // потрібно тримати в обох місцях — інакше касир його не побачить.
    expect(layoutSource).toContain('<SyncHealthIndicator')
    expect(posPageSource).toContain('<SyncHealthIndicator theme="dark" />')
  })

  it('no longer throws the desktop sync error away', () => {
    expect(localSyncAgentSource).toContain('const { lastError } = useDesktopOutboxSync(serverOnline)')
    expect(localSyncAgentSource).toContain('useDesktopSyncErrorNotice(lastError)')
  })
})
