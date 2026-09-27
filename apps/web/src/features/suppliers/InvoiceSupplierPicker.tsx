import { useEffect, useId, useRef, useState } from 'react'
import { supplierApi } from './supplierApi'
type Option = { id: string; name: string; phone?: string | null }

export function InvoiceSupplierPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const listId = useId()
  const root = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<Option | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Option[]>([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [selectedError, setSelectedError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [active, setActive] = useState(-1)
  useEffect(() => {
    let cancelled = false
    setSelectedError(false)
    if (!value) { setSelected(null); return }
    if (selected?.id === value) return
    setSelected(null)
    supplierApi.get(value).then(({ data }) => { if (!cancelled) setSelected(data) })
      .catch(() => { if (!cancelled) setSelectedError(true) })
    return () => { cancelled = true }
  }, [value, retry])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setBusy(true); setError(false)
    const timer = window.setTimeout(() => {
      supplierApi.list({ search: query.trim() || undefined, is_active: 'true', page, per_page: 50 })
        .then(result => {
          if (cancelled) return
          setRows(previous => page === 1 ? result.data : [...new Map([...previous, ...result.data].map(row => [row.id, row])).values()])
          setPages(Math.max(1, result.pagination.total_pages))
        }).catch(() => { if (!cancelled) setError(true) })
        .finally(() => { if (!cancelled) setBusy(false) })
    }, query ? 250 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [open, query, page, retry])
  function show() { if (!open) { setQuery(''); setRows([]); setPage(1); setActive(-1); setOpen(true) } }
  function choose(option: Option) { setSelected(option); onChange(option.id); setOpen(false) }
  return <div ref={root} className="relative min-w-0 flex-1" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }}>
    <div className="flex items-center gap-1">
      <input role="combobox" aria-label="Постачальник" aria-expanded={open} aria-controls={listId}
        aria-autocomplete="list" aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        value={open ? query : selected?.name || ''} placeholder={value ? 'Завантаження постачальника…' : 'Знайти постачальника за назвою або телефоном'}
        onFocus={show} onClick={show} autoComplete="off" maxLength={200}
        onChange={event => { setQuery(event.target.value); setPage(1); setRows([]); setActive(-1); setOpen(true) }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); show()
            setActive(index => Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
          }
          if (event.key === 'Enter') { event.preventDefault(); if (open && !busy && rows[active]) choose(rows[active]) }
        }} className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
      {value && <button type="button" aria-label="Прибрати постачальника" onClick={() => { onChange(''); setSelected(null); setOpen(false) }} className="px-2 text-gray-500">×</button>}
    </div>
    {selectedError && <p role="alert" className="text-xs text-red-600">Не вдалося завантажити вибраного постачальника. <button type="button" onClick={() => setRetry(n => n + 1)} className="underline">Повторити</button></p>}
    {open && <div className="absolute z-40 mt-1 w-full rounded-xl border border-gray-200 bg-white shadow-lg max-h-72 overflow-y-auto">
      <div id={listId} role="listbox" aria-label="Постачальники">
        {rows.map((row, index) => <button key={row.id} id={`${listId}-${index}`} role="option" aria-selected={value === row.id}
          type="button" onMouseDown={event => event.preventDefault()} onClick={() => choose(row)}
          className={`block w-full text-left px-3 py-2 text-sm hover:bg-yellow-50 ${active === index ? 'bg-yellow-50' : ''}`}>
          {row.name}{row.phone && <span className="block text-xs text-gray-500">{row.phone}</span>}
        </button>)}
      </div>
      {busy && <p role="status" className="p-3 text-sm text-gray-500">Пошук…</p>}
      {error && <div role="alert" className="p-3 text-sm text-red-600">Не вдалося знайти постачальників. <button type="button" onClick={() => setRetry(n => n + 1)} className="underline">Повторити</button></div>}
      {!busy && !error && !rows.length && <p className="p-3 text-sm text-gray-500">Не знайдено. Нового постачальника можна додати кнопкою «+» поруч.</p>}
      {!busy && !error && page < pages && <button type="button" onClick={() => setPage(n => n + 1)} className="w-full p-2 text-sm text-yellow-700">Показати ще</button>}
    </div>}
  </div>
}
