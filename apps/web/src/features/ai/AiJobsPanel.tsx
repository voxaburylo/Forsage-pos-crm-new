import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, Pause, Play, Search, X } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { requestDesktopSync } from '@/features/products/productApi'
import { LoadRing } from '@/features/settings/LoadRing'
import { aiJobsApi, applyProductChunk, JOB_STATUS_LABEL, type AiJob, type AiJobItem, type JobItemState } from './aiJobs'
import type { ChatCatalogBridge } from './aiCatalogApply'

/**
 * 26.11.2026, слово власника: «по 200 за раз дуже довго, товарів мільйони; хай працює на сервері у фоні, щоб я
 * запустив на будь-якому пристрої, і він працював». Панель над чатом: підготувати задачу (або її готує сам помічник
 * на прохання в чаті), запустити, бачити хід (кружечок), переглянути готові й підозрілі назви та застосувати.
 */
const message = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback
const money = (usd: number) => '$' + (usd < 10 ? usd.toFixed(2) : Math.round(usd).toLocaleString('uk-UA'))
const select = 'rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm'

export function AiJobsPanel() {
  const [jobs, setJobs] = useState<AiJob[] | null>(null)
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [target, setTarget] = useState('products')
  const [task, setTask] = useState<AiJob['task']>('cleanup')
  const [filter, setFilter] = useState('messy_names')
  const [busy, setBusy] = useState('')
  const [review, setReview] = useState<AiJob | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try { setJobs((await aiJobsApi.list()).data); setError('') }
    catch (reason) { setError(message(reason, 'Не вдалося отримати фонові задачі. Потрібен інтернет.')) }
  }, [])
  useEffect(() => {
    void load()
    void api.get<{ data: Array<{ id: string; name: string }> }>('/api/v1/supplier-api', { silent: true, timeoutMs: 15_000 })
      .then(result => setSuppliers(result.data.map(row => ({ id: row.id, name: row.name }))), () => undefined)
    // Помічник у чаті сам готує задачу — панель дізнається про це з події чату.
    const refresh = () => { void load() }
    window.addEventListener('forsage:ai-jobs-changed', refresh)
    return () => window.removeEventListener('forsage:ai-jobs-changed', refresh)
  }, [load])
  const running = Boolean(jobs?.some(job => job.status === 'running'))
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 10_000)
    return () => window.clearInterval(timer)
  }, [running, load])

  async function act(label: string, run: () => Promise<unknown>, done?: string) {
    setBusy(label)
    try { await run(); if (done) toast.success(done); await load() } catch (reason) { toast.error(message(reason, 'Не вдалося')) } finally { setBusy('') }
  }
  const prepare = () => act('create', async () => {
    const job = (await aiJobsApi.create({ target: target === 'products' ? 'products' : 'supplier_offers', task, filter, ...(target === 'products' ? {} : { connection_id: target }) })).data
    toast.success(job.total ? `Підготовлено: ${job.total.toLocaleString('uk-UA')} товарів. Орієнтовно ${money(job.estimate.cost_usd)}, ≈ ${job.estimate.minutes} хв.` : 'Таких товарів немає')
  })

  const open = jobs?.filter(job => !['done', 'cancelled'].includes(job.status)) ?? []
  const finished = jobs?.filter(job => ['done', 'cancelled'].includes(job.status)).slice(0, 5) ?? []
  return (
    <details className="group mb-3 rounded-xl border border-gray-200 bg-white" open={open.length > 0 || undefined} data-ai-jobs>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <span className="flex-1 text-sm font-semibold text-gray-800">Фонові задачі {open.length > 0 && <span className="font-normal text-gray-500">· {open.length}</span>}</span>
        {open.find(job => job.status === 'running') && <LoadRing progress={open.find(job => job.status === 'running')!.progress} label="Фонова задача" />}
        <ChevronDown size={16} className="text-gray-400 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-3 border-t border-gray-100 px-3 py-3">
        <p className="text-xs text-gray-500">Сервер наводить порядок у назвах чи перекладає їх сам, пачками, навіть коли телефон чи ПК вимкнено. Картки не змінюються, доки ви не переглянете й не натиснете «Застосувати». Можна й просто написати в чаті: «наведи порядок у назвах усіх товарів».</p>
        <div className="flex flex-wrap items-end gap-2">
          <select aria-label="Які товари" value={target} onChange={event => setTarget(event.target.value)} className={select}>
            <option value="products">Наші товари</option>
            {suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>Товари {supplier.name}</option>)}
          </select>
          <select aria-label="Що зробити" value={task} onChange={event => setTask(event.target.value as AiJob['task'])} className={select}>
            <option value="cleanup">Порядок у назвах</option>
            <option value="translate">Переклад українською</option>
            <option value="cleanup_translate">Порядок і переклад</option>
          </select>
          <select aria-label="Які назви" value={filter} onChange={event => setFilter(event.target.value)} className={select}>
            <option value="messy_names">Лише «брудні» назви</option>
            <option value="russian_names">Лише російські</option>
            <option value="all">Усі</option>
          </select>
          <Button size="sm" loading={busy === 'create'} onClick={() => void prepare()}>Підготувати</Button>
        </div>
        {error && <p role="alert" className="text-sm text-amber-800">{error}</p>}
        {jobs === null && !error && <p role="status" className="text-sm text-gray-500">Завантажуємо…</p>}
        {[...open, ...finished].map(job => (
          <div key={job.id} className="rounded-lg border border-gray-100 p-2.5" data-ai-job={job.status}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900">{job.title}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {JOB_STATUS_LABEL[job.status]} · оброблено {job.processed.toLocaleString('uk-UA')} з {job.total.toLocaleString('uk-UA')}
                  {job.changed > 0 && <> · нових назв {job.changed.toLocaleString('uk-UA')}</>}
                  {job.suspicious > 0 && <> · <span className="text-amber-700">підозрілих {job.suspicious.toLocaleString('uk-UA')}</span></>}
                  {job.applied > 0 && <> · застосовано {job.applied.toLocaleString('uk-UA')}</>}
                  {' · '}{job.cost_usd > 0 ? 'витрачено ' + money(job.cost_usd) : job.status === 'ready' ? `орієнтовно ${money(job.estimate.cost_usd)}, ≈ ${job.estimate.minutes} хв` : ''}
                </p>
                {job.last_error && <p className="mt-0.5 text-xs text-red-700">{job.last_error}</p>}
              </div>
              <LoadRing progress={job.progress} label={job.title} showText={job.status === 'running'} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {['ready', 'paused'].includes(job.status) && job.total > 0 && <Button size="sm" icon={<Play size={14} />} loading={busy === 'start' + job.id} onClick={() => void act('start' + job.id, () => aiJobsApi.action(job.id, 'start'), 'Запущено. Можна закрити екран — сервер працює сам.')}>Запустити</Button>}
              {job.status === 'running' && <Button size="sm" variant="secondary" icon={<Pause size={14} />} loading={busy === 'pause' + job.id} onClick={() => void act('pause' + job.id, () => aiJobsApi.action(job.id, 'pause'))}>Пауза</Button>}
              {job.processed > 0 && <Button size="sm" variant="secondary" icon={<Search size={14} />} onClick={() => setReview(job)}>Переглянути</Button>}
              {!['done', 'cancelled'].includes(job.status) && <Button size="sm" variant="ghost" icon={<X size={14} />} loading={busy === 'cancel' + job.id}
                onClick={() => window.confirm('Скасувати задачу? Уже застосовані назви лишаться.') && void act('cancel' + job.id, () => aiJobsApi.action(job.id, 'cancel'))}>Скасувати</Button>}
            </div>
          </div>
        ))}
      </div>
      {review && <JobReview job={review} onClose={() => { setReview(null); void load() }} />}
    </details>
  )
}

