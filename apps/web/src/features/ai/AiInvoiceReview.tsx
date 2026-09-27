import { useEffect, useRef, useState } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'

type Supply = NonNullable<NonNullable<ReturnType<typeof desktopBridge>>['supply']>
type Review = Awaited<ReturnType<NonNullable<Supply['previewInvoiceFromAi']>>>[number]
type Row = Record<string, unknown>
export function AiInvoiceReview({ actionId, rows, onReady, disabled }: {
  actionId: string; rows: Row[]; onReady: (rows: Row[] | null) => void; disabled: boolean
}) {
  const [review, setReview] = useState<Review[]>([]), [drafts, setDrafts] = useState<Row[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const callback = useRef(onReady)
  useEffect(() => { callback.current = onReady }, [onReady])
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(''); callback.current(null)
    const preview = desktopBridge()?.supply?.previewInvoiceFromAi
    if (!preview) { setError('Для перевірки товарів потрібна оновлена локальна програма.'); setLoading(false); return }
    void preview({ rows }).then(result => {
      if (cancelled) return
      if (result.length !== rows.length) throw new Error('Перевірено не всі рядки накладної. Повторіть розпізнавання.')
      setReview(result)
      setDrafts(result.map((item, index) => ({ ...rows[index], source_name: item.source_name,
        name: item.status === 'matched' ? rows[index].name : item.name, brand: item.brand,
        match_choice: rows[index].match_choice ?? item.product_id ?? '',
      })))
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Не вдалося перевірити товари') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [actionId, rows])
  useEffect(() => {
    callback.current(!loading && !error && drafts.length === rows.length && review.every((item,index) => item.status !== 'review' || drafts[index]?.match_choice)
      ? drafts : null)
  }, [drafts, review, loading, error, rows.length])
  function update(index: number, patch: Row) { setDrafts(current => current.map((row,i) => i === index ? { ...row, ...patch } : row)) }
  if (loading) return <p className="py-4 text-sm text-gray-600">Зіставляю з локальною базою…</p>
  if (error) return <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>
  const unresolved = review.filter((item,index) => item.status === 'review' && !drafts[index]?.match_choice).length
  return <div className="space-y-2">
    <p className="text-xs text-gray-600">З бази: {review.filter(item => item.status === 'matched').length} · Перевірити: {unresolved}. Кількість і закупка залишаться з накладної. Назва знайденого товару — з вашої бази.</p>
    <div className="max-h-[60vh] space-y-2 overflow-y-auto">
      {review.map((item,index) => {
        const draft = drafts[index], choice = String(draft?.match_choice ?? '')
        const chosen = item.candidates.find(product => product.id === choice)
        const isNew = choice === 'new' || (item.status === 'new' && !choice)
        return <div key={index} className={`rounded-lg border p-3 ${item.status === 'review' && !choice ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
          <p className="break-words text-xs text-gray-500">{index + 1}. У накладній: {item.source_name}</p>
          {item.status === 'review' && <select aria-label={`Товар для рядка ${index+1}`} disabled={disabled} value={choice}
            onChange={event => update(index, { match_choice: event.target.value })} className="my-2 w-full min-w-0 rounded border border-amber-400 bg-white p-2 text-sm">
            <option value="">Перевірте схожі товари — виберіть картку</option>
            {item.candidates.map(product => <option key={product.id} value={product.id}>{product.name} · {product.sku} · {product.barcode || 'без штрихкоду'}</option>)}
            <option value="new">Це інший товар — створити новий</option>
          </select>}
          {chosen ? <p className="mt-1 break-words text-sm font-semibold text-green-800">З бази: {chosen.name}</p>
            : isNew ? <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_10rem]">
              <label className="text-xs text-gray-600">Коротка назва для етикетки
                <input aria-label={`Назва нового товару ${index+1}`} value={String(draft?.name ?? '')} disabled={disabled} onChange={event => update(index, { name: event.target.value })} className="mt-1 w-full rounded border p-2 text-sm text-gray-900" />
              </label>
              <label className="text-xs text-gray-600">Бренд (якщо відомий)
                <input aria-label={`Бренд нового товару ${index+1}`} value={String(draft?.brand ?? '')} disabled={disabled} onChange={event => update(index, { brand: event.target.value })} className="mt-1 w-full rounded border p-2 text-sm text-gray-900" />
              </label>
            </div> : <p className="mt-1 text-sm text-amber-800">{item.reason}</p>}
          <p className="mt-2 text-xs text-gray-600">Кількість: {String(draft?.qty ?? '')} · Закупка: {String(draft?.purchase_price_uah ?? '')} грн · {isNew ? 'Новий, без штрихкоду' : chosen?.barcode || 'Потрібне зіставлення'}</p>
          {Boolean(draft?.purchase_price_note) && <p role="note" className="mt-1 text-xs font-medium text-amber-800">{String(draft?.purchase_price_note)}</p>}
        </div>
      })}
    </div>
  </div>
}
