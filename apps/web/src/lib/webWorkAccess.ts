import { useEffect, useSyncExternalStore } from 'react'
import { api } from '@/lib/api'
import { phoneLanCall, phoneWorksViaWifi } from '@/lib/phoneLan/phoneLan'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'

/**
 * 23.11.2026 (план B3, рішення власника): хто у вебі працює через головний ПК.
 * Власник, адміністратор і менеджер — за роллю. Касир — лише коли власник увімкнув йому «Працює через веб»
 * у картці працівника; дозвіл живе в базі головного ПК, тож веб питає про нього саме головний ПК.
 * Це лише про те, що показувати: кожну дію однаково перевіряє головний ПК.
 */
export const WEB_ROLES_BY_DEFAULT: ReadonlySet<string> = new Set(['owner', 'admin', 'manager'])
export const WEB_ACCESS_PROBE = 'desktop:access:web-work'
/** Скільки вірити відповіді головного ПК; після цього питаємо знову (власник міг перемкнути дозвіл). */
export const WEB_ACCESS_TTL_MS = 5 * 60_000
/** Головний ПК не відповів — не питаємо частіше за це. */
export const WEB_ACCESS_RETRY_MS = 30_000

type Entry = { allowed: boolean; at: number }
const answers = new Map<string, Entry>()
const asking = new Map<string, number>()
const listeners = new Set<() => void>()
const storageKey = (userId: string) => `forsage.web-work-access.${userId}`

function remember(userId: string, entry: Entry) {
  answers.set(userId, entry)
  try { sessionStorage.setItem(storageKey(userId), JSON.stringify(entry)) } catch { /* optional */ }
  for (const listener of listeners) listener()
}

function known(userId: string, now: number): Entry | null {
  let entry = answers.get(userId) ?? null
  if (!entry) {
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? 'null') as Entry | null
      if (stored && typeof stored.allowed === 'boolean' && typeof stored.at === 'number') { entry = stored; answers.set(userId, stored) }
    } catch { /* optional */ }
  }
  return entry && now - entry.at < WEB_ACCESS_TTL_MS ? entry : null
}

/** Відповідь рахується лише тоді, коли головний ПК відповів; «не на зв'язку» — не відмова, спитаємо згодом. */
export async function askWebWorkAccess(userId: string, ask: () => Promise<unknown>, now: () => number = Date.now): Promise<boolean> {
  const fresh = known(userId, now())
  if (fresh) return fresh.allowed
  const last = asking.get(userId)
  if (last !== undefined && now() - last < WEB_ACCESS_RETRY_MS) return answers.get(userId)?.allowed ?? false
  asking.set(userId, now())
  try {
    const allowed = (await ask()) === true
    remember(userId, { allowed, at: now() })
    asking.delete(userId)
    return allowed
  } catch { return answers.get(userId)?.allowed ?? false }
}

/** Для тестів і виходу з облікового запису. */
export function forgetWebWorkAccess() {
  for (const userId of answers.keys()) { try { sessionStorage.removeItem(storageKey(userId)) } catch { /* optional */ } }
  answers.clear(); asking.clear()
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** true — цей працівник у вебі працює через головний ПК. Для касира спершу false, доки ПК не відповість. */
export function useWebWorkAccess(): boolean {
  const { session } = useAuthStore()
  const role = String(session?.user?.app_metadata?.role ?? '')
  const userId = String(session?.user?.id ?? '')
  const byRole = WEB_ROLES_BY_DEFAULT.has(role)
  const probing = !byRole && role === 'cashier' && Boolean(userId) && !isDesktopRuntime()
  const granted = useSyncExternalStore(subscribe, () => probing && (known(userId, Date.now())?.allowed ?? false), () => false)
  useEffect(() => {
    if (!probing) return
    // 27.11.2026: телефон через Wi-Fi питає головний ПК напряму.
    void askWebWorkAccess(userId, async () => phoneWorksViaWifi() ? phoneLanCall(WEB_ACCESS_PROBE, []) : (await api.post<{ data?: unknown }>('/api/v1/till-rpc',
      { channel: WEB_ACCESS_PROBE, args: [] }, undefined, { silent: true, timeoutMs: 60_000 })).data)
  }, [probing, userId])
  return byRole || granted
}