const TABS: Array<{ state: JobItemState; label: string }> = [
  { state: 'proposed', label: 'Готові' }, { state: 'suspicious', label: 'Підозрілі' }, { state: 'applied', label: 'Застосовано' },
  { state: 'failed', label: 'Не вдалося' }, { state: 'rejected', label: 'Відхилені' }, { state: 'unchanged', label: 'Без змін' },
]

/** Перегляд результату: стара → нова назва, що прибрано, чому підозріло; погодити, відхилити, застосувати всі готові. */
function JobReview({ job, onClose }: { job: AiJob; onClose: () => void }) {
  const [state, setState] = useState<JobItemState>('proposed')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ items: AiJobItem[]; counts: Partial<Record<JobItemState, number>> } | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState('')

  const load = useCallback(async () => {
    try { setData((await aiJobsApi.items(job.id, state, page)).data); setPicked(new Set()) }
    catch (reason) { toast.error(message(reason, 'Не вдалося відкрити результат')) }
  }, [job.id, state, page])
  useEffect(() => { void load() }, [load])

  async function setItems(to: 'approve' | 'reject') {
    if (!picked.size) return
    setBusy(to)
    try { await aiJobsApi.setItems(job.id, to, [...picked]); await load() } catch (reason) { toast.error(message(reason, 'Не вдалося')) } finally { setBusy('') }
  }

  async function applyAll() {
    setBusy('apply')
    try {
      if (job.target === 'supplier_offers') {
        let total = 0
        for (let round = 0; round < 200; round++) {
          const applied = (await aiJobsApi.applyOffers(job.id)).data.applied
          total += applied
          setProgress(`Застосовано ${total.toLocaleString('uk-UA')}…`)
          if (!applied) break
        }
        toast.success(`Нові назви записано: ${total.toLocaleString('uk-UA')}. Прайс постачальника їх не перезапише.`)
      } else {
        const bridge = desktopBridge()?.catalog as unknown as ChatCatalogBridge | undefined
        if (!bridge?.agentFingerprints || !bridge.agentApply) throw new Error('Застосувати назви наших товарів можна лише через головний ПК: він має бути увімкнений, а програма — оновлена.')
        let applied = 0, failed = 0
        for (let round = 0; round < 2000; round++) {
          const batch = (await aiJobsApi.items(job.id, 'proposed', 1, 500)).data.items
          if (!batch.length) break
          const result = await applyProductChunk(job, batch, bridge)
          await aiJobsApi.markApplied(job.id, result.applied, result.failed)
          applied += result.applied.length; failed += result.failed.length
          setProgress(`Записано ${applied.toLocaleString('uk-UA')}${failed ? `, не вдалося ${failed}` : ''}…`)
          if (!result.applied.length && !result.failed.length) break
        }
        requestDesktopSync()
        if (failed) toast.warning(`Записано ${applied}, не вдалося ${failed} — причини у вкладці «Не вдалося».`)
        else toast.success(`Записано назв: ${applied.toLocaleString('uk-UA')}. Перед записом каса зробила резервну копію.`)
      }
      setProgress('')
      await load()
    } catch (reason) { toast.error(message(reason, 'Не вдалося застосувати')); setProgress('') } finally { setBusy('') }
  }

  const counts = data?.counts ?? {}
  const pages = Math.max(1, Math.ceil((counts[state] ?? 0) / 100))
  return (
    <Modal open onClose={busy === 'apply' ? () => undefined : onClose} title={job.title} size="xl">
      <div className="space-y-3" data-ai-job-review>
        <div className="flex flex-wrap gap-1.5" role="tablist">
          {TABS.map(tab => (
            <button key={tab.state} type="button" role="tab" aria-selected={state === tab.state} onClick={() => { setState(tab.state); setPage(1) }}
              className={`rounded-lg px-2.5 py-1 text-sm ${state === tab.state ? 'bg-gray-900 text-white' : 'border border-gray-200 bg-white text-gray-700'}`}>
              {tab.label} {(counts[tab.state] ?? 0).toLocaleString('uk-UA')}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {state === 'proposed' && <Button size="sm" loading={busy === 'apply'} disabled={!counts.proposed} onClick={() => void applyAll()}>Застосувати всі готові ({(counts.proposed ?? 0).toLocaleString('uk-UA')})</Button>}
          {state === 'suspicious' && <Button size="sm" variant="secondary" loading={busy === 'approve'} disabled={!picked.size} onClick={() => void setItems('approve')}>Погодити вибрані ({picked.size})</Button>}
          {['proposed', 'suspicious'].includes(state) && <Button size="sm" variant="ghost" loading={busy === 'reject'} disabled={!picked.size} onClick={() => void setItems('reject')}>Відхилити вибрані ({picked.size})</Button>}
          {state === 'rejected' && <Button size="sm" variant="secondary" loading={busy === 'approve'} disabled={!picked.size} onClick={() => void setItems('approve')}>Повернути в готові ({picked.size})</Button>}
          {progress && <span role="status" className="text-sm text-gray-600">{progress}</span>}
        </div>
        {state === 'suspicious' && <p className="text-xs text-gray-500">Тут назви, де програма побачила ризик: зʼявилось нове число, зник артикул чи (у перекладі) зникла цифра. Перегляньте й погодьте правильні — вони перейдуть у «Готові».</p>}
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-gray-100">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="w-8 px-2 py-1.5"><input type="checkbox" aria-label="Вибрати всі на сторінці" checked={Boolean(data?.items.length) && data!.items.every(item => picked.has(item.item_key))}
                  onChange={event => setPicked(event.target.checked ? new Set(data?.items.map(item => item.item_key)) : new Set())} /></th>
                <th className="px-2 py-1.5">Було</th><th className="px-2 py-1.5">Стане</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map(item => (
                <tr key={item.item_key} className="border-t border-gray-100 align-top">
                  <td className="px-2 py-1.5"><input type="checkbox" aria-label={'Вибрати ' + item.old_name} checked={picked.has(item.item_key)}
                    onChange={event => setPicked(current => { const next = new Set(current); if (event.target.checked) next.add(item.item_key); else next.delete(item.item_key); return next })} /></td>
                  <td className="px-2 py-1.5 text-gray-500">{item.old_name}{item.sku ? <span className="block text-xs">арт. {item.sku}</span> : null}</td>
                  <td className="px-2 py-1.5 text-gray-900">{item.new_name ?? '—'}{item.new_sku ? <span className="block text-xs text-gray-500">новий артикул {item.new_sku}</span> : null}
                    {item.note && <span className={`block text-xs ${item.state === 'suspicious' || item.state === 'failed' ? 'text-amber-700' : 'text-gray-400'}`}>{item.note}</span>}</td>
                </tr>
              ))}
              {data && !data.items.length && <tr><td colSpan={3} className="px-2 py-6 text-center text-gray-400">Порожньо</td></tr>}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Назад</Button>
            <span>{page} з {pages}</span>
            <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Далі</Button>
          </div>
        )}
      </div>
    </Modal>
  )
}
