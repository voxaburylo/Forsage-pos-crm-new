import { useMemo, useState } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import { Button } from '@/components/ui'
import type { AiPendingAction } from './aiApi'

/**
 * 26.11.2026, слово власника: «хочу візуально бачити, у чому він не впевнений — щоб це була таблиця; у чому впевнений
 * на сто відсотків — таблиця не потрібна, тільки підтвердити, і все».
 *  — точні пари (sure=true): одним рядком «Точно той самий товар: N пар», без таблиці (переглянути — за бажанням);
 *  — сумнівні: таблиця-картки з обома картками й причиною сумніву; власник сам відмічає, які обʼєднати (за замовчуванням — жодної);
 *  — «Підтвердити» обʼєднує точні + відмічені сумнівні.
 */
export interface MergePair { primary_product_id: string; duplicate_product_id: string; reason?: string; sure?: boolean }
export interface MergeRow { pair: MergePair; keep: string; gone: string; why: string; index: number }

export function mergeRows(action: AiPendingAction): { sure: MergeRow[]; doubt: MergeRow[] } {
  const merges = (Array.isArray(action.payload?.merges) ? action.payload.merges : []) as MergePair[]
  const items = action.items ?? []
  const rows = merges.map((pair, index): MergeRow => ({
    pair, index,
    keep: items[index]?.['Залишається'] ?? pair.primary_product_id,
    gone: items[index]?.['Зливається (зникне)'] ?? pair.duplicate_product_id,
    why: items[index]?.['Чому'] ?? pair.reason ?? '',
  }))
  // Стара пропозиція (до 26.11) без позначок: усе — у таблицю, як сумнівне.
  return { sure: rows.filter(row => row.pair.sure === true), doubt: rows.filter(row => row.pair.sure !== true) }
}

/** Пари, які власник вирішив не обʼєднувати: невідмічені сумнівні (при підтвердженні). */
export function declinedPairs(rows: { doubt: MergeRow[] }, picked: ReadonlySet<number>): Array<{ a: string; b: string }> {
  return rows.doubt.filter(row => !picked.has(row.index)).map(row => ({ a: row.pair.primary_product_id, b: row.pair.duplicate_product_id }))
}

export function chosenMerges(rows: { sure: MergeRow[]; doubt: MergeRow[] }, picked: ReadonlySet<number>): MergePair[] {
  return [...rows.sure, ...rows.doubt.filter(row => picked.has(row.index))].sort((a, b) => a.index - b.index).map(row => row.pair)
}

export function MergeProposal({ action, busy, onConfirm, onReject }: {
  action: AiPendingAction; busy: boolean; onConfirm: (merges: MergePair[], declined: Array<{ a: string; b: string }>) => void; onReject: () => void
}) {
  const rows = useMemo(() => mergeRows(action), [action])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const chosen = chosenMerges(rows, picked)
  const toggle = (index: number) => setPicked(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })
  return (
    <div className="space-y-2" data-ai-merge-proposal>
      {rows.sure.length > 0 && (
        <details className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" data-ai-merge-sure>
          <summary className="cursor-pointer list-none font-semibold [&::-webkit-details-marker]:hidden">
            <Check size={14} className="mr-1 inline" /> Точно той самий товар: {rows.sure.length} {rows.sure.length === 1 ? 'пара' : 'пар'}
            <span className="ml-1 text-xs font-normal text-emerald-700 underline">показати</span>
          </summary>
          <ul className="mt-1.5 space-y-1 text-xs">
            {rows.sure.map(row => <li key={row.index} className="break-words">{row.keep} ← <span className="text-emerald-700">{row.gone}</span></li>)}
          </ul>
        </details>
      )}
      {rows.doubt.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-white" data-ai-merge-doubt>
          <p className="flex items-center gap-1 border-b border-amber-100 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800">
            <AlertTriangle size={12} /> Сумнівні: {rows.doubt.length} — відмітьте ті, що обʼєднати
          </p>
          <p className="px-3 pt-1.5 text-[11px] text-gray-500">Невідмічені програма запамʼятає як «не дублі» й більше не пропонуватиме.</p>
          <ul className="divide-y divide-gray-100">
            {rows.doubt.map(row => (
              <li key={row.index}>
                <label className="flex cursor-pointer gap-2 px-3 py-2 text-xs">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 rounded text-amber-500" checked={picked.has(row.index)} onChange={() => toggle(row.index)}
                    aria-label={'Обʼєднати: ' + row.gone} data-ai-merge-pick={row.index} />
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block break-words text-gray-900"><span className="text-gray-400">Лишається: </span>{row.keep}</span>
                    <span className="block break-words text-gray-700"><span className="text-gray-400">Зникне: </span>{row.gone}</span>
                    {row.why && <span className="block break-words text-amber-800">{row.why}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2">
        {/* Нічого не відмічено — кнопка лише запамʼятовує «не дублі» (без обʼєднання). */}
        <Button type="button" disabled={busy || (chosen.length === 0 && rows.doubt.length === 0)} loading={busy} onClick={() => onConfirm(chosen, declinedPairs(rows, picked))} className="text-xs" data-ai-merge-confirm>
          <Check size={14} className="mr-1" /> {chosen.length ? `Підтвердити (${chosen.length})` : 'Не обʼєднувати — запамʼятати'}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onReject} className="text-xs">Відхилити</Button>
      </div>
    </div>
  )
}
