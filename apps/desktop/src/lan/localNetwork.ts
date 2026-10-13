import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import { LanUnavailableError } from './orderQueue'
import { discoverLanHubs, isPrivateLanAddress, privateHubAddress, startLanDiscovery, type LanDiscoveryOptions, type LanHubCandidate } from './discovery'
import { LAN_BOOTSTRAP_VERSION, LanReplayGuard, lanRequestContext, normalizeConnectCode, openLanEnvelope, sealLanEnvelope, secureNonce, SECURE_MAX_WIRE_BYTES, type SecureEnvelope } from './secureTransport'

export type LanMode = 'standalone' | 'hub' | 'client'

export interface LanConfig {
  mode: LanMode
  port: number
  hubAddress: string
  accessKey: string
  allowedUserId: string
  secureTransport?: 1
}

export interface LanSession {
  id: string
  tenant_id: string
  role: string
}

export interface LanPublicProfile extends LanSession { full_name: string; phone: string; is_active: true }
export interface LanPairCandidate { hubAddress: string; accessKey: string; port?: number }
export interface LanUpdateChunk { releaseId: string; sha256: string; offset: number; length: number }
export interface LanUpdateMetadata { protocol: 1; releaseId: string; sha256: string; size: number }
export interface LanBootstrapServices {
  authenticate?: (phone: string, password: string) => unknown | Promise<unknown>
  updateMetadata?: (session: LanSession) => unknown | Promise<unknown>
  updateChunk?: (input: LanUpdateChunk, session: LanSession) => { offset: number; data: Uint8Array } | Promise<{ offset: number; data: Uint8Array }>
  discovery?: LanDiscoveryOptions | false
}
export interface LanBootstrapCapability { service: 'forsage-lan'; version: 3; bootstrap: 1; offlineAuth: boolean; updates: boolean }

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
const LAN_PROTOCOL_VERSION = 3

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
      ...(parsed.secureTransport === 1 ? { secureTransport: 1 as const } : {}),
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
    'desktop:catalog:cleanup-',
    'desktop:lan:',
    'desktop:orders:offline-status',
    'desktop:orders:discard-offline',
    'desktop:orders:retry-offline',
    'desktop:print:',
    'desktop:fiscal:',
    'desktop:sync:',
    'desktop:bootstrap:',
    'desktop:get-runtime-info',
    'desktop:backup-now',
    // Бекапи й відкат бази — завжди про ЦЕЙ компʼютер. Проксіювати їх на
    // головний ПК не можна: людина відновлювала б чужу базу.
    'desktop:backup:',
    // Журнал проблем описує саме цей комп'ютер: його чергу, його принтер,
    // його базу. Проксіювати на головний ПК означало б показувати чужі збої.
    'desktop:problems:',
  ].some((prefix) => channel.startsWith(prefix))
}

export class LocalNetworkCoordinator {
  private config: LanConfig
  private server: Server | null = null
  private connected = false
  private lastError: string | null = null
  private discoverySocket: Socket | null = null
  private hubNonce = secureNonce()
  private replayGuard = new LanReplayGuard()
  private secureFlights = 0

