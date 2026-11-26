import type { AiPendingAction } from './aiApi'

/**
 * Таблиця-прев'ю масової дії помічника (винесено з AiAssistantPage.tsx 26.11.2026 за правилом ділити великі файли).
 * 26.11.2026, власник (скрин з телефона): «чому на обʼєднання дублів видало один товар?» — на телефоні таблиця
 * обрізалась, і колонку «Зливається (зникне)» не було видно. Тепер на телефоні кожен рядок — картка, колонки одна під
 * одною; на ПК — таблиця, як була.
 */
export function BulkPreviewTable({ action, maxRows }: { action: AiPendingAction; maxRows?: number }) {
  const all = action.items ?? []
  const cols = action.columns ?? []
  const rows = maxRows ? all.slice(0, maxRows) : all
  return (
    <div className="rounded-lg border border-gray-100 overflow-hidden bg-white" data-ai-bulk-preview>
      {/* Телефон: картки. */}
      <ol className={`divide-y divide-gray-100 sm:hidden ${maxRows ? '' : 'max-h-[60vh] overflow-auto'}`} data-ai-bulk-cards>
        {rows.map((row, ri) => (
          <li key={ri} className="flex gap-2 px-2.5 py-2 text-xs">
            <span className="w-5 shrink-0 text-gray-300">{ri + 1}</span>
            <dl className="min-w-0 flex-1 space-y-1">
              {cols.map(col => (
                <div key={col}>
                  <dt className="text-[11px] text-gray-400">{col}</dt>
                  <dd className="break-words text-gray-800">{row[col] ?? '—'}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ol>
      {/* ПК: таблиця. */}
      <div className={`hidden sm:block ${maxRows ? 'overflow-x-auto' : 'max-h-[60vh] overflow-auto'}`}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gray-50 text-gray-400">
            <tr>
              <th className="px-2 py-1.5 text-left font-semibold w-8">#</th>
              {cols.map((col) => (
                <th key={col} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((row, ri) => (
              <tr key={ri}>
                <td className="px-2 py-1.5 text-gray-300">{ri + 1}</td>
                {cols.map((col) => (
                  <td key={col} className="px-2 py-1.5 text-gray-800 align-top whitespace-nowrap">{row[col] ?? '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {maxRows && all.length > maxRows && (
        <div className="text-[11px] text-gray-400 px-2 py-1 bg-gray-50 text-center">
          …та ще {all.length - maxRows} — «усі рядки» під таблицею.
        </div>
      )}
    </div>
  )
}
