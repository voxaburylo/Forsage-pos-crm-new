import { useEffect, useRef, useState } from 'react'

export type InventoryProductField = 'name' | 'sku' | 'retail_price' | 'purchase_price'
export interface InventoryProductDraft { value: string; base?: string | number }
export type InventoryProductDrafts = Record<string, Partial<Record<InventoryProductField, InventoryProductDraft>>>
export const inventoryProductFields: InventoryProductField[] = ['name', 'sku', 'retail_price', 'purchase_price']
export function normalizeProductDrafts(input: unknown): InventoryProductDrafts {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const output: InventoryProductDrafts = {}
  for (const [id, row] of Object.entries(input)) {
    if (['__proto__', 'constructor', 'prototype'].includes(id) || !row || typeof row !== 'object' || Array.isArray(row)) continue
    for (const field of inventoryProductFields) {
      const draft = (row as Record<string, InventoryProductDraft>)[field]
      if (draft && typeof draft.value === 'string') {
        output[id] ??= {}
        output[id][field] = { value: draft.value, base: typeof draft.base === 'string' || (typeof draft.base === 'number' && Number.isFinite(draft.base)) ? draft.base : undefined }
      }
    }
  }
  return output
}

/** Keep typed text and its original field value across polling, paging and reload. */
export function InventoryProductInput({ field, current, draft, disabled, onDraft, onDiscard, onSave }: {
  field: InventoryProductField; current: string | number; draft?: InventoryProductDraft; disabled: boolean
  onDraft: (draft: InventoryProductDraft) => void; onDiscard: () => void
  onSave: (draft: InventoryProductDraft) => Promise<string | number | null>
}) {
  const money = field === 'retail_price' || field === 'purchase_price'
  const format = (value: string | number) => money ? (Number(value) / 100).toFixed(2) : String(value)
  const label = { name: 'Назва товару', sku: 'Артикул', retail_price: 'Ціна продажу', purchase_price: 'Ціна закупівлі' }[field]
  const [view, setView] = useState(current), [saving, setSaving] = useState(false)
  const focused = useRef(false), savingRef = useRef(false)
  const acknowledged = useRef<{ before: string | number; after: string | number } | null>(null)
  useEffect(() => {
    if (!focused.current && !draft && !savingRef.current) {
      if (acknowledged.current && acknowledged.current.before !== acknowledged.current.after && current === acknowledged.current.before) return
      acknowledged.current = null; setView(current)
    }
  }, [current, draft])
  async function save(value = draft) {
    if (!value || disabled || savingRef.current) return
    savingRef.current = true; setSaving(true)
    try {
      const saved = await onSave(value)
      if (saved !== null) { acknowledged.current = { before: current, after: saved }; setView(saved) }
    } finally { savingRef.current = false; setSaving(false) }
  }
  const changed = Boolean(draft && draft.base !== current)
  const shared = {
    'aria-label': label, value: draft?.value ?? format(view), disabled: disabled || saving,
    onFocus: () => { focused.current = true },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onDraft({ value: event.target.value, base: draft ? draft.base : view }),
    onBlur: () => { focused.current = false; if (draft) void save(); else setView(current) },
    className: 'w-full min-w-0 rounded-lg border border-gray-300 px-2 py-1 text-sm font-semibold outline-none focus:border-yellow-500 disabled:bg-gray-50',
  }
  return <div className="min-w-0">
    {field === 'name' ? <textarea {...shared} rows={2} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur() } }} />
      : <input {...shared} type={money ? 'number' : 'text'} min={money ? '0' : undefined} step={money ? '0.01' : undefined} inputMode={money ? 'decimal' : undefined}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} />}
    {saving && <span className="block text-xs text-gray-500">Зберігається…</span>}
    {draft && !saving && <div className="mt-1 text-xs text-amber-800">
      <span className="block break-words">Не збережено{changed ? ` · у базі: ${format(current)}` : ''}</span>
      <button type="button" disabled={disabled} className="mr-2 underline" onMouseDown={event => event.preventDefault()} onClick={() => {
        if (changed && !confirm(`У базі: ${format(current)}. Ви звірили й хочете зберегти ${draft.value}?`)) return
        const reviewed = { ...draft, base: current }; onDraft(reviewed); void save(reviewed)
      }}>{changed ? 'Звірив — зберегти моє' : 'Повторити'}</button>
      <button type="button" disabled={disabled} className="underline" onMouseDown={event => event.preventDefault()} onClick={() => {
        if (!confirm(`Відкинути введене ${draft.value} і залишити з бази: ${format(current)}?`)) return
        setView(current); onDiscard()
      }}>Взяти з бази</button>
    </div>}
  </div>
}
