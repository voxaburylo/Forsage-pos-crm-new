import { useRef, useState } from 'react'
import { Button, Card, Modal } from '@/components/ui'
import {
  retainTidyOperation, tidyInfoLines, tidyResultText, tidyStepText,
  type TidyApplyInput, type TidyPlan, type TidyResult, type TidyStepPlan,
} from './catalogTidyModel'

interface TidyApi {
  cleanupTidyPlan?: () => Promise<TidyPlan>
  cleanupTidyApply?: (input: TidyApplyInput) => Promise<TidyResult>
}

const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

/**
 * Кнопки «навести порядок». Нічого не виконується без показаного переліку й підтвердження;
 * перед кожним кроком програма робить резервну копію бази.
 */
export function CatalogTidyPanel({ api, disabled, onChanged }: { api: TidyApi; disabled: boolean; onChanged: () => void }) {
  const [plan, setPlan] = useState<TidyPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<TidyResult[]>([])
  const [selected, setSelected] = useState<TidyStepPlan | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [confirmError, setConfirmError] = useState('')
  const running = useRef(false)
  const pending = useRef<TidyApplyInput | null>(null)
  if (!api.cleanupTidyPlan || !api.cleanupTidyApply) return null

  async function load() {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { setPlan(await api.cleanupTidyPlan!()) }
    catch (err) { setError(messageOf(err, 'Не вдалося скласти перелік змін.')) }
    finally { running.current = false; setBusy(false) }
  }
  async function apply() {
    if (!selected || !confirmed || running.current) return
    running.current = true; setBusy(true); setConfirmError('')
    try {
      pending.current = retainTidyOperation(pending.current, selected.step, selected.fingerprint)
      const result = await api.cleanupTidyApply!(pending.current)
      pending.current = null
      setResults(previous => [...previous, result]); setSelected(null); setConfirmed(false)
      // Каталог змінився: перелік і список дублів на екрані застаріли.
      setPlan(null); onChanged()
      running.current = false
      await load()
    } catch (err) { setConfirmError(messageOf(err, 'Результат не підтверджено. Повторіть: номер операції збережено.')) }
    finally { running.current = false; setBusy(false) }
  }
  const close = () => { if (!running.current) { setSelected(null); setConfirmed(false); setConfirmError('') } }
  const info = plan ? tidyInfoLines(plan.info) : []

  return <div data-tidy-panel><Card className="mb-4">
    <h2 className="font-semibold">Навести порядок автоматично</h2>
    <p className="mt-1 text-sm text-gray-600">Шість окремих кроків. Спершу програма показує, що саме зміниться, і нічого не робить без вашого підтвердження. Перед кожним кроком створюється резервна копія бази.</p>
    <Button className="mt-3" variant="secondary" onClick={load} disabled={disabled || busy} loading={busy && !selected}>{plan ? 'Оновити перелік змін' : 'Показати, що буде змінено'}</Button>
    {error && <p role="alert" className="mt-2 text-sm text-red-700 [overflow-wrap:anywhere]">{error}</p>}
    {results.map((result, index) => <div key={index} role="status" className="mt-2 rounded bg-green-50 p-2 text-sm text-green-900 [overflow-wrap:anywhere]" data-tidy-result={result.step}>
      {tidyResultText(result)}{result.backupPath ? ' Резервна копія: ' + result.backupPath : ''}
      {result.skipped.length > 0 && <details className="mt-1 text-amber-900"><summary className="cursor-pointer">Що пропущено і чому</summary><ul className="mt-1 list-disc pl-5">{result.skipped.slice(0, 50).map((item, i) => <li key={i}>{item.name}: {item.reason}</li>)}</ul></details>}
    </div>)}
    {plan && <ul className="mt-3 divide-y">{plan.steps.map(step => <li key={step.step} className="flex flex-wrap items-start justify-between gap-3 py-3" data-tidy-step={step.step} data-tidy-count={step.count}>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{tidyStepText[step.step].title}: <strong>{step.count}</strong></p>
        <p className="text-sm text-gray-600">{tidyStepText[step.step].what}</p>
        {step.examples.length > 0 && <details className="mt-1 text-sm"><summary className="cursor-pointer text-gray-700">Приклади</summary>
          <ul className="mt-1 space-y-1">{step.examples.map((item, index) => <li key={index} className="[overflow-wrap:anywhere]"><span className="text-gray-900">{item.name}</span><span className="text-gray-500"> — {item.before} → </span><strong>{item.after}</strong></li>)}</ul>
        </details>}
      </div>
      <Button onClick={() => { setSelected(step); setConfirmed(false); setConfirmError('') }} disabled={disabled || busy || step.count === 0}>Виконати</Button>
    </li>)}</ul>}
    {info.length > 0 && <div className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-900"><p className="font-semibold">Не змінюється автоматично</p><ul className="mt-1 list-disc pl-5">{info.map((line, index) => <li key={index}>{line}</li>)}</ul></div>}
    <Modal open={!!selected} onClose={close} title="Підтвердити крок наведення порядку">
      {selected && <>
        <p className="font-semibold">{tidyStepText[selected.step].title}: {selected.count}</p>
        <p className="mt-2 text-sm">{tidyStepText[selected.step].what}</p>
        <p className="mt-2 text-sm text-gray-600">Перед записом програма створить резервну копію бази. Якщо каталог змінився після показу переліку, крок не виконається — оновіть перелік.</p>
        <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" aria-label="Підтверджую крок" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />Я переглянув приклади й погоджуюсь змінити {selected.count} записів.</label>
        {confirmError && <p role="alert" className="mt-3 text-sm text-red-700 [overflow-wrap:anywhere]">{confirmError}</p>}
        <div className="mt-4 flex gap-3"><Button variant="danger" onClick={apply} disabled={busy || !confirmed} loading={busy}>Виконати крок</Button><Button variant="secondary" disabled={busy} onClick={close}>Скасувати</Button></div>
      </>}
    </Modal>
  </Card></div>
}
