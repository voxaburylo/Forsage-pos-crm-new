import { createSocket, type Socket } from 'node:dgram'
import { afterEach, expect, it } from 'vitest'
import { discoverLanHubs, discoveryBroadcasts, isPrivateLanAddress, privateHubAddress, startLanDiscovery } from '../src/lan/discovery'

const sockets: Socket[] = []
afterEach(async () => { for (const socket of sockets.splice(0)) await new Promise<void>(resolve => { try { socket.close(() => resolve()) } catch { resolve() } }) })
async function bind(socket: Socket) { await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve)); return socket.address().port }
it('accepts private IPv4 and switch link-local addresses, rejecting public/DNS/invalid literals', () => {
  for (const ip of ['10.2.3.4', '192.168.2.3', '172.16.0.2', '172.31.255.254', '169.254.10.3', '127.0.0.1', '::ffff:192.168.1.2']) expect(isPrivateLanAddress(ip)).toBe(true)
  for (const ip of ['172.32.0.1', '8.8.8.8', '192.168.999.1', '10.bad', '192.169.1.2', '224.0.0.1', 'example.com']) expect(isPrivateLanAddress(ip)).toBe(false)
  expect(privateHubAddress('169.254.10.3')).toBe('http://169.254.10.3:3210')
  expect(discoveryBroadcasts([{ address: '169.254.10.3', netmask: '255.255.0.0', family: 'IPv4', internal: false, cidr: '169.254.10.3/16', mac: 'test' }, { address: '192.168.1.3', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '192.168.1.3/24', mac: 'test' }])).toEqual(['169.254.255.255', '192.168.1.255'])
})
it('discovers a real isolated UDP hub without account, code or shop metadata', async () => {
  const hub = await startLanDiscovery(45678, { port: 0, bindAddress: '127.0.0.1' }); sockets.push(hub)
  expect(await discoverLanHubs({ port: hub.address().port, bindAddress: '127.0.0.1', targets: ['127.0.0.1'], timeoutMs: 150 })).toEqual([{ service: 'forsage-lan', protocol: 3, bootstrap: 1, hubAddress: 'http://127.0.0.1:45678', name: 'Головний ПК каси' }])
})
it('ignores wrong nonce, protocol and host spoofing; no usable reply returns empty within deadline', async () => {
  const fake = createSocket('udp4'); sockets.push(fake); const port = await bind(fake)
  let query: Record<string, unknown> | undefined
  fake.on('message', (packet, peer) => {
    query = JSON.parse(packet.toString('utf8'))
    for (const override of [{ nonce: '0'.repeat(32) }, { protocol: 2 }, { address: 'http://8.8.8.8:3210' }, { address: 'http://192.168.1.2:3210' }, { address: 'http://127.0.0.1:3210/a' }]) {
      fake.send(Buffer.from(JSON.stringify({ service: 'forsage-lan', protocol: 3, bootstrap: 1, address: 'http://127.0.0.1:3210', nonce: query?.nonce, ...override })), peer.port, peer.address)
    }
  })
  expect(await discoverLanHubs({ port, bindAddress: '127.0.0.1', targets: ['127.0.0.1'], timeoutMs: 150 })).toEqual([])
  expect(Object.keys(query ?? {}).sort()).toEqual(['nonce', 'protocol', 'service'])
})
