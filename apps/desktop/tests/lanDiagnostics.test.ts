import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  buildLanDiagnosis, describeLanConnectFailure, firewallQueryScript, firewallRuleScript, parseFirewallState,
  type LanDiagnosisInput,
} from '../src/lan/diagnostics'
import { LocalNetworkCoordinator } from '../src/lan/localNetwork'
import { LanUnavailableError } from '../src/lan/orderQueue'

/**
 * Скарга власника: два ПК в одній мережі тижнями не зʼєднувалися, а програма
 * казала лише «не знайдено». Діагностика має називати саме ту причину, яка є.
 */
const hub: LanDiagnosisInput = {
  mode: 'hub', port: 3210, allowedUserId: 'manager', addresses: ['192.168.0.103'],
  running: true, discovery: true, connected: true, lastError: null,
}
const state = (diagnosis: ReturnType<typeof buildLanDiagnosis>, id: string) => diagnosis.checks.find(check => check.id === id)?.state

const roots: string[] = [], peers: LocalNetworkCoordinator[] = []
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.stop()
  for (const root of roots.splice(0)) if (path.basename(root).startsWith('forsage-lan-diagnostics-')) rmSync(root, { recursive: true, force: true })
})

it('says plainly that a standalone PC is invisible to other computers', () => {
  const diagnosis = buildLanDiagnosis({ ...hub, mode: 'standalone', allowedUserId: '', running: false, discovery: false })
  expect(diagnosis.ready).toBe(false)
  expect(diagnosis.checks).toHaveLength(1)
  expect(diagnosis.checks[0]).toMatchObject({ id: 'mode', state: 'problem' })
  expect(diagnosis.checks[0].detail).toContain('Головний ПК каси')
  expect(diagnosis.firewallCommand).toBe('')
})

it('reports a ready hub only when Windows lets the second PC in', () => {
  const ready = buildLanDiagnosis(hub, { tcpAllowed: true, udpAllowed: true, networks: ['Public'] })
  expect(ready.ready).toBe(true)
  expect(ready.checks.every(check => check.state === 'ok')).toBe(true)
  expect(ready.checks.find(check => check.id === 'address')?.detail).toContain('192.168.0.103:3210')

  const blocked = buildLanDiagnosis(hub, { tcpAllowed: false, udpAllowed: false, networks: ['Public'] })
  expect(blocked.ready).toBe(false)
  expect(state(blocked, 'firewall')).toBe('problem')
  expect(blocked.checks.find(check => check.id === 'firewall')?.detail).toContain('загальнодоступна')
  expect(blocked.firewallCommand).toContain('-LocalPort 3210')
})

it('keeps manual pairing possible when only auto-discovery is blocked', () => {
  const diagnosis = buildLanDiagnosis(hub, { tcpAllowed: true, udpAllowed: false, networks: ['Private'] })
  expect(state(diagnosis, 'firewall')).toBe('problem')
  expect(diagnosis.checks.find(check => check.id === 'firewall')?.title).toContain('автопошук')
})

it('does not claim readiness or a block when Windows could not be read', () => {
  const diagnosis = buildLanDiagnosis(hub)
  expect(state(diagnosis, 'firewall')).toBe('unknown')
  expect(diagnosis.ready).toBe(true)
})

it('names a missing employee, a closed port and a missing network on the hub', () => {
  const diagnosis = buildLanDiagnosis({ ...hub, allowedUserId: '', running: false, discovery: false, addresses: [], lastError: 'listen EADDRINUSE' },
    { tcpAllowed: true, udpAllowed: true, networks: [] })
  expect(state(diagnosis, 'staff')).toBe('problem')
  expect(state(diagnosis, 'listening')).toBe('problem')
  expect(diagnosis.checks.find(check => check.id === 'listening')?.detail).toContain('EADDRINUSE')
  expect(state(diagnosis, 'address')).toBe('problem')
  expect(state(diagnosis, 'discovery')).toBe('problem')
  expect(diagnosis.ready).toBe(false)
})

