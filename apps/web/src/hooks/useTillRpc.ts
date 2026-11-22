import { api } from '@/lib/api'
import type { ForsageDesktopBridge } from '@/lib/desktopBridge'
import { decodeRpcValue, encodeRpcValue } from '@/lib/tillRpcCodec'

interface ClaimedRequest { id: string; user_id: string; channel: string; args: unknown[] }
export interface TillLinkContext { bridge: ForsageDesktopBridge; deviceId: string }
type Outcome = { status: 'done' | 'failed'; result?: unknown; error?: string }

/** Паузи між спробами віддати відповідь каси серверу (разом близько хвилини). */
export const ANSWER_RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 20_000, 40_000]

/**
 * Відповідь каси не має губитися через блимання мережі: дія вже виконана у базі каси, а веб чекає
 * саме на неї. Повторюємо кілька разів; відмову сервера «такого запиту вже немає» (4xx) не повторюємо.
 */
export async function deliverTillAnswer(
  send: () => Promise<unknown>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  delays: readonly number[] = ANSWER_RETRY_DELAYS_MS,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try { await send(); return true } catch (error) {
      const status = Number((error as { status?: number })?.status ?? 0)
      const final = status >= 400 && status < 500 && ![401, 408, 429].includes(status)
      if (final || attempt >= delays.length) return false
      await sleep(delays[attempt])
    }
  }
}

async function serveWebRequest(execute: NonNullable<NonNullable<ForsageDesktopBridge['auth']>['executeWebRequest']>, deviceId: string, request: ClaimedRequest): Promise<void> {
  let outcome: Outcome
  try {
    const result = await execute(request.user_id, request.channel, decodeRpcValue(request.args) as unknown[])
    outcome = { status: 'done', result: encodeRpcValue(result ?? null) }
  } catch (error) {
    outcome = { status: 'failed', error: (error instanceof Error ? error.message : 'Каса не змогла виконати дію').slice(0, 1000) }
  }
  await deliverTillAnswer(() => api.post(`/api/v1/till-rpc/${request.id}/result`, { device_id: deviceId, outcome }, undefined, { silent: true, timeoutMs: 15_000 }))
}

/**
 * 22.11.2026, рішення власника «веб повний, але тільки через головний ПК».
 * Головна каса забирає запити вебу, виконує кожен у своїй базі від імені працівника з вебу (головний процес
 * перевіряє канал і права) і повертає відповідь. Коли питати сервер — вирішує useTillLink.
 * Виконання не чекаємо: довга дія не має затримувати наступні запити вебу. Повертає, скільки запитів забрано.
 */
export async function claimWebRequests({ bridge, deviceId }: TillLinkContext): Promise<number> {
  const execute = bridge.auth?.executeWebRequest
  if (!execute) return 0
  const { data } = await api.post<{ data: ClaimedRequest[] }>('/api/v1/till-rpc/claim', { device_id: deviceId }, undefined, { silent: true, timeoutMs: 10_000 })
  for (const request of data) void serveWebRequest(execute, deviceId, request)
  return data.length
}
