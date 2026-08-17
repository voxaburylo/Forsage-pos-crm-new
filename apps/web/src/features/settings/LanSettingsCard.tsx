import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Copy, Network, RefreshCw, WifiOff } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge, type DesktopLanMode, type DesktopLanStatus } from '@/lib/desktopBridge'

function modeDescription(mode: DesktopLanMode): string {
  if (mode === 'hub') return 'Головна база магазину. Компʼютер менеджера працює з нею напряму через локальну мережу.'
  if (mode === 'client') return 'Робоче місце менеджера. Товари, клієнти та замовлення беруться з головного ПК каси.'
  return 'Звичайна автономна робота цього компʼютера без підключення інших робочих місць.'
}

export function LanSettingsCard() {
  const lan = desktopBridge()?.lan
  const [status, setStatus] = useState<DesktopLanStatus | null>(null)
  const [mode, setMode] = useState<DesktopLanMode>('standalone')
  const [hubAddress, setHubAddress] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [allowedUserId, setAllowedUserId] = useState('')
  const [staff, setStaff] = useState<Array<{ id: string; full_name: string; role: string }>>([])
  const [port, setPort] = useState(3210)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const applyStatus = (value: DesktopLanStatus) => {
    setStatus(value)
    setMode(value.mode)
    setHubAddress(value.hubAddress)
    setAccessKey(value.accessKey)
    setAllowedUserId(value.allowedUserId)
    setPort(value.port)
  }

  useEffect(() => {
    if (!lan) return
    lan.getStatus().then(applyStatus).catch(() => {})
    desktopBridge()?.catalog.listStaff?.()
      .then((rows) => setStaff((rows ?? []).filter((row) => row.is_active !== false && ['manager', 'owner', 'admin'].includes(row.role))))
      .catch(() => setStaff([]))
  }, [lan])

  const hubUrls = useMemo(
    () => (status?.addresses ?? []).map((address) => `http://${address}:${status?.port ?? port}`),
    [status?.addresses, status?.port, port],
  )

  if (!lan) return null

  async function save() {
    setSaving(true)
    try {
      const next = await lan!.update({ mode, port, hubAddress, accessKey, allowedUserId })
      applyStatus(next)
      toast.success(mode === 'hub'
        ? 'Головний ПК відкрито для локальної мережі'
        : mode === 'client'
          ? 'Компʼютер менеджера підключено до каси'
          : 'Локальну мережу вимкнено')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти налаштування мережі')
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    setTesting(true)
    try {
      const next = await lan!.update({ mode: 'client', port, hubAddress, accessKey, allowedUserId: '' })
      applyStatus(next)
      toast.success('Звʼязок із головним ПК працює')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Головний ПК недоступний')
    } finally {
      setTesting(false)
    }
  }

  async function copy(value: string, label: string) {
    await navigator.clipboard.writeText(value)
    toast.success(`${label} скопійовано`)
  }

  return (
    <Card className="mt-6 space-y-4 border-blue-100 bg-blue-50/30">
      <div className="flex items-start gap-3 border-b border-blue-100 pb-3">
        <Network size={20} className="mt-0.5 text-blue-600" />
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Робота компʼютерів через локальну мережу</h3>
          <p className="mt-1 text-xs text-gray-500">Працює без інтернету. Усі операції виконуються в одній базі на ПК каси.</p>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        {([
          ['standalone', 'Окремий компʼютер'],
          ['hub', 'Головний ПК каси'],
          ['client', 'ПК менеджера'],
        ] as Array<[DesktopLanMode, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={`rounded-xl border px-4 py-3 text-left transition ${mode === value ? 'border-blue-500 bg-white ring-2 ring-blue-100' : 'border-gray-200 bg-white hover:border-blue-300'}`}
          >
            <span className="block text-sm font-semibold text-gray-800">{label}</span>
            <span className="mt-1 block text-[11px] leading-4 text-gray-500">{modeDescription(value)}</span>
          </button>
        ))}
      </div>

      {mode === 'hub' && (
        <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
            {status?.running ? <CheckCircle2 size={17} /> : <WifiOff size={17} />}
            {status?.running ? 'Головний ПК доступний у мережі' : 'Збережіть, щоб увімкнути головний ПК'}
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-gray-600">Хто працюватиме з другого компʼютера</span>
            <select value={allowedUserId} onChange={(event) => setAllowedUserId(event.target.value)}
              className="w-full rounded-lg border border-emerald-200 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-200">
              <option value="">Оберіть менеджера</option>
              {staff.map((user) => <option key={user.id} value={user.id}>{user.full_name} — {user.role}</option>)}
            </select>
            <p className="mt-1 text-[11px] text-emerald-800">Код працюватиме тільки з обліковим записом цього працівника.</p>
          </label>
          {hubUrls.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold text-gray-600">Адреса для ПК менеджера</p>
              {hubUrls.map((url) => (
                <button key={url} type="button" onClick={() => copy(url, 'Адресу')}
                  className="mr-2 mt-1 inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 font-mono text-xs text-gray-700 shadow-sm">
                  {url} <Copy size={13} />
                </button>
              ))}
            </div>
          )}
          {status?.accessKey && (
            <div>
              <p className="mb-1 text-xs font-semibold text-gray-600">Код підключення</p>
              <button type="button" onClick={() => copy(status.accessKey, 'Код')}
                className="inline-flex max-w-full items-center gap-2 rounded-lg bg-white px-3 py-2 font-mono text-xs text-gray-700 shadow-sm">
                <span className="truncate">{status.accessKey}</span> <Copy size={13} className="shrink-0" />
              </button>
            </div>
          )}
          <p className="text-[11px] leading-4 text-emerald-800">Коли Windows запитає дозвіл для мережі, виберіть лише «Приватні мережі». Публічні мережі дозволяти не потрібно.</p>
        </div>
      )}

      {mode === 'client' && (
        <div className="grid gap-3 rounded-xl border border-blue-200 bg-white p-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-gray-600">Адреса головного ПК</span>
            <input value={hubAddress} onChange={(event) => setHubAddress(event.target.value)}
              placeholder="192.168.1.20 або http://192.168.1.20:3210"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-gray-600">Код підключення з ПК каси</span>
            <input value={accessKey} onChange={(event) => setAccessKey(event.target.value.trim())}
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-200" />
          </label>
          <div className="md:col-span-2 flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" loading={testing} onClick={test}>
              <RefreshCw size={15} /> Перевірити звʼязок
            </Button>
            {status?.mode === 'client' && (
              <span className={`text-xs font-semibold ${status.connected ? 'text-emerald-600' : 'text-red-600'}`}>
                {status.connected ? 'Підключено до головного ПК' : status.lastError || 'Немає звʼязку'}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-gray-500">
          Порт
          <input type="number" min={1024} max={65535} value={port}
            onChange={(event) => setPort(Number(event.target.value) || 3210)}
            className="w-24 rounded-lg border border-gray-200 bg-white px-2 py-1.5" />
        </label>
        <Button type="button" loading={saving} onClick={save}>Зберегти мережу</Button>
      </div>
    </Card>
  )
}
