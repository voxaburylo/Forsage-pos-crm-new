import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalNetworkCoordinator, type LanSession } from '../src/lan/localNetwork'
import { LanUnavailableError } from '../src/lan/orderQueue'
import { openLanEnvelope, sealLanEnvelope, secureNonce } from '../src/lan/secureTransport'

const actor: LanSession = { id: 'employee', tenant_id: 'shop', role: 'manager' }
const code = '1234567890abcdef1234567890abcdef'
const roots: string[] = [], peers: LocalNetworkCoordinator[] = [], servers: Server[] = []
function root() { const p = mkdtempSync(path.join(tmpdir(), 'forsage-secure-lan-')); roots.push(p); return p }
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}
async function port() { const s = createServer(), p = await listen(s); await new Promise<void>(resolve => s.close(() => resolve())); return p }
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.stop()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const p of roots.splice(0)) if (path.dirname(p) === path.resolve(tmpdir()) && path.basename(p).startsWith('forsage-secure-lan-')) rmSync(p, { recursive: true, force: true })
})

it('pairs before persisting; encrypts login, binary update and business traffic without secrets on wire', async () => {
  const hubPort = await port(), calls: string[] = [], wire: string[] = []
  const hub = new LocalNetworkCoordinator(root(), async (channel, _args, session) => { expect(session).toEqual(actor); calls.push(channel); return { saved: true } }, () => actor, {
    discovery: false,
    authenticate: async (phone, password) => { expect(phone).toBe('0671234567'); expect(password).toBe('secret-password'); return { ...actor, full_name: 'Менеджер', phone, is_active: true, password_hash: 'never-transfer' } },
    updateMetadata: async () => ({ protocol: 1, releaseId: 'build-1', sha256: 'a'.repeat(64), size: 4 }),
    updateChunk: async (input, session) => { expect(session).toEqual(actor); return { offset: input.offset, data: Uint8Array.from([1, 2, 3, 4]) } },
  })
  peers.push(hub); await hub.update({ mode: 'hub', port: hubPort, accessKey: code, allowedUserId: actor.id })
  const proxy = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8'); wire.push(JSON.stringify(req.headers), body)
    const reply = await fetch(`http://127.0.0.1:${hubPort}${req.url}`, { method: req.method, headers: { 'Content-Type': 'application/json' }, ...(req.method === 'POST' ? { body } : {}) })
    const output = await reply.text(); wire.push(output); res.writeHead(reply.status).end(output)
  })
  servers.push(proxy); const proxyPort = await listen(proxy)
  const directory = root(), client = new LocalNetworkCoordinator(directory, async () => null, () => null, { discovery: false }); peers.push(client)
  await client.pairRemote({ hubAddress: `127.0.0.1:${proxyPort}`, accessKey: code })
  expect(client.getStatus()).toMatchObject({ mode: 'client', secureTransport: 1, connected: true })
  expect(await client.loginRemote('0671234567', 'secret-password')).toEqual({ ...actor, full_name: 'Менеджер', phone: '0671234567', is_active: true })
  expect(await client.requestUpdateMetadata(actor)).toMatchObject({ releaseId: 'build-1' })
  expect(await client.requestUpdateChunk({ releaseId: 'build-1', sha256: 'a'.repeat(64), offset: 0, length: 4 }, actor)).toEqual({ offset: 0, data: Uint8Array.from([1, 2, 3, 4]) })
  expect(await client.invoke('desktop:orders:list', [], actor)).toEqual({ saved: true })
  expect(calls).toEqual(['desktop:orders:list'])
  for (const secret of [code, 'secret-password', 'never-transfer', '0671234567', 'desktop:orders:list']) expect(wire.join('\n')).not.toContain(secret)
  expect(wire.join('\n')).not.toContain('Bearer')
  const before = readFileSync(path.join(directory, 'lan-config.json'), 'utf8')
  await expect(client.pairRemote({ hubAddress: `127.0.0.1:${proxyPort}`, accessKey: '0'.repeat(32) })).rejects.toThrow()
  expect(readFileSync(path.join(directory, 'lan-config.json'), 'utf8')).toBe(before)
  expect(client.getStatus().hubAddress).toBe(`http://127.0.0.1:${proxyPort}`)
})

it('distinguishes disabled/wrong-user/auth failures from actual disconnection and never downgrades', async () => {
  const hubPort = await port(); let current: LanSession | null = actor, profile: Record<string, unknown> = { ...actor, is_active: true }
  const hub = new LocalNetworkCoordinator(root(), async () => null, () => current, { discovery: false, authenticate: async () => profile })
  peers.push(hub); await hub.update({ mode: 'hub', port: hubPort, accessKey: code, allowedUserId: actor.id })
  const client = new LocalNetworkCoordinator(root(), async () => null, () => null, { discovery: false }); peers.push(client)
  await client.pairRemote({ hubAddress: `127.0.0.1:${hubPort}`, accessKey: code })
  for (const bad of [{ ...actor, id: 'another', is_active: true }, { ...actor, tenant_id: 'other', is_active: true }, { ...actor, is_active: false }]) {
    profile = bad
    await expect(client.loginRemote('phone', 'password')).rejects.not.toBeInstanceOf(LanUnavailableError)
  }
  current = null; profile = { ...actor, is_active: true }
  await expect(client.loginRemote('phone', 'password')).rejects.not.toBeInstanceOf(LanUnavailableError)
  await expect(client.requestUpdateMetadata(actor)).rejects.not.toBeInstanceOf(LanUnavailableError)
  await hub.stop()
  await expect(client.loginRemote('phone', 'password')).rejects.toBeInstanceOf(LanUnavailableError)
})

