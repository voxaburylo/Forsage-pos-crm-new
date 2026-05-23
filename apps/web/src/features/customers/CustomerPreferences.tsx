import { useState, useEffect, useCallback } from 'react'
import { Bell, Save, MessageSquare, Phone } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

interface CustomerPreferencesProps {
  customerId: string
}

interface PreferenceRow {
  channel: 'telegram' | 'sms'
  event_type: string
  is_enabled: boolean
}

const EVENTS = [
  { type: 'order_ready', label: 'Замовлення готове' },
  { type: 'order_completed', label: 'Замовлення виконано' },
]

export default function CustomerPreferences({ customerId }: CustomerPreferencesProps) {
  const [preferences, setPreferences] = useState<PreferenceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get<{ data: any[] }>(`/api/v1/notifications/preferences/${customerId}`)
      // Match incoming preferences, default missing to true
      const loadedPrefs: PreferenceRow[] = []
      for (const ch of ['telegram', 'sms'] as const) {
        for (const ev of EVENTS) {
          const found = data.find((p) => p.channel === ch && p.event_type === ev.type)
          loadedPrefs.push({
            channel: ch,
            event_type: ev.type,
            is_enabled: found ? found.is_enabled : true,
          })
        }
      }
      setPreferences(loadedPrefs)
    } catch {
      toast.error('Помилка завантаження преференцій')
    } finally {
      setLoading(false)
    }
  }, [customerId])

  useEffect(() => {
    load()
  }, [load])

  function togglePreference(channel: 'telegram' | 'sms', eventType: string) {
    setPreferences((prev) =>
      prev.map((p) =>
        p.channel === channel && p.event_type === eventType
          ? { ...p, is_enabled: !p.is_enabled }
          : p
      )
    )
  }

  async function handleSave() {
    setSaving(true)
    try {
      await api.put(`/api/v1/notifications/preferences/${customerId}`, {
        preferences: preferences.map((p) => ({
          channel: p.channel,
          event_type: p.event_type,
          is_enabled: p.is_enabled,
        })),
      })
      toast.success('Налаштування сповіщень збережено')
      load()
    } catch {
      toast.error('Помилка збереження налаштувань')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="text-gray-400 text-sm">Завантаження...</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-3">
        <div className="flex items-center gap-2">
          <Bell size={16} className="text-gray-400" />
          <h3 className="text-sm font-semibold text-gray-800">Уподобання сповіщень</h3>
        </div>
        <Button
          size="sm"
          variant="outline"
          icon={<Save size={14} />}
          loading={saving}
          onClick={handleSave}
        >
          Зберегти
        </Button>
      </div>

      <div className="space-y-4">
        {EVENTS.map((ev) => {
          const tgPref = preferences.find((p) => p.channel === 'telegram' && p.event_type === ev.type)
          const smsPref = preferences.find((p) => p.channel === 'sms' && p.event_type === ev.type)

          return (
            <div key={ev.type} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg bg-gray-50 border border-gray-100">
              <span className="text-sm font-medium text-gray-800">{ev.label}</span>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={tgPref?.is_enabled ?? true}
                    onChange={() => togglePreference('telegram', ev.type)}
                    className="rounded border-gray-300 text-accent focus:ring-accent"
                  />
                  <MessageSquare size={12} className="text-blue-500" />
                  Telegram
                </label>
                <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={smsPref?.is_enabled ?? true}
                    onChange={() => togglePreference('sms', ev.type)}
                    className="rounded border-gray-300 text-accent focus:ring-accent"
                  />
                  <Phone size={12} className="text-emerald-500" />
                  SMS
                </label>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
