import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { BATCH_SIZES, DEFAULT_BATCH, jobText, photoAiApi, worstCaseCalls, type PhotoAiStatus, type ReviewProduct } from './photoAiApi'
import { collectTillBatch, hasTillCatalog, runApplyApproved } from './photoAiApply'

/**
 * «Фото ШІ» — масовий режим для товарів без фото: партія → черга у фоні → «готово N з M» → кнопка «Стоп».
 * Два режими: «на перевірку» (знайдене чекає людини — типово) і «автоматично» (найкраще фото ставиться одразу).
 * Гроші: партії малі, перед запуском видно найбільшу можливу кількість платних запитів, далі — лічильник витраченого.
 */
const message = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback

export function PhotoAiBulkModal({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged?: () => void }) {
  const [status, setStatus] = useState<PhotoAiStatus | null>(null)
  const [error, setError] = useState('')
  const [size, setSize] = useState<number>(DEFAULT_BATCH)
  const [mode, setMode] = useState<'review' | 'auto'>('review')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState('')
  const [review, setReview] = useState<ReviewProduct[]>([])
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [note, setNote] = useState('')
  const applying = useRef(false)
  const onTill = hasTillCatalog()

  const applyNow = useCallback(async () => {
    if (applying.current) return
    applying.current = true
    try {
      const result = await runApplyApproved()
      if (result && (result.applied || result.skipped)) {
        setNote(`Поставлено в картки: ${result.applied}` + (result.skipped ? ` · у картці вже було своє фото: ${result.skipped}` : ''))
        onChanged?.()
      }
    } catch { /* наступне оновлення екрана спробує ще раз */ } finally { applying.current = false }
  }, [onChanged])

  const load = useCallback(async () => {
    try {
      const data = await photoAiApi.status()
      setStatus(data); setError('')
      if (data.review) {
        const list = await photoAiApi.review()
        setReview(list.products)
        setChecked(current => { const next = { ...current }; for (const product of list.products) for (const photo of product.photos) if (!(photo.id in next)) next[photo.id] = true; return next })
      } else setReview([])
      if (data.unapplied) void applyNow()
    } catch (reason) { setError(message(reason, 'Не вдалося відкрити «Фото ШІ». Потрібен інтернет.')) }
  }, [applyNow])

  useEffect(() => {
    if (!open) return
    setConfirming(false); setNote('')
    void load()
    const timer = window.setInterval(() => { void load() }, 6_000)
    return () => window.clearInterval(timer)
  }, [open, load])

  async function start() {
    setBusy('start')
    try {
      const products = await collectTillBatch(size)
      if (!products.length) { toast.error('Товарів без фото, яких ще не шукали за останні 30 днів, не знайдено.'); return }
      const started = await photoAiApi.start(mode, products)
      toast.success(`Партію запущено: ${started.job.total} товарів`)
      setConfirming(false)
      await load()
    } catch (reason) { toast.error(message(reason, 'Не вдалося запустити партію')) } finally { setBusy('') }
  }

  async function change(action: 'stop' | 'resume') {
    if (!status?.job) return
    setBusy(action)
    try { await photoAiApi.change(status.job.id, action); await load() }
    catch (reason) { toast.error(message(reason, 'Не вдалося')) } finally { setBusy('') }
  }

  async function decide(product: ReviewProduct, none = false) {
    setBusy(product.product_id)
    try {
      await photoAiApi.decide(product.product_id, none ? [] : product.photos.filter(photo => checked[photo.id]).map(photo => photo.id))
      setReview(current => current.filter(item => item.product_id !== product.product_id))
      await load()
    } catch (reason) { toast.error(message(reason, 'Не вдалося зберегти рішення')) } finally { setBusy('') }
  }

  async function decideAll() {
    setBusy('all')
    try {
      for (const product of review) await photoAiApi.decide(product.product_id, product.photos.filter(photo => checked[photo.id]).map(photo => photo.id))
      setReview([])
      await load()
    } catch (reason) { toast.error(message(reason, 'Не все вдалося зберегти — список оновлено')); await load() } finally { setBusy('') }
  }

  const job = status?.job ?? null
  const ready = Boolean(status?.keys.serper && status.keys.ai)
  const worst = worstCaseCalls(size)
  return (
    <Modal open={open} onClose={onClose} title="Фото ШІ — товари без фото" size="xl">
      <div className="space-y-4" data-photo-ai-bulk>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {!status && !error && <p className="text-sm text-gray-500">Завантаження…</p>}
        {status && !ready && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {!status.keys.serper
              ? 'Спершу власник має вставити ключ Serper.dev: Сайт → Налаштування → «Ключі API» → «Фото ШІ». Без нього нічого не шукається.'
              : 'Помічник ШІ вимкнений або немає ключа Anthropic (Налаштування → ШІ). Фото перевіряє саме він.'}
          </p>
        )}
        {status && (
          <section className="rounded-lg border border-gray-200 p-3 space-y-2">
            <p className="text-sm font-medium" role="status">{jobText(job)}</p>
            {job && (
              <>
                <div className="h-2 overflow-hidden rounded bg-gray-100" aria-hidden>
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${job.total ? Math.round(job.done / job.total * 100) : 0}%` }} />
                </div>
                <p className="text-xs text-gray-500">
                  Режим: {job.mode === 'auto' ? 'автоматично' : 'на перевірку'} · витрачено в цій партії: пошук {job.serper_calls}, перевірок фото {job.ai_calls} (≈ ${job.ai_usd.toFixed(2)})
                  {' '}· за сьогодні: пошук {status.usage.serper_today}, перевірок {status.usage.ai_today} · за 30 днів: пошук {status.usage.serper_month}, перевірок {status.usage.ai_month} (≈ ${status.usage.usd_month.toFixed(2)})
                </p>
              </>
            )}
            <div className="flex flex-wrap gap-2">
              {job?.status === 'running' && <Button type="button" size="sm" variant="secondary" loading={busy === 'stop'} onClick={() => void change('stop')}>⏹ Стоп</Button>}
              {job?.status === 'stopped' && <Button type="button" size="sm" loading={busy === 'resume'} onClick={() => void change('resume')}>▶ Продовжити</Button>}
            </div>
            {note && <p className="text-xs text-green-700">{note}</p>}
            {status.unapplied > 0 && !onTill && (
              <p className="text-xs text-gray-500">Готових фото, що чекають картки: {status.unapplied}. Їх ставить головний ПК — сам, протягом 10 хвилин, коли програма на ньому відкрита.</p>
            )}
          </section>
        )}
        {status && ready && job?.status !== 'running' && (
          <section className="rounded-lg border border-gray-200 p-3 space-y-2">
            <p className="text-sm font-medium">Нова партія</p>
            {!onTill ? (
              <p className="text-sm text-gray-600">Партію запускають на головному ПК: лише каса знає, у яких товарів уже є своє фото. Тут можна стежити за ходом і перевіряти знайдене.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <label className="flex items-center gap-2">Товарів у партії
                    <select value={size} onChange={event => { setSize(Number(event.target.value)); setConfirming(false) }} className="rounded border border-gray-300 px-2 py-1">
                      {BATCH_SIZES.map(count => <option key={count} value={count}>{count}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1"><input type="radio" name="photo-ai-mode" checked={mode === 'review'} onChange={() => setMode('review')} /> на перевірку</label>
                  <label className="flex items-center gap-1"><input type="radio" name="photo-ai-mode" checked={mode === 'auto'} onChange={() => setMode('auto')} /> автоматично</label>
                </div>
                <p className="text-xs text-gray-500">
                  Беруться товари без фото, спершу ті, що є на складі. {mode === 'auto' ? 'Найкращі фото одразу ставляться в картки.' : 'Знайдене чекатиме вашого підтвердження нижче.'}
                  {' '}Товар без підхожого фото не шукаємо знову 30 днів.{status.settings.night_only ? ' Увімкнено «лише вночі»: черга піде з 22:00.' : ''}
                </p>
                {!confirming
                  ? <Button type="button" size="sm" onClick={() => setConfirming(true)}>Запустити партію…</Button>
                  : (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                      <p>Це платно: щонайбільше {worst.serper} запитів пошуку (Serper.dev) і {worst.ai} перевірок фото помічником (≈ до ${worst.usd.toFixed(2)} з рахунку Anthropic). Запустити?</p>
                      <div className="mt-2 flex gap-2">
                        <Button type="button" size="sm" loading={busy === 'start'} onClick={() => void start()}>Так, запустити</Button>
                        <Button type="button" size="sm" variant="secondary" disabled={busy === 'start'} onClick={() => setConfirming(false)}>Ні</Button>
                      </div>
                    </div>
                  )}
              </>
            )}
          </section>
        )}
        {review.length > 0 && (
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">На перевірку: {status?.review ?? review.length} товарів</p>
              <Button type="button" size="sm" loading={busy === 'all'} onClick={() => void decideAll()}>Зберегти всі відмічені</Button>
            </div>
            <p className="text-xs text-gray-500">Зніміть галочку з фото, яке не підходить. Перше відмічене стане головним, решта — галереєю для сайту.</p>
            <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
              {review.map(product => (
                <li key={product.product_id} className="rounded-lg border border-gray-200 p-2">
                  <p className="text-sm font-medium break-words">{product.name}</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {product.photos.map(photo => (
                      <label key={photo.id} className={`relative cursor-pointer rounded border-2 bg-white p-1 ${checked[photo.id] ? 'border-blue-600' : 'border-gray-200 opacity-60'}`}>
                        <input type="checkbox" className="absolute left-1 top-1" checked={Boolean(checked[photo.id])} aria-label={'Фото для ' + product.name}
                          onChange={event => setChecked(current => ({ ...current, [photo.id]: event.target.checked }))} />
                        <img src={photo.thumb_url} alt="" loading="lazy" className="h-28 w-28 object-contain" />
                      </label>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button type="button" size="sm" loading={busy === product.product_id} disabled={!product.photos.some(photo => checked[photo.id])} onClick={() => void decide(product)}>Зберегти відмічені</Button>
                    <Button type="button" size="sm" variant="secondary" disabled={busy === product.product_id} onClick={() => void decide(product, true)}>Жодне не підходить</Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="flex justify-end border-t border-gray-100 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Закрити</Button>
        </div>
      </div>
    </Modal>
  )
}
