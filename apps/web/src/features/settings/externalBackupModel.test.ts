import { describe, expect, it } from 'vitest'
import type { ExternalBackupStatus } from '@/lib/desktopBridge'
import { externalBackupNotice, externalBackupReminder } from './externalBackupModel'

const now = Date.parse('2026-11-20T12:00:00Z')
const status = (patch: Partial<ExternalBackupStatus>): ExternalBackupStatus => ({ folder: 'E:\\', available: true, same_drive: false,
  last_copy_at: '2026-11-20T08:00:00Z', last_error: null, stale: false, running: false, copies: [], ...patch })

describe('flash drive backup notices', () => {
  it('stays quiet on the dashboard when no drive was chosen or the copy is fresh', () => {
    expect(externalBackupReminder(status({ folder: null }), now)).toBeNull()
    expect(externalBackupReminder(status({}), now)).toBeNull()
    expect(externalBackupNotice(status({}), now).tone).toBe('ok')
    expect(externalBackupNotice(status({ folder: null }), now).tone).toBe('info')
  })
  it('asks to insert the drive once the last copy is older than two days', () => {
    const text = externalBackupReminder(status({ available: false, stale: true, last_copy_at: '2026-11-17T08:00:00Z' }), now)
    expect(text).toContain('Вставте флешку')
    expect(text).toContain('3 дн. тому')
  })
  it('shows a failed write', () => {
    expect(externalBackupReminder(status({ stale: true, last_error: 'Копія на носії не збігається' }), now)).toContain('не збігається')
  })
})
