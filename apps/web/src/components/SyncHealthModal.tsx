import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Modal } from '@/components/ui'
import { listDesktopStuckOperations } from '@/lib/desktopSyncApi'
import type { DesktopSyncStatus, DesktopSyncStuckOperation } from '@/lib/desktopBridge'

interface Props {
  open: boolean
  onClose: () => void
  status: DesktopSyncStatus | null
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

/**
 * Вікно тільки показує стан — жодної кнопки.
 *
 * Черга розбирається сама: відправка йде кожні десять секунд, застрягле
 * повторюється, а те, що сервер не прийме ніколи, каса знімає й вирівнює
 * залишок зі свого боку. Натискати тут нічого не треба, і саме тому нема чого.
 * Власник заглядає сюди, тільки якщо хоче побачити, що саме ще в дорозі.
 */
export function SyncHealthModal({ open, onClose, status }: Props) {
  const [operations, setOperations] = useState<DesktopSyncStuckOperation[]>([])
  const [loading, setLoading] = useState(false)

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

        {operations.length === 0 ? (
          <p className="rounded-lg bg-gray-50 px-3 py-6 text-center text-sm text-gray-500">
            {loading
              ? 'Завантаження…'
              : waiting > 0
                ? 'Усе в дорозі — решта поїде автоматично.'
                : 'Усе синхронізовано.'}
          </p>
        ) : (
          <div>
            <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-700">
              <AlertTriangle size={16} />
              Сервер поки не прийняв ці операції
            </p>
            <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2">Операція</th>
                    <th className="px-3 py-2">Створено</th>
                    <th className="px-3 py-2">Причина</th>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Дані не втрачені — вони збережені на цьому компʼютері, і каса повторює відправку сама.
              Те, що сервер не прийме ніколи, вона знімає з черги теж сама і вирівнює залишок зі свого
              боку. Робити тут нічого не треба; якщо рядок висить тиждень — покажіть його розробнику.
            </p>
          </div>
        )}
      </div>
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