  constructor(
    private readonly dataRoot: string,
    private readonly invokeRemote: InvokeRemote,
    private readonly resolveSession: ResolveSession,
    private readonly services: LanBootstrapServices = {},
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
    // Once paired securely, old settings screens cannot downgrade the transport.
    if (mode === 'client' && (input.secureTransport === 1 || this.config.secureTransport === 1)) {
      return this.pairRemote({ hubAddress: input.hubAddress ?? this.config.hubAddress, accessKey: input.accessKey ?? this.config.accessKey, port: input.port ?? this.config.port })
    }
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

  discoverHubs(): Promise<LanHubCandidate[]> {
    return this.services.discovery === false ? Promise.resolve([]) : discoverLanHubs(this.services.discovery)
  }

  async probeRemote(candidate: LanPairCandidate): Promise<LanBootstrapCapability> {
    const target = this.secureCandidate(candidate)
    const reply = await this.performSecureRequest(target, { action: 'probe' }) as LanBootstrapCapability
    if (reply?.service !== 'forsage-lan' || reply.version !== LAN_PROTOCOL_VERSION || reply.bootstrap !== LAN_BOOTSTRAP_VERSION || reply.offlineAuth !== true) {
      throw new Error('Головний ПК не підтримує захищений перший вхід. Оновіть його програму.')
    }
    return reply
  }

  async pairRemote(candidate: LanPairCandidate): Promise<LanStatus> {
    const target = this.secureCandidate(candidate)
    await this.probeRemote(target)
    const next: LanConfig = { mode: 'client', ...target, allowedUserId: '', secureTransport: 1 }
    // Probe failures cannot erase an existing working connection or enable a local hub.
    const configFile = path.join(this.dataRoot, CONFIG_FILE)
    const pendingFile = configFile + '.pending'
    writeFileSync(pendingFile, JSON.stringify(next, null, 2), 'utf8')
    renameSync(pendingFile, configFile)
    await this.stop()
    this.config = next; this.connected = true; this.lastError = null
    return this.getStatus()
  }

  async loginRemote(phone: string, password: string): Promise<LanPublicProfile> {
    if (typeof phone !== 'string' || phone.length > 64 || !phone.trim() || typeof password !== 'string' || !password || password.length > 1024) throw new Error('Вкажіть номер телефону та пароль')
    return this.secureClientRequest({ action: 'login', phone, password }) as Promise<LanPublicProfile>
  }

  async requestUpdateMetadata(session: LanSession, signal?: AbortSignal): Promise<LanUpdateMetadata> {
    return this.secureClientRequest({ action: 'update-metadata', user_id: session.id, tenant_id: session.tenant_id }, signal) as Promise<LanUpdateMetadata>
  }

  async requestUpdateChunk(input: LanUpdateChunk, session: LanSession, signal?: AbortSignal): Promise<{ offset: number; data: Uint8Array }> {
    this.validateUpdateChunk(input)
    return this.secureClientRequest({ action: 'update-chunk', input, user_id: session.id, tenant_id: session.tenant_id }, signal) as Promise<{ offset: number; data: Uint8Array }>
  }

  private secureCandidate(candidate: LanPairCandidate): Required<LanPairCandidate> {
    const hubAddress = privateHubAddress(candidate.hubAddress, candidate.port ?? DEFAULT_PORT)
    return { hubAddress, port: Number(new URL(hubAddress).port), accessKey: normalizeConnectCode(candidate.accessKey) }
  }

  private async secureClientRequest(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.config.mode !== 'client') throw new Error('Оберіть режим компʼютера менеджера')
    try {
      const result = await this.performSecureRequest(this.secureCandidate(this.config), payload, signal)
      this.connected = true; this.lastError = null
      return result
    } catch (error) {
      if (error instanceof LanUnavailableError) this.connected = false
      this.lastError = error instanceof Error ? error.message : 'Помилка локальної мережі'
      throw error
    }
  }

