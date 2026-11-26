import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { errorText } from './siteGateway'
import { isOpen, textJobLine, textJobsApi, type TextItem, type TextJob, type TextJobAction } from './siteTextJobs'

/**
 * Масова робота над текстами товарів — одна смужка вгорі вкладки помічника (26.11.2026, слово власника: «великі пачки,
 * без купи підтверджень і всього червоного; зручно й тактовно»). Одне рішення від власника — «зразки годяться»; далі сервер
 * працює сам, а тут видно один рядок стану. Кольори спокійні: сірий і зелений, жодних червоних плашок.
 */
export function SiteTextJobPanel({ refresh = 0 }: { refresh?: number }) {
  const [job, setJob] = useState<TextJob | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState('')
  const [scope, setScope] = useState<'in_stock' | 'all'>('in_stock')
  const [overwrite, setOverwrite] = useState(false)
  const [samples, setSamples] = useState<TextItem[]>([])
  const [note, setNote] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)

  const load = useCallback(async () => {
    try { const jobs = await textJobsApi.list(); setJob(jobs[0] ?? null); setMissing(false) } catch { setMissing(true) }
  }, [])
  useEffect(() => { void load() }, [load, refresh])
  // Поки робота йде — тихо оновлюємо рядок стану.
  const live = Boolean(job && ['sample', 'running', 'reverting'].includes(job.status))
  useEffect(() => { if (!live) return; const timer = window.setInterval(() => void load(), 6000); return () => window.clearInterval(timer) }, [live, load])
  useEffect(() => {
    if (job?.status !== 'sample_ready') { setSamples([]); return }
    let alive = true
    textJobsApi.items(job.id, 'sample').then(items => { if (alive) setSamples(items) }, () => undefined)
    return () => { alive = false }
  }, [job?.id, job?.status])

  async function act(key: string, run: () => Promise<TextJob>, done?: string) {
    setBusy(key)
    try { setJob(await run()); if (done) toast.success(done) } catch (reason) { toast.error(errorText(reason, 'Не вийшло. Спробуйте ще раз.')) } finally { setBusy('') }
  }
  const action = (name: TextJobAction, done?: string, extra?: { style_note?: string }) => job && act(name, () => textJobsApi.action(job.id, name, extra), done)

  if (missing) return null
  const open = isOpen(job)
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-3" data-site-text-job={job?.status ?? 'none'}>
      <p className="text-sm font-semibold text-gray-900">Тексти для всіх товарів одразу</p>
      {!open && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <select aria-label="Які товари" value={scope} onChange={event => setScope(event.target.value as 'in_stock' | 'all')} className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm">
            <option value="in_stock">Товари в наявності</option>
            <option value="all">Усі товари</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-gray-600"><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} /> переписати й ті, де опис уже є</label>
          <Button size="sm" loading={busy === 'create'} onClick={() => void act('create', () => textJobsApi.create({ scope, overwrite }))} data-site-text-start>Почати — спершу 10 зразків</Button>
        </div>
      )}
      {job && <p role="status" className="mt-2 text-sm text-gray-700" data-site-text-line>{textJobLine(job)}</p>}
      {job && live && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${job.status === 'sample' ? 5 : job.progress}%` }} /></div>}

      {job?.status === 'sample_ready' && (
        <div className="mt-3 space-y-2" data-site-text-samples>
          <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
            {samples.map(item => <TextCard key={item.product_id} item={item} />)}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" loading={busy === 'approve_sample'} onClick={() => void action('approve_sample', 'Працюю далі сам. Екран можна закрити.')} data-site-text-approve>Годиться — роби всі {job.total.toLocaleString('uk-UA')}</Button>
            <input value={note} onChange={event => setNote(event.target.value)} maxLength={500} placeholder="або напишіть, що змінити: коротше, без слова «купити»…"
              className="min-w-[14rem] flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-yellow-400" aria-label="Побажання до стилю" />
            <Button size="sm" variant="secondary" disabled={!note.trim()} loading={busy === 'redo_sample'} onClick={() => void action('redo_sample', 'Переписую зразки.', { style_note: note.trim() })}>Переписати зразки</Button>
            <Button size="sm" variant="ghost" loading={busy === 'cancel'} onClick={() => void action('cancel')}>Не треба</Button>
          </div>
        </div>
      )}

      {job && job.status !== 'sample_ready' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {job.status === 'running' && <Button size="sm" variant="secondary" loading={busy === 'pause'} onClick={() => void action('pause')}>Пауза</Button>}
          {job.status === 'paused' && <Button size="sm" loading={busy === 'resume'} onClick={() => void action('resume')}>Продовжити</Button>}
          {job.review > 0 && <Button size="sm" variant="secondary" onClick={() => setReviewOpen(true)} data-site-text-review>Відкладені на ваш погляд ({job.review.toLocaleString('uk-UA')})</Button>}
          {job.failed > 0 && <Button size="sm" variant="secondary" loading={busy === 'retry_failed'} onClick={() => void action('retry_failed')}>Спробувати ще раз ({job.failed})</Button>}
          {['sample', 'running', 'paused'].includes(job.status) && <Button size="sm" variant="ghost" loading={busy === 'cancel'}
            onClick={() => { if (window.confirm('Зупинити роботу? Уже записані тексти лишаться на сайті.')) void action('cancel') }}>Зупинити</Button>}
          {['done', 'cancelled', 'paused'].includes(job.status) && job.written > 0 && <Button size="sm" variant="ghost" loading={busy === 'revert'}
            onClick={() => { if (window.confirm(`Повернути на сайт тексти, які були до цієї роботи (${job.written} товарів)?`)) void action('revert', 'Повертаю як було.') }}>Повернути як було</Button>}
        </div>
      )}
      {job && reviewOpen && <ReviewModal job={job} onClose={() => { setReviewOpen(false); void load() }} onJob={setJob} />}
    </section>
  )
}

function TextCard({ item, footer }: { item: TextItem; footer?: React.ReactNode }) {
  return (
    <li className="rounded-lg border border-gray-100 bg-gray-50/60 p-2 text-xs">
      <p className="font-medium text-gray-900">{item.name}</p>
      {item.new_fields?.seo_title && <p className="mt-1 text-blue-800">{item.new_fields.seo_title}</p>}
      {item.new_fields?.seo_description && <p className="text-gray-600">{item.new_fields.seo_description}</p>}
      {item.new_fields?.description && <p className="mt-1 whitespace-pre-line text-gray-800">{item.new_fields.description}</p>}
      {item.note && <p className="mt-1 text-gray-500">Чому відкладено: {item.note}</p>}
      {footer}
    </li>
  )
}

/** Тексти, які програма не пустила на сайт сама: видно причину; можна записати, або пропустити — по одному чи всі разом. */
function ReviewModal({ job, onClose, onJob }: { job: TextJob; onClose: () => void; onJob: (job: TextJob) => void }) {
  const [items, setItems] = useState<TextItem[] | null>(null)
  const [busy, setBusy] = useState('')
  const load = useCallback(async () => { try { setItems(await textJobsApi.items(job.id, 'review')) } catch { setItems([]) } }, [job.id])
  useEffect(() => { void load() }, [load])
  async function run(key: string, action: 'write_review' | 'reject_review', ids?: string[]) {
    setBusy(key)
    try { onJob(await textJobsApi.action(job.id, action, ids ? { product_ids: ids } : {})); await load() } catch (reason) { toast.error(errorText(reason, 'Не вийшло')) } finally { setBusy('') }
  }
  return (
    <Modal open onClose={onClose} title="Відкладені на ваш погляд" size="xl">
      <div className="space-y-3" data-site-text-review-list>
        <p className="text-xs text-gray-500">Тут тексти, у яких програма побачила те, чого немає в даних товару (число, назву авто, обіцянку), або текст вийшов закоротким. На сайт вони не пішли. Якщо текст правильний — запишіть його; якщо ні — пропустіть, а товар можна описати вручну в «Товарах».</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!items?.length} loading={busy === 'all-reject'} onClick={() => void run('all-reject', 'reject_review')}>Пропустити всі</Button>
          <Button size="sm" variant="ghost" disabled={!items?.length} loading={busy === 'all-write'}
            onClick={() => { if (window.confirm('Записати на сайт усі відкладені тексти без перегляду кожного?')) void run('all-write', 'write_review') }}>Записати всі</Button>
        </div>
        <ul className="max-h-[60vh] space-y-2 overflow-y-auto">
          {items?.map(item => <TextCard key={item.product_id} item={item} footer={
            <div className="mt-2 flex gap-2">
              <Button size="sm" loading={busy === 'w' + item.product_id} onClick={() => void run('w' + item.product_id, 'write_review', [item.product_id])}>Записати</Button>
              <Button size="sm" variant="secondary" loading={busy === 'r' + item.product_id} onClick={() => void run('r' + item.product_id, 'reject_review', [item.product_id])}>Пропустити</Button>
            </div>} />)}
          {items && !items.length && <li className="py-6 text-center text-sm text-gray-400">Порожньо</li>}
          {!items && <li className="py-6 text-center text-sm text-gray-400">Завантажуємо…</li>}
        </ul>
      </div>
    </Modal>
  )
}
