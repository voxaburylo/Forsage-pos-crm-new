import { decodeRpcValue, encodeRpcValue } from './rpcCodec'
import { statusReportDue } from './statusReport'

/**
 * Зв'язок головного ПК із сервером власним ключем (22.11.2026, «головний ПК — тимчасовий сервер магазину»).
 *
 * Досі запити вебу забирало вікно програми під сесією того, хто увійшов: вийшов касир, перезапустився ПК,
 * зникло світло — веб до ранку показував «лише перегляд». Тепер зв'язок тримає головний процес програми
 * з ключем самого ПК: запити вебу виконуються й на екрані входу. Права не міняються — кожну дію каса
 * виконує у своїй базі з правами того працівника, що у вебі (як і команди з ПК менеджера).
 *
 * Лише звичайні запити назовні (жодних відкритих портів). Коли питати сервер:
 *  - у вебі нікого — раз на 30 с; у вебі працюють — кожні 3 с; сигнал із вікна програми — одразу.
 * На власному сервері зміниться тільки адреса (apiUrl) — решта лишиться як є.
 */
export const DEVICE_LINK_FAST_MS = 3_000
export const DEVICE_LINK_SLOW_MS = 30_000
export const DEVICE_LINK_FAST_HOLD_MS = 60_000
/** Паузи між спробами віддати відповідь серверу: дія вже виконана, відповідь не має губитися. */
export const DEVICE_ANSWER_RETRY_MS = [1_000, 3_000, 8_000, 20_000, 40_000]

