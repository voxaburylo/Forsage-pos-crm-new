import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('safe staff directory sync', () => {
  let root = ''
  let db: LocalDatabase
  let sync: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-staff-directory-'))
    db = new LocalDatabase(root)
    sync = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-staff-directory-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('adds a web-created employee without overwriting protected local payroll fields', () => {
    const employeeId = 'staff-directory-user'
    sync.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: '2026-08-15T08:00:00.000Z',
      staff_snapshot_included: true,
      staff: [{
        id: employeeId,
        full_name: 'Старе імʼя',
        phone: '+380501111111',
        role: 'manager',
        is_active: true,
        base_rate: 250000,
        rate_period: 'month',
        created_at: '2026-08-15T07:00:00.000Z',
        updated_at: '2026-08-15T07:00:00.000Z',
      }],
    })

    sync.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: '2026-08-15T08:01:00.000Z',
      staff_directory_snapshot_included: true,
      staff_directory: [{
        id: employeeId,
        full_name: 'Новий працівник',
        phone: '+380502222222',
        role: 'cashier',
        is_active: true,
        created_at: '2026-08-15T07:00:00.000Z',
        updated_at: '2026-08-15T08:01:00.000Z',
      }],
    })

    const row = db.prepare(`
      SELECT full_name, phone, role, base_rate, rate_period
      FROM staff_users WHERE id = ? AND tenant_id = ?
    `).get(employeeId, DEFAULT_TENANT_ID) as Record<string, unknown>

    expect(row).toEqual({
      full_name: 'Новий працівник',
      phone: '+380502222222',
      role: 'cashier',
      base_rate: 250000,
      rate_period: 'month',
    })
  })
})
