import { api } from '@/lib/api'
import { isNativeApp } from '@/lib/nativeScan'
import { decodeRpcValue } from '@/lib/tillRpcCodec'
import { phoneLanStored, phoneWorksViaWifi, savePhoneLanAccess, type PhoneLanStored } from './phoneLan'

/**
 * Автоматичне підключення телефона до головного ПК (27.11.2026, слово власника: «щоб нічого не сканувати: пропав
 * інтернет — працюємо офлайн автоматом»). Поки є інтернет і людина увійшла, застосунок від її імені питає головний ПК
 * (через сервер, як будь-яку дію вебу): «куди йти без інтернету?». ПК відповідає своїми адресами в мережі, кодом каналу
 * й сеансом Wi-Fi саме цього працівника. Повторює раз на кілька годин (адреса ПК могла змінитися) і після кожного входу.
 */
export const OFFLINE_COPY_URL = 'https://localhost/index.html'
export const PHONE_WIFI_CHANNEL = 'desktop:phone:wifi-pairing'
const REFRESH_EVERY_MS = 6 * 60 * 60_000

/** Чи час оновити: немає сеансу, інший працівник, сеанс скоро скінчиться або давно не оновлювали. */
export function needsPhoneWifiRefresh(stored: PhoneLanStored | null, userId: string, now = Date.now()): boolean {
  if (!stored?.token || stored.user?.id !== userId || !stored.expires_at) return true
  if (Date.parse(stored.expires_at) - now < 3 * 24 * 60 * 60_000) return true
  return !stored.refreshed_at || now - Date.parse(stored.refreshed_at) > REFRESH_EVERY_MS
}

let flight: Promise<void> | null = null
export function refreshPhoneWifiAccess(userId: string, force = false): Promise<void> {
  if (!isNativeApp() || phoneWorksViaWifi() || !userId) return Promise.resolve()
  if (!force && !needsPhoneWifiRefresh(phoneLanStored(), userId)) return Promise.resolve()
  flight ??= (async () => {
    try {
      const answer = await api.post<{ data?: unknown }>('/api/v1/till-rpc', { channel: PHONE_WIFI_CHANNEL, args: [] }, undefined, { silent: true, timeoutMs: 60_000 })
      const result = decodeRpcValue(answer.data) as { hosts?: unknown; port?: unknown; key?: unknown; token?: unknown; expires_at?: unknown; user?: PhoneLanStored['user'] } | null
      if (!result || typeof result.token !== 'string' || typeof result.expires_at !== 'string' || result.user?.id !== userId) return
      savePhoneLanAccess({ pairing: { hosts: result.hosts as string[], port: Number(result.port), key: String(result.key) },
        token: result.token, expires_at: result.expires_at, user: result.user, refreshed_at: new Date().toISOString() })
    } catch { /* головний ПК не на звʼязку або касир без «Працює через веб» — спробуємо пізніше */ }
    finally { flight = null }
  })()
  return flight
}

/** Перейти на копію екранів у застосунку (без інтернету). Робиться лише коли є дійсний сеанс Wi-Fi. */
export function openOfflineCopy(): void { window.location.href = OFFLINE_COPY_URL }
export const isOfflineCopy = () => typeof window !== 'undefined' && window.location.hostname === 'localhost'
