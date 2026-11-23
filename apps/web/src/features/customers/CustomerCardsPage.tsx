import { useCallback, useEffect, useState } from 'react'
import { Copy, FileSpreadsheet, Printer } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge } from '@/lib/desktopBridge'
import {
  CARD_BATCH_MAX, CARD_COUNT_PRESETS, CARD_FORMATS, type CardFormat, cardBatchFileName, cardCodesSheet, cardCodesText, cardFormatLabel, parseCardCount,
} from './cardBatchModel'

type Batch = { id: string; created_at: string; format: CardFormat; count: number; linked: number }
type Shown = { id: string; created_at: string; format: CardFormat; codes: string[] }

const dateText = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }

async function saveExcel(shown: Shown) {
  const XLSX = await import('xlsx')
  const sheet = XLSX.utils.aoa_to_sheet(cardCodesSheet(shown.codes))
  sheet['!cols'] = [{ wch: 18 }]
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Картки')
  XLSX.writeFile(book, cardBatchFileName(shown.created_at, shown.codes.length))
}

/**
 * «Клієнти» → «Картки для друку» (план B2, 23.11.2026): стовпчик нових штрихкодів для друкарні.
 * Видані коди головний ПК запам'ятовує як вільні картки: вдруге не видасть, а при першому скануванні
 * на касі запропонує прив'язати картку до клієнта.
 */
