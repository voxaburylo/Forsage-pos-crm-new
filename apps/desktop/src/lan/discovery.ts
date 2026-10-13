import { createSocket, type Socket } from 'node:dgram'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { secureNonce } from './secureTransport'

export const LAN_DISCOVERY_PORT = 3211
export interface LanHubCandidate { service: 'forsage-lan'; protocol: 3; bootstrap: 1; hubAddress: string; name: string }
export interface LanDiscoveryOptions { port?: number; bindAddress?: string; targets?: string[]; timeoutMs?: number }
export function isPrivateLanAddress(value: string | undefined): boolean {
  const address = String(value ?? '').replace(/^::ffff:/, '')
  if (address === '::1') return true
  if (isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
}
export function privateHubAddress(value: unknown, defaultPort = 3210): string {
  const raw = String(value ?? '').trim()
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
    || isIP(url.hostname) !== 4 || !isPrivateLanAddress(url.hostname)) throw new Error('Вкажіть приватну IPv4-адресу головного ПК без шляху чи пароля')
  const port = url.port ? Number(url.port) : defaultPort
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Некоректний порт головного ПК')
  return `http://${url.hostname}:${port}`
}
const numeric = (ip: string) => ip.split('.').reduce((acc, n) => (acc * 256 + Number(n)) >>> 0, 0)
const dotted = (n: number) => [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.')
export function discoveryBroadcasts(entries = Object.values(networkInterfaces()).flatMap(value => value ?? [])): string[] {
  return [...new Set(entries.filter(entry => entry.family === 'IPv4' && !entry.internal && isPrivateLanAddress(entry.address) && isIP(entry.netmask) === 4)
    .map(entry => dotted((numeric(entry.address) | ~numeric(entry.netmask)) >>> 0)))]
}
function addressForPeer(peer: string): string | undefined {
  if (peer.startsWith('127.')) return '127.0.0.1'
  return Object.values(networkInterfaces()).flatMap(entries => entries ?? []).find(entry => entry.family === 'IPv4' && !entry.internal
    && isPrivateLanAddress(entry.address) && (numeric(entry.address) & numeric(entry.netmask)) === (numeric(peer) & numeric(entry.netmask)))?.address
}
export async function startLanDiscovery(hubPort: number, options: LanDiscoveryOptions = {}): Promise<Socket> {
  const socket = createSocket('udp4')
  const replies = new Map<string, number>()
  socket.on('message', (packet, peer) => {
    if (packet.length > 512 || !isPrivateLanAddress(peer.address)) return
    try {
      const message = JSON.parse(packet.toString('utf8'))
      if (message.service !== 'forsage-lan-discover' || message.protocol !== 1 || !/^[a-f0-9]{32}$/.test(message.nonce)) return
      const now = Date.now()
      for (const [ip, at] of replies) if (now - at > 1000) replies.delete(ip)
      if (replies.has(peer.address) || replies.size >= 256) return
      const address = addressForPeer(peer.address)
      if (!address) return
      replies.set(peer.address, now)
      socket.send(Buffer.from(JSON.stringify({ service: 'forsage-lan', protocol: 3, bootstrap: 1, address: `http://${address}:${hubPort}`, nonce: message.nonce })), peer.port, peer.address, () => {})
    } catch { /* Untrusted discovery datagrams do not reach any business operation. */ }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(options.port ?? LAN_DISCOVERY_PORT, options.bindAddress ?? '0.0.0.0', () => { socket.off('error', reject); resolve() })
  }).catch(error => { try { socket.close() } catch { /* bind failed */ } throw error })
  socket.on('error', () => {})
  socket.unref()
  return socket
}
export async function discoverLanHubs(options: LanDiscoveryOptions = {}): Promise<LanHubCandidate[]> {
  const socket = createSocket('udp4'), nonce = secureNonce(), found = new Map<string, LanHubCandidate>()
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); try { socket.close() } catch { /* not bound */ } error ? reject(error) : resolve([...found.values()].sort((a, b) => a.hubAddress.localeCompare(b.hubAddress))) }
    const timer = setTimeout(() => finish(), Math.max(100, Math.min(5000, options.timeoutMs ?? 1200)))
    socket.once('error', finish)
    socket.on('message', (packet, peer) => {
      if (packet.length > 1024 || !isPrivateLanAddress(peer.address) || found.size >= 32) return
      try {
        const message = JSON.parse(packet.toString('utf8'))
        if (message.service !== 'forsage-lan' || message.protocol !== 3 || message.bootstrap !== 1 || message.nonce !== nonce) return
        const hubAddress = privateHubAddress(message.address)
        if (new URL(hubAddress).hostname !== peer.address) return
        found.set(hubAddress, { service: 'forsage-lan', protocol: 3, bootstrap: 1, hubAddress, name: 'Головний ПК каси' })
      } catch { /* Ignore unsolicited, malformed or redirected announcements. */ }
    })
    socket.bind(0, options.bindAddress ?? '0.0.0.0', () => {
      try {
        socket.setBroadcast(true)
        const targets = options.targets ?? discoveryBroadcasts()
        const query = Buffer.from(JSON.stringify({ service: 'forsage-lan-discover', protocol: 1, nonce }))
        for (const target of [...new Set(targets)].slice(0, 32)) if (isPrivateLanAddress(target)) socket.send(query, options.port ?? LAN_DISCOVERY_PORT, target, () => {})
        if (targets.length === 0) finish()
      } catch (error) { finish(error instanceof Error ? error : new Error('LAN_DISCOVERY_FAILED')) }
    })
  })
}
