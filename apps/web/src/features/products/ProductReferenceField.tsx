import { useEffect, useId, useState } from 'react'
import { normalizeProductReferenceName, resolveProductReference, type ProductReferenceOption } from './productFormModel'

/** Existing category/brand selector: draft text never silently clears the confirmed ID. */
export function ProductReferenceField({ label, emptyLabel, value, options, draft, onDraft, onChange, onCreate }: {
  label: string; emptyLabel: string; value: string; options: readonly ProductReferenceOption[]; draft: string | null
  onDraft: (text: string | null) => void; onChange: (id: string) => void; onCreate: () => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [error, setError] = useState('')
  useEffect(() => {
    if (draft === null) { setOpen(false); setActive(-1); setError('') }
  }, [value, draft])
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [id, open, active])
  const selected = options.find(option => option.id === value)
  const query = normalizeProductReferenceName(draft ?? '')
  const filtered = options.filter(option => !query || normalizeProductReferenceName(option.name).includes(query))
  const canCreate = !!query && !options.some(option => normalizeProductReferenceName(option.name) === query)
  const optionCount = filtered.length + 1 + Number(canCreate)

  function choose(nextId: string) {
    onChange(nextId); onDraft(null); setError(''); setActive(-1); setOpen(false)
  }
  function commitExact(showError = true) {
    try {
      choose(resolveProductReference(value, { draft, options }, label))
    } catch (cause) {
      if (showError) setError(cause instanceof Error ? cause.message : 'Виберіть значення зі списку')
    }
  }
  function selectActive() {
    if (active >= 0 && active < filtered.length) choose(filtered[active].id)
    else if (active === filtered.length) choose('')
    else if (canCreate && active === filtered.length + 1) onCreate()
    else commitExact()
  }
  return <div className="relative" onBlur={event => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setOpen(false); setActive(-1)
    // Do not move the clicked Save/Cancel target by inserting an error on mousedown blur.
    // Pending text is already marked; Enter/Tab and submit validate it explicitly.
    if (draft !== null) commitExact(false)
  }}>
    <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    <input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
      aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined}
      aria-invalid={!!error} aria-describedby={error ? `${id}-error` : `${id}-status`}
      value={draft ?? selected?.name ?? (value ? 'Збережене значення недоступне' : '')} autoComplete="off" placeholder="Пошук або створити..."
      onChange={event => { onDraft(event.target.value); setOpen(true); setActive(-1); setError('') }}
      onFocus={() => { setOpen(true); setActive(-1) }}
      onClick={() => setOpen(true)}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDraft(null); setError(''); setOpen(false); setActive(-1) }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true)
          setActive(previous => Math.max(0, Math.min(optionCount - 1, previous < 0 ? (event.key === 'ArrowDown' ? 0 : optionCount - 1) : previous + (event.key === 'ArrowDown' ? 1 : -1))))
        }
        if (event.key === 'Enter') { event.preventDefault(); selectActive() }
        if (event.key === 'Tab' && draft !== null) commitExact()
      }}
      className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
    {open && <div id={`${id}-list`} role="listbox" aria-label={label} className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
      {filtered.map((option, index) => <button key={option.id} id={`${id}-option-${index}`} type="button" role="option" aria-selected={value === option.id}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(option.id)}
        className={`w-full text-left px-3 py-2 text-sm hover:bg-yellow-50 ${active === index ? 'bg-yellow-50' : ''}`}>{option.name}</button>)}
      <button id={`${id}-option-${filtered.length}`} type="button" role="option" aria-selected={!value}
        onMouseDown={event => event.preventDefault()} onClick={() => choose('')}
        className={`w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-yellow-50 ${active === filtered.length ? 'bg-yellow-50' : ''}`}>{emptyLabel}</button>
      {canCreate && <button id={`${id}-option-${filtered.length + 1}`} type="button" role="option" aria-selected={false}
        onMouseDown={event => event.preventDefault()} onClick={onCreate}
        className={`w-full text-left px-3 py-2 text-sm text-yellow-700 hover:bg-yellow-50 font-medium ${active === filtered.length + 1 ? 'bg-yellow-50' : ''}`}>+ Створити "{draft?.trim()}"</button>}
    </div>}
    {error && <p id={`${id}-error`} role="alert" className="text-xs text-red-600 mt-1">{error}</p>}
    <p id={`${id}-status`} className={`text-xs mt-0.5 ${draft !== null ? 'text-amber-700' : 'text-green-600'}`}>
      {draft !== null ? (value ? `Вибрано: ${selected?.name ?? 'попереднє значення'}. Пошук ще не підтверджено.` : 'Пошук ще не підтверджено.') : (value ? (selected ? '✓ вибрано' : 'Попередній вибір збережено; його назва недоступна.') : emptyLabel)}
    </p>
  </div>
}
