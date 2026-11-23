import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalNetworkCoordinator } from '../src/lan/localNetwork'
import { LocalStaffRepository } from '../src/repositories/staffRepository'
import { PIN_FAILURES_BEFORE_PAUSE, PIN_PAUSE_MS, PIN_ROLES, PinRoster, type PinRosterUser } from '../src/security/pinRoster'

// 23.11.2026, рішення власника: «ввів свій PIN і зайшов — навіщо когось вибирати»; за PIN — касири й менеджери,
// власник — лише паролем; логін (номер телефону) у програмі не потрібен — досить пароля, і на ПК менеджера теж.
const day = Date.parse('2026-11-23T08:00:00Z')
function rosterSetup() {
  let stored: string | null = null, now = day
  const person = (id: string, role: string, pin: string | null): PinRosterUser =>
    ({ id, tenant_id: 't', role, phone: '+38067' + id.length, full_name: id, password_hash: 'h-' + id, pin_hash: pin, is_active: 1, deleted_at: null })
  const users = new Map([
    ['anna', person('anna', 'cashier', '1111')], ['petro', person('petro', 'manager', '2222')],
    ['owner', person('owner', 'owner', '3333')], ['admin', person('admin', 'admin', '4444')], ['ira', person('ira', 'cashier', '5555')],
  ])
  const roster = new PinRoster({ read: () => stored, write: value => { stored = value }, encrypt: text => 'enc:' + text,
    decrypt: text => text.slice(4), user: id => users.get(id) ?? null, now: () => now })
  // Імітація звірки PIN: «хеш» тут — сам PIN.
  const owners = (pin: string) => (ids: string[]) => ids.filter(id => users.get(id)?.pin_hash === pin)
  return { roster, users, owners, setNow: (value: number) => { now = value } }
}

describe('PIN without choosing a person', () => {
  it('the PIN itself says who signs in, among those who used a password today', () => {
    const { roster, users, owners } = rosterSetup()
    roster.rememberPasswordLogin(users.get('anna')!)
    roster.rememberPasswordLogin(users.get('petro')!)
    expect(roster.loginByPin(owners('1111')).id).toBe('anna')
    expect(roster.loginByPin(owners('2222')).id).toBe('petro')
    // Іра сьогодні паролем не входила — її PIN ще не діє; відповідь та сама, що й на невірний PIN.
    expect(() => roster.loginByPin(owners('5555'))).toThrow('PIN не підійшов')
    expect(() => roster.loginByPin(owners('9999'))).toThrow('PIN не підійшов')
  })

  it('the owner and the administrator sign in with a password only', () => {
    const { roster, users, owners } = rosterSetup()
    expect(PIN_ROLES).toEqual(['cashier', 'manager'])
    roster.rememberPasswordLogin(users.get('owner')!)
    roster.rememberPasswordLogin(users.get('admin')!)
    roster.rememberPasswordLogin(users.get('anna')!)
    expect(roster.list().map(item => item.id)).toEqual(['anna'])
    expect(() => roster.loginByPin(owners('3333'))).toThrow('PIN не підійшов')
    expect(() => roster.loginByPin(owners('4444'))).toThrow('PIN не підійшов')
  })

  it('never guesses between two people with the same PIN', () => {
    const { roster, users, owners } = rosterSetup()
    users.get('ira')!.pin_hash = '1111'
    roster.rememberPasswordLogin(users.get('anna')!)
    roster.rememberPasswordLogin(users.get('ira')!)
    expect(() => roster.loginByPin(owners('1111'))).toThrow('Цей PIN мають кілька працівників')
  })

  it('pauses PIN sign-in after several wrong PINs in a row; the password still works', () => {
    const { roster, users, owners, setNow } = rosterSetup()
    roster.rememberPasswordLogin(users.get('anna')!)
    for (let attempt = 1; attempt < PIN_FAILURES_BEFORE_PAUSE; attempt++) expect(() => roster.loginByPin(owners('0000'))).toThrow('PIN не підійшов')
    expect(() => roster.loginByPin(owners('0000'))).toThrow('Забагато невірних PIN')
    // Під час паузи не діє й правильний PIN.
    expect(() => roster.loginByPin(owners('1111'))).toThrow('Забагато невірних PIN')
    setNow(day + PIN_PAUSE_MS + 1)
    expect(roster.loginByPin(owners('1111')).id).toBe('anna')
    // Вдалий вхід скидає лічильник.
    for (let attempt = 1; attempt < PIN_FAILURES_BEFORE_PAUSE; attempt++) expect(() => roster.loginByPin(owners('0000'))).toThrow('PIN не підійшов')
    expect(roster.loginByPin(owners('1111')).id).toBe('anna')
  })
})

