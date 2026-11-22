import { api } from '@/lib/api'
import { decodeRpcValue, encodeRpcValue } from '@/lib/tillRpcCodec'
import type { ForsageDesktopBridge } from '@/lib/desktopBridge'
// Той самий перелік дій, що в програмі каси (preload): однакові назви й канали, екрани не дублюються.
import { createDesktopApi } from '../../../../desktop/src/desktopApi'
import { setRemoteBridgeSlot } from './slot'

/**
 * 22.11.2026, рішення власника «веб повний, але робота тільки через головний ПК».
 * Коли головний ПК на зв'язку, екрани вебу отримують той самий місток, що й програма каси; кожна дія
 * виконується на головному ПК (сервер лише передає). Без головного ПК місток вимкнено — лише перегляд.
 */
let bridge: ForsageDesktopBridge | null = null
let active = 0
const publish = () => setRemoteBridgeSlot(active > 0 ? bridge : null)

async function invokeTill(channel: string, ...args: unknown[]): Promise<unknown> {
  const { data } = await api.post<{ data: unknown }>('/api/v1/till-rpc', { channel, args: encodeRpcValue(args) },
    undefined, { silent: true, timeoutMs: 35_000 })
  return decodeRpcValue(data)
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
