import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalNetworkCoordinator, type LanSession } from '../src/lan/localNetwork'
import { PhoneLanAccess } from '../src/lan/phoneAccess'
// Код телефона — з вебу; підвантажуємо під час тесту (vitest), щоб перевірка типів десктопу не тягнула файли вебу.
const webPhoneLan = 'phoneLan'
const { secureCall } = await import(/* @vite-ignore */ `../../web/src/lib/phoneLan/${webPhoneLan}.ts`) as {
  secureCall: (pairing: { hosts: string[]; port: number; key: string }, payload: Record<string, unknown>) => Promise<unknown>
}

// 27.11.2026: телефон (код застосунку з WebCrypto) говорить із справжнім мережевим сервером головного ПК — по HTTP,
// через посередника, який записує все, що йде мережею. Код ПК менеджера при цьому працює як і раніше.
const manager: LanSession = { id: 'manager', tenant_id: 'shop', role: 'manager' }
const managerCode = '1234567890abcdef1234567890abcdef'
const roots: string[] = [], peers: LocalNetworkCoordinator[] = [], servers: Server[] = []
function root() { const p = mkdtempSync(path.join(tmpdir(), 'forsage-phone-hub-')); roots.push(p); return p }
async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return (server.address() as { port: number }).port }
async function freePort() { const s = createServer(), p = await listen(s); await new Promise<void>(resolve => s.close(() => resolve())); return p }
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.stop()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})

it('a phone pairs with its own code, logs in with a password and works; the manager code is untouched; nothing secret on the wire', async () => {
  const hubPort = await freePort(), dataRoot = root(), wire: string[] = []
  const executed: Array<{ userId: string; channel: string }> = []
  const phone = new PhoneLanAccess(dataRoot, {
    authenticate: (_phone, password) => password === 'pass-s-123' ? { id: 'cashier', tenant_id: 'shop', role: 'cashier', is_active: true, full_name: 'Каса s' } : null,
    resolveSession: userId => userId === 'cashier' ? { id: 'cashier', tenant_id: 'shop', role: 'cashier' } : userId === 'manager' ? manager : null,
    execute: async (userId, channel) => { executed.push({ userId, channel }); return { items: ['фільтр s'] } },
  })
  const hub = new LocalNetworkCoordinator(dataRoot, async () => ({ managerCall: true }), userId => userId === manager.id ? manager : null, {
    discovery: false, phone,
    authenticate: async () => ({ ...manager, full_name: 'Менеджер', phone: '', is_active: true }),
  })
  peers.push(hub); await hub.update({ mode: 'hub', port: hubPort, accessKey: managerCode, allowedUserId: manager.id })
  const proxy = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8'); wire.push(body)
    const reply = await fetch(`http://127.0.0.1:${hubPort}${req.url}`, { method: req.method, headers: { 'Content-Type': 'application/json' }, ...(req.method === 'POST' ? { body } : {}) })
    const output = await reply.text(); wire.push(output); res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(output)
  })
  servers.push(proxy); const proxyPort = await listen(proxy)

  // Телефони ще не ввімкнено — код телефона не відкриває головний ПК.
  const guess = { hosts: ['127.0.0.1'], port: proxyPort, key: 'ffffffffffffffffffffffffffffffff' }
  await expect(secureCall(guess, { action: 'phone-probe' })).rejects.toThrow('не прийняв код телефона')

  // Перша адреса (інший адаптер ПК) не відповідає — телефон сам пробує наступну.
  const pairing = { hosts: ['127.0.0.2', '127.0.0.1'], port: proxyPort, key: phone.enable() }
  await expect(secureCall(pairing, { action: 'phone-probe' })).resolves.toEqual({ service: 'forsage-lan', phone: 1 })
  await expect(secureCall(pairing, { action: 'phone-login', phone: '', password: 'wrong-s' })).rejects.toThrow('заблокований')
  const login = await secureCall(pairing, { action: 'phone-login', phone: '', password: 'pass-s-123' }) as { token: string; user: { id: string } }
  expect(login.user.id).toBe('cashier')
  await expect(secureCall(pairing, { action: 'phone-rpc', token: login.token, channel: 'desktop:catalog:list', args: [] })).resolves.toEqual({ items: ['фільтр s'] })
  expect(executed).toEqual([{ userId: 'cashier', channel: 'desktop:catalog:list' }])
  // Автоматичний сеанс (виданий через сервер, поки був інтернет) працює без пароля і переживає перезапуск програми каси.
  const auto = phone.issueFor({ id: 'cashier', tenant_id: 'shop', role: 'cashier' }, { full_name: 'Каса s' }, { mode: 'hub', addresses: ['192.168.1.5'], port: hubPort })
  expect(auto).toMatchObject({ hosts: ['192.168.1.5'], port: hubPort, key: pairing.key, user: { id: 'cashier', full_name: 'Каса s' } })
  const restarted = new PhoneLanAccess(dataRoot, { authenticate: () => null, resolveSession: () => ({ id: 'cashier', tenant_id: 'shop', role: 'cashier' }), execute: async () => 'after restart s' })
  await expect(restarted.dispatch({ action: 'phone-rpc', token: auto.token, channel: 'desktop:catalog:list', args: [] })).resolves.toBe('after restart s')
  // Дії ПК менеджера телефону недоступні (інший код — інші дії).
  await expect(secureCall(pairing, { action: 'rpc', user_id: 'manager', tenant_id: 'shop', channel: 'desktop:orders:list', args: [] })).rejects.toThrow('не знайдено')

  // ПК менеджера своїм кодом працює як раніше.
  const client = new LocalNetworkCoordinator(root(), async () => null, () => null, { discovery: false }); peers.push(client)
  await client.pairRemote({ hubAddress: `127.0.0.1:${proxyPort}`, accessKey: managerCode })
  expect(await client.invoke('desktop:orders:list', [], manager)).toEqual({ managerCall: true })

  for (const secret of [pairing.key, managerCode, 'pass-s-123', login.token, 'desktop:catalog:list', 'фільтр s']) expect(wire.join('\n')).not.toContain(secret)
})
