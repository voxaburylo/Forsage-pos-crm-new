import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalStaffRepository } from '../src/repositories/staffRepository'

describe('LocalStaffRepository server-first credentials', () => {
  let root = ''
  let db: LocalDatabase
  let repository: LocalStaffRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-staff-'))
    db = new LocalDatabase(root)
    repository = new LocalStaffRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-staff-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stores the server id and local hash without creating an outbox operation', () => {
    repository.saveServerUser({
      id: 'server-user-1',
      phone: '+380671112233',
      full_name: 'Касир',
      role: 'cashier',
      is_active: true,
      created_at: '2026-07-22T10:00:00.000Z',
      updated_at: '2026-07-22T10:00:00.000Z',
    }, 'secret-1')

    expect(repository.loginWithPassword('+380671112233', 'secret-1').id).toBe('server-user-1')
    const outbox = db.prepare(
      "SELECT count(*) AS count FROM sync_outbox WHERE aggregate_type = 'staff_user'",
    ).get() as { count: number }
    expect(outbox.count).toBe(0)
  })

  it('retires an old provisional UUID and removes its unsupported outbox entry', () => {
    const provisionalId = 'legacy-local-user'
    const timestamp = '2026-07-22T09:00:00.000Z'
    db.prepare(
      'INSERT INTO staff_users (id, tenant_id, full_name, role, phone, is_active, dirty_at, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
    ).run(
      provisionalId,
      DEFAULT_TENANT_ID,
      'Старий локальний запис',
      'cashier',
      '+380672223344',
      timestamp,
      timestamp,
      timestamp,
    )
    db.prepare(
      'INSERT INTO sync_outbox (operation_id, tenant_id, device_id, aggregate_type, aggregate_id, ' +
      'operation_type, payload_json, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
    ).run('legacy-operation', DEFAULT_TENANT_ID, db.deviceId, 'staff_user', provisionalId,
      'staff_user.created', JSON.stringify({ id: provisionalId }), 'pending', timestamp)

    repository.saveServerUser({
      id: 'server-user-2',
      phone: '+380672223344',
      full_name: 'Серверний запис',
      role: 'cashier',
    }, 'new-pass')

    expect(repository.listUsers().map((user) => user.id)).toContain('server-user-2')
    expect(repository.listUsers().map((user) => user.id)).not.toContain(provisionalId)
    const outbox = db.prepare(
      "SELECT count(*) AS count FROM sync_outbox WHERE aggregate_type = 'staff_user'",
    ).get() as { count: number }
    expect(outbox.count).toBe(0)
  })

  it('updates the local hash only after a server password reset', () => {
    repository.saveServerUser({
      id: 'server-user-3',
      phone: '+380673334455',
      full_name: 'Адміністратор',
      role: 'admin',
    }, 'old-pass')
    repository.saveServerPassword('server-user-3', 'new-pass')

    expect(() => repository.loginWithPassword('+380673334455', 'old-pass')).toThrow()
    expect(repository.loginWithPassword('+380673334455', 'new-pass').id).toBe('server-user-3')
  })
})