  private async performSecureRequest(candidate: LanPairCandidate, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const challenge = await this.fetchSecureJson(`${candidate.hubAddress}/forsage-lan/bootstrap`, { method: 'GET' }, 3000, 4096, signal)
    if (challenge.response.status !== 200 || challenge.payload?.service !== 'forsage-lan' || challenge.payload?.version !== LAN_PROTOCOL_VERSION || challenge.payload?.bootstrap !== LAN_BOOTSTRAP_VERSION || !/^[a-f0-9]{32}$/.test(challenge.payload?.nonce ?? '')) {
      throw new Error('Головний ПК не підтримує захищене підключення. Оновіть обидва ПК.')
    }
    const receivedAt = performance.now()
    const context = lanRequestContext(String(challenge.payload.nonce), challenge.payload.serverTime)
    const body = JSON.stringify(sealLanEnvelope(encodeTransport(payload), candidate.accessKey, 'request', context))
    const reply = await this.fetchSecureJson(`${candidate.hubAddress}/forsage-lan/secure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 30_000, SECURE_MAX_WIRE_BYTES, signal)
    if (reply.response.status === 401) throw new Error('Невірний код підключення або захищений запит відхилено')
    if (reply.response.status !== 200) throw new Error(`Головний ПК відхилив захищений запит (${reply.response.status})`)
    let decoded: { ok?: boolean; result?: unknown; error?: string }
    try { decoded = decodeTransport(openLanEnvelope(reply.payload, candidate.accessKey, 'response', context, Number(challenge.payload.serverTime) + Math.ceil(performance.now() - receivedAt)).value) as typeof decoded }
    catch { throw new Error('Не вдалося перевірити захищену відповідь головного ПК. Дані не прийнято.') }
    if (decoded?.ok !== true) throw new Error(typeof decoded?.error === 'string' ? decoded.error : 'Головний ПК відхилив операцію')
    return decoded.result
  }

  private currentHubSession(userId?: unknown, tenantId?: unknown): LanSession {
    const allowed = this.config.allowedUserId
    if (!allowed || (userId !== undefined && userId !== allowed)) throw new Error('Цей код підключення видано іншому працівнику')
    const session = this.resolveSession(allowed)
    if (!session || session.id !== allowed || !session.tenant_id || !session.role || session.role === 'tire_worker') throw new Error('Працівник не знайдений або заблокований на головному ПК')
    if (tenantId !== undefined && tenantId !== session.tenant_id) throw new Error('Невірний магазин підключення')
    return session
  }

  private validateUpdateChunk(value: LanUpdateChunk): void {
    if (!value || typeof value.releaseId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value.releaseId)
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)
      || !Number.isSafeInteger(value.offset) || value.offset < 0 || !Number.isSafeInteger(value.length)
      || value.length < 1 || value.length > 1024 * 1024 || !Number.isSafeInteger(value.offset + value.length)) throw new Error('Некоректний фрагмент оновлення')
  }

  private async dispatchSecure(payload: unknown): Promise<unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Некоректна мережева команда')
    const input = payload as Record<string, unknown>
    if (input.action === 'probe') {
      this.currentHubSession()
      return { service: 'forsage-lan', version: LAN_PROTOCOL_VERSION, bootstrap: LAN_BOOTSTRAP_VERSION, offlineAuth: Boolean(this.services.authenticate), updates: Boolean(this.services.updateMetadata && this.services.updateChunk) } satisfies LanBootstrapCapability
    }
    if (input.action === 'login') {
      if (!this.services.authenticate) throw new Error('Головний ПК не підтримує перший вхід без інтернету')
      if (typeof input.phone !== 'string' || !input.phone.trim() || input.phone.length > 64 || typeof input.password !== 'string' || !input.password || input.password.length > 1024) throw new Error('Вкажіть номер телефону та пароль')
      this.currentHubSession()
      const profile = await this.services.authenticate(input.phone, input.password) as Partial<LanPublicProfile> | null
      const session = this.currentHubSession(profile?.id, profile?.tenant_id)
      if (!profile || profile.id !== session.id || profile.tenant_id !== session.tenant_id || profile.role !== session.role || profile.is_active !== true) throw new Error('Працівник не знайдений або заблокований на головному ПК')
      return { ...session, full_name: typeof profile.full_name === 'string' ? profile.full_name.slice(0, 300) : '', phone: typeof profile.phone === 'string' ? profile.phone.slice(0, 64) : input.phone, is_active: true } satisfies LanPublicProfile
    }
    if (typeof input.user_id !== 'string' || typeof input.tenant_id !== 'string') throw new Error('Потрібен вхід працівника')
    const session = this.currentHubSession(input.user_id, input.tenant_id)
    if (input.action === 'rpc') {
      if (typeof input.channel !== 'string' || !isLanProxyChannel(input.channel) || !Array.isArray(input.args)) throw new Error('Цю команду не можна виконувати через мережу')
      return this.invokeRemote(input.channel, input.args, session)
    }
    if (input.action === 'update-metadata') {
      if (!this.services.updateMetadata) throw new Error('Оновлення з головного ПК ще недоступне')
      return this.services.updateMetadata(session)
    }
    if (input.action === 'update-chunk') {
      if (!this.services.updateChunk) throw new Error('Оновлення з головного ПК ще недоступне')
      const chunk = input.input as LanUpdateChunk
      this.validateUpdateChunk(chunk)
      const result = await this.services.updateChunk({ releaseId: chunk.releaseId, sha256: chunk.sha256, offset: chunk.offset, length: chunk.length }, session)
      if (result.offset !== chunk.offset || !(result.data instanceof Uint8Array) || result.data.byteLength > chunk.length) throw new Error('Некоректний фрагмент оновлення')
      return { offset: result.offset, data: result.data }
    }
    throw new Error('Команду не знайдено')
  }

  private async fetchSecureJson(url: string, init: RequestInit, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<{ response: Response; payload: any }> {
    const controller = new AbortController()
    const cancelled = () => controller.abort()
    if (signal?.aborted) throw new Error('LAN_REQUEST_CANCELLED')
    signal?.addEventListener('abort', cancelled, { once: true })
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response: Response
      try { response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal }) }
      catch { if (signal?.aborted) throw new Error('LAN_REQUEST_CANCELLED'); throw new LanUnavailableError('Немає зв’язку з головним ПК') }
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('Перенаправлення захищеного LAN-запиту заборонено') }
      const chunks: Uint8Array[] = []; let size = 0
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Порожня відповідь головного ПК')
      for (;;) {
        let part: ReadableStreamReadResult<Uint8Array>
        try { part = await reader.read() }
        catch { if (signal?.aborted) throw new Error('LAN_REQUEST_CANCELLED'); throw new LanUnavailableError('З’єднання з головним ПК перервано') }
        if (part.done) break
        size += part.value.byteLength
        if (size > maxBytes) { await reader.cancel(); throw new Error('Головний ПК повернув забагато даних') }
        chunks.push(part.value)
      }
      let payload: unknown
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new Error('Некоректна відповідь головного ПК') }
      return { response, payload }
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancelled) }
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
    const discovery = this.discoverySocket
    this.discoverySocket = null
    if (discovery) await new Promise<void>(resolve => { try { discovery.close(() => resolve()) } catch { resolve() } })
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  async testConnection(): Promise<LanStatus> {
    if (this.config.mode === 'hub') return this.getStatus()
    if (this.config.mode !== 'client') throw new Error('Оберіть режим компʼютера менеджера')
    try {
      if (this.config.secureTransport === 1) {
        await this.probeRemote(this.config)
        this.connected = true; this.lastError = null
        return this.getStatus()
      }
      const { response, payload: health } = await this.fetchWithTimeout(`${this.config.hubAddress}/forsage-lan/health`, {
        headers: { Authorization: `Bearer ${this.config.accessKey}` },
      }, 3_000)
      if (!response.ok) throw new Error(response.status === 401 ? 'Невірний код підключення' : `Головний ПК відповів з помилкою ${response.status}`)
      if (health?.service !== 'forsage-lan' || health.version !== LAN_PROTOCOL_VERSION) throw new Error('Несумісні версії програм. Оновіть обидва ПК однією збіркою.')
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
    if (this.config.secureTransport === 1) return this.secureClientRequest({ action: 'rpc', channel, args, user_id: session.id, tenant_id: session.tenant_id })
    let response: Response
    let payload: { ok?: boolean; result?: unknown; error?: string } | null
    try {
      const reply = await this.fetchWithTimeout(`${this.config.hubAddress}/forsage-lan/rpc`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(encodeTransport({ channel, args, user_id: session.id, protocol_version: LAN_PROTOCOL_VERSION })),
      }, ['desktop:orders:list', 'desktop:orders:get', 'desktop:orders:accept-offline'].includes(channel) ? 3_000 : 30_000)
      response = reply.response
      payload = reply.payload
    } catch (error) {
      this.connected = false
      this.lastError = error instanceof Error ? error.message : 'Головний ПК недоступний'
      throw new LanUnavailableError(`Немає звʼязку з головним ПК каси. Складські операції та оплати недоступні: ${this.lastError}`)
    }
    if ((response.ok && !payload) || response.status >= 500 || response.status === 408 || response.status === 429) {
      this.connected = false
      this.lastError = 'Головний ПК не підтвердив результат операції. Перевірте зв’язок.'
      throw new LanUnavailableError(this.lastError)
    }
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
    this.hubNonce = secureNonce()
    this.replayGuard = new LanReplayGuard()
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      if (!isPrivateLanAddress(request.socket.remoteAddress)) {
        response.writeHead(403).end(JSON.stringify({ ok: false, error: 'Доступ дозволено лише з локальної мережі' }))
        return
      }
      if (request.method === 'GET' && request.url === '/forsage-lan/bootstrap') {
        response.writeHead(200).end(JSON.stringify({ service: 'forsage-lan', version: LAN_PROTOCOL_VERSION, bootstrap: LAN_BOOTSTRAP_VERSION, nonce: this.hubNonce, serverTime: Date.now() }))
        return
      }
      if (request.method === 'POST' && request.url === '/forsage-lan/secure') {
        let envelope: SecureEnvelope | undefined
        let claimed = false
        try {
          if (this.secureFlights >= 8) throw new Error('LAN_BUSY')
          this.secureFlights++; claimed = true
          const body = await this.readBody(request, SECURE_MAX_WIRE_BYTES)
          const opened = openLanEnvelope(JSON.parse(body), this.config.accessKey, 'request', { hubNonce: this.hubNonce })
          this.replayGuard.claim(opened.envelope.requestId, opened.envelope.deadline)
          envelope = opened.envelope
          const result = await this.dispatchSecure(decodeTransport(opened.value))
          response.writeHead(200).end(JSON.stringify(sealLanEnvelope(encodeTransport({ ok: true, result }), this.config.accessKey, 'response', envelope)))
        } catch (error) {
          // Unauthenticated failures do not disclose parsing, key, account or crypto details.
          if (!envelope) response.writeHead(401).end(JSON.stringify({ ok: false, error: 'LAN_SECURE_REJECTED' }))
          else {
            const message = error instanceof Error ? error.message.slice(0, 500) : 'Помилка локальної мережі'
            response.writeHead(200).end(JSON.stringify(sealLanEnvelope({ ok: false, error: message }, this.config.accessKey, 'response', envelope)))
          }
        } finally { if (claimed) this.secureFlights-- }
        return
      }
      const suppliedKey = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (!sameSecret(suppliedKey, this.config.accessKey)) {
        response.writeHead(401).end(JSON.stringify({ ok: false, error: 'Невірний код підключення' }))
        return
      }
      if (request.method === 'GET' && request.url === '/forsage-lan/health') {
        response.writeHead(200).end(JSON.stringify({ ok: true, service: 'forsage-lan', version: LAN_PROTOCOL_VERSION }))
        return
      }
      if (request.method !== 'POST' || request.url !== '/forsage-lan/rpc') {
        response.writeHead(404).end(JSON.stringify({ ok: false, error: 'Команду не знайдено' }))
        return
      }
      try {
        const body = await this.readBody(request)
        const decoded = decodeTransport(JSON.parse(body)) as { channel?: unknown; args?: unknown; user_id?: unknown; protocol_version?: unknown }
        if (decoded.protocol_version !== LAN_PROTOCOL_VERSION) throw new Error('Несумісні версії програм. Оновіть обидва ПК однією збіркою.')
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
    server.maxConnections = 64
    server.requestTimeout = 35_000
    server.headersTimeout = 10_000
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
    if (this.services.authenticate && this.services.discovery !== false) {
      // A blocked UDP port does not stop the already working TCP hub/manual pairing.
      try { this.discoverySocket = await startLanDiscovery(this.config.port, this.services.discovery) }
      catch { this.lastError = 'Автопошук недоступний. Головний ПК можна підключити за його локальною IP-адресою.' }
    }
  }

  private readBody(request: NodeJS.ReadableStream, limit = MAX_BODY_BYTES): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) {
          chunks.length = 0
          reject(new Error('Передано забагато даних'))
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      request.on('error', reject)
    })
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; payload: any }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      // Keep the deadline until the body is read; headers alone are not an acknowledgment.
      const payload = await response.json().catch(error => { if (controller.signal.aborted) throw error; return null })
      return { response, payload }
    } finally {
      clearTimeout(timeout)
    }
  }
}
