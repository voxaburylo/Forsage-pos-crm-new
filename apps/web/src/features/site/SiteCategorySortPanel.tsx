import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { errorText } from './siteGateway'

/**
 * Розкладка товарів постачальників по наших категоріях — один рядок у вкладці помічника сайту (26.11.2026, слово
 * власника: «ті, що прийшли по API й ще прийдуть, не розсортовані, і на сайті невідомо як показуватимуться»).
 * Увімкнув один раз — сервер розкладає все, що є, і все, що прийде далі. Без підтверджень по кожному товару.
 */
export interface SortState {
  enabled: boolean; waiting: number; sorted: number; unsure: number; with_category: number; total: number; cost_usd: number; last_error: string | null
  /** Товари, для яких потрібна нова категорія: чекають, поки головний ПК її створить. */
  waiting_new?: number; waiting_names?: string[]; till_error?: string | null
  /** «Повернути як було» ще триває: сервер знімає категорії порціями, щоб не перевантажити базу. */
  undoing?: boolean
}

export const UNDOING_TEXT = 'Знімаю категорії помічника — порціями по 2 000 товарів за хвилину, щоб не перевантажити базу. Екран можна закрити.'
/** Нові категорії, які помічник замовив касі: що створюється і чого чекаємо. */
export function newCategoriesText(state: SortState): string {
  const names = state.waiting_names ?? []
  if (!names.length) return ''
  const list = names.slice(0, 8).map(name => '«' + name + '»').join(', ') + (names.length > 8 ? ` і ще ${names.length - 8}` : '')
  return `Підхожих категорій не було — створюю нові: ${list}. Їх створює головний ПК; щойно він у мережі, ${count(state.waiting_new ?? 0)} товарів ляжуть у них самі.`
    + (state.till_error ? ' Головний ПК поки відповів: ' + state.till_error : '')
}
const count = (value: number) => value.toLocaleString('uk-UA')

export function sortLineText(state: SortState): string {
  const done = [state.sorted ? `помічник розклав ${count(state.sorted)}` : '', state.unsure ? `не певен щодо ${count(state.unsure)} — вони лишились без категорії` : ''].filter(Boolean).join(' · ')
  if (state.enabled && state.waiting > 0) return `Розкладаю: лишилось ${count(state.waiting)} із ${count(state.total)} товарів постачальників${done ? ' · ' + done : ''}. Екран можна закрити.`
  if (state.enabled) return `Усе розкладено${done ? ': ' + done : ''}. Нові товари, що прийдуть по API, розкладатимуться самі.`
  if (state.waiting > 0) return `Без категорії ${count(state.waiting)} із ${count(state.total)} товарів постачальників — на сайті вони не потрапляють у жоден розділ каталогу.` + (done ? ' Раніше: ' + done + '.' : '')
  return `Усі ${count(state.total)} товарів постачальників мають категорію або розглянуті${done ? ': ' + done : ''}.`
}

/** Числа плитками — замість одного довгого речення (27.11.2026: «рядок стану читається важко»). */
export function sortTiles(state: SortState): Array<{ label: string; value: number }> {
  return [
    { label: 'чекають розкладки', value: state.waiting }, { label: 'розкладено автоматично', value: state.sorted },
    { label: 'помічник не певен', value: state.unsure }, { label: 'чекають нову категорію', value: state.waiting_new ?? 0 },
  ].filter((tile, index) => index === 0 || tile.value > 0)
}
/** Одне коротке речення про стан; числа — у плитках. */
export function sortHeadline(state: SortState): string {
  if (state.enabled && state.waiting > 0) return 'Розкладаю. Екран можна закрити.'
  if (state.enabled) return 'Усе розкладено. Нові товари, що прийдуть по API, розкладатимуться самі.'
  if (state.waiting > 0) return 'Товари без категорії на сайті не потрапляють у жоден розділ каталогу.'
  return 'Усі товари постачальників мають категорію або розглянуті.'
}

