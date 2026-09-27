import { useEffect, useRef, useState } from 'react'

export interface InventoryQuantityDraft { value: string; baseRevision?: string }
export type InventoryQuantityDrafts = Record<string, InventoryQuantityDraft>
export interface InventoryQuantitySaved { counted_stock: number; edit_revision?: string }

export function normalizeQuantityDrafts(value: unknown): InventoryQuantityDrafts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([id, raw]) => {
    if (!raw || typeof raw !== 'object' || typeof (raw as InventoryQuantityDraft).value !== 'string') return []
    const draft = raw as InventoryQuantityDraft
    return [[id, { value: draft.value, baseRevision: typeof draft.baseRevision === 'string' ? draft.baseRevision : undefined }]]
  }))
}

/** A focused/failed edit is never replaced by the periodic inventory refresh. */
export function InventoryQuantityInput({ current, draft, disabled, onDraft, onDiscard, onSave }: {
  current: InventoryQuantitySaved
  draft?: InventoryQuantityDraft
  disabled: boolean
  onDraft: (draft: InventoryQuantityDraft) => void
  onDiscard: () => void
  onSave: (draft: InventoryQuantityDraft) => Promise<InventoryQuantitySaved | null>
}) {
  const [view, setView] = useState(current)
  const focused = useRef(false), savingRef = useRef(false)
  const acknowledged = useRef<{ before?: string; after?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!focused.current && !draft && !savingRef.current) {
      if (acknowledged.current && acknowledged.current.before !== acknowledged.current.after
        && current.edit_revision === acknowledged.current.before) return
      acknowledged.current = null
      setView(current)
    }
  }, [current.counted_stock, current.edit_revision, draft])

  async function save(value = draft) {
    if (!value || disabled || savingRef.current) return
    savingRef.current = true; setSaving(true)
    try {
      const saved = await onSave(value)
      if (saved) {
        acknowledged.current = { before: current.edit_revision, after: saved.edit_revision }
        setView(saved)
      }
    } finally { savingRef.current = false; setSaving(false) }
  }
  const changed = Boolean(draft && current.edit_revision && draft.baseRevision !== current.edit_revision)
  return <div>
    <input type="number" min="0" step="1" inputMode="decimal" aria-label="Фактична кількість"
      value={draft?.value ?? String(view.counted_stock)} disabled={disabled || saving}
      onFocus={() => { focused.current = true }}
      onChange={event => onDraft({ value: event.target.value, baseRevision: draft ? draft.baseRevision : view.edit_revision })}
      onBlur={() => { focused.current = false; if (draft) void save(); else setView(current) }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
      className="mt-0.5 w-20 rounded-lg border border-yellow-300 px-2 py-1 text-center font-bold outline-none focus:border-yellow-500" />
    {saving && <span className="block text-xs text-gray-500">Зберігається…</span>}
    {draft && !saving && <div className="mt-1 text-xs text-amber-800">
      <span className="block">Не збережено{changed ? ` · у базі ${current.counted_stock}` : ''}</span>
      <button type="button" disabled={disabled} className="mr-2 underline" onMouseDown={e => e.preventDefault()} onClick={() => {
        if (changed && !confirm(`У базі зараз ${current.counted_stock}. Ви перевірили й хочете встановити ${draft.value}?`)) return
        const reviewed = { ...draft, baseRevision: current.edit_revision }
        onDraft(reviewed); void save(reviewed)
      }}>{changed ? 'Звірив — зберегти моє' : 'Повторити'}</button>
      <button type="button" disabled={disabled} className="underline" onMouseDown={e => e.preventDefault()} onClick={() => {
        if (!confirm(`Відкинути введене ${draft.value} і залишити кількість з бази: ${current.counted_stock}?`)) return
        setView(current); onDiscard()
      }}>Взяти з бази</button>
    </div>}
  </div>
}