export default function CustomerCardsPage() {
  const pos = desktopBridge()?.pos
  const [countText, setCountText] = useState('100')
  const [format, setFormat] = useState<CardFormat>('ean13')
  const [busy, setBusy] = useState(false)
  const [batches, setBatches] = useState<Batch[] | null>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [loadError, setLoadError] = useState('')

  const reload = useCallback(() => {
    if (!pos?.cardBatches) return
    setLoadError('')
    pos.cardBatches().then(setBatches, error => setLoadError(error instanceof Error ? error.message : 'Не вдалося завантажити пачки'))
  }, [pos])
  useEffect(() => { reload() }, [reload])

  if (!pos?.cardBatches || !pos.createCardBatch || !pos.cardBatchCodes) {
    return <Layout title="Картки для друку"><Card><p className="text-sm text-gray-600">Цей розділ працює в програмі на касі або у вебі, коли головний ПК на звʼязку. Оновіть програму на головному ПК.</p></Card></Layout>
  }

  const parsed = parseCardCount(countText)

  async function generate() {
    if (busy || 'error' in parsed || !pos?.createCardBatch) return
    setBusy(true)
    try {
      const batch = await pos.createCardBatch({ count: parsed.count, format })
      setShown(batch)
      toast.success(`Готово: ${batch.codes.length} нових кодів`)
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося створити пачку')
    } finally { setBusy(false) }
  }

  async function show(batch: Batch) {
    if (busy || !pos?.cardBatchCodes) return
    setBusy(true)
    try { setShown({ id: batch.id, created_at: batch.created_at, format: batch.format, codes: await pos.cardBatchCodes(batch.id) }) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Не вдалося показати коди') }
    finally { setBusy(false) }
  }

  async function copy() {
    if (!shown) return
    try { await navigator.clipboard.writeText(cardCodesText(shown.codes)); toast.success(`Скопійовано кодів: ${shown.codes.length}`) }
    catch { toast.error('Не вдалося скопіювати. Виділіть стовпчик і скопіюйте вручну.') }
  }

  return (
    <Layout title="Картки для друку">
      <div className="mx-auto max-w-3xl space-y-4">
        <Card>
          <h2 className="flex items-center gap-2 font-semibold text-gray-800"><Printer size={16} aria-hidden="true" />Нова пачка штрихкодів</h2>
          <p className="mt-1 text-sm text-gray-600">Стовпчик нових кодів для друкарні. Кожен код перевіряється: його немає ні в клієнтів, ні в товарів, ні в попередніх пачках.</p>
          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="card-count" className="mb-1 block text-sm font-medium text-gray-700">Скільки карток</label>
              <div className="flex flex-wrap items-center gap-2">
                {CARD_COUNT_PRESETS.map(preset => (
                  <button key={preset} type="button" onClick={() => setCountText(String(preset))} aria-pressed={countText.trim() === String(preset)}
                    className={`rounded-lg border px-3 py-2 text-sm font-semibold ${countText.trim() === String(preset) ? 'border-yellow-400 bg-yellow-50 text-yellow-800' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`}>{preset}</button>
                ))}
                <input id="card-count" inputMode="numeric" value={countText} onChange={event => setCountText(event.target.value)} aria-invalid={'error' in parsed}
                  className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="своє число" />
              </div>
              {'error' in parsed ? <p role="alert" className="mt-1 text-xs text-red-600">{parsed.error}</p> : <p className="mt-1 text-xs text-gray-500">За один раз — до {CARD_BATCH_MAX}.</p>}
            </div>
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-gray-700">Формат</legend>
              <div className="space-y-2">
                {CARD_FORMATS.map(item => (
                  <label key={item.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 px-3 py-2 has-[:checked]:border-yellow-400 has-[:checked]:bg-yellow-50">
                    <input type="radio" name="card-format" value={item.id} checked={format === item.id} onChange={() => setFormat(item.id)} className="mt-1" />
                    <span><span className="block text-sm font-medium text-gray-800">{item.label}</span><span className="block text-xs text-gray-500">{item.hint}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Button onClick={() => void generate()} disabled={busy || 'error' in parsed}>{busy ? 'Працюємо…' : 'Згенерувати'}</Button>
          </div>
        </Card>

        {shown && (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold text-gray-800">Коди: {shown.codes.length} шт. <span className="font-normal text-gray-500">· {cardFormatLabel(shown.format)} · {dateText(shown.created_at)}</span></h2>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" icon={<Copy size={14} />} onClick={() => void copy()}>Скопіювати</Button>
                <Button size="sm" variant="secondary" icon={<FileSpreadsheet size={14} />} onClick={() => { void saveExcel(shown).catch(() => toast.error('Не вдалося зберегти файл Excel')) }}>Зберегти в Excel</Button>
              </div>
            </div>
            <textarea readOnly value={cardCodesText(shown.codes)} aria-label="Стовпчик кодів карток" data-card-codes
              className="mt-3 h-64 w-full rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-sm" onFocus={event => event.currentTarget.select()} />
          </Card>
        )}

        <Card>
          <h2 className="font-semibold text-gray-800">Видані пачки</h2>
          {loadError && <p role="alert" className="mt-2 text-sm text-amber-700">{loadError} <button type="button" className="font-semibold underline" onClick={reload}>Повторити</button></p>}
          {!loadError && batches === null && <p role="status" className="mt-2 text-sm text-gray-500">Завантажуємо…</p>}
          {batches && batches.length === 0 && <p className="mt-2 text-sm text-gray-500">Пачок ще не було.</p>}
          {batches && batches.length > 0 && (
            <div className="mt-2">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs uppercase text-gray-500"><th className="py-2 pr-3">Дата</th><th className="py-2 pr-3">Формат</th><th className="py-2 pr-3 text-right">Видано</th><th className="py-2 pr-3 text-right">Привʼязано</th><th /></tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {batches.map(batch => (
                    <tr key={batch.id} data-card-batch={batch.id}>
                      <td className="py-2 pr-3 whitespace-nowrap">{dateText(batch.created_at)}</td>
                      <td className="py-2 pr-3">{cardFormatLabel(batch.format)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{batch.count}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{batch.linked}</td>
                      <td className="py-2 text-right"><button type="button" disabled={busy} onClick={() => void show(batch)} className="text-sm font-semibold text-blue-700 hover:text-blue-900 disabled:opacity-50">Показати коди</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Layout>
  )
}
