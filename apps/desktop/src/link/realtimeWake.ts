/**
 * 23.11.2026: сигнал «у вебі є робота» для головного ПК у ФОНОВОМУ режимі (без вікна).
 * Сигнал слухало лише вікно програми (useTillLink). Без вікна каса сама питала сервер раз на 3–30 с, і запити вебу
 * чекали 1–11 с замість 0,3 с (виміряно 23.11 о 12:24–12:46). Тут те саме підписання на Supabase Realtime, але в
 * головному процесі, без бібліотек: WebSocket (Node 24) і протокол Phoenix. Сигнал без даних — лише «прокинься»;
 * зв'язок і права, як і раніше, стереже ключ ПК. Транспорт замінний (власний сервер — довге з'єднання).
 */
export interface WakeSocket {
  readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}
export interface RealtimeWakeDeps {
  /** https://<project>.supabase.co */
  url: () => string | null
  apiKey: () => string | null
  /** till-rpc-<tenant> — той самий топік, у який шле сервер (tillWake.ts). */
  topic: () => string | null
  onWake: () => void
  socket?: (url: string) => WakeSocket
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export const WAKE_HEARTBEAT_MS = 25_000
export const WAKE_RECONNECT_MS = [2_000, 5_000, 15_000, 30_000, 60_000]
const OPEN = 1

export function realtimeSocketUrl(base: string, apiKey: string): string {
  const url = new URL(base)
  if (url.protocol !== 'https:') throw new Error('Realtime лише через https')
  return `wss://${url.host}/realtime/v1/websocket?apikey=${encodeURIComponent(apiKey)}&vsn=1.0.0`
}

export class RealtimeWake {
  private socket: WakeSocket | null = null
  private heartbeat: unknown = null
  private reconnect: unknown = null
  private attempt = 0
  private ref = 0
  private stopped = true
  private joinedTopic = ''

  constructor(private readonly deps: RealtimeWakeDeps) {}

  private timer(run: () => void, ms: number) { return (this.deps.setTimer ?? ((r, m) => setTimeout(r, m)))(run, ms) }
  private clear(handle: unknown) { if (handle !== null) (this.deps.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle) }
  private send(message: Record<string, unknown>) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify({ ...message, ref: String(++this.ref) }))
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clear(this.heartbeat); this.heartbeat = null
    this.clear(this.reconnect); this.reconnect = null
    const socket = this.socket; this.socket = null
    try { socket?.close() } catch { /* already closed */ }
  }

  private connect(): void {
    if (this.stopped) return
    const base = this.deps.url(), key = this.deps.apiKey(), topic = this.deps.topic()
    // Ключа зв'язку ще немає (ніхто не входив) — спробуємо пізніше.
    if (!base || !key || !topic) { this.retry(); return }
    let socket: WakeSocket
    try {
      socket = (this.deps.socket ?? (address => new WebSocket(address) as unknown as WakeSocket))(realtimeSocketUrl(base, key))
    } catch { this.retry(); return }
    this.socket = socket
    this.joinedTopic = 'realtime:' + topic
    socket.onopen = () => {
      this.attempt = 0
      this.send({ topic: this.joinedTopic, event: 'phx_join', payload: { config: { broadcast: { self: false }, presence: { key: '' } } } })
      this.clear(this.heartbeat)
      const beat = () => { this.send({ topic: 'phoenix', event: 'heartbeat', payload: {} }); this.heartbeat = this.timer(beat, WAKE_HEARTBEAT_MS) }
      this.heartbeat = this.timer(beat, WAKE_HEARTBEAT_MS)
      // Поки нас не було — могла прийти робота: одразу питаємо касу.
      this.deps.onWake()
    }
    socket.onmessage = event => {
      let message: { topic?: unknown; event?: unknown; payload?: { event?: unknown } } | null = null
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message?.topic === this.joinedTopic && message.event === 'broadcast' && message.payload?.event === 'wake') this.deps.onWake()
    }
    socket.onerror = () => { /* onclose піде слідом */ }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.clear(this.heartbeat); this.heartbeat = null
      this.retry()
    }
  }

  private retry(): void {
    if (this.stopped) return
    this.clear(this.reconnect)
    const delay = WAKE_RECONNECT_MS[Math.min(this.attempt++, WAKE_RECONNECT_MS.length - 1)]
    this.reconnect = this.timer(() => { this.reconnect = null; this.connect() }, delay)
  }
}
