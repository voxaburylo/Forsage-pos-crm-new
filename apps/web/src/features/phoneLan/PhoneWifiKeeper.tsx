import { useEffect, useState } from 'react'
import { isNativeApp } from '@/lib/nativeScan'
import { useAuthStore } from '@/stores/authStore'
import { phoneLanActive, phoneWorksViaWifi } from '@/lib/phoneLan/phoneLan'
import { isOfflineCopy, openOfflineCopy, refreshPhoneWifiAccess } from '@/lib/phoneLan/phoneWifiAutoSetup'

/**
 * Застосунок на телефоні сам перемикається між інтернетом і Wi-Fi головного ПК (27.11.2026, слово власника:
 * «щоб нічого не сканувати: пропав інтернет — працюємо офлайн автоматом»).
 *  - Є інтернет і людина увійшла — тихо отримує від головного ПК доступ через Wi-Fi (раз на кілька годин).
 *  - Телефон втратив звʼязок (подія offline) — відкриває копію екранів у застосунку, вона сама входить сеансом Wi-Fi.
 *  - У копії без інтернету: щойно інтернет повернувся — кнопка «Перейти на звичайну версію» (не перемикає сама,
 *    щоб не перервати чек на півдорозі).
 * У браузері нічого не робить.
 */
const SCREENS_URL = 'https://forsage-pos-crm-new-web.vercel.app/'
const INTERNET_CHECK_MS = 30_000

export function PhoneWifiKeeper() {
  const native = isNativeApp()
  const userId = useAuthStore(store => store.session?.user?.id ?? '')
  const offlineMode = useAuthStore(store => store.offlineMode)
  const [internetBack, setInternetBack] = useState(false)

  useEffect(() => {
    if (!native || !userId || offlineMode || isOfflineCopy()) return
    void refreshPhoneWifiAccess(userId)
  }, [native, userId, offlineMode])

  useEffect(() => {
    if (!native || isOfflineCopy()) return
    const lost = () => { if (phoneLanActive()) openOfflineCopy() }
    window.addEventListener('offline', lost)
    return () => window.removeEventListener('offline', lost)
  }, [native])

  useEffect(() => {
    if (!native || !isOfflineCopy()) return
    let stopped = false
    const check = async () => {
      const ok = await fetch(SCREENS_URL + 'api/v1/health', { cache: 'no-store', signal: AbortSignal.timeout(8_000) }).then(response => response.ok, () => false)
      if (!stopped) setInternetBack(ok)
    }
    void check()
    const timer = window.setInterval(() => { void check() }, INTERNET_CHECK_MS)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [native])

  if (!native || !isOfflineCopy()) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center p-1 print:hidden" data-phone-wifi-mode>
      {internetBack ? (
        <button type="button" onClick={() => { window.location.href = SCREENS_URL }}
          className="pointer-events-auto rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white shadow">Інтернет є — перейти на звичайну версію</button>
      ) : phoneWorksViaWifi() ? (
        <span className="rounded-full bg-amber-500/90 px-3 py-0.5 text-[11px] font-semibold text-black">Без інтернету — через Wi-Fi головного ПК</span>
      ) : null}
    </div>
  )
}
