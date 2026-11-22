import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'

/** Пороги тривог власнику (етап 11). Зберігаються на сервері; копійки — лише всередині, тут гривні. */
export interface OwnerAlertSettings {
  till_offline_minutes: number
  work_from_hour: number
  work_to_hour: number
  cash_diff_kopecks: number
  backup_max_hours: number
  shift_open_hours: number
}
type Form = Record<keyof OwnerAlertSettings, string>

export function alertsToForm(settings: OwnerAlertSettings): Form {
  return {
    till_offline_minutes: String(settings.till_offline_minutes), work_from_hour: String(settings.work_from_hour),
    work_to_hour: String(settings.work_to_hour), cash_diff_kopecks: String(settings.cash_diff_kopecks / 100),
    backup_max_hours: String(settings.backup_max_hours), shift_open_hours: String(settings.shift_open_hours),
  }
}

/** Текст полів → пороги; null — якщо щось поза межами (ті самі межі, що й на сервері). */
export function formToAlerts(form: Form): OwnerAlertSettings | null {
  const n = (text: string) => Number(String(text).replace(',', '.').trim())
  const value: OwnerAlertSettings = {
    till_offline_minutes: Math.round(n(form.till_offline_minutes)), work_from_hour: Math.round(n(form.work_from_hour)),
    work_to_hour: Math.round(n(form.work_to_hour)), cash_diff_kopecks: Math.round(n(form.cash_diff_kopecks) * 100),
    backup_max_hours: Math.round(n(form.backup_max_hours)), shift_open_hours: Math.round(n(form.shift_open_hours)),
  }
  const within = (x: number, min: number, max: number) => Number.isFinite(x) && x >= min && x <= max
  const ok = within(value.till_offline_minutes, 5, 240) && within(value.work_from_hour, 0, 23) && within(value.work_to_hour, 1, 24)
    && value.work_from_hour < value.work_to_hour && within(value.cash_diff_kopecks, 100, 100_000_000)
    && within(value.backup_max_hours, 12, 720) && within(value.shift_open_hours, 12, 720)
  return ok ? value : null
}

const FIELDS: Array<{ key: keyof OwnerAlertSettings; label: string; hint: string }> = [
  { key: 'work_from_hour', label: 'Робочий день з', hint: 'год' },
  { key: 'work_to_hour', label: 'до', hint: 'год' },
  { key: 'till_offline_minutes', label: 'Каса не в мережі довше', hint: 'хв' },
  { key: 'cash_diff_kopecks', label: 'Різниця каси від', hint: 'грн' },
  { key: 'shift_open_hours', label: 'Зміна відкрита довше', hint: 'год' },
  { key: 'backup_max_hours', label: 'Хмарна копія старша за', hint: 'год' },
]

export function OwnerAlertThresholds() {
  const [form, setForm] = useState<Form | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void api.get<{ data: { settings: OwnerAlertSettings } }>('/api/v1/settings/owner-alerts', { silent: true, timeoutMs: 15_000 })
      .then(result => { if (active) setForm(alertsToForm(result.data.settings)) })
      .catch(() => { if (active) setForm(null) })
    return () => { active = false }
  }, [])
  if (!form) return null

  async function save() {
    const value = formToAlerts(form!)
    if (!value) { toast.error('Перевірте пороги: години 0–24 (початок раніше за кінець), хвилини 5–240, години копії й зміни 12–720, різниця від 1 грн'); return }
    setBusy(true)
    try {
      const { data } = await api.put<{ data: { settings: OwnerAlertSettings } }>('/api/v1/settings/owner-alerts', value, { silent: true, timeoutMs: 15_000 })
      setForm(alertsToForm(data.settings))
      toast.success('Пороги тривог збережено')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти пороги')
    } finally { setBusy(false) }
  }

  return (
    <div className="mt-3 space-y-2" data-owner-alert-thresholds>
      <p className="font-medium text-gray-800">Коли писати</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FIELDS.map(field => (
          <label key={field.key} className="flex items-center justify-between gap-2">
            <span>{field.label}</span>
            <span className="flex items-center gap-1">
              <input type="text" inputMode="decimal" value={form[field.key]} disabled={busy} aria-label={field.label}
                onChange={event => setForm(current => current && { ...current, [field.key]: event.target.value })}
                className="w-20 rounded border border-gray-200 px-2 py-1 text-right text-xs" />
              <span className="w-6 text-gray-500">{field.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <button type="button" onClick={() => { void save() }} disabled={busy}
        className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-100 disabled:opacity-50">
        {busy ? 'Зберігаю…' : 'Зберегти пороги'}
      </button>
    </div>
  )
}
