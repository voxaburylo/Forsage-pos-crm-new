import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Monitor, WifiOff } from 'lucide-react'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { api } from '@/lib/api'
import { isUserWatching } from '@/lib/userActivity'
import { useWebWorkAccess } from '@/lib/webWorkAccess'
import { Layout } from '@/components/Layout'
import { Card } from '@/components/ui'

/**
 * Розділи, які змінюють дані.
 *
 * Рішення власника (06.09.2026): робоча база одна — та, що на касі. Рішення 22.11.2026: «веб повний, але робота
 * тільки через головний ПК, щоб нічого не задвоїлось». Тож у вебі такий екран відкривається, лише коли головний
 * ПК на зв'язку, і кожна дія виконується на ньому — тим самим кодом і з правами того самого працівника, що й на
 * ПК менеджера. Головний ПК вимкнено — лише перегляд. Сервер це теж стереже (localFirstWriteGuard, till-rpc).
 *
 * remote={false} — екран лише на самій касі (друк етикеток, очищення номенклатури). Продаж, повернення й гроші з
 * 27.11.2026 теж ідуть через головний ПК (рішення власника: фіскалізація поки не працює, потрібна повна версія на телефоні).
 */
export function TillOnly({ children, what, remote = true, offline }: { children: React.ReactNode; what: string; remote?: boolean; offline?: React.ReactNode }) {
  if (isDesktopRuntime()) return <>{children}</>
  if (!remote) return <ViewOnlyCard what={what} reason="till-only" />
  return <ThroughMainPc what={what} offline={offline}>{children}</ThroughMainPc>
}

const STATUS_POLL_MS = 20_000

type State = 'checking' | 'online' | 'offline'

/**
 * Зв'язок екрана вебу з головним ПК: стан (опитування сервера) і місток, який живе, доки відкритий екран.
 * Спільний для TillOnly (екран лише через ПК) і MainPcWhenOnline (перегляд, а з ПК — повна робота).
 */
/**
 * 27.11.2026 (проба застосунку на телефоні: «швидкість низька»): кожен екран починав із запиту «чи на звʼязку головний ПК»
 * і до відповіді показував лише «Перевіряємо звʼязок…» — а сервер під навантаженням відповідав 3–10 с. Тепер остання
 * відповідь памʼятається: наступний екран відкривається одразу з нею, а перевірка йде у фоні й виправить стан, якщо він змінився.
 */
const LINK_MEMORY_MS = 3 * 60_000
let lastLink: { state: Exclude<State, 'checking'>; at: number } | null = null
export function rememberedLink(now = Date.now()): State {
  return lastLink && now - lastLink.at < LINK_MEMORY_MS ? lastLink.state : 'checking'
}
export function rememberLink(state: Exclude<State, 'checking'>, now = Date.now()): void { lastLink = { state, at: now } }

function useMainPcLink(allowed: boolean): { state: State; ready: boolean } {
  const [state, setState] = useState<State>(() => rememberedLink())
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!allowed) return
    let stopped = false
    async function check() {
      // watch=0 — вкладка схована або людина давно нічого не натискала: тоді сервер не просить касу опитувати його часто.
      const online = await api.get<{ data: { online: boolean } }>('/api/v1/till-commands/status' + (isUserWatching() ? '' : '?watch=0'), { silent: true, timeoutMs: 10_000 })
        .then(result => Boolean(result.data?.online), () => false)
      rememberLink(online ? 'online' : 'offline')
      if (!stopped) setState(online ? 'online' : 'offline')
    }
    void check()
    const timer = window.setInterval(() => { void check() }, STATUS_POLL_MS)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [allowed])

  // Місток вмикається, щойно ПК вперше відповів, і живе, доки відкритий екран. Якщо ПК зник,
  // екран лишається (щоб не втратити введене), а дії відповідають «головний ПК не на зв'язку».
  const release = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (state !== 'online' || ready) return
    let cancelled = false
    void import('@/lib/remoteDesktop/remoteDesktop').then(async module => {
      await module.loadRemoteBridge()
      if (cancelled || release.current) return
      release.current = module.activateRemoteBridge()
      setReady(true)
    }).catch(() => { if (!cancelled) setState('offline') })
    return () => { cancelled = true }
  }, [state, ready])
  useEffect(() => () => { release.current?.(); release.current = null }, [])
  return { state, ready }
}

