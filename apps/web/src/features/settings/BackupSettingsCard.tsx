import { useCallback, useEffect, useState } from 'react'
import { HardDriveDownload, RotateCcw, Save } from 'lucide-react'
import { Button, Card, ConfirmDialog } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge, type DesktopDatabaseBackup } from '@/lib/desktopBridge'
import { BackupStatusSummary, type ShiftCopyStatus } from './BackupStatusSummary'

function formatMoment(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('uk-UA')
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`
}

/**
 * Резервні копії локальної бази. Копії створювались і раніше, але скористатися
 * ними було нічим: у програмі не було жодного способу відкотитись, і при
 * пошкодженні бази каса просто не відкривалася.
 */
export function BackupSettingsCard() {
  const [shiftCopies, setShiftCopies] = useState<ShiftCopyStatus[]>([])
  const [loadError, setLoadError] = useState('')
  const [backups, setBackups] = useState<DesktopDatabaseBackup[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<DesktopDatabaseBackup | null>(null)

  const load = useCallback(async () => {
    const list = desktopBridge()?.listBackups
    if (!list) return
    setLoading(true)
    setLoadError('')
    try {
      const [local, shifts] = await Promise.all([list(), desktopBridge()?.shiftBackups?.status() ?? Promise.resolve([])])
      setBackups(local)
      setShiftCopies(shifts)
    } catch {
      setLoadError('Не вдалося прочитати стан резервних копій. Натисніть «Оновити».')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function handleBackupNow() {
    const backupNow = desktopBridge()?.backupNow
    if (!backupNow) return
    setSaving(true)
    try {
      await backupNow()
      toast.success('Резервну копію створено')
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося створити копію')
    } finally {
      setSaving(false)
    }
  }

  async function handleRestore(backup: DesktopDatabaseBackup) {
    const restore = desktopBridge()?.restoreBackup
    if (!restore) return
    try {
      // Після успішного відкату програма перезапускається сама, тому відповіді
      // ми можемо й не дочекатися — це нормально.
      await restore(backup.fileName)
      toast.success('Копію відновлено, програма перезапускається…')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося відновити копію')
    }
  }

  return (
    <Card className="mt-6 space-y-4 border-slate-200">
      <div className="space-y-2">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">Резервні копії для відновлення</h3><Button size="sm" variant="secondary" onClick={load} loading={loading}>Оновити</Button></div>
        <p className="text-sm text-gray-600">Excel: папка «Вивантаження» поруч із програмою, окремо товари та клієнти. Сервер: приватна копія бази з доступними локальними фото, до 7 останніх перевірених копій на комп’ютер. Без інтернету чекає наступного підключення програми. Знімок створюється під час виконання резервування; відсутні файли фото відновити неможливо.</p>
        {loadError&&<p role="alert" className="text-sm text-red-700">{loadError}</p>}
        {!loading&&!loadError&&<BackupStatusSummary backups={backups} shifts={shiftCopies}/>}
        {!loading&&!loadError&&shiftCopies.length>0&&<details><summary className="cursor-pointer py-2 text-sm font-medium">Історія копій після зміни</summary>{shiftCopies.map(copy=><div key={copy.id} className="border-b py-2 text-sm break-words">
          <strong>{formatMoment(copy.closed_at)}</strong>
          <p>{copy.exports_ready?'Excel збережено: '+copy.export_directory:'Excel: файли не готові або ще не перевірені'}</p>
          <p>{copy.cloud_completed_at?'Серверну копію перевірено: '+formatMoment(copy.cloud_completed_at):'Серверна копія: очікує відправлення'}</p>
          {(copy.local_error||copy.cloud_error)&&<p role="alert" className="text-red-700">{copy.local_error||copy.cloud_error}</p>}
        </div>)}</details>}
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 pb-2">
            <HardDriveDownload size={18} className="text-slate-600" />
            <h3 className="text-sm font-semibold text-slate-900">Резервні копії локальної бази</h3>
          </div>
          <p className="text-xs text-slate-600">
            Перевірена копія створюється щогодини під час роботи: зберігаються
            24 останні та щоденні копії за 14 днів із копіями. Автоматичного відкату немає.
            Копії на цьому ПК не захищають від поломки диска — зберігайте їх також окремо.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          loading={saving}
          icon={<Save size={16} />}
          onClick={handleBackupNow}
          className="shrink-0"
        >
          Зробити копію
        </Button>
      </div>

      {loadError ? null : backups.length === 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-500">
          {loading ? 'Завантаження…' : 'Копій ще немає — натисніть «Зробити копію».'}
        </p>
      ) : (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {backups.map((backup) => (
            <div key={backup.fileName} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{formatMoment(backup.createdAt)}</p>
                <p className="text-xs text-slate-500">{formatSize(backup.sizeBytes)}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="danger-outline"
                icon={<RotateCcw size={14} />}
                onClick={() => setPendingRestore(backup)}
              >
                Відновити
              </Button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingRestore !== null}
        onClose={() => setPendingRestore(null)}
        onConfirm={async () => { if (pendingRestore) await handleRestore(pendingRestore) }}
        title="Відновити базу з копії?"
        message={pendingRestore
          ? `Каса повернеться до стану на ${formatMoment(pendingRestore.createdAt)}. `
            + 'Уся робота, зроблена після цього моменту, '
            + 'у копії відсутня. Поточна база не видаляється — її буде збережено в папці corrupt. '
            + 'Після відновлення програма перезапуститься.'
          : ''}
        confirmLabel="Відновити"
        danger
      />
    </Card>
  )
}
