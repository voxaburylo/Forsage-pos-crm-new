import { useEffect, useRef, useState, type ReactNode } from 'react'
import { desktopBridge, isDesktopRuntime, type DesktopLanDiscoveredHub } from '@/lib/desktopBridge'
import { lanNeedsSetup, lanPairInput, normalizeDiscoveredHubs, readLanFirstRunStatus } from '@/lib/lanFirstRun'

function FirstRunFrame({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
    <div className="bg-white rounded-2xl shadow-lg p-6 sm:p-8 w-full max-w-md">
      <h1 className="text-2xl font-bold text-gray-900">Форсаж CRM</h1>
      <p className="mt-1 mb-6 text-sm text-gray-500">Підключення робочого ПК</p>
      {children}
    </div>
  </div>
}

/** Renders login only after the safe public status has identified this device.
 * A clean manager PC never opens a standalone store or cloud bootstrap. */
export function LanFirstRun({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<'checking' | 'setup' | 'ready' | 'login' | 'blocked' | 'error'>(() =>
    isDesktopRuntime() && desktopBridge()?.lan?.firstRunStatus ? 'checking' : 'login')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!isDesktopRuntime() || !desktopBridge()?.lan?.firstRunStatus) return
    let active = true
    setPhase('checking'); setError('')
    void readLanFirstRunStatus().then(status => {
      if (!active) return
      setPhase(status?.canPair ? 'setup' : lanNeedsSetup(status) ? 'blocked' : 'login')
    }).catch(reason => {
      if (!active) return
      setError(reason instanceof Error ? reason.message : 'Не вдалося перевірити підключення')
      setPhase('error')
    })
    return () => { active = false }
  }, [retry])
  if (phase === 'login') return <>{children}</>
  return <FirstRunFrame>
    {phase === 'checking' && <p role="status" className="text-sm text-gray-600">Перевіряємо налаштування цього ПК…</p>}
    {phase === 'setup' && <PairForm onPaired={() => setPhase('ready')} />}
    {phase === 'ready' && <div className="space-y-4">
      <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">Підключення збережено.</p>
      <p className="text-sm text-gray-700">Тепер увійдіть за звичайним номером телефону та паролем. Їх перевірить головний ПК через локальну мережу — інтернет не потрібен. Код підключення повторно вводити не потрібно.</p>
      <button type="button" onClick={() => setPhase('login')} className="w-full rounded-lg bg-accent py-3 font-semibold">Перейти до входу</button>
    </div>}
    {(phase === 'blocked' || phase === 'error') && <div className="space-y-4">
      <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{phase === 'blocked'
        ? 'Налаштування підключення цього ПК пошкоджені або неповні. Збережені замовлення не видалено. Потрібно відновити підключення; автоматично прив’язувати ці дані до іншого магазину небезпечно.'
        : error}</p>
      <button type="button" onClick={() => setRetry(value => value + 1)} className="w-full rounded-lg border py-3 text-sm">Повторити перевірку</button>
    </div>}
  </FirstRunFrame>
}

