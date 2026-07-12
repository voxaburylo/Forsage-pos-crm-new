import { useEffect, useState } from 'react'
import { Receipt } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/ui/Toast'
import { desktopBridge, type DesktopFiscalConfig } from '@/lib/desktopBridge'

// Налаштування інтеграції з ПРРО Cashalot (тільки desktop-додаток).
export function FiscalSettingsCard() {
  const [config, setConfig] = useState<DesktopFiscalConfig | null>(null)
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [statusText, setStatusText] = useState<string | null>(null)

  useEffect(() => {
    desktopBridge()?.fiscal?.getConfig()
      .then(setConfig)
      .catch(() => toast.error('Не вдалося прочитати налаштування ПРРО'))
  }, [])

  if (!config) return null

  function patch(update: Partial<DesktopFiscalConfig>) {
    setConfig((prev) => (prev ? { ...prev, ...update } : prev))
  }

  async function handleSave() {
    const desktop = desktopBridge()
    if (!desktop?.fiscal || !config) return
    if (config.enabled && !config.fiscalNumberRRO.trim()) {
      toast.error('Вкажіть фіскальний номер ПРРО')
      return
    }
    setSaving(true)
    try {
      const saved = await desktop.fiscal.setConfig({
        enabled: config.enabled,
        cashalotDir: config.cashalotDir,
        fiscalNumberRRO: config.fiscalNumberRRO,
        certificateDir: config.certificateDir || null,
        ...(password ? { keyPassword: password } : {}),
      })
      setConfig(saved)
      setPassword('')
      toast.success('Налаштування ПРРО збережено')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка збереження')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    const desktop = desktopBridge()
    if (!desktop?.fiscal) return
    setTesting(true)
    setStatusText(null)
    try {
      const result = await desktop.fiscal.status()
      setStatusText(result.JsonVal || 'Зв’язок з Кашалотом працює')
      toast.success('Кашалот відповів — інтеграція працює')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatusText('Помилка: ' + message)
      toast.error('Кашалот не відповів: ' + message)
    } finally {
      setTesting(false)
    }
  }

  async function handleRegisterCom() {
    const desktop = desktopBridge()
    if (!desktop?.fiscal) return
    setRegistering(true)
    try {
      const { registered } = await desktop.fiscal.registerCom()
      patch({ comRegistered: registered })
      if (registered) toast.success('COM-бібліотеку Кашалота зареєстровано')
      else toast.error('Реєстрація не пройшла — підтвердіть запит адміністратора (UAC)')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка реєстрації COM')
    } finally {
      setRegistering(false)
    }
  }

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent'

  return (
    <Card className="mt-6 space-y-4 border-amber-200 bg-amber-50/50">
      <div className="flex items-center justify-between gap-4 pb-2">
        <div className="flex items-center gap-2">
          <Receipt size={18} className="text-amber-600" />
          <h3 className="text-sm font-semibold text-amber-900">ПРРО Кашалот (фіскальні чеки)</h3>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input type="checkbox"
            aria-label="Увімкнути фіскалізацію через Кашалот"
            checked={config.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="sr-only peer" />
          <div className="w-9 h-5 bg-gray-200 rounded-full peer peer-checked:bg-yellow-400 peer-focus:ring-2 peer-focus:ring-yellow-200 after:content-[''] after:absolute after:top-0.5 after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
        </label>
      </div>

      <p className="text-xs text-amber-700">
        Фіскалізація чеків через встановлену програму Кашалот (COM API). Продаж із увімкненим
        «Фіскальний чек» у касі реєструється на податковій, номер і QR зберігаються в чеку.
      </p>

      {!config.comRegistered && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3">
          <p className="text-xs text-red-700">
            COM-бібліотека Кашалота ще не зареєстрована в Windows — фіскалізація не працюватиме.
            Реєстрація разова, потрібно підтвердити запит адміністратора.
          </p>
          <Button type="button" variant="secondary" loading={registering} onClick={handleRegisterCom} className="shrink-0">
            Зареєструвати
          </Button>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Фіскальний номер ПРРО</label>
          <input value={config.fiscalNumberRRO}
            onChange={(e) => patch({ fiscalNumberRRO: e.target.value })}
            placeholder="4000523261"
            className={inputClass} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Папка програми Кашалот</label>
          <input value={config.cashalotDir}
            onChange={(e) => patch({ cashalotDir: e.target.value })}
            placeholder="C:\Users\...\AppData\Local\Cashalot"
            className={inputClass} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Папка файлового ключа касира (КЕП)</label>
          <input value={config.certificateDir ?? ''}
            onChange={(e) => patch({ certificateDir: e.target.value })}
            placeholder="Порожньо — Кашалот сам спитає ключ"
            className={inputClass} />
          <p className="text-xs text-gray-400 mt-1">У папці має бути ключ і сертифікат лише одного касира</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Пароль ключа</label>
          <input type="password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={config.hasPassword ? '•••••• (збережено)' : 'Пароль КЕП'}
            autoComplete="new-password"
            className={inputClass} />
          <p className="text-xs text-gray-400 mt-1">Зберігається зашифрованим на цьому ПК</p>
        </div>
      </div>

      {statusText && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white/80 px-3 py-2 font-mono text-[11px] text-gray-700">{statusText}</pre>
      )}

      <div className="flex gap-3 pt-1">
        <Button type="button" loading={saving} onClick={handleSave}>Зберегти</Button>
        <Button type="button" variant="secondary" loading={testing} onClick={handleTest}>Перевірити зв'язок</Button>
      </div>
    </Card>
  )
}
