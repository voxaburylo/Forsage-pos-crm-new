import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, existsSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syncSeverity, useDesktopSyncHealth } from '@/hooks/useDesktopSyncHealth'
import { useAuthStore } from '@/stores/authStore'
import { ServerCopyStatusCard } from '@/features/settings/ServerCopyStatusCard'
import type { DesktopSyncStatus } from '@/lib/desktopBridge'
vi.mock('@/hooks/useDesktopSyncHealth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/useDesktopSyncHealth')>()
  return { ...actual, useDesktopSyncHealth: vi.fn() }
})
vi.mock('@/stores/authStore', async importOriginal => {
  const actual = await importOriginal<typeof import('@/stores/authStore')>()
  return { ...actual, useAuthStore: Object.assign((selector: any) => selector(actual.useAuthStore.getState()), actual.useAuthStore) }
})
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const layoutSource = source('./Layout.tsx')
const posPageSource = source('../features/pos/POSPage.tsx')
const localSyncAgentSource = source('./LocalSyncAgent.tsx')
const settingsSource = source('../features/settings/SettingsPage.tsx')
const cardSource = source('../features/settings/ServerCopyStatusCard.tsx')
function status(overrides: Partial<DesktopSyncStatus> = {}): DesktopSyncStatus {
  return { pending: 0, retrying: 0, stuck: 0, total: 0, oldest_created_at: null,
    last_error: null, pull_last_success_at: null, pull_last_error: null, ...overrides }
}
beforeEach(() => {
  vi.mocked(useDesktopSyncHealth).mockReset()
  vi.mocked(useDesktopSyncHealth).mockReturnValue({ status: status(), severity: 'clean', refresh: vi.fn() })
  useAuthStore.setState({ session: { user: { app_metadata: { role: 'owner' } } } as any })
})
describe('server copy diagnostics remain available without interrupting work', () => {
  it('retains accurate status for explicit diagnostics', () => {
    expect(syncSeverity(null)).toBe('clean')
    expect(syncSeverity(status())).toBe('clean')
    expect(syncSeverity(status({ pending: 2 }))).toBe('pending')
    expect(syncSeverity(status({ retrying: 2 }))).toBe('pending')
    expect(syncSeverity(status({ pending: 9, stuck: 4 }))).toBe('stuck')
  })
  it('removes the queue badge from POS and all other working pages', () => {
    expect(layoutSource).not.toContain('SyncHealthIndicator')
    expect(posPageSource).not.toContain('SyncHealthIndicator')
    expect(existsSync(new URL('./SyncHealthIndicator.tsx', import.meta.url))).toBe(false)
  })
  it('keeps diagnostics in settings, opened only by the user', () => {
    expect(settingsSource).toContain('<ServerCopyStatusCard />')
    expect(cardSource).toContain('useState(false)')
    expect(cardSource).toContain('onClick={() => setOpen(true)}')
    expect(cardSource).toContain('{open && <SyncHealthModal')
  })
  for (const counts of [{ pending: 4 }, { stuck: 4, last_error: 'Test error' }]) {
    it('does not open a dialog, flash counts or poll while settings diagnostics are closed: ' + JSON.stringify(counts), () => {
      vi.mocked(useDesktopSyncHealth).mockReturnValue({ status: status(counts), severity: syncSeverity(status(counts)), refresh: vi.fn() })
      const html = renderToStaticMarkup(React.createElement(ServerCopyStatusCard))
      expect(html).toContain('Переглянути стан')
      expect(html).not.toMatch(/не відправлено|чекає відправки|Test error|role="dialog"|animate-pulse/)
      expect(useDesktopSyncHealth).toHaveBeenCalledWith(false)
    })
  }
  it('does not expose diagnostics or poll for a cashier', () => {
    useAuthStore.setState({ session: { user: { app_metadata: { role: 'cashier' } } } as any })
    expect(renderToStaticMarkup(React.createElement(ServerCopyStatusCard))).toBe('')
    expect(useDesktopSyncHealth).toHaveBeenCalledWith(false)
  })
  it('keeps the background worker and backups running without popup notices', () => {
    expect(localSyncAgentSource).toContain('useOfflineSync(serverOnline)')
    expect(localSyncAgentSource).toContain('useShiftBackups(serverOnline)')
    expect(localSyncAgentSource).toContain('useDesktopOutboxSync(serverOnline)')
    expect(localSyncAgentSource).not.toMatch(/toast|ERROR_TOAST_AFTER_MS|useDesktopSyncErrorNotice/)
    expect(localSyncAgentSource).toContain("console.warn('[desktop-sync] ' + lastError)")
  })
})
