import { useEffect, useState } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

export function LoginSecurityCard() {
  const role = useAuthStore(s => s.session?.user.app_metadata?.role)
  const auth = desktopBridge()?.auth
  const [required, setRequired] = useState(true)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let active = true
    void auth?.rememberedStatus?.().then(s => {
      if (active) { setRequired(s.pinRequired !== false); setReady(true) }
    }).catch(() => { if (active) toast.error('Не вдалося завантажити налаштування входу') })
    return () => { active = false }
  }, [auth])
  if (!auth?.setPinRequired || !['owner','admin'].includes(String(role))) return null
  async function change(value: boolean) {
    setSaving(true)
    try {
      const result = await auth!.setPinRequired!(value)
      setRequired(result.pinRequired)
      toast.success('Налаштування входу збережено')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Не вдалося зберегти') }
    finally { setSaving(false) }
  }
  return <Card className="p-5 space-y-3">
    <h2 className="font-semibold">Вхід на цьому комп’ютері</h2>
    <label className="flex items-center gap-3">
      <input type="checkbox" checked={required} disabled={!ready || saving}
        onChange={e => { void change(e.target.checked) }} />
      Запитувати PIN для збереженого входу
    </label>
    <p className="text-sm text-gray-600">Увімкнено: PIN після перезапуску та 5 хвилин бездіяльності. Вимкнено: вхід без PIN протягом 24 годин. Пароль не зберігається; вихід із профілю скасовує збережений доступ.</p>
    {!required && <p className="text-sm text-amber-700">Будь-хто за цим комп’ютером зможе скористатися збереженим входом. Вимикайте PIN лише на довіреному ПК.</p>}
  </Card>
}
