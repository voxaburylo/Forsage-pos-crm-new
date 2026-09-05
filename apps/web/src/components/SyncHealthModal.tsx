import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Ban, RefreshCw } from 'lucide-react'
import { Button, ConfirmDialog, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import {
  discardDesktopStuckOperations,
  listDesktopStuckOperations,
  retryDesktopStuckOperations,
  syncDesktopNow,
} from '@/lib/desktopSyncApi'
import { useAuthStore } from '@/stores/authStore'
import type { DesktopSyncStatus, DesktopSyncStuckOperation } from '@/lib/desktopBridge'

interface Props {
  open: boolean
  onClose: () => void
  status: DesktopSyncStatus | null
  onChanged: () => void
}

/** Технічні назви операцій — людською мовою. */
const OPERATION_LABELS: Record<string, string> = {
  'sale.created': 'Продаж',
  'sale.updated': 'Зміна продажу',
  'return.created': 'Повернення',
  'shift.opened': 'Відкриття зміни',
  'shift.closed': 'Закриття зміни',
  'cash_operation.created': 'Касова операція',
  'customer.created': 'Новий клієнт',
  'customer.updated': 'Зміна клієнта',
  'customer_vehicle.created': 'Авто клієнта',
  'customer_vehicle.updated': 'Зміна авто клієнта',
  'product.upsert': 'Товар',
  'supplier.upsert': 'Постачальник',
  'supply_invoice.created': 'Прихідна накладна',
  'supply_invoice.posted': 'Проведення накладної',
  'inventory_session.completed': 'Ревізія',
  'order.created': 'Замовлення',
  'order.updated': 'Зміна замовлення',
}

function operationLabel(operation: DesktopSyncStuckOperation): string {
  return OPERATION_LABELS[operation.operation_type] ?? operation.operation_type
}

function formatMoment(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function SyncHealthModal({ open, onClose, status, onChanged }: Props) {
  const [operations, setOperations] = useState<DesktopSyncStuckOperation[]>([])
  const [loading, setLoading] = useState(false)
  const [busySequence, setBusySequence] = useState<number | null>(null)
  const [retryingAll, setRetryingAll] = useState(false)
  const [discardTarget, setDiscardTarget] = useState<DesktopSyncStuckOperation | null>(null)
  // Відмова від операції — рішення про гроші й залишки, а не про техніку.
  const role = useAuthStore((state) => (state.session?.user?.app_metadata?.role as string) ?? 'cashier')
  const canDiscard = role === 'owner' || role === 'admin'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setOperations(await listDesktopStuckOperations())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  async function handleRetry(sequences?: number[]) {
    const single = sequences?.length === 1 ? sequences[0] : null
    if (single !== null) setBusySequence(single)
    else setRetryingAll(true)
    try {
      const { retried } = await retryDesktopStuckOperations(sequences)
      if (retried === 0) toast.error('Не вдалося поставити операції в чергу')
      else toast.success(`Поставлено в чергу: ${retried}. Перевіряємо звʼязок…`)
      await load()
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося повторити відправку')
    } finally {
      setBusySequence(null)
      setRetryingAll(false)
    }
  }

  async function handleDiscard(operation: DesktopSyncStuckOperation) {
    setBusySequence(operation.sequence)
    try {
      const { discarded, corrected } = await discardDesktopStuckOperations([operation.sequence])
      if (discarded === 0) toast.error('Операцію не знайдено — можливо, вона вже пройшла')
      else toast.success(corrected > 0
        ? `Операцію знято з черги. Залишок з каси надіслано на сервер: товарів ${corrected}`
        : 'Операцію знято з черги. Слід залишився в журналі проблем')
      await load()
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося зняти операцію з черги')
    } finally {
      setBusySequence(null)
    }
  }

  async function handleSyncNow() {
    setRetryingAll(true)
    try {
      const result = await syncDesktopNow()
      toast.success(result.pushed > 0
        ? `Відправлено операцій: ${result.pushed}`
        : 'Нових операцій для відправки немає')
      await load()
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Синхронізація не вдалася')
    } finally {
      setRetryingAll(false)
    }
  }

  const waiting = (status?.pending ?? 0) + (status?.retrying ?? 0)

  return (
    <Modal open={open} onClose={onClose} title="Синхронізація з сервером" size="xl">
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <SummaryTile label="Чекають відправки" value={waiting} tone="neutral" />
          <SummaryTile label="Не відправлено" value={status?.stuck ?? 0} tone="danger" />
          <SummaryTile
            label="Останній обмін"
            value={status?.pull_last_success_at ? formatMoment(status.pull_last_success_at) : '—'}
            tone="neutral"
          />
        </div>

        {status?.last_error && (
          <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
            <span className="font-semibold">Остання помилка: </span>{status.last_error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleSyncNow} loading={retryingAll} icon={<RefreshCw size={16} />}>
            Синхронізувати зараз
          </Button>
          {operations.length > 0 && (
            <Button variant="secondary" onClick={() => handleRetry()} disabled={retryingAll}>
              Повторити всі ({operations.length})
            </Button>
          )}
        </div>

        {operations.length === 0 ? (
          <p className="rounded-lg bg-gray-50 px-3 py-6 text-center text-sm text-gray-500">
            {loading
              ? 'Завантаження…'
              : waiting > 0
                ? 'Застряглих операцій немає — решта поїде автоматично.'
                : 'Усе синхронізовано.'}
          </p>
        ) : (
          <div>
            <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-700">
              <AlertTriangle size={16} />
              Ці операції вичерпали спроби і самі вже не відправляться
            </p>
            <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2">Операція</th>
                    <th className="px-3 py-2">Створено</th>
                    <th className="px-3 py-2">Помилка</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {operations.map((operation) => (
                    <tr key={operation.sequence}>
                      <td className="px-3 py-2 font-medium text-gray-900">{operationLabel(operation)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">{formatMoment(operation.created_at)}</td>
                      <td className="px-3 py-2 text-gray-600">
                        <span className="line-clamp-2" title={operation.last_error ?? ''}>
                          {operation.last_error ?? '—'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busySequence === operation.sequence || retryingAll}
                            onClick={() => handleRetry([operation.sequence])}
                          >
                            Повторити
                          </Button>
                          {canDiscard && (
                            <Button
                              size="sm"
                              variant="danger-outline"
                              icon={<Ban size={14} />}
                              disabled={busySequence === operation.sequence || retryingAll}
                              onClick={() => setDiscardTarget(operation)}
                            >
                              Не надсилати
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Дані не втрачені — вони збережені на цьому компʼютері. «Повторити» ставить операцію
              в чергу заново; якщо помилка повториться, покажіть її текст розробнику.
              {canDiscard && ' «Не надсилати» — для операцій, які сервер не прийме ніколи: вона зникне з черги, і сервер про неї не дізнається.'}
            </p>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={discardTarget !== null}
        onClose={() => setDiscardTarget(null)}
        danger
        title="Не надсилати цю операцію?"
        confirmLabel="Так, не надсилати"
        message={discardTarget && (
          <span>
            <b>{operationLabel(discardTarget)}</b> від {formatMoment(discardTarget.created_at)} зникне з черги.
            Сервер про цю зміну не дізнається ніколи, тому суми за цим документом доведеться
            звірити вручну. Залишки товарів з цієї операції каса надішле на сервер зі свого
            боку — щоб склад не розʼїхався. Локальні дані на касі лишаються як є.
            <br />
            <span className="text-gray-500">Відповідь сервера: {discardTarget.last_error ?? '—'}</span>
          </span>
        )}
        onConfirm={() => discardTarget ? handleDiscard(discardTarget) : undefined}
      />
    </Modal>
  )
}

function SummaryTile({ label, value, tone }: { label: string; value: number | string; tone: 'neutral' | 'danger' }) {
  const danger = tone === 'danger' && Number(value) > 0
  return (
    <div className={`rounded-lg border px-3 py-2 ${danger ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-lg font-bold ${danger ? 'text-red-700' : 'text-gray-900'}`}>{value}</p>
    </div>
  )
}
