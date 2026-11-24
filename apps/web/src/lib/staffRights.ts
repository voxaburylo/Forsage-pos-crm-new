import { useEffect, useSyncExternalStore } from 'react'
import { desktopBridge } from './desktopBridge'
import { subscribeRemoteBridgeSlot } from './remoteDesktop/slot'
import { useAuthStore } from '@/stores/authStore'

/**
 * 24.11.2026 (рішення власника): права працівника — перемикачами в його картці («Працівники» → картка → «Права»).
 * Перемикач додає право понад роль. Правду зберігає головний ПК (apps/desktop/src/security/staffRights.ts);
 * тут — що екран знає про права того, хто увійшов. Поки головний ПК не відповів (або його немає на звʼязку) —
 * діє те, що дає роль: зайвого екран не покаже.
 */
export type StaffRight = 'orders' | 'purchase_prices' | 'reports'
export type StaffRights = Record<StaffRight, boolean>

const BY_ROLE: Record<StaffRight, readonly string[]> = {
  orders: ['owner', 'admin', 'manager'],
  purchase_prices: ['owner', 'admin', 'storekeeper'],
  reports: ['owner', 'admin', 'manager'],
}
/** Кому власник може ввімкнути право перемикачем (решта має його за роллю або не має взагалі). */
export const SWITCHABLE_RIGHTS: Record<StaffRight, readonly string[]> = {
  orders: ['cashier', 'storekeeper'],
  purchase_prices: ['cashier', 'manager'],
  reports: ['cashier'],
}

export function defaultStaffRights(role: string): StaffRights {
  return { orders: BY_ROLE.orders.includes(role), purchase_prices: BY_ROLE.purchase_prices.includes(role), reports: BY_ROLE.reports.includes(role) }
}

/** Відповідь головного ПК → права; усе незрозуміле лишається «за роллю». */
export function mergeStaffRights(role: string, answer: unknown): StaffRights {
  const base = defaultStaffRights(role)
  if (!answer || typeof answer !== 'object') return base
  const record = answer as Record<string, unknown>
  return {
    orders: base.orders || (record.orders === true && SWITCHABLE_RIGHTS.orders.includes(role)),
    purchase_prices: base.purchase_prices || (record.purchase_prices === true && SWITCHABLE_RIGHTS.purchase_prices.includes(role)),
    reports: base.reports || (record.reports === true && SWITCHABLE_RIGHTS.reports.includes(role)),
  }
}

let loaded: { userId: string; rights: StaffRights } | null = null
let loadingFor = ''
let loadedAt = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => loaded
const REFRESH_MS = 60_000

async function refresh(userId: string, role: string, force = false): Promise<void> {
  const read = desktopBridge()?.staff?.myRights
  if (!read || !userId) return
  if (loadingFor === userId || (!force && loaded?.userId === userId && Date.now() - loadedAt < REFRESH_MS)) return
  loadingFor = userId
  try {
    const rights = mergeStaffRights(role, await read())
    loaded = { userId, rights }
    loadedAt = Date.now()
    listeners.forEach(listener => listener())
  } catch { /* лишається те, що дає роль */ } finally { if (loadingFor === userId) loadingFor = '' }
}

/** Після зміни перемикача власником — щоб його власний екран не чекав хвилину (на випадок правки собі). */
export function invalidateStaffRights(): void { loadedAt = 0 }

/** Права того, хто увійшов: роль + увімкнене власником. */
export function useStaffRights(): StaffRights {
  const userId = useAuthStore(state => state.session?.user?.id ?? '')
  const role = useAuthStore(state => (state.session?.user?.app_metadata?.role as string | undefined) ?? 'cashier')
  const state = useSyncExternalStore(subscribe, snapshot, () => null)
  useEffect(() => {
    if (!userId) return
    void refresh(userId, role)
    // Веб підключився до головного ПК чи людина повернулась до вкладки — питаємо ще раз.
    const again = () => { void refresh(userId, role) }
    const unsubscribe = subscribeRemoteBridgeSlot(() => { void refresh(userId, role, true) })
    window.addEventListener('focus', again)
    return () => { unsubscribe(); window.removeEventListener('focus', again) }
  }, [userId, role])
  return state?.userId === userId ? state.rights : defaultStaffRights(role)
}
