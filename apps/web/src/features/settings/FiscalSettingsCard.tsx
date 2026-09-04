import { useEffect, useState } from 'react'
import { Receipt, FolderOpen } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge, type DesktopFiscalConfig, type DesktopFiscalResult } from '@/lib/desktopBridge'

// Повна панель налаштування ПРРО Cashalot (тільки desktop-додаток).
// Дозволяє власнику самостійно підключити й перевірити фіскалізацію, а також
// вручну керувати зміною (відкрити/закрити, X/Z-звіт, службові внесення/видача).

interface ParsedStatus {
  shiftState?: string
  licEndDate?: string
  raw: string
}

function parseStatus(result: DesktopFiscalResult): ParsedStatus {
  const raw = result.JsonVal || result.Description || ''
  try {
    const json = JSON.parse(result.JsonVal || '{}')
    const values = json.Values ?? {}
    return {
      shiftState: values.ShiftStateStr ?? values.ShiftState,
      licEndDate: values.LicEndDate,
      raw,
    }
  } catch {
    return { raw }
  }
}

function shiftStateLabel(state?: string): string {
  if (!state) return '—'
  const map: Record<string, string> = {
    ShiftOpened: 'Зміна відкрита',
    ShiftClosed: 'Зміна закрита',
    ShiftsIsAbsent: 'Зміна не відкрита',
    '0': 'Зміна не відкрита',
    '1': 'Зміна відкрита',
  }
  return map[state] ?? state
}