function PairForm({ onPaired }: { onPaired: () => void }) {
  const [hubs, setHubs] = useState<DesktopLanDiscoveredHub[]>([])
  const [selected, setSelected] = useState('')
  const [manual, setManual] = useState(false)
  const [address, setAddress] = useState('')
  const [port, setPort] = useState('')
  const [code, setCode] = useState('')
  const [searching, setSearching] = useState(true)
  const [discoveryError, setDiscoveryError] = useState('')
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState(false)
  const discoveryVersion = useRef(0), pairingRef = useRef(false), mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void search()
    return () => { mounted.current = false; discoveryVersion.current++ }
  }, [])

  async function search() {
    if (pairingRef.current) return
    const version = ++discoveryVersion.current
    setSearching(true); setDiscoveryError('')
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const discover = desktopBridge()?.lan?.discover
      if (!discover) throw new Error('Автоматичний пошук недоступний. Введіть адресу головного ПК вручну.')
      const result = await Promise.race([
        discover(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Пошук не завершився. Перевірте локальну мережу або введіть адресу вручну.')), 10000) }),
      ])
      if (!mounted.current || discoveryVersion.current !== version) return
      const found = normalizeDiscoveredHubs(result)
      setHubs(found)
      setSelected(current => found.some(hub => hub.address === current) ? current : found.length === 1 ? found[0].address : '')
      if (!found.length) setManual(true)
    } catch (reason) {
      if (!mounted.current || discoveryVersion.current !== version) return
      setDiscoveryError(reason instanceof Error ? reason.message : 'Не вдалося знайти головний ПК')
      setManual(true)
    } finally {
      if (timeout) clearTimeout(timeout)
      if (mounted.current && discoveryVersion.current === version) setSearching(false)
    }
  }

  async function pair(event: React.FormEvent) {
    event.preventDefault()
    if (pairingRef.current || searching) return
    setError('')
    pairingRef.current = true; setPairing(true)
    try {
      const input = lanPairInput(manual ? address : selected, code, manual ? port : '')
      const save = desktopBridge()?.lan?.pair
      if (!save) throw new Error('Ця версія програми не підтримує підключення. Потрібне оновлення.')
      const result = await save(input)
      if (result?.mode !== 'client' || result.configured !== true) throw new Error('Підключення не підтверджене. Повторіть перевірку.')
      if (mounted.current) { setCode(''); onPaired() }
    } catch (reason) {
      if (!mounted.current) return
      // A lost IPC reply is not proof that persistence failed. Confirm the
      // safe status before offering another pairing attempt.
      try {
        const status = await readLanFirstRunStatus()
        if (mounted.current && status?.mode === 'client' && status.configured) { setCode(''); onPaired(); return }
      } catch { /* retain the pairing error, never fall through to login */ }
      if (mounted.current) {
        setCode('')
        setError(reason instanceof Error ? reason.message : 'Не вдалося підключити цей ПК')
      }
    } finally {
      pairingRef.current = false
      if (mounted.current) setPairing(false)
    }
  }

  return <form onSubmit={pair} className="space-y-4">
    <p className="text-sm text-gray-600">Головний ПК має бути ввімкнений, а обидва комп’ютери — в одній локальній мережі. Новий магазин та окрему базу товарів тут не створюємо.</p>
    <fieldset disabled={pairing} className="space-y-4 disabled:opacity-60">
      {searching ? <p role="status" className="text-sm text-gray-600">Шукаємо головний ПК у локальній мережі…</p> : <>
        {discoveryError && <p className="text-sm text-amber-800">{discoveryError}</p>}
        {!hubs.length && !discoveryError && <p className="text-sm text-gray-600">Головний ПК автоматично не знайдено. Можна ввести його адресу вручну.</p>}
        {hubs.length > 0 && <label className="block text-sm text-gray-700">Головний ПК
          <select aria-label="Головний ПК" value={selected} onChange={event => { setSelected(event.target.value); setManual(false) }} disabled={manual} className="mt-1 block w-full rounded-lg border p-3">
            {hubs.length > 1 && <option value="">Виберіть потрібний комп’ютер</option>}
            {hubs.map(hub => <option key={hub.address} value={hub.address}>{hub.name} — {hub.address}</option>)}
          </select>
        </label>}
      </>}
      <div className="flex flex-wrap gap-3 text-sm">
        <button type="button" disabled={searching} onClick={() => { void search() }} className="text-gray-700 underline disabled:opacity-50">Повторити пошук</button>
        <label className="flex items-center gap-2"><input type="checkbox" checked={manual} onChange={event => setManual(event.target.checked)} />Ввести адресу вручну</label>
      </div>
      {manual && <div className="space-y-3">
        <label className="block text-sm text-gray-700">Адреса головного ПК
          <input value={address} onChange={event => setAddress(event.target.value)} placeholder="192.168.1.10" maxLength={256} autoComplete="off" className="mt-1 block w-full rounded-lg border p-3" />
        </label>
        <label className="block text-sm text-gray-700">Порт (зазвичай 3210)
          <input value={port} onChange={event => setPort(event.target.value)} placeholder="3210" inputMode="numeric" autoComplete="off" className="mt-1 block w-full rounded-lg border p-3" />
        </label>
      </div>}
      <label className="block text-sm text-gray-700">Код підключення
        <input type="password" value={code} onChange={event => setCode(event.target.value)} maxLength={256} autoComplete="off" spellCheck={false} className="mt-1 block w-full rounded-lg border p-3" />
      </label>
      <p className="text-xs text-gray-500">Код надає власник із налаштувань локальної мережі головного ПК. Це не пароль працівника; код потрібний лише для підключення цього комп’ютера.</p>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={searching || pairing || !(manual ? address.trim() : selected) || !code.trim()} className="w-full rounded-lg bg-accent py-3 font-semibold disabled:opacity-50">{pairing ? 'Підключаємо…' : 'Підключити цей ПК'}</button>
    </fieldset>
  </form>
}
