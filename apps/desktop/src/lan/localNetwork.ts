import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import path from 'node:path'

export type LanMode = 'standalone' | 'hub' | 'client'

export interface LanConfig {
  mode: LanMode
  port: number
  hubAddress: string
  accessKey: string
  allowedUserId: string
}

export interface LanSession {
  id: string
  tenant_id: string
  role: string
}

export interface LanStatus extends LanConfig {
  addresses: string[]
  running: boolean
  connected: boolean
  lastError: string | null
}

type InvokeRemote = (channel: string, args: unknown[], session: LanSession) => Promise<unknown>
type ResolveSession = (userId: string) => LanSession | null

const DEFAULT_PORT = 3210
const MAX_BODY_BYTES = 16 * 1024 * 1024
const CONFIG_FILE = 'lan-config.json'

function defaultConfig(): LanConfig {
  return { mode: 'standalone', port: DEFAULT_PORT, hubAddress: '', accessKey: '', allowedUserId: '' }
}

function safePort(value: unknown): number {
  const port = Number(value)
  return Number.isSafeInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT
}

function normalizeHubAddress(value: unknown, port: number): string {
  const raw = String(value ?? '').trim().replace(/\/$/, '')
  if (!raw) return ''
  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  const url = new URL(candidate)
  if (url.protocol !== 'http:') throw new Error('Для локальної мережі вкажіть адресу виду 192.168.1.20')
  if (!url.port) url.port = String(port)
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function loadConfig(dataRoot: string): LanConfig {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataRoot, CONFIG_FILE), 'utf8')) as Partial<LanConfig>
    const port = safePort(parsed.port)
    return {
      mode: parsed.mode === 'hub' || parsed.mode === 'client' ? parsed.mode : 'standalone',
      port,
      hubAddress: parsed.hubAddress ? normalizeHubAddress(parsed.hubAddress, port) : '',
      accessKey: String(parsed.accessKey ?? '').trim(),
      allowedUserId: String(parsed.allowedUserId ?? '').trim(),
    }
  } catch {
    return defaultConfig()
  }
}

function localAddresses(): string[] {
  const result = new Set<string>()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      result.add(entry.address)
    }
  }
  return [...result].sort()
}

function isPrivateAddress(value: string | undefined): boolean {
  const address = String(value ?? '').replace(/^::ffff:/, '')
  if (address === '::1' || address === '127.0.0.1') return true
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true
  const match = /^172\.(\d+)\./.exec(address)
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31)
}

function sameSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function encodeTransport(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return { $forsageBinary: Buffer.from(new Uint8Array(value)).toString('base64') }
  }
  if (ArrayBuffer.isView(value)) {
    return { $forsageBinary: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  }
  if (Array.isArray(value)) return value.map(encodeTransport)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, encodeTransport(item)]))
  }
  return value
}

function decodeTransport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeTransport)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.$forsageBinary === 'string') return Uint8Array.from(Buffer.from(record.$forsageBinary, 'base64'))
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeTransport(item)]))
  }
  return value
}

export function isLanProxyChannel(channel: string): boolean {
  if (!channel.startsWith('desktop:')) return false
  return ![
    'desktop:auth:',
    'desktop:lan:',
    'desktop:print:',
    'desktop:fiscal:',
    'desktop:sync:',
    'desktop:bootstrap:',
    'desktop:get-runtime-info',
    'desktop:backup-now',
  ].some((prefix) => channel.startsWith(prefix))
}

export class LocalNetworkCoordinator {
  private config: LanConfig
  private server: Server | null = null
  private connected = false
  private lastError: string | null = null

  constructor(
    private readonly dataRoot: string,
    private readonly invokeRemote: InvokeRemote,
    private readonly resolveSession: ResolveSession,
  ) {
    this.config = loadConfig(dataRoot)
  }

  getStatus(): LanStatus {
    return {
      ...this.config,
      accessKey: this.config.accessKey,
      addresses: localAddresses(),
      running: this.server?.listening === true,
      connected: this.config.mode === 'hub' ? this.server?.listening === true : this.connected,
      lastError: this.lastError,
    }
  }

  async update(input: Partial<LanConfig>): Promise<LanStatus> {
    const mode: LanMode = input.mode === 'hub' || input.mode === 'client' ? input.mode : 'standalone'
    const port = safePort(input.port ?? this.config.port)
    let accessKey = String(input.accessKey ?? this.config.accessKey).trim()
    if (mode === 'hub' && accessKey.length < 16) accessKey = randomBytes(16).toString('hex')
    if (mode === 'client' && accessKey.length < 16) throw new Error('Вкажіть код підключення з головного компʼютера')
    const hubAddress = mode === 'client'
      ? normalizeHubAddress(input.hubAddress ?? this.config.hubAddress, port)
      : ''
    if (mode === 'client' && !hubAddress) throw new Error('Вкажіть IP-адресу головного компʼютера')
    const allowedUserId = mode === 'hub'
      ? String(input.allowedUserId ?? this.config.allowedUserId).trim()
      : ''
    if (mode === 'hub' && !allowedUserId) throw new Error('Оберіть менеджера, якому дозволено це підключення')

    this.config = { mode, port, hubAddress, accessKey, allowedUserId }
    writeFileSync(path.join(this.dataRoot, CONFIG_FILE), JSON.stringify(this.config, null, 2), 'utf8')
    await this.restart()
    if (mode === 'client') await this.testConnection()
    return this.getStatus()
  }

