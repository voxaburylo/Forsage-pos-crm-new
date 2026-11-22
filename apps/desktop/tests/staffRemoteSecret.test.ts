import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalStaffRepository } from '../src/repositories/staffRepository'
import { hashSecret } from '../src/security/secretHash'

// 22.11.2026: PIN і пароль, змінені у вебі без головного ПК, приходять на касу лише хешем.
let root: string, db: LocalDatabase, staff: LocalStaffRepository, id: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-remote-secret-'))
  db = new LocalDatabase(root)
  staff = new LocalStaffRepository(db)
  id = 'manager-1'
  staff.saveServerUser({ id, phone: '+380671234567', full_name: 'Петро', role: 'manager', is_active: true,
    created_at: '2026-11-16T08:00:00.000Z', updated_at: '2026-11-16T08:00:00.000Z' }, 'old-password-1')
})
afterEach(() => {
  db.close()
  if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-remote-secret-')) rmSync(root, { recursive: true, force: true })
})

it('applies a PIN and a password hash from the web; the new password logs in, the old does not', () => {
  staff.applyRemoteSecret(id, 'pin', hashSecret('4321'))
  expect(staff.verifyPin(id, '4321').valid).toBe(true)
  staff.applyRemoteSecret(id, 'password', hashSecret('new-password-2'))
  expect(staff.loginWithPassword('+380671234567', 'new-password-2').id).toBe(id)
  expect(() => staff.loginWithPassword('+380671234567', 'old-password-1')).toThrow()
})

it('refuses anything that is not a modern hash', () => {
  expect(() => staff.applyRemoteSecret(id, 'pin', '4321')).toThrow('Некоректні дані')
  expect(() => staff.applyRemoteSecret(id, 'pin', 'a'.repeat(128))).toThrow('Некоректні дані')
  expect(() => staff.applyRemoteSecret(id, 'other' as 'pin', hashSecret('1111'))).toThrow('Некоректні дані')
})
