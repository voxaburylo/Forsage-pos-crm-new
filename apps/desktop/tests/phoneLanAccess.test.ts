import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PhoneLanAccess, PHONE_SESSION_MS, changePhoneAccess, phoneAccessStatus } from '../src/lan/phoneAccess'

// 27.11.2026, слово власника: «якщо застосунок в одній мережі з головним ПК по Wi-Fi — щоб можна було працювати без
// інтернету». Код телефона лише відкриває канал; хто працює — визначає пароль; права — як у вебі (execute).
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function hub(options: { now?: () => number } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-phone-')); roots.push(root)
  const staff: Record<string, { id: string; tenant_id: string; role: string; active: boolean; password: string }> = {
    cashier: { id: 'cashier', tenant_id: 't', role: 'cashier', active: true, password: 's-cash' },
    tires: { id: 'tires', tenant_id: 't', role: 'tire_worker', active: true, password: 's-tire' },
  }
  const calls: Array<{ userId: string; channel: string; args: unknown[] }> = []
  const access = new PhoneLanAccess(root, {
    authenticate: (_phone, password) => {
      const found = Object.values(staff).find(person => person.password === password)
      if (!found) throw new Error('Невірний пароль')
      return { id: found.id, tenant_id: found.tenant_id, role: found.role, is_active: true, full_name: 'Олексій s', phone: '' }
    },
    resolveSession: userId => staff[userId]?.active ? { id: userId, tenant_id: staff[userId].tenant_id, role: staff[userId].role } : null,
    execute: async (userId, channel, args) => { calls.push({ userId, channel, args }); return { ok: true, bytes: new Uint8Array([1, 2]).buffer } },
  }, options.now)
  return { root, access, staff, calls }
}

describe('phones over Wi-Fi on the main PC', () => {
  it('is off until the owner turns it on; a new code replaces the old one and logs every phone out', async () => {
    const { access, root } = hub()
    expect(access.key()).toBeNull()
    expect(phoneAccessStatus(access, { mode: 'hub', addresses: ['192.168.1.5'], port: 3210 })).toEqual({ enabled: false, key: null, addresses: ['192.168.1.5'], port: 3210, hub: true })
    changePhoneAccess(access, 'enable')
    const first = access.key()
    expect(first).toMatch(/^[a-f0-9]{32}$/)
    changePhoneAccess(access, 'enable')
    expect(access.key()).toBe(first)
    // Код переживає перезапуск програми.
    expect(new PhoneLanAccess(root, { authenticate: () => null, resolveSession: () => null, execute: async () => null }).key()).toBe(first)
    const { token } = await access.dispatch({ action: 'phone-login', password: 's-cash' }) as { token: string }
    changePhoneAccess(access, 'rotate')
    expect(access.key()).not.toBe(first)
    await expect(access.dispatch({ action: 'phone-rpc', token, channel: 'desktop:pos:checkout', args: [] })).rejects.toThrow('увійдіть знову')
    changePhoneAccess(access, 'disable')
    expect(access.key()).toBeNull()
    expect(() => changePhoneAccess(access, 'something')).toThrow()
  })

  it('a worker logs in with a password and every action runs as that worker, with bytes kept', async () => {
    const { access, calls } = hub()
    access.enable()
    const login = await access.dispatch({ action: 'phone-login', phone: '', password: 's-cash' }) as { token: string; user: { id: string; role: string; full_name: string } }
    expect(login.user).toMatchObject({ id: 'cashier', role: 'cashier', full_name: 'Олексій s' })
    expect(login.token).toMatch(/^[a-f0-9]{64}$/)
    const answer = await access.dispatch({ action: 'phone-rpc', token: login.token, channel: 'desktop:catalog:list', args: [{ query: 'фільтр s', photo: { __forsage_bytes: 'AQI=' } }] })
    expect(calls).toHaveLength(1)
    expect(calls[0].userId).toBe('cashier')
    expect(new Uint8Array((calls[0].args[0] as { photo: ArrayBuffer }).photo)).toEqual(new Uint8Array([1, 2]))
    expect(answer).toEqual({ ok: true, bytes: { __forsage_bytes: 'AQI=' } })
  })

  it('refuses a wrong password, a tyre worker, a forged or expired token and a worker blocked after login', async () => {
    let now = 1_000_000
    const { access, staff, calls } = hub({ now: () => now })
    access.enable()
    await expect(access.dispatch({ action: 'phone-login', password: 'nope-s' })).rejects.toThrow()
    await expect(access.dispatch({ action: 'phone-login', password: 's-tire' })).rejects.toThrow('заблокований')
    await expect(access.dispatch({ action: 'phone-rpc', token: 'a'.repeat(64), channel: 'desktop:catalog:list', args: [] })).rejects.toThrow('закінчився')
    const { token } = await access.dispatch({ action: 'phone-login', password: 's-cash' }) as { token: string }
    staff.cashier.active = false
    await expect(access.dispatch({ action: 'phone-rpc', token, channel: 'desktop:catalog:list', args: [] })).rejects.toThrow('заблокований')
    staff.cashier.active = true
    const again = await access.dispatch({ action: 'phone-login', password: 's-cash' }) as { token: string }
    now += PHONE_SESSION_MS + 1
    await expect(access.dispatch({ action: 'phone-rpc', token: again.token, channel: 'desktop:catalog:list', args: [] })).rejects.toThrow('закінчився')
    expect(calls).toHaveLength(0)
    await expect(access.dispatch({ action: 'something-else' })).rejects.toThrow('не знайдено')
  })

  // 27.11.2026, слово власника: «щоб нічого не сканувати». Сеанс видається тому, кого вже підтвердили сервер і головний ПК.
  it('issues an automatic session only on the main PC and never to a tyre worker; stores only fingerprints', async () => {
    const { access, root } = hub()
    expect(() => access.issueFor({ id: 'cashier', tenant_id: 't', role: 'cashier' }, null, { mode: 'client', addresses: [], port: 3210 })).toThrow('не є головним')
    expect(() => access.issueFor({ id: 'tires', tenant_id: 't', role: 'tire_worker' }, null, { mode: 'hub', addresses: ['192.168.1.5'], port: 3210 })).toThrow('заблокований')
    const issued = access.issueFor({ id: 'cashier', tenant_id: 't', role: 'cashier' }, { full_name: 'Олексій s', phone: '+380' }, { mode: 'hub', addresses: ['192.168.1.5', '10.0.0.2'], port: 3210 })
    expect(issued).toMatchObject({ hosts: ['192.168.1.5', '10.0.0.2'], port: 3210, user: { id: 'cashier', role: 'cashier', full_name: 'Олексій s' } })
    expect(access.key()).toBe(issued.key)
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(path.join(root, 'lan-phone.json'), 'utf8')).not.toContain(issued.token)
    await expect(access.dispatch({ action: 'phone-rpc', token: issued.token, channel: 'desktop:catalog:list', args: [] })).resolves.toMatchObject({ ok: true })
  })

  it('logout ends the phone session', async () => {
    const { access } = hub()
    access.enable()
    const { token } = await access.dispatch({ action: 'phone-login', password: 's-cash' }) as { token: string }
    await access.dispatch({ action: 'phone-logout', token })
    await expect(access.dispatch({ action: 'phone-rpc', token, channel: 'desktop:catalog:list', args: [] })).rejects.toThrow('закінчився')
  })
})
