import { useEffect, useState } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'
import { toast } from '@/components/ui/Toast'

type Price = { mode: 'pct'; pct: number } | { mode: 'cost' }

/** Текст поля → відсоток 0–100 або null, якщо це не число. Порожнє поле — «особистої знижки немає». */
export function readEmployeePct(text: string): number | null | undefined {
  const value = text.trim().replace(',', '.')
  if (!value) return undefined
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value) || Number(value) > 100) return null
  return Number(value)
}

/**
 * 22.11.2026 (рішення власника): ціна для працівника в його картці — своя знижка у відсотках
 * або галочка «за закупкою» (тоді поле відсотків неактивне). Порожньо — діє загальна знижка з налаштувань.
 * Діє одразу й зберігається в базі головного ПК. Нижче закупівельної ціни каса не продає ніколи.
 */
export function EmployeePriceControl({ userId }: { userId: string }) {
  const staff = desktopBridge()?.staff
  const [loaded, setLoaded] = useState<{ userId: string; price: Price | null } | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    staff?.employeePricing?.().then(all => {
      if (cancelled) return
      const price = all[userId] ?? null
      setLoaded({ userId, price })
      setText(price?.mode === 'pct' ? String(price.pct) : '')
    }).catch(() => { if (!cancelled) setLoaded({ userId, price: null }) })
    return () => { cancelled = true }
  }, [staff, userId])

  if (!staff?.employeePricing || !staff.setEmployeePricing) return null
  const ready = loaded?.userId === userId
  const atCost = ready && loaded!.price?.mode === 'cost'

  async function save(next: Price | null, message: string) {
    if (busy || !staff?.setEmployeePricing) return
    setBusy(true)
    try {
      const all = await staff.setEmployeePricing(userId, next)
      const price = all[userId] ?? null
      setLoaded({ userId, price })
      setText(price?.mode === 'pct' ? String(price.pct) : '')
      toast.success(message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти ціну працівника')
    } finally { setBusy(false) }
  }
  function savePct() {
    const pct = readEmployeePct(text)
    if (pct === null) { toast.error('Знижка: число від 0 до 100'); return }
    const current = loaded?.price?.mode === 'pct' ? loaded.price.pct : undefined
    if (pct === current) return
    void save(pct === undefined ? null : { mode: 'pct', pct }, pct === undefined ? 'Особисту знижку прибрано: діє загальна з налаштувань' : `Знижка працівника: ${pct} %`)
  }

  return (
    <div className="space-y-2 border-t border-gray-100 pt-3">
      <p className="text-sm font-medium text-gray-700">Ціна для цього працівника</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <span>Знижка, %</span>
          <input type="text" inputMode="decimal" aria-label="Знижка працівника у відсотках" value={atCost ? '' : text} disabled={!ready || busy || atCost}
            placeholder={atCost ? '—' : 'загальна'} onChange={event => setText(event.target.value)} onBlur={savePct}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); savePct() } }}
            className="w-24 rounded-lg border border-gray-200 px-2 py-1.5 text-sm disabled:bg-gray-100 disabled:text-gray-400" />
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={atCost} disabled={!ready || busy} className="h-4 w-4 rounded text-amber-500 focus:ring-amber-300"
            onChange={event => { void save(event.target.checked ? { mode: 'cost' } : null, event.target.checked ? 'Працівник купує за закупівельною ціною' : 'Ціну «за закупкою» вимкнено') }} />
          <span>За закупкою</span>
        </label>
      </div>
      <p className="text-xs text-gray-500">Діє на касі, коли в чек вибрано клієнта з телефоном цього працівника. Порожньо — загальна знижка з налаштувань. Нижче закупівельної ціни товар не продається.</p>
    </div>
  )
}
