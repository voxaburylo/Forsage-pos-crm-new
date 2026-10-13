import { useEffect, useState } from 'react'
import { toast } from './Toast'

export function pageNumber(value: string, maximum = 1_000_000): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 1 && page <= maximum ? page : null
}

/** Replaces the existing page label; Enter commits, Escape/blur discard only the draft. */
export function PageNumberInput({ page, pages, disabled, onPage }: {
  page: number; pages?: number; disabled?: boolean; onPage: (page: number) => void
}) {
  const [draft, setDraft] = useState(String(page))
  useEffect(() => { setDraft(String(page)) }, [page])
  return <label className="inline-flex items-center gap-1 text-xs text-gray-600">Сторінка
    <input aria-label="Номер сторінки" title="Введіть номер і натисніть Enter" inputMode="numeric" disabled={disabled}
      value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => setDraft(String(page))}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setDraft(String(page)); return }
        if (event.key !== 'Enter' || disabled) return
        event.preventDefault()
        const requested = pageNumber(draft, pages)
        if (requested === null) { toast.error(pages ? `Введіть номер сторінки від 1 до ${pages}` : 'Введіть цілий номер сторінки від 1 до 1000000'); return }
        // A rejected/out-of-range jump may return to the same page in one render batch.
        // Display the committed page until the parent accepts a different one.
        setDraft(String(page))
        onPage(requested)
      }} className="w-16 rounded-lg border border-gray-200 bg-white px-2 py-1 text-center disabled:opacity-50" />
    {pages !== undefined && <span>з {pages}</span>}
  </label>
}