export function FiscalSettingsCard() {
  const [config, setConfig] = useState<DesktopFiscalConfig | null>(null)
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<ParsedStatus | null>(null)
  const [cashDirection, setCashDirection] = useState<'in' | 'out' | null>(null)
  const [cashAmount, setCashAmount] = useState('')

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

  async function pickFolder(field: 'cashalotDir' | 'certificateDir') {
    const desktop = desktopBridge()
    if (!desktop?.fiscal) return
    const picked = await desktop.fiscal.pickFolder(config?.[field] ?? undefined).catch(() => null)
    if (picked) patch({ [field]: picked } as Partial<DesktopFiscalConfig>)
  }

  // Обгортка для дій, що вимагають зв'язку з Кашалотом
  async function runAction(key: string, action: () => Promise<DesktopFiscalResult | { registered: boolean }>, okMsg: string) {
    setBusy(key)
    try {
      const result = await action()
      if ('registered' in result) {
        if (result.registered) toast.success('COM-бібліотеку Кашалота зареєстровано')
        else toast.error('Реєстрація не пройшла')
        patch({ comRegistered: (result as { registered: boolean }).registered })
      } else {
        toast.success(okMsg)
        setStatus(parseStatus(result))
      }
    } catch (err) {
      toast.error((err instanceof Error ? err.message : 'Помилка') + '')
    } finally {
      setBusy(null)
    }
  }

  // Суму питаємо власною модалкою: Electron не реалізує window.prompt(),
  // тож на касі кнопки внесення/видачі просто мовчали.
  function askServiceCash(direction: 'in' | 'out') {
    if (!desktopBridge()?.fiscal) return
    setCashDirection(direction)
    setCashAmount('')
  }

  function submitServiceCash() {
    const desktop = desktopBridge()
    if (!desktop?.fiscal || !cashDirection) return
    const kopecks = Math.round(parseFloat(String(cashAmount).replace(',', '.')) * 100)
    if (!Number.isFinite(kopecks) || kopecks <= 0) { toast.error('Некоректна сума'); return }
    const direction = cashDirection
    setCashDirection(null)
    runAction('service', () => desktop.fiscal.serviceCash(kopecks, direction), direction === 'in' ? 'Внесення проведено' : 'Видачу проведено')
  }

  const desktop = desktopBridge()
  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent'

  return (
    <Card className="mt-6 space-y-4 border-amber-200 bg-amber-50/50">
      <div className="flex items-center justify-between gap-4 pb-2">
        <div className="flex items-center gap-2">
          <Receipt size={18} className="text-amber-600" />
          <h3 className="text-sm font-semibold text-amber-900">ПРРО Кашалот (фіскальні чеки)</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-500">
            {config.enabled ? 'Увімкнено' : 'Вимкнено'}
          </span>
          <label className="relative inline-flex items-center cursor-pointer">
          <input type="checkbox"
            aria-label="Увімкнути фіскалізацію через Кашалот"
            checked={config.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="sr-only peer" />
          <div className="w-9 h-5 bg-gray-200 rounded-full peer peer-checked:bg-yellow-400 peer-focus:ring-2 peer-focus:ring-yellow-200 after:content-[''] after:absolute after:top-0.5 after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
        </label>
        </div>
      </div>

      <p className="text-xs text-amber-700">
        Фіскалізація чеків через встановлену програму Кашалот (COM API). Продаж із увімкненим
        «Фіскальний чек» у касі реєструється на податковій, номер і QR зберігаються в чеку.
      </p>

      {/* Крок 1: реєстрація COM */}
      <div className="rounded-xl border border-amber-200 bg-white/70 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-gray-700">1. Реєстрація бібліотеки Кашалота</p>
            <p className="text-xs text-gray-500">
              {config.comRegistered
                ? '✓ Зареєстровано на цьому ПК'
                : 'Разова дія для поточного користувача (без прав адміністратора)'}
            </p>
          </div>
          <Button type="button" variant="secondary"
            loading={busy === 'register'}
            onClick={() => runAction('register', () => desktop!.fiscal.registerCom(), '')}>
            {config.comRegistered ? 'Перереєструвати' : 'Зареєструвати'}
          </Button>
        </div>
      </div>

      {/* Крок 2: параметри підключення */}
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
          <div className="flex gap-2">
            <input value={config.cashalotDir}
              onChange={(e) => patch({ cashalotDir: e.target.value })}
              placeholder="C:\Users\...\AppData\Local\Cashalot"
              className={inputClass} />
            <button type="button" onClick={() => pickFolder('cashalotDir')}
              className="shrink-0 rounded-lg border border-gray-200 px-3 hover:bg-gray-50" title="Вибрати папку">
              <FolderOpen size={16} className="text-gray-500" />
            </button>
          </div>
          {!config.dllFound && (
            <p className="mt-1 text-xs text-amber-700">
              У цій папці нема CashalotApi64.dll — фіскальний чек не пройде. Вкажіть папку, куди встановлено Кашалот.
            </p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Папка файлового ключа касира (КЕП)</label>
          <div className="flex gap-2">
            <input value={config.certificateDir ?? ''}
              onChange={(e) => patch({ certificateDir: e.target.value })}
              placeholder="Порожньо — Кашалот сам спитає ключ"
              className={inputClass} />
            <button type="button" onClick={() => pickFolder('certificateDir')}
              className="shrink-0 rounded-lg border border-gray-200 px-3 hover:bg-gray-50" title="Вибрати папку">
              <FolderOpen size={16} className="text-gray-500" />
            </button>
          </div>
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

      <div className="flex flex-wrap gap-3 pt-1">
        <Button type="button" loading={saving} onClick={handleSave}>Зберегти</Button>
        <Button type="button" variant="secondary" loading={busy === 'status'}
          onClick={() => runAction('status', () => desktop!.fiscal.status(), 'Кашалот відповів — зв\'язок працює')}>
          Перевірити зв'язок
        </Button>
      </div>

      {/* Читабельний статус */}
      {status && (
        <div className="rounded-xl border border-gray-200 bg-white/80 px-4 py-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-400">Стан зміни</p>
              <p className="font-semibold text-gray-800">{shiftStateLabel(status.shiftState)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-400">Ліцензія до</p>
              <p className="font-semibold text-gray-800">
                {status.licEndDate ? new Date(status.licEndDate).toLocaleDateString('uk-UA') : '—'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Крок 3: ручне керування зміною (для налаштування/діагностики) */}
      <div className="rounded-xl border border-amber-200 bg-white/70 px-4 py-3 space-y-2">
        <p className="text-xs font-semibold text-gray-700">Ручне керування ПРРО</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" loading={busy === 'open'}
            onClick={() => runAction('open', () => desktop!.fiscal.openShift(), 'Зміну ПРРО відкрито')}>
            Відкрити зміну
          </Button>
          <Button type="button" variant="secondary" loading={busy === 'close'}
            onClick={() => runAction('close', () => desktop!.fiscal.closeShift(), 'Зміну закрито, Z-звіт зареєстровано')}>
            Закрити зміну (Z-звіт)
          </Button>
          <Button type="button" variant="secondary" loading={busy === 'x'}
            onClick={() => runAction('x', () => desktop!.fiscal.xReport(), 'X-звіт сформовано')}>
            X-звіт
          </Button>
          <Button type="button" variant="secondary" loading={busy === 'service'}
            onClick={() => askServiceCash('in')}>
            Внесення готівки
          </Button>
          <Button type="button" variant="secondary" loading={busy === 'service'}
            onClick={() => askServiceCash('out')}>
            Видача готівки
          </Button>
        </div>
        <p className="text-xs text-gray-400">
          Зазвичай зміна відкривається автоматично при першому чеку, а Z-звіт — при закритті зміни каси.
          Ці кнопки — для налаштування й нештатних ситуацій.
        </p>
      </div>

      <Modal open={cashDirection !== null} onClose={() => setCashDirection(null)}
        title={cashDirection === 'out' ? 'Видача готівки з каси' : 'Внесення готівки в касу'} size="sm">
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Сума, грн</label>
            <Input value={cashAmount} autoFocus inputMode="decimal" placeholder="0,00"
              onChange={(e) => setCashAmount(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitServiceCash() }} />
          </div>
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="secondary" onClick={() => setCashDirection(null)}>Скасувати</Button>
            <Button type="button" onClick={submitServiceCash}>
              {cashDirection === 'out' ? 'Провести видачу' : 'Провести внесення'}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  )
}
