import { describe, expect, it } from 'vitest'
import { PinRoster, type PinRosterUser } from '../src/security/pinRoster'

// Етап 9, рішення власника 22.11.2026 «быстрый вход по пин»: раз на день пароль, далі — 4 цифри.
const day = Date.parse('2026-11-22T08:00:00Z')
function setup() {
  let stored: string | null = null, now = day
  const users = new Map<string, PinRosterUser>([
    ['anna', { id: 'anna', tenant_id: 't', role: 'cashier', phone: '+380671111111', full_name: 'Анна', password_hash: 'h1', pin_hash: 'p1', is_active: 1, deleted_at: null }],
    ['petro', { id: 'petro', tenant_id: 't', role: 'manager', phone: '+380672222222', full_name: 'Петро', password_hash: 'h2', pin_hash: null, is_active: 1, deleted_at: null }],
  ])
  const roster = new PinRoster({
    read: () => stored, write: value => { stored = value },
    encrypt: text => 'enc:' + text, decrypt: text => text.slice(4),
    user: id => users.get(id) ?? null, now: () => now,
  })
  return { roster, users, setNow: (value: number) => { now = value }, stored: () => stored }
}
const ok = () => ({ valid: true }), bad = () => ({ valid: false })

describe('PIN quick login roster', () => {
  it('lists only people who signed in with a password today and have a PIN', () => {
    const { roster, users } = setup()
    expect(roster.list()).toEqual([])
    roster.rememberPasswordLogin(users.get('anna')!)
    roster.rememberPasswordLogin(users.get('petro')!)
    expect(roster.list()).toEqual([{ id: 'anna', full_name: 'Анна', role: 'cashier' }])
    expect(roster.login('anna', 't', ok).id).toBe('anna')
    expect(() => roster.login('petro', 't', ok)).toThrow('PIN-код не налаштовано')
  })
  it('stored roster is encrypted and keeps no PIN or password', () => {
    const { roster, users, stored } = setup()
    roster.rememberPasswordLogin(users.get('anna')!)
    expect(stored()).toMatch(/^enc:/)
    expect(stored()).not.toContain('h1')
    expect(stored()).not.toContain('p1')
  })
  it('needs the password again the next day, after a password change or dismissal', () => {
    const { roster, users, setNow } = setup()
    roster.rememberPasswordLogin(users.get('anna')!)
    setNow(day + 24 * 60 * 60 * 1000)
    expect(roster.list()).toEqual([])
    expect(() => roster.login('anna', 't', ok)).toThrow('Увійдіть паролем')
    setNow(day)
    roster.rememberPasswordLogin(users.get('anna')!)
    users.set('anna', { ...users.get('anna')!, password_hash: 'changed' })
    expect(roster.list()).toEqual([])
    users.set('anna', { ...users.get('anna')!, password_hash: 'h1', is_active: 0 })
    expect(roster.list()).toEqual([])
  })
  it('three wrong PINs in a row send the person back to the password', () => {
    const { roster, users } = setup()
    roster.rememberPasswordLogin(users.get('anna')!)
    expect(() => roster.login('anna', 't', bad)).toThrow('Невірний PIN-код')
    expect(() => roster.login('anna', 't', bad)).toThrow('Невірний PIN-код')
    expect(() => roster.login('anna', 't', bad)).toThrow('Увійдіть паролем')
    expect(roster.list()).toEqual([])
    expect(() => roster.login('anna', 't', ok)).toThrow('Увійдіть паролем')
    roster.rememberPasswordLogin(users.get('anna')!)
    expect(roster.login('anna', 't', ok).id).toBe('anna')
  })
  it('keeps the employee server session for the day so sync works after a PIN switch', () => {
    const { roster, users } = setup()
    roster.rememberPasswordLogin(users.get('anna')!)
    roster.saveServerSession('anna', 't', { access_token: 'a.b.c', refresh_token: 'r1' })
    expect(roster.serverSession('anna', 't')).toEqual({ access_token: 'a.b.c', refresh_token: 'r1' })
    expect(roster.serverSession('petro', 't')).toBeNull()
  })
})