describe('PINs and passwords in the staff database', () => {
  let root = '', db: LocalDatabase, staff: LocalStaffRepository
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-pin-')); db = new LocalDatabase(root); staff = new LocalStaffRepository(db) })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const add = (name: string, phone: string, password: string, role = 'cashier') => {
    const id = randomUUID()
    staff.saveServerUser({ id, phone, full_name: name, role }, password)
    return id
  }

  it('finds the owner of a PIN without touching the attempt counters', () => {
    const anna = add('Анна', '+380671110001', 'password-anna'), ira = add('Іра', '+380671110002', 'password-ira')
    staff.setPin(anna, '1111'); staff.setPin(ira, '2222')
    expect(staff.pinOwners('1111')).toEqual([anna])
    expect(staff.pinOwners('2222', undefined, [anna])).toEqual([])
    expect(staff.pinOwners('12')).toEqual([])
    // Багато невдалих пошуків не блокують звичайну перевірку PIN цього працівника.
    for (let attempt = 0; attempt < 20; attempt++) expect(staff.pinOwners('9999')).toEqual([])
    expect(staff.verifyPin(anna, '1111')).toEqual({ valid: true })
  })

  it('every person has a PIN of their own', () => {
    const anna = add('Анна', '+380671110001', 'password-anna'), ira = add('Іра', '+380671110002', 'password-ira')
    staff.setPin(anna, '1111')
    expect(() => staff.setPin(ira, '1111')).toThrow('Такий PIN уже має інший працівник')
    // Свій власний PIN можна зберегти повторно.
    expect(staff.setPin(anna, '1111')).toEqual({ success: true })
    expect(staff.setPin(ira, '2222')).toEqual({ success: true })
  })

  it('a password alone signs in; two people with one password are not guessed', () => {
    const anna = add('Анна', '+380671110001', 'password-anna')
    add('Іра', '+380671110002', 'same-password'); add('Олег', '+380671110003', 'same-password', 'manager')
    expect(staff.loginWithPasswordOnly('password-anna').id).toBe(anna)
    expect(() => staff.loginWithPasswordOnly('same-password')).toThrow('Цей пароль мають кілька працівників')
    expect(() => staff.loginWithPasswordOnly('nobody-has-it')).toThrow('Невірний пароль')
  })
})

describe('the manager PC signs in with a password only', () => {
  const peers: LocalNetworkCoordinator[] = [], roots: string[] = []
  afterEach(async () => {
    for (const peer of peers.splice(0)) await peer.stop()
    for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
  })
  const root = () => { const directory = mkdtempSync(path.join(tmpdir(), 'forsage-pin-lan-')); roots.push(directory); return directory }
  const freePort = () => new Promise<number>(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)) }) })

  it('sends no phone number; the main PC says who it is', async () => {
    const actor = { id: 'manager-1', tenant_id: '00000000-0000-0000-0000-000000000001', role: 'manager' }
    const seen: Array<[string, string]> = []
    const hub = new LocalNetworkCoordinator(root(), async () => null, () => actor, {
      discovery: false,
      authenticate: async (phone, password) => {
        seen.push([phone, password])
        if (password !== 'manager-password') throw new Error('Невірний пароль')
        return { ...actor, full_name: 'Менеджер', phone: '+380671234567', is_active: true }
      },
    })
    peers.push(hub)
    const hubPort = await freePort(), code = 'a'.repeat(32)
    await hub.update({ mode: 'hub', port: hubPort, accessKey: code, allowedUserId: actor.id })
    const client = new LocalNetworkCoordinator(root(), async () => null, () => null, { discovery: false }); peers.push(client)
    await client.pairRemote({ hubAddress: `127.0.0.1:${hubPort}`, accessKey: code })
    expect(await client.loginRemote('', 'manager-password')).toEqual({ ...actor, full_name: 'Менеджер', phone: '+380671234567', is_active: true })
    expect(seen).toEqual([['', 'manager-password']])
    await expect(client.loginRemote('', 'wrong')).rejects.toThrow('Невірний пароль')
    await expect(client.loginRemote('', '')).rejects.toThrow('Введіть пароль')
  })
})

describe('wiring of the sign-in', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')
  const main = read('../src/main.ts')

  it('the PIN handler takes only the PIN', () => {
    expect(main).toContain("handleDesktopIpc('desktop:auth:login-pin', async (_event, pin: string) => {")
    expect(main).toContain('getPinRoster().loginByPin(candidateIds => requireLocalStaff().pinOwners(pin, DEFAULT_TENANT_ID, candidateIds))')
    expect(read('../src/desktopApi.ts')).toContain("loginByPin: (pin: string) => ipcRenderer.invoke('desktop:auth:login-pin', pin)")
  })

  it('password-only sign-in works on the manager PC through the main PC, and offline from its own cache', () => {
    const handler = main.slice(main.indexOf("handleDesktopIpc('desktop:auth:login-password'"), main.indexOf("handleDesktopIpc('desktop:web-rpc:execute'"))
    expect(handler).not.toContain('з номером телефону')
    expect(handler).toContain("remote: () => network.loginRemote('', password)")
    expect(handler).toContain('cacheLanIdentity(requireLocalDatabase(), profile, profile.phone, password, network.getStatus().accessKey)')
    expect(handler).toContain('local: localLogin')
    expect(main).toContain('if (!phone) return requireLocalStaff().loginWithPasswordOnly(password)')
  })

  it('the sign-in screens ask nobody to choose a person or type a phone number in the program', () => {
    const pin = read('../../web/src/pages/PinQuickLogin.tsx')
    expect(pin).toContain('signInByPin(value)')
    expect(pin).not.toContain('roster.map')
    const login = read('../../web/src/pages/LoginPage.tsx')
    expect(login).not.toContain('Увійти з номером телефону')
    // Поле номера з'являється лише як вихід із «однаковий пароль у двох працівників».
    expect(login).toContain("if (passwordOnly && /кілька працівників/.test(message)) setWithPhone(true)")
    const auth = read('../../web/src/lib/auth.ts')
    expect(auth).not.toContain('На ПК менеджера вхід — з номером телефону')
  })
})
