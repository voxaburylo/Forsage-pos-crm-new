import { useEffect, useState } from 'react'
import { Archive } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1).replace('.', ',') + ' МБ'

/**
 * 24.11.2026 (план C9): журнал відправлених операцій — стиснути старе. Лише власник, лише на головному ПК, з підрахунком
 * перед запуском. Рядки лишаються (на них спираються перевірки), стискається лише вміст старих відправлених записів.
 */
export function OutboxJournalCard() {
  const staff = desktopBridge()?.staff
  const [preview, setPreview] = useState<Awaited<ReturnType<NonNullable<NonNullable<typeof staff>['outboxPreview']>>> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!staff?.outboxPreview) return
    let alive = true
    staff.outboxPreview().then(value => { if (alive) setPreview(value) }, reason => { if (alive) setError(reason instanceof Error ? reason.message : 'Не вдалося порахувати') })
    return () => { alive = false }
  }, [staff])

  if (!isDesktopRuntime() || !staff?.outboxPreview || !staff.outboxCompact) return null

  async function compact() {
    if (!preview?.rows || busy || !staff?.outboxCompact) return
    if (!window.confirm(`Стиснути ${preview.rows} старих відправлених записів (≈ ${mb(preview.bytes)})? Продажі, повернення, гроші й завершені ревізії не чіпаються.`)) return
    setBusy(true)
    try {
      const result = await staff.outboxCompact()
      toast.success(`Стиснуто записів: ${result.rows}, звільнено ≈ ${mb(result.bytes)}`)
      setPreview(await staff.outboxPreview!())
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Не вдалося стиснути журнал')
    } finally { setBusy(false) }
  }

  return (
    <Card className="mt-6 space-y-3" data-outbox-journal>
      <div className="flex items-center gap-2 pb-3 border-b border-gray-100">
        <Archive size={18} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-800">Журнал відправлених операцій</h3>
      </div>
      <p className="text-xs text-gray-500">
        Каса памʼятає все, що відправила на сервер. Старі картки товарів, накладні й налаштування (понад 90 днів) можна стиснути:
        записи лишаються, зникає лише їхній вміст. Продажі, повернення, гроші й завершені ревізії не чіпаються. Сервер має їхню копію.
      </p>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {!preview && !error && <p role="status" className="text-xs text-gray-500">Рахую…</p>}
      {preview && (
        <p className="text-sm text-gray-700">
          Увесь журнал: {preview.journal_rows} записів, {mb(preview.journal_bytes)}.{' '}
          {preview.rows ? <>Можна стиснути: <b>{preview.rows}</b> (≈ {mb(preview.bytes)}).</> : 'Стискати поки нічого.'}
        </p>
      )}
      <Button size="sm" variant="secondary" disabled={!preview?.rows || busy} loading={busy} onClick={() => void compact()}>Стиснути старе</Button>
    </Card>
  )
}