export interface DeviceLinkResponse { ok: boolean; status: number; json(): Promise<unknown> }
export interface TillDeviceLinkDeps {
  fetch(url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<DeviceLinkResponse>
  /** 24.11.2026: запит помічника — будь-який метод, відповідь текстом (хід роботи ШІ приходить рядками). */
  request?(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>
  /** Адреса сервера без кінцевої риски; null — у цій збірці сервер не налаштовано. */
  apiUrl(): string | null
  deviceId(): string | null
  /** Ключ лежить у захищеному сховищі Windows; null — ключа ще немає. */
  readKey(): { token: string; tenant_id: string } | null
  /** 23.11.2026: стан черги передачі на сервер — іде з кожним «я на зв'язку», щоб сервер міг попередити власника. */
  outboxSummary?: () => { waiting: number; oldest_at: string | null; error: string | null } | null
  /** 23.11.2026 (план T2): відомості про цей комп'ютер для екрана «Стан системи» — раз на кілька хвилин. */
  statusReport?: () => unknown | null
  writeKey(key: { token: string; tenant_id: string } | null): void
  /** Виконати запит вебу в базі каси з правами його працівника. Відмова — виняток із зрозумілим текстом. */
  execute(userId: string, channel: string, args: unknown[]): Promise<unknown>
  /** Чи це головний ПК із готовою базою (не ПК менеджера, не обслуговування бази). */
  canRun(): boolean
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  sleep?: (ms: number) => Promise<void>
  onError?: (error: unknown) => void
}
export interface TillDeviceLinkStatus {
  /** Ключ є і сервер його приймає. */
  registered: boolean
  /** Сервер ключ відхилив (замінили чи відкликали) — потрібна нова видача при вході власника. */
  rejected: boolean
  tenant_id: string | null
  /** На сервері чекають команди, які виконує вікно програми під сесією працівника. */
  commands_pending: boolean
  last_ok_at: string | null
}
interface ClaimedRequest { id: string; user_id: string; channel: string; args: unknown }
interface Beat { rpc?: unknown; commands?: unknown; web_active?: unknown }

export class TillDeviceLink {
  private stopped = true
  private busy = false
  private again = false
  private timer: unknown = null
  private fastUntil = 0
  private rejected = false
  private commandsPending = false
  private statusSentAt: number | null = null
  private lastOkAt: number | null = null
  private key: { token: string; tenant_id: string } | null | undefined
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: TillDeviceLinkDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  status(): TillDeviceLinkStatus {
    const key = this.currentKey()
    // Без адреси сервера (пробна збірка) ключ нічого не дає — тоді зв'язок лишається за вікном програми.
    return { registered: Boolean(key) && !this.rejected && Boolean(this.deps.apiUrl()), rejected: this.rejected, tenant_id: key?.tenant_id ?? null,
      commands_pending: this.commandsPending, last_ok_at: this.lastOkAt === null ? null : new Date(this.lastOkAt).toISOString() }
  }

  /** Новий ключ від сервера (видає власник чи адміністратор при вході). */
  register(token: string, tenantId: string): void {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(token) || typeof tenantId !== 'string' || !tenantId) throw new Error('Некоректний ключ зв\'язку')
    this.key = { token, tenant_id: tenantId }
    this.deps.writeKey(this.key)
    this.rejected = false
    if (!this.stopped) void this.beat(true)
  }

  commandsTaken(): void { this.commandsPending = false }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.beat(false)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) (this.deps.clearTimer ?? clearTimeout as (handle: unknown) => void)(this.timer)
    this.timer = null
  }

  /** Сигнал «на сервері є робота» (його ловить вікно програми). Повертає стан після перевірки. */
  async wake(): Promise<TillDeviceLinkStatus> {
    await this.beat(true)
    return this.status()
  }

  /**
   * Дані, що живуть лише в хмарі (лист очікування, листування, пороги тривог…), для копії в базі каси.
   * null — ключа ще немає або сервер зараз недоступний; це не помилка, наступна спроба буде пізніше.
   */
  async serverData(): Promise<unknown | null> {
    if (!this.currentKey() || this.rejected || !this.deps.canRun() || !this.deps.apiUrl() || !this.deps.deviceId()) return null
    try { return await this.post('/server-data', {}, 30_000) } catch (error) { this.deps.onError?.(error); return null }
  }

  /** Чи може ПК зараз говорити із сервером власним ключем (ключ є, не відхилений, це головний ПК). */
  available(): boolean {
    return Boolean(this.currentKey()) && !this.rejected && this.deps.canRun() && Boolean(this.deps.apiUrl()) && Boolean(this.deps.deviceId())
  }

  /**
   * 23.11.2026: передача документів каси на сервер ключем ПК (див. outboxPush.ts). Помилка зв'язку летить далі —
   * викликач позначає пачку для повтору.
   */
  async syncPush(body: Record<string, unknown>): Promise<unknown> {
    if (!this.available()) throw new Error('Зв\'язок головного ПК не налаштовано')
    try { return await this.post('/sync/push', body, 60_000) } catch (error) {
      if (Number((error as { status?: number })?.status) === 401) this.rejected = true
      throw error
    }
  }

  /**
   * 24.11.2026 (власник: «прибери пароль у ШІ-помічнику»): запит помічника на сервер ключем ПК. Працівника вже
   * перевірила каса; серверу передається лише його роль. Відповідь повертається як є (код, тип, текст) — помилки
   * помічника показує екран. Лише адреси помічника: /ai/…, /vin/… і завантаження вкладення.
   */
  async assistant(input: { method: string; path: string; body?: string; role: string; staffId?: string }): Promise<{ status: number; content_type: string; text: string }> {
    const key = this.currentKey(), base = this.deps.apiUrl(), deviceId = this.deps.deviceId()
    if (!key || !base || !deviceId || !this.available()) throw new Error('Зв\'язок головного ПК не налаштовано')
    if (!isAssistantRequest(input.method, input.path)) throw new Error('Ця адреса не належить помічнику')
    if (!this.deps.request) throw new Error('Зв\'язок головного ПК не налаштовано')
    const response = await this.deps.request(base.replace(/\/$/, '') + '/api/v1/till-device' + input.path, {
      method: input.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Device ${deviceId}.${key.token}`, 'X-Forsage-Client': 'desktop', 'X-Forsage-Staff-Role': input.role, ...(input.staffId ? { 'X-Forsage-Staff-Id': input.staffId } : {}) },
      ...(input.method === 'GET' ? {} : { body: input.body ?? '{}' }),
      signal: AbortSignal.timeout(280_000),
    })
    return { status: response.status, content_type: response.headers.get('content-type') ?? '', text: await response.text() }
  }

  private currentKey() {
    if (this.key === undefined) { try { this.key = this.deps.readKey() } catch { this.key = null } }
    return this.key
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer !== null) (this.deps.clearTimer ?? clearTimeout as (handle: unknown) => void)(this.timer)
    const delay = this.now() < this.fastUntil ? DEVICE_LINK_FAST_MS : DEVICE_LINK_SLOW_MS
    this.timer = (this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => { void this.beat(false) }, delay)
  }

  private async beat(woken: boolean): Promise<void> {
    if (this.stopped) return
    if (this.busy) { this.again = this.again || woken; return }
    this.busy = true
    try {
      if (!this.currentKey() || this.rejected || !this.deps.canRun() || !this.deps.apiUrl() || !this.deps.deviceId()) return
      let outbox: unknown = null
      try { outbox = this.deps.outboxSummary?.() ?? null } catch { outbox = null }
      let status: unknown = null
      if (this.deps.statusReport && statusReportDue(this.statusSentAt, this.now())) {
        try { status = this.deps.statusReport() ?? null } catch { status = null }
      }
      const beat = (await this.post('/beat', { ...(outbox ? { outbox } : {}), ...(status ? { status } : {}) }, 10_000)) as Beat | null
      // Наступного разу — за кілька хвилин; не дійшло — повторимо з наступним «я на зв'язку».
      if (status && beat) this.statusSentAt = this.now()
      this.commandsPending = Boolean(beat?.commands)
      if (woken || beat?.web_active) this.fastUntil = this.now() + DEVICE_LINK_FAST_HOLD_MS
      if (woken || beat?.rpc) {
        const requests = ((await this.post('/rpc/claim', {}, 10_000)) ?? []) as ClaimedRequest[]
        // Виконання не чекаємо: довга дія не має затримувати наступні запити вебу.
        for (const request of requests) void this.serve(request)
        if (requests.length) this.fastUntil = this.now() + DEVICE_LINK_FAST_HOLD_MS
      }
      this.lastOkAt = this.now()
    } catch (error) {
      // 401 — сервер ключ не прийняв: не стукаємо далі, чекаємо нової видачі при вході власника.
      if (Number((error as { status?: number })?.status) === 401) this.rejected = true
      this.deps.onError?.(error)
    } finally {
      this.busy = false
      if (this.again && !this.stopped) { this.again = false; void this.beat(true) } else this.schedule()
    }
  }

  private async serve(request: ClaimedRequest): Promise<void> {
    let outcome: { status: 'done' | 'failed'; result?: unknown; error?: string }
    try {
      const args = decodeRpcValue(request.args)
      const result = await this.deps.execute(String(request.user_id), String(request.channel), Array.isArray(args) ? args : [])
      outcome = { status: 'done', result: encodeRpcValue(result ?? null) }
    } catch (error) {
      outcome = { status: 'failed', error: (error instanceof Error ? error.message : 'Каса не змогла виконати дію').slice(0, 1000) }
    }
    for (let attempt = 0; ; attempt++) {
      try { await this.post(`/rpc/${request.id}/result`, { outcome }, 15_000); return } catch (error) {
        const status = Number((error as { status?: number })?.status ?? 0)
        // 4xx — запит уже закрито або ключ не прийнято: повторювати нема чого.
        if ((status >= 400 && status < 500 && ![408, 429].includes(status)) || attempt >= DEVICE_ANSWER_RETRY_MS.length || this.stopped) {
          this.deps.onError?.(error)
          return
        }
        await this.sleep(DEVICE_ANSWER_RETRY_MS[attempt])
      }
    }
  }

  private async post(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const key = this.currentKey(), base = this.deps.apiUrl(), deviceId = this.deps.deviceId()
    if (!key || !base || !deviceId) throw new Error('Зв\'язок головного ПК не налаштовано')
    const response = await this.deps.fetch(base.replace(/\/$/, '') + '/api/v1/till-device' + path, {
      method: 'POST',
      // Заголовок каси: сервер приймає ці адреси лише від програми.
      headers: { 'Content-Type': 'application/json', Authorization: `Device ${deviceId}.${key.token}`, 'X-Forsage-Client': 'desktop' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw Object.assign(new Error('Сервер відповів HTTP ' + response.status), { status: response.status })
    const payload = await response.json() as { data?: unknown } | null
    return payload?.data ?? null
  }
}

/** Адреси помічника, які каса передає ключем ПК. Ключ ШІ (/ai/config, /ai/test) сюди не входить. */
export function isAssistantRequest(method: string, path: string): boolean {
  // 24.11.2026: розділ «Сайт» власника — теж ключем ПК (сервер пускає туди лише власника).
  if (['GET', 'POST', 'PUT', 'DELETE'].includes(method) && /^\/site-admin(?:\/[a-z][a-z-]{0,40})?$/.test(path)) return true
  // 24.11.2026: товари постачальників під замовлення (пошук) і налаштування ключів постачальників.
  // 25.11.2026: і аналоги з крос-номерів постачальника (Омега).
  if (method === 'GET' && /^\/supplier-offers\/(?:search|crosses)\?q=[A-Za-z0-9%._~-]{1,240}$/.test(path)) return true
  if (['GET', 'PUT', 'POST', 'DELETE'].includes(method) && /^\/supplier-api(?:\/[A-Za-z0-9-]{1,60}){0,2}$/.test(path)) return true
  // 24.11.2026: фото, знайдені сайтом, — головний ПК забирає список своїм ключем.
  if (method === 'GET' && /^\/(?:site|supplier)-photos(?:\?since=[A-Za-z0-9%._:-]{1,60})?$/.test(path)) return true
  if (!['GET', 'POST', 'DELETE'].includes(method)) return false
  if (path === '/assistant-upload') return method === 'POST'
  if (/^\/ai\/(config|test)(?:[/?]|$)/.test(path)) return false
  return /^\/(?:ai|vin)\/[a-z0-9][a-z0-9\/_-]{0,120}(?:\?[a-zA-Z0-9=&%._-]{0,300})?$/.test(path)
}