  async startConfigured(): Promise<void> {
    try {
      await this.restart()
      if (this.config.mode === 'client') await this.testConnection()
    } catch (error) {
      // Невірна IP-адреса, вимкнений головний ПК або зайнятий порт не повинні
      // блокувати запуск Forsage. Користувач виправить адресу в налаштуваннях.
      this.connected = false
      this.lastError = error instanceof Error ? error.message : 'Локальна мережа недоступна'
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  async testConnection(): Promise<LanStatus> {
    if (this.config.mode === 'hub') return this.getStatus()
    if (this.config.mode !== 'client') throw new Error('Оберіть режим компʼютера менеджера')
    try {
      const response = await this.fetchWithTimeout(`${this.config.hubAddress}/forsage-lan/health`, {
        headers: { Authorization: `Bearer ${this.config.accessKey}` },
      }, 3_000)
      if (!response.ok) throw new Error(response.status === 401 ? 'Невірний код підключення' : `Головний ПК відповів з помилкою ${response.status}`)
      this.connected = true
      this.lastError = null
      return this.getStatus()
    } catch (error) {
      this.connected = false
      this.lastError = error instanceof Error ? error.message : 'Головний ПК недоступний'
      throw new Error(`Не вдалося підключитися до головного ПК: ${this.lastError}`)
    }
  }

  async invoke(channel: string, args: unknown[], session: LanSession): Promise<unknown> {
    if (this.config.mode !== 'client' || !isLanProxyChannel(channel)) {
      throw new Error('LAN_PROXY_NOT_CONFIGURED')
    }
    let response: Response
    try {
      response = await this.fetchWithTimeout(`${this.config.hubAddress}/forsage-lan/rpc`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(encodeTransport({ channel, args, user_id: session.id })),
      }, 30_000)
    } catch (error) {
      this.connected = false
      this.lastError = error instanceof Error ? error.message : 'Головний ПК недоступний'
      throw new Error(`Немає звʼязку з головним ПК каси: ${this.lastError}`)
    }
    const payload = await response.json().catch(() => null) as { ok?: boolean; result?: unknown; error?: string } | null
    this.connected = true
    this.lastError = null
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || `Головний ПК відповів з помилкою ${response.status}`)
    }
    return decodeTransport(payload.result)
  }

  private async restart(): Promise<void> {
    await this.stop()
    this.connected = false
    this.lastError = null
    if (this.config.mode !== 'hub') return
    await this.startHub()
  }

  private async startHub(): Promise<void> {
    if (this.config.accessKey.length < 16) {
      this.config.accessKey = randomBytes(16).toString('hex')
      writeFileSync(path.join(this.dataRoot, CONFIG_FILE), JSON.stringify(this.config, null, 2), 'utf8')
    }
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (!isPrivateAddress(request.socket.remoteAddress)) {
        response.writeHead(403).end(JSON.stringify({ ok: false, error: 'Доступ дозволено лише з локальної мережі' }))
        return
      }
      const suppliedKey = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (!sameSecret(suppliedKey, this.config.accessKey)) {
        response.writeHead(401).end(JSON.stringify({ ok: false, error: 'Невірний код підключення' }))
        return
      }
      if (request.method === 'GET' && request.url === '/forsage-lan/health') {
        response.writeHead(200).end(JSON.stringify({ ok: true, service: 'forsage-lan', version: 1 }))
        return
      }
      if (request.method !== 'POST' || request.url !== '/forsage-lan/rpc') {
        response.writeHead(404).end(JSON.stringify({ ok: false, error: 'Команду не знайдено' }))
        return
      }
      try {
        const body = await this.readBody(request)
        const decoded = decodeTransport(JSON.parse(body)) as { channel?: unknown; args?: unknown; user_id?: unknown }
        const channel = String(decoded.channel ?? '')
        if (!isLanProxyChannel(channel)) throw new Error('Цю команду не можна виконувати через мережу')
        const requestedUserId = String(decoded.user_id ?? '')
        if (!requestedUserId || requestedUserId !== this.config.allowedUserId) {
          throw new Error('Цей код підключення видано іншому працівнику')
        }
        const session = this.resolveSession(this.config.allowedUserId)
        if (!session) throw new Error('Працівник не знайдений або заблокований на головному ПК')
        const result = await this.invokeRemote(channel, Array.isArray(decoded.args) ? decoded.args : [], session)
        response.writeHead(200).end(JSON.stringify(encodeTransport({ ok: true, result })))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Помилка локальної мережі'
        response.writeHead(message.includes('прав') ? 403 : 400).end(JSON.stringify({ ok: false, error: message }))
      }
    })
    server.on('error', (error) => {
      this.lastError = error.message
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.port, '0.0.0.0', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.connected = true
  }

  private readBody(request: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('Передано забагато даних'))
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      request.on('error', reject)
    })
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
  }
}
