import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLanProxyChannel, LocalNetworkCoordinator } from '../src/lan/localNetwork'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('Forsage local network coordinator', () => {
  const roots: string[] = []
  const coordinators: LocalNetworkCoordinator[] = []

  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.stop()))
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('routes business commands to the hub with the hub-side employee session', async () => {
    const port = await freePort()
    const hubRoot = mkdtempSync(path.join(tmpdir(), 'forsage-lan-hub-'))
    const clientRoot = mkdtempSync(path.join(tmpdir(), 'forsage-lan-client-'))
    roots.push(hubRoot, clientRoot)

    const calls: Array<{ channel: string; args: unknown[]; userId: string }> = []
    const hub = new LocalNetworkCoordinator(
      hubRoot,
      async (channel, args, session) => {
        calls.push({ channel, args, userId: session.id })
        return { saved: true }
      },
      (userId) => userId === 'manager-1'
        ? { id: userId, tenant_id: 'tenant-1', role: 'manager' }
        : null,
    )
    coordinators.push(hub)
    const hubStatus = await hub.update({ mode: 'hub', port, allowedUserId: 'manager-1' })

    const client = new LocalNetworkCoordinator(clientRoot, async () => null, () => null)
    coordinators.push(client)
    await client.update({
      mode: 'client',
      port,
      hubAddress: `http://127.0.0.1:${port}`,
      accessKey: hubStatus.accessKey,
    })

    await expect(client.invoke(
      'desktop:orders:save',
      [{ items: [{ name: 'Фільтр' }] }],
      { id: 'manager-1', tenant_id: 'tenant-1', role: 'manager' },
    )).resolves.toEqual({ saved: true })
    expect(calls).toEqual([{
      channel: 'desktop:orders:save',
      args: [{ items: [{ name: 'Фільтр' }] }],
      userId: 'manager-1',
    }])
  })

  it('never sends login, cloud sync, printing or fiscal commands to another PC', () => {
    expect(isLanProxyChannel('desktop:orders:save')).toBe(true)
    expect(isLanProxyChannel('desktop:catalog:search-products')).toBe(true)
    expect(isLanProxyChannel('desktop:auth:login')).toBe(false)
    expect(isLanProxyChannel('desktop:sync:list-pending')).toBe(false)
    expect(isLanProxyChannel('desktop:print:html')).toBe(false)
    expect(isLanProxyChannel('desktop:fiscal:fiscalize-sale')).toBe(false)
  })

  it('rejects an invalid connection key', async () => {
    const port = await freePort()
    const hubRoot = mkdtempSync(path.join(tmpdir(), 'forsage-lan-hub-'))
    const clientRoot = mkdtempSync(path.join(tmpdir(), 'forsage-lan-client-'))
    roots.push(hubRoot, clientRoot)
    const hub = new LocalNetworkCoordinator(hubRoot, async () => null, () => null)
    coordinators.push(hub)
    await hub.update({ mode: 'hub', port, allowedUserId: 'manager-1' })
    const client = new LocalNetworkCoordinator(clientRoot, async () => null, () => null)
    coordinators.push(client)
    await expect(client.update({
      mode: 'client', port, hubAddress: `127.0.0.1:${port}`, accessKey: 'wrong-key-wrong-key',
    })).rejects.toThrow('Невірний код підключення')
  })
})
