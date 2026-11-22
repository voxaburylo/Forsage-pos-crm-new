import { useState } from 'react'
import { CloudDownload } from 'lucide-react'
import { Button, Card, ConfirmDialog } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { backupAgeDays, cloudBackupFormat, usableCloudBackups, type CloudBackupItem } from './cloudRestoreModel'

const formatMoment = (value: string) => new Date(value).toLocaleString('uk-UA')
const formatSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} МБ`

/**
 * «На випадок аварії»: програму поставили заново (порожню), потрібна найсвіжіша база з хмари.
 * Шукає перевірені копії магазину на сервері, скачує вибрану, перевіряє контрольну суму й файл,
 * а заміну бази виконує те саме штатне відновлення з перезапуском.
 */
export function CloudRestoreCard() {
  const session = useAuthStore(state => state.session)
  const tenantId = String(session?.user?.app_metadata?.tenant_id ?? '')
  const [items, setItems] = useState<CloudBackupItem[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<CloudBackupItem | null>(null)

  async function search() {
    setSearching(true); setError('')
    try {
      const { data } = await api.get<{ data: CloudBackupItem[] }>('/api/v1/backups', { silent: true, timeoutMs: 60_000 })
      setItems(usableCloudBackups(data))
    } catch {
      setItems(null)
      setError('Не вдалося отримати список копій із сервера. Потрібен інтернет і вхід власника через інтернет.')
    } finally { setSearching(false) }
  }

  async function restore(item: CloudBackupItem) {
    const bridge = desktopBridge()
    if (!bridge?.fetchCloudBackup || !bridge.restoreBackup) throw new Error('Ця версія програми не вміє відновлювати з хмари. Оновіть програму.')
    const { data } = await api.post<{ data: { url: string } }>('/api/v1/backups/download', {
      device_id: item.device_id, id: item.id, sha256: item.sha256, size_bytes: item.size_bytes, format: cloudBackupFormat(item),
    }, undefined, { silent: true, timeoutMs: 60_000 })
    const fetched = await bridge.fetchCloudBackup({
      url: data.url, tenant_id: tenantId, device_id: item.device_id, id: item.id, sha256: item.sha256, size_bytes: item.size_bytes, format: cloudBackupFormat(item),
    })
    toast.success('Копію завантажено й перевірено. Відновлюю…')
    // Після успіху програма перезапускається сама — відповіді можемо не дочекатись.
    await bridge.restoreBackup(fetched.fileName)
  }

  const newest = items?.[0] ?? null
  return (
    <Card className="mt-6 space-y-3 border-red-200">
      <div className="flex items-center gap-2">
        <CloudDownload size={18} className="text-red-600" />
        <h3 className="text-sm font-semibold text-slate-900">Аварійне відновлення з хмари</h3>
      </div>
      <p className="text-xs text-slate-600">
        Якщо головний ПК зламався і програму встановлено заново (база порожня): знайдіть найсвіжішу перевірену копію магазину
        на сервері й поверніть її на цей ПК. Копії створюються під час закриття зміни, на сервері лишається 7 останніх.
        Роботу, зроблену після дати копії, повернути не можна. Старий і новий ПК одночасно з однією базою не запускайте.
      </p>
      <Button type="button" variant="secondary" loading={searching} onClick={search}>Знайти найсвіжішу копію</Button>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {items && !items.length && <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-600">Перевірених копій на сервері немає.</p>}
      {items && items.length > 0 && (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {items.slice(0, 7).map(item => (
            <div key={item.name} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">
                  {formatMoment(item.created_at)}{item === newest && <span className="ml-2 rounded bg-green-50 px-1.5 py-0.5 text-[11px] font-semibold text-green-700">найсвіжіша</span>}
                </p>
                <p className="text-xs text-slate-500">{formatSize(item.size_bytes)} · {backupAgeDays(item.created_at)} дн. тому</p>
              </div>
              <Button type="button" size="sm" variant={item === newest ? 'primary' : 'danger-outline'} onClick={() => setPending(item)}>Відновити</Button>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={async () => { if (pending) await restore(pending) }}
        title="Відновити базу з хмарної копії?"
        message={pending
          ? `База на цьому ПК буде замінена копією від ${formatMoment(pending.created_at)}. Усе, що зроблено після цього моменту, у копії відсутнє. `
            + 'Поточну базу буде збережено в папці corrupt. Після відновлення програма перезапуститься, і заходити треба буде зі збереженими в копії логінами й паролями.'
          : ''}
        confirmLabel="Скачати й відновити"
        danger
      />
    </Card>
  )
}
