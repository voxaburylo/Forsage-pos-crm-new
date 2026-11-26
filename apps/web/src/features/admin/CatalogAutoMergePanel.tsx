import { useMemo, useRef, useState } from 'react'
import { Button, Card } from '@/components/ui'
import { formatMoney } from '@/lib/utils'
import { applyAutoMerges, autoMergePlan, type AutoMergeBridge, type AutoMergeResult } from './catalogAutoMerge'
import type { CleanupScan } from './catalogCleanupModel'

/**
 * 26.11.2026, слово власника: «дублі зі стовідсотковою схожістю обʼєднувати автоматично».
 * Одна кнопка на всі точні дублі: правило — у catalogAutoMerge.ts (назва буква в букву, близькі ціни, немає двох різних
 * заводських штрихкодів). Кожну групу каса перевіряє й записує тим самим шляхом, що й «Залишити цю картку».
 */
export function CatalogAutoMergePanel({ scan, bridge, canWrite, disabled, onMerged }: {
  scan: CleanupScan; bridge: Partial<AutoMergeBridge> | null | undefined; canWrite: boolean; disabled: boolean; onMerged: () => void
}) {
  const plan = useMemo(() => autoMergePlan(scan), [scan])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [report, setReport] = useState<AutoMergeResult | null>(null)
  const [error, setError] = useState('')
  const stop = useRef(false)
  const ready = canWrite && Boolean(bridge?.cleanupPreview && bridge.cleanupApply)

  async function run() {
    if (busy || disabled || !ready || !plan.rows.length || !bridge?.cleanupPreview || !bridge.cleanupApply) return
    const cards = plan.rows.reduce((sum, row) => sum + row.verdict.source_ids.length, 0)
    if (!window.confirm(`Обʼєднати ${plan.rows.length} груп точних дублів (зайвих карток: ${cards})?\n\n`
      + 'У кожній групі назва збігається буква в букву. Залишки складаються, ціна лишається більша, усі штрихкоди й артикули переходять до головної картки. '
      + 'Історія продажів і накладних не змінюється. Перед записом каса робить резервну копію.')) return
    stop.current = false; setBusy(true); setError(''); setReport(null); setProgress(`0 з ${plan.rows.length}`)
    try {
      // Картка товару потрібна лише для підняття ціни — підвантажуємо в момент натискання, а не разом з екраном.
      const { productApi } = await import('@/features/products/productApi')
      const result = await applyAutoMerges(plan.rows, {
        bridge: { cleanupPreview: bridge.cleanupPreview, cleanupApply: bridge.cleanupApply },
        raisePrices: (productId, prices) => productApi.update(productId, prices as never),
        operationId: () => crypto.randomUUID(),
        onProgress: (done, total) => setProgress(`${done} з ${total}`),
        shouldStop: () => stop.current,
      })
      setReport(result)
      if (result.merged) onMerged()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не вдалося обʼєднати дублі') }
    finally { setBusy(false); setProgress('') }
  }

  if (!plan.same_name_groups && !report) return null
  return (
    <div data-cleanup-auto><Card className="mb-4">
      <h2 className="font-semibold">Точні дублі — обʼєднати всі одразу</h2>
      <p className="mt-1 text-sm text-gray-600">
        Картки з назвою, що збігається буква в букву: <strong>{plan.same_name_groups}</strong>. Програма готова обʼєднати сама <strong data-cleanup-auto-count>{plan.rows.length}</strong>:
        ціни карток близькі, двох різних заводських штрихкодів немає. Решту ({plan.skipped.length}) лишає вам — причини нижче.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => void run()} disabled={disabled || busy || !ready || !plan.rows.length} loading={busy} data-cleanup-auto-run>
          Обʼєднати всі точні дублі ({plan.rows.length})
        </Button>
        {busy && <>
          <span role="status" className="text-sm text-gray-700">Обʼєднано груп: {progress}</span>
          <Button variant="secondary" size="sm" onClick={() => { stop.current = true }}>Зупинити</Button>
        </>}
      </div>
      {!ready && <p className="mt-2 text-sm text-amber-900">Обʼєднання виконується на головному ПК магазину.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700 [overflow-wrap:anywhere]">{error}</p>}
      {report && (
        <div role="status" className="mt-3 rounded bg-green-50 p-3 text-sm text-green-900 [overflow-wrap:anywhere]" data-cleanup-auto-report>
          Обʼєднано груп: {report.merged} (зайвих карток прибрано: {report.cards}).{report.stopped ? ' Зупинено на вашу вимогу.' : ''}
          {report.backupPath ? ' Резервна копія: ' + report.backupPath + '.' : ''} Облікові залишки складено; фактичний залишок не змінювали.
          {report.skipped.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-amber-900">
              {report.skipped.slice(0, 30).map((item, index) => <li key={index}>{item.name} — {item.reason}</li>)}
              {report.skipped.length > 30 && <li>…і ще {report.skipped.length - 30}</li>}
            </ul>
          )}
        </div>
      )}
      {plan.rows.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-gray-700">Що саме буде обʼєднано ({plan.rows.length})</summary>
          <ul className="mt-2 max-h-80 divide-y divide-gray-100 overflow-y-auto rounded border border-gray-100" data-cleanup-auto-list>
            {plan.rows.map(row => (
              <li key={row.verdict.target_id} className="px-3 py-2">
                <p className="font-medium text-gray-900 [overflow-wrap:anywhere]">{row.name}</p>
                <p className="text-xs text-gray-600">
                  {row.cards.map(card => `${card.id === row.verdict.target_id ? 'головна: ' : ''}арт. ${card.sku || '—'}, залишок ${card.qty_on_hand}, ${formatMoney(Number(card.retail_price) || 0)}`).join(' · ')}
                  {' → '}залишок {row.verdict.quantity}, ціна {formatMoney(row.verdict.retail_price)}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {plan.skipped.length > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-gray-700">Що програма лишає вам і чому ({plan.skipped.length})</summary>
          <ul className="mt-2 max-h-64 list-disc overflow-y-auto pl-5 text-gray-700">
            {plan.skipped.map((item, index) => <li key={index} className="[overflow-wrap:anywhere]">{item.name} — {item.reason}</li>)}
          </ul>
        </details>
      )}
    </Card></div>
  )
}
