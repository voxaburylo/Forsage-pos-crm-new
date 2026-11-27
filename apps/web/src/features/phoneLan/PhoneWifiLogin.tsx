import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Wifi } from 'lucide-react'
import { Button } from '@/components/ui'
import { homePathForRole } from '@/components/ProtectedRoute'
import { isNativeApp, nativeScanOnce } from '@/lib/nativeScan'
import { checkPhonePairing, forgetPhonePairing, parsePhoneQr, phonePairing, savePhonePairing, validPairing } from '@/lib/phoneLan/phoneLan'
import { restorePhoneLanSession, signInViaPhoneLan } from '@/lib/phoneLan/phoneLanSession'

/** Адреса звичайної версії (та сама, що в apps/mobile/capacitor.config.ts). */
const SCREENS_URL = 'https://forsage-pos-crm-new-web.vercel.app/'

/**
 * Екран входу застосунку на телефоні: «Через Wi-Fi» — робота з головним ПК без інтернету (27.11.2026, слово власника).
 * Перший раз — сканувати QR-код на головному ПК («Налаштування» → мережа → «Телефони через Wi-Fi»), далі — лише пароль.
 * У браузері цього блоку немає: прямий звʼязок із ПК у мережі вміє лише застосунок.
 */
export function PhoneWifiLogin() {
  const navigate = useNavigate()
  // Копія екранів у застосунку (адреса localhost) відкривається саме тоді, коли сервера не видно, — блок одразу відкритий.
  const offlineCopy = typeof window !== 'undefined' && window.location.hostname === 'localhost'
  const [open, setOpen] = useState(() => Boolean(phonePairing()) || offlineCopy)
  const [paired, setPaired] = useState(() => phonePairing())
  const [password, setPassword] = useState('')
  const [manual, setManual] = useState(false)
  const [host, setHost] = useState(''), [port, setPort] = useState(''), [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const native = isNativeApp()

  // Після перезапуску застосунку сеанс через Wi-Fi ще дійсний — входимо одразу.
  useEffect(() => {
    if (!native) return
    const session = restorePhoneLanSession()
    if (session) navigate(homePathForRole(session.user.app_metadata?.role as string | undefined), { replace: true })
  }, [native, navigate])
  if (!native) return null

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не вдалося') } finally { setBusy(false) }
  }
  const pair = (next: ReturnType<typeof validPairing>) => run(async () => {
    await checkPhonePairing(next)
    savePhonePairing(next); setPaired(next); setManual(false)
  })
  const scan = () => run(async () => {
    const text = await nativeScanOnce()
    if (!text) return
    const next = parsePhoneQr(text)
    await checkPhonePairing(next)
    savePhonePairing(next); setPaired(next)
  })
  const signIn = (event: React.FormEvent) => {
    event.preventDefault()
    void run(async () => {
      const session = await signInViaPhoneLan(password)
      setPassword('')
      navigate(homePathForRole(session.user.app_metadata?.role as string | undefined), { replace: true })
    })
  }

  if (!open) return (
    <button type="button" onClick={() => setOpen(true)} data-phone-wifi-open
      className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 py-3 text-sm text-gray-700">
      <Wifi size={16} /> Немає інтернету? Через Wi-Fi з головним ПК
    </button>
  )
  return (
    <div className="mt-6 space-y-3 rounded-xl border border-gray-200 p-4" data-phone-wifi-login>
      <p className="flex items-center gap-2 text-sm font-semibold text-gray-800"><Wifi size={16} /> Через Wi-Fi з головним ПК</p>
      {!paired ? (
        <>
          <p className="text-xs text-gray-600">Один раз: на головному ПК відкрийте «Налаштування» → мережа → «Телефони через Wi-Fi» і відскануйте QR-код.</p>
          <Button type="button" className="w-full" loading={busy} onClick={() => void scan()}>Сканувати QR-код</Button>
          {!manual ? <button type="button" className="w-full text-xs text-gray-500 underline" onClick={() => setManual(true)}>Ввести адресу й код вручну</button> : (
            <div className="space-y-2">
              <input className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" placeholder="Адреса, напр. 192.168.1.10" inputMode="decimal" value={host} onChange={event => setHost(event.target.value)} />
              <input className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" placeholder="Порт" inputMode="numeric" value={port} onChange={event => setPort(event.target.value)} />
              <input className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs" placeholder="Код (32 знаки)" autoCapitalize="none" value={key} onChange={event => setKey(event.target.value)} />
              <Button type="button" className="w-full" loading={busy} onClick={() => void run(async () => { await pair(validPairing({ host, port: Number(port), key })) })}>Підключити</Button>
            </div>
          )}
        </>
      ) : (
        <form onSubmit={signIn} className="space-y-2">
          <p className="text-xs text-gray-600">Головний ПК: {paired.host}. Телефон має бути в тій самій мережі Wi-Fi, а програма на касі — відкрита.</p>
          <input type="password" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" placeholder="Ваш пароль" autoComplete="current-password"
            value={password} onChange={event => setPassword(event.target.value)} data-phone-wifi-password />
          <Button type="submit" className="w-full" loading={busy} disabled={!password}>Увійти через Wi-Fi</Button>
          <button type="button" className="w-full text-xs text-gray-500 underline" onClick={() => { forgetPhonePairing(); setPaired(null) }}>Підключити до іншого головного ПК</button>
        </form>
      )}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      {offlineCopy && <button type="button" className="w-full text-xs text-gray-500 underline" onClick={() => { window.location.href = SCREENS_URL }}>Зʼявився інтернет — відкрити звичайну версію</button>}
    </div>
  )
}