export function SiteCategorySortPanel({ refresh = 0 }: { refresh?: number }) {
  const [state, setState] = useState<SortState | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState('')
  // Розкрито чи згорнуто — вирішує власник; поки він не чіпав, розкрито лише коли потрібне його рішення.
  const [shown, setShown] = useState<boolean | null>(null)
  const load = useCallback(async () => {
    try { setState((await api.get<{ data: SortState }>('/api/v1/site-admin/category-sort', { silent: true })).data); setMissing(false) } catch { setMissing(true) }
  }, [])
  useEffect(() => { void load() }, [load, refresh])
  const live = Boolean(state?.undoing || (state?.enabled && (state.waiting > 0 || (state.waiting_names?.length ?? 0) > 0)))
  useEffect(() => { if (!live) return; const timer = window.setInterval(() => void load(), 8000); return () => window.clearInterval(timer) }, [live, load])

  async function act(action: 'start' | 'stop' | 'undo', done?: string) {
    setBusy(action)
    try { setState((await api.post<{ data: SortState }>('/api/v1/site-admin/category-sort', { action }, undefined, { silent: true })).data); if (done) toast.success(done) }
    catch (reason) { toast.error(errorText(reason, 'Не вийшло. Спробуйте ще раз.')) } finally { setBusy('') }
  }
  if (missing || !state || !state.total) return null
  const progress = state.total ? Math.round((state.total - state.waiting) / state.total * 100) : 0
  return (
    <details className="group rounded-xl border border-gray-200 bg-white" open={shown ?? (state.waiting > 0 && !state.enabled)} onToggle={event => setShown(event.currentTarget.open)} data-site-category-sort={state.enabled ? 'on' : 'off'}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-semibold text-gray-900">Категорії для товарів постачальників</span>
        <span className="text-xs text-gray-500" data-site-sort-short>{state.enabled && state.waiting > 0 ? `розкладаю, лишилось ${count(state.waiting)}` : state.waiting > 0 ? `без категорії ${count(state.waiting)}` : 'усе розкладено'}</span>
        <span className="ml-auto text-xs text-gray-400 group-open:hidden">показати</span>
      </summary>
      <div className="border-t border-gray-100 px-3 pb-3 pt-2">
      <p role="status" aria-label={sortLineText(state)} className="text-sm text-gray-700" data-site-sort-line>{sortHeadline(state)}</p>
      <div className="mt-2 flex flex-wrap gap-2" data-site-sort-tiles>
        {sortTiles(state).map(tile => <div key={tile.label} className="rounded-lg bg-gray-50 px-3 py-1.5"><p className="text-base font-semibold text-gray-900">{count(tile.value)}</p><p className="text-[11px] text-gray-500">{tile.label}</p></div>)}
      </div>
      {newCategoriesText(state) && <p className="mt-1 text-sm text-gray-700" data-site-sort-new>{newCategoriesText(state)}</p>}
      {state.undoing && <p className="mt-1 text-sm text-gray-700" data-site-sort-undoing>{UNDOING_TEXT}</p>}
      {state.last_error && <p className="mt-1 text-xs text-gray-500">{state.last_error}</p>}
      {live && state.waiting > 0 && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} /></div>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!state.enabled && !state.undoing && <Button size="sm" loading={busy === 'start'} onClick={() => void act('start', 'Розкладаю. Екран можна закрити.')} data-site-sort-start>
          {state.waiting > 0 ? 'Розкласти по категоріях — і надалі розкладати нові' : 'Розкладати нові надходження самому'}</Button>}
        {state.enabled && <Button size="sm" variant="secondary" loading={busy === 'stop'} onClick={() => void act('stop')}>Зупинити</Button>}
        {(state.sorted > 0 || state.unsure > 0) && !state.undoing && <Button size="sm" variant="ghost" loading={busy === 'undo'}
          onClick={() => { if (window.confirm(`Зняти категорії, які поставив помічник (${state.sorted}), і забути його правила? Категорії, поставлені вручну, лишаться.`)) void act('undo', 'Знімаю категорії — це займе трохи часу.') }}>Повернути як було</Button>}
      </div>
      </div>
    </details>
  )
}