it('shows the manager PC its own connection state with the last reason', () => {
  const lost = buildLanDiagnosis({ ...hub, mode: 'client', connected: false, lastError: 'Немає зв’язку з головним ПК: він не відповідає.' })
  expect(lost.ready).toBe(false)
  expect(lost.checks[0]).toMatchObject({ id: 'connection', state: 'problem', detail: 'Немає зв’язку з головним ПК: він не відповідає.' })
  expect(buildLanDiagnosis({ ...hub, mode: 'client' }).ready).toBe(true)
})

it('builds a port-based rule limited to the local subnet and rejects unsafe ports', () => {
  const script = firewallRuleScript(3210)
  expect(script).toContain("New-NetFirewallRule -DisplayName 'Forsage LAN TCP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3210 -RemoteAddress LocalSubnet")
  expect(script).toContain("-DisplayName 'Forsage LAN UDP' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 3211 -RemoteAddress LocalSubnet")
  // Правило не привʼязане до шляху програми: portable-EXE після оновлення лежить в іншій теці.
  expect(script).not.toContain('-Program')
  for (const port of [80, 0, 70000, 3210.5, Number.NaN]) expect(() => firewallRuleScript(port)).toThrow('Некоректний порт')
  expect(() => firewallRuleScript('3210; Remove-Item C:\\' as unknown as number)).toThrow('Некоректний порт')
})

it('reads firewall rules without changing them and escapes the program path', () => {
  const script = firewallQueryScript(3210, "C:\\Temp\\it's\\Forsage.exe")
  expect(script).toContain("-Program 'C:\\Temp\\it''s\\Forsage.exe'")
  expect(script).not.toMatch(/New-NetFirewallRule|Remove-NetFirewallRule|Set-NetFirewall/)
})

it('parses the Windows answer and treats anything unreadable as unknown', () => {
  expect(parseFirewallState('{"tcp":true,"udp":false,"networks":["Public"]}')).toEqual({ tcpAllowed: true, udpAllowed: false, networks: ['Public'] })
  expect(parseFirewallState('{"tcp":false,"udp":false,"networks":"Private"}\r\n')).toEqual({ tcpAllowed: false, udpAllowed: false, networks: ['Private'] })
  expect(parseFirewallState('')).toEqual({ tcpAllowed: null, udpAllowed: null, networks: [] })
  expect(parseFirewallState('{"tcp":"yes"}')).toEqual({ tcpAllowed: null, udpAllowed: null, networks: [] })
})

it('turns low-level network errors into the action the owner must take', () => {
  const nested = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })
  expect(describeLanConnectFailure(nested('ECONNREFUSED'), false)).toContain('режим «Головний ПК каси» не ввімкнено')
  expect(describeLanConnectFailure(nested('EHOSTUNREACH'), false)).toContain('в одній мережі')
  expect(describeLanConnectFailure(nested('UND_ERR_CONNECT_TIMEOUT'), false)).toContain('брандмауер')
  expect(describeLanConnectFailure(new Error('aborted'), true)).toContain('Перевірити готовність')
  expect(describeLanConnectFailure(new Error('other'), false)).toBe('Немає зв’язку з головним ПК')
})

it('tells a pairing manager PC that the hub program is closed or not enabled', async () => {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const closedPort = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-lan-diagnostics-')); roots.push(root)
  const client = new LocalNetworkCoordinator(root, async () => null, () => null, { discovery: false }); peers.push(client)
  const failure = await client.pairRemote({ hubAddress: `127.0.0.1:${closedPort}`, accessKey: '1234567890abcdef1234567890abcdef' }).catch(error => error)
  expect(failure).toBeInstanceOf(LanUnavailableError)
  expect((failure as Error).message).toContain('Форсаж на ньому закрито або режим «Головний ПК каси» не ввімкнено')
  // Невдала спроба не має перетворювати чистий ПК на клієнта.
  expect(client.getStatus().mode).toBe('standalone')
  expect(client.getStatus().discovery).toBe(false)
})
