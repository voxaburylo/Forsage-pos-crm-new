import { useEffect, useState } from 'react'
import { HardDrive } from 'lucide-react'
import { Button, Card, ConfirmDialog } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge, type ExternalBackupStatus } from '@/lib/desktopBridge'
import { externalBackupNotice } from './externalBackupModel'

type Copy = ExternalBackupStatus['copies'][number]
const formatSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
const copyMoment = (copy: Copy) => copy.createdAt.replace('T', ' ')
const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Не вдалося виконати дію'

/**
 * Друга копія бази на флешці або зовнішньому диску (рішення власника 17.11.2026).
 * Раз на добу, коли носій підключено, — стиснена перевірена копія з SHA-256.
 */
export function ExternalBackupCard() {
  const bridge = desktopBridge()?.externalBackup
  const [status, setStatus] = useState<ExternalBackupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Copy | null>(null)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    if (!bridge) return
    // Касир не має права на цю дію — картку просто не показуємо.
    bridge.status().then(setStatus).catch(() => setDenied(true))
  }, [bridge])

  if (!bridge || denied) return null

  async function act(run: () => Promise<ExternalBackupStatus>, success?: string) {
    setBusy(true)
    try { const next = await run(); setStatus(next); if (success) toast.success(success) }
    catch (error) { toast.error(errorText(error)); bridge!.status().then(setStatus).catch(() => undefined) }
    finally { setBusy(false) }
  }

  async function restore(copy: Copy) {
    const desktop = desktopBridge()
    if (!desktop?.restoreBackup) throw new Error('Ця версія програми не вміє відновлювати. Оновіть програму.')
    const imported = await bridge!.importCopy(copy.fileName)
    toast.success('Копію з флешки перевірено. Відновлюю…')
    await desktop.restoreBackup(imported.fileName)
  }

  const notice = status ? externalBackupNotice(status) : null
  const tone = notice?.tone === 'warn' ? 'bg-amber-50 text-amber-800' : notice?.tone === 'ok' ? 'bg-green-50 text-green-800' : 'bg-slate-50 text-slate-700'
  return (
    <Card className="mt-6 space-y-3">
      <div className="flex items-center gap-2">
        <HardDrive size={18} className="text-slate-700" />
        <h3 className="text-sm font-semibold text-slate-900">Копії на флешку або зовнішній диск</h3>
      </div>
      <p className="text-xs text-slate-600">
        Раз на добу, коли флешка вставлена, програма записує на неї стиснену перевірену копію бази з контрольною сумою
        і читає записане назад для звірки. Зберігаються 30 останніх копій. Флешки краще дві: одна в магазині, друга вдома.
        На флешці — уся база (клієнти, продажі, працівники), зберігайте її як ключі від каси.
      </p>
      {notice && <p role={notice.tone === 'warn' ? 'alert' : undefined} className={`rounded-lg px-3 py-2 text-sm ${tone}`}>{notice.text}</p>}
      {status?.folder && <p className="break-all text-xs text-slate-500">Папка: {status.folder}{status.available ? '' : ' (не підключено)'}</p>}
      {status?.same_drive && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Ця папка на тому ж диску, що й програма: від поломки диска вона не захищає. Оберіть флешку.</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant={status?.folder ? 'secondary' : 'primary'} loading={busy} onClick={() => act(bridge.choose)}>
          {status?.folder ? 'Змінити флешку…' : 'Вибрати флешку…'}
        </Button>
        {status?.folder && <Button type="button" variant="secondary" disabled={busy || !status.available} onClick={() => act(bridge.run, 'Копію записано й перевірено')}>Записати копію зараз</Button>}
        {status?.folder && <Button type="button" variant="ghost" disabled={busy} onClick={() => act(bridge.clear)}>Не використовувати флешку</Button>}
      </div>
      {status && status.copies.length > 0 && (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {status.copies.slice(0, 10).map(copy => (
            <div key={copy.fileName} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">{copyMoment(copy)}</p>
                <p className="text-xs text-slate-500">{formatSize(copy.sizeBytes)}{copy.sha256 ? '' : ' · без контрольної суми'}</p>
              </div>
              <Button type="button" size="sm" variant="danger-outline" disabled={!copy.sha256} onClick={() => setPending(copy)}>Відновити</Button>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={async () => { if (pending) await restore(pending) }}
        title="Відновити базу з копії на флешці?"
        message={pending
          ? `База на цьому ПК буде замінена копією від ${copyMoment(pending)}. Усе, що зроблено після цього моменту, у копії відсутнє. `
            + 'Поточну базу буде збережено в папці corrupt. Після відновлення програма перезапуститься.'
          : ''}
        confirmLabel="Перевірити й відновити"
        danger
      />
    </Card>
  )
}