it('rejects public, credential-bearing and DNS candidates before any fetch or persist', async () => {
  const directory = root(), client = new LocalNetworkCoordinator(directory, async () => null, () => null, { discovery: false }); peers.push(client)
  for (const address of ['8.8.8.8:3210', 'example.com:3210', 'http://user:pass@192.168.1.2:3210', 'https://192.168.1.2:3210', 'http://192.168.1.2:3210/other']) {
    await expect(client.pairRemote({ hubAddress: address, accessKey: code })).rejects.toThrow()
    expect(client.getStatus().mode).toBe('standalone')
  }
})

it('rejects replay across requests/restart, excessive updater reads, protected channels and wrong tenant', async () => {
  const hubPort = await port(), updates: unknown[] = []
  const hub = new LocalNetworkCoordinator(root(), async () => 'ok', () => actor, { discovery: false, authenticate: async () => ({ ...actor, is_active: true }), updateChunk: async input => { updates.push(input); return { offset: input.offset, data: new Uint8Array() } } })
  peers.push(hub); await hub.update({ mode: 'hub', port: hubPort, accessKey: code, allowedUserId: actor.id })
  const address = `http://127.0.0.1:${hubPort}`
  const challenge = await (await fetch(address + '/forsage-lan/bootstrap')).json() as { nonce: string }
  const context = { hubNonce: challenge.nonce, requestId: secureNonce(), deadline: Date.now() + 30000 }
  const post = (body: unknown) => fetch(address + '/forsage-lan/secure', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Connection: 'close' } })
  const request = sealLanEnvelope({ action: 'probe' }, code, 'request', context)
  expect((await post(request)).status).toBe(200)
  expect((await post(request)).status).toBe(401)
  await hub.stop(); await hub.startConfigured()
  expect((await post(request)).status).toBe(401)
  const client = new LocalNetworkCoordinator(root(), async () => null, () => null, { discovery: false }); peers.push(client)
  await client.pairRemote({ hubAddress: address, accessKey: code })
  await expect(client.invoke('desktop:auth:login', [], actor)).rejects.toThrow('LAN_PROXY_NOT_CONFIGURED')
  await expect(client.invoke('desktop:orders:list', [], { ...actor, tenant_id: 'other' })).rejects.toThrow('Невірний магазин')
  await expect(client.requestUpdateChunk({ releaseId: 'build', sha256: 'a'.repeat(64), offset: 0, length: 1024 * 1024 + 1 }, actor)).rejects.toThrow('Некоректний фрагмент')
  expect(updates).toEqual([])
  const latest = await (await fetch(address + '/forsage-lan/bootstrap')).json() as { nonce: string }
  const invalidContext = { hubNonce: latest.nonce, requestId: secureNonce(), deadline: Date.now() + 30000 }
  const malformed = sealLanEnvelope({ action: 'update-chunk', user_id: actor.id, tenant_id: actor.tenant_id, input: { releaseId: '../../secret', sha256: 'a'.repeat(64), offset: 0, length: 4 } }, code, 'request', invalidContext)
  const response = await (await post(malformed)).json()
  expect(openLanEnvelope(response, code, 'response', invalidContext).value).toMatchObject({ ok: false })
  expect(updates).toEqual([])
})

it('rejects redirect/downgrade/auth failures as non-network errors and preserves secure settings on update', async () => {
  const fake = createServer((_req, res) => res.writeHead(302, { Location: 'http://8.8.8.8/' }).end())
  servers.push(fake); const fakePort = await listen(fake)
  const client = new LocalNetworkCoordinator(root(), async () => null, () => null, { discovery: false }); peers.push(client)
  await expect(client.pairRemote({ hubAddress: `127.0.0.1:${fakePort}`, accessKey: code })).rejects.not.toBeInstanceOf(LanUnavailableError)
  const hubPort = await port(), hub = new LocalNetworkCoordinator(root(), async () => null, () => actor, { discovery: false, authenticate: async () => { throw new Error('Невірний пароль') } })
  peers.push(hub); await hub.update({ mode: 'hub', port: hubPort, accessKey: code, allowedUserId: actor.id })
  await client.pairRemote({ hubAddress: `127.0.0.1:${hubPort}`, accessKey: code })
  await client.update({ mode: 'client' })
  expect(client.getStatus().secureTransport).toBe(1)
  await expect(client.loginRemote('phone', 'wrong')).rejects.toThrow('Невірний пароль')
  const abort = new AbortController(); abort.abort()
  await expect(client.requestUpdateMetadata(actor, abort.signal)).rejects.toThrow('LAN_REQUEST_CANCELLED')
})
