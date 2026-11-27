import { api } from '@/lib/api'
import { decodeRpcValue, encodeRpcValue } from '@/lib/tillRpcCodec'
import type { ForsageDesktopBridge } from '@/lib/desktopBridge'
// Той самий перелік дій, що в програмі каси (preload): однакові назви й канали, екрани не дублюються.
import { createDesktopApi } from '../../../../desktop/src/desktopApi'
import { setRemoteBridgeSlot } from './slot'
import { phoneLanActive, phoneLanCall } from '@/lib/phoneLan/phoneLan'
import { waitForTillAnswer, type TillAnswerState } from './tillAnswer'

/**
 * 22.11.2026, рішення власника «веб повний, але робота тільки через головний ПК».
 * Коли головний ПК на зв'язку, екрани вебу отримують той самий місток, що й програма каси; кожна дія
 * виконується на головному ПК (сервер лише передає). Без головного ПК місток вимкнено — лише перегляд.
 */
let bridge: ForsageDesktopBridge | null = null
let active = 0
const publish = () => setRemoteBridgeSlot(active > 0 ? bridge : null)

async function invokeTill(channel: string, ...args: unknown[]): Promise<unknown> {
  // 27.11.2026: телефон увійшов через Wi-Fi головного ПК — дія йде прямо туди, без сервера й без інтернету.
  if (phoneLanActive()) return phoneLanCall(channel, args)
  // Сервер чекає касу до 55 с; якщо каса запит забрала, але ще виконує, він віддає номер запиту (pending),
  // і ми дочікуємося відповіді за цим номером — запит на касу вдруге не надсилається.
  const answer = await api.post<{ data?: unknown; pending?: { id: string } }>('/api/v1/till-rpc',
    { channel, args: encodeRpcValue(args), pending_ok: true }, undefined, { silent: true, timeoutMs: 70_000 })
  if (!answer.pending) return decodeRpcValue(answer.data)
  const requestId = answer.pending.id
  return decodeRpcValue(await waitForTillAnswer(async () =>
    (await api.get<{ data: TillAnswerState }>(`/api/v1/till-rpc/${requestId}`, { silent: true, timeoutMs: 10_000 })).data))
}

export async function loadRemoteBridge(): Promise<ForsageDesktopBridge> {
  bridge ??= createDesktopApi({ invoke: invokeTill }) as unknown as ForsageDesktopBridge
  return bridge
}

/** Екран, відкритий через головний ПК, вмикає місток на час свого життя. */
export function activateRemoteBridge(): () => void {
  active++
  publish()
  let released = false
  return () => { if (!released) { released = true; active = Math.max(0, active - 1); publish() } }
}