// 23.11.2026 (власник): напис «Працює через головний ПК» закривав перемикання сторінок на телефоні.
// Тепер це лише крапка в кутку: зелена — ПК на звʼязку, червона — ні. Вона не перехоплює натискань.
function MainPcBadge({ state }: { state: State }) {
  const text = state === 'offline' ? 'Головний ПК не на звʼязку — зміни зараз не пройдуть' : 'Працює через головний ПК'
  return (
    <span className={`pointer-events-none fixed bottom-1 right-1 z-40 h-2.5 w-2.5 rounded-full ring-2 ring-white ${state === 'offline' ? 'bg-red-600' : 'bg-emerald-500'}`}
      role="status" aria-label={text} title={text} data-main-pc-link={state} />
  )
}

/**
 * 23.11.2026, план 4.1 «веб через головний ПК — кожен екран»: екрани перегляду (товари, клієнти, замовлення, звіти,
 * зарплата) у вебі теж працюють повністю, коли головний ПК на зв'язку: усі зміни виконує він. Без ПК — той самий
 * екран лише для перегляду серверної копії (як і раніше), а не заглушка. Касир без дозволу й комірник — лише перегляд.
 * view — окремий екран перегляду для вебу без ПК (якщо повний екран без ПК не працює, напр. замовлення).
 */
export function MainPcWhenOnline({ children, view }: { children: React.ReactNode; view?: React.ReactNode }) {
  // Власник, адміністратор, менеджер — за роллю; касир — із дозволом «Працює через веб» (lib/webWorkAccess).
  const viaWeb = useWebWorkAccess()
  const desktop = isDesktopRuntime()
  const allowed = !desktop && viaWeb
  const { state, ready } = useMainPcLink(allowed)
  if (desktop) return <>{children}</>
  if (!allowed) return <>{view ?? children}</>
  if (!ready) {
    if (state === 'checking') return <Layout><p className="py-10 text-center text-sm text-gray-500" role="status">Перевіряємо звʼязок із головним ПК…</p></Layout>
    // Без ПК — перегляд. Коли ПК зʼявиться, екран відкриється заново вже з повною роботою (key нижче).
    return <div key="view" data-main-pc-mode="view">{view ?? children}</div>
  }
  return <div key="main-pc" data-main-pc-mode="main-pc"><MainPcBadge state={state} />{children}</div>
}

/** offline — що можна зробити й без головного ПК (не стосується залишків і грошей); показується під карткою. */
function ThroughMainPc({ what, children, offline }: { what: string; children: React.ReactNode; offline?: React.ReactNode }) {
  const allowed = useWebWorkAccess()
  const { state, ready } = useMainPcLink(allowed)

  if (!allowed) return <ViewOnlyCard what={what} reason="role" />
  if (!ready) return state === 'offline' ? <ViewOnlyCard what={what} reason="offline">{offline}</ViewOnlyCard> : (
    <Layout><p className="py-10 text-center text-sm text-gray-500" role="status">Підключаємось до головного ПК…</p></Layout>
  )
  return (
    <>
      <MainPcBadge state={state} />
      {children}
    </>
  )
}

function ViewOnlyCard({ what, reason, children }: { what: string; reason: 'till-only' | 'offline' | 'role'; children?: React.ReactNode }) {
  const text = reason === 'offline'
    ? 'Головний ПК зараз не на звʼязку. Щойно програма на касі запуститься й матиме інтернет, цей розділ відкриється тут — і всі дії виконуватимуться на касі.'
    : reason === 'role'
      ? 'Через веб цей розділ відкривають власник, адміністратор, менеджер і касир, якому власник увімкнув «Працює через веб» у картці працівника. Працюйте на касі.'
      : 'Цей розділ працює лише на самій касі.'
  return (
    <Layout>
      <div className="mx-auto max-w-lg py-10">
        <Card>
          <div className="flex flex-col items-center gap-4 px-6 py-8 text-center">
            <span className="rounded-full bg-amber-50 p-3 text-amber-600">
              {reason === 'offline' ? <WifiOff size={28} /> : <Monitor size={28} />}
            </span>
            <div>
              <h1 className="text-lg font-semibold text-gray-900">{what} — {reason === 'offline' ? 'головний ПК не на звʼязку' : 'тільки на касі'}</h1>
              <p className="mt-2 text-sm text-gray-600">{text}</p>
              <p className="mt-2 text-sm text-gray-600">Переглядати продажі, аналітику, товари й замовлення можна й зараз.</p>
            </div>
            <Link to="/analytics" className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800">
              До аналітики
            </Link>
          </div>
        </Card>
      </div>
      {children}
    </Layout>
  )
}

/** На касі — повний робочий екран; у вебі — окремий екран лише для перегляду копії. */
export function TillOrView({ till, view }: { till: React.ReactNode; view: React.ReactNode }) {
  return <>{isDesktopRuntime() ? till : view}</>
}
