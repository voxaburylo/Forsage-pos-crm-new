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
export interface SortState { enabled: boolean; waiting: number; sorted: number; unsure: number; with_category: number; total: number; cost_usd: number; last_error: string | null }
const count = (value: number) => value.toLocaleString('uk-UA')

export function sortLineText(state: SortState): string {
  const done = [state.sorted ? `помічник розклав ${count(state.sorted)}` : '', state.unsure ? `не певен щодо ${count(state.unsure)} — вони лишились без категорії` : ''].filter(Boolean).join(' · ')
  if (state.enabled && state.waiting > 0) return `Розкладаю: лишилось ${count(state.waiting)} із ${count(state.total)} товарів постачальників${done ? ' · ' + done : ''}. Екран можна закрити.`
  if (state.enabled) return `Усе розкладено${done ? ': ' + done : ''}. Нові товари, що прийдуть по API, розкладатимуться самі.`
  if (state.waiting > 0) return `Без категорії ${count(state.waiting)} із ${count(state.total)} товарів постачальників — на сайті вони не потрапляють у жоден розділ каталогу.` + (done ? ' Раніше: ' + done + '.' : '')
  return `Усі ${count(state.total)} товарів постачальників мають категорію або розглянуті${done ? ': ' + done : ''}.`
}

export function SiteCategorySortPanel({ refresh = 0 }: { refresh?: number }) {
  const [state, setState] = useState<SortState | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    try { setState((await api.get<{ data: SortState }>('/api/v1/site-admin/category-sort', { silent: true })).data); setMissing(false) } catch { setMissing(true) }
  }, [])
  useEffect(() => { void load() }, [load, refresh])
  const live = Boolean(state?.enabled && state.waiting > 0)
  useEffect(() => { if (!live) return; const timer = window.setInterval(() => void load(), 8000); return () => window.clearInterval(timer) }, [live, load])

  async function act(action: 'start' | 'stop' | 'undo', done?: string) {
    setBusy(action)
    try { setState((await api.post<{ data: SortState }>('/api/v1/site-admin/category-sort', { action }, undefined, { silent: true })).data); if (done) toast.success(done) }
    catch (reason) { toast.error(errorText(reason, 'Не вийшло. Спробуйте ще раз.')) } finally { setBusy('') }
  }
  if (missing || !state || !state.total) return null
  const progress = state.total ? Math.round((state.total - state.waiting) / state.total * 100) : 0
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-3" data-site-category-sort={state.enabled ? 'on' : 'off'}>
      <p className="text-sm font-semibold text-gray-900">Категорії для товарів постачальників</p>
      <p role="status" className="mt-1 text-sm text-gray-700" data-site-sort-line>{sortLineText(state)}</p>
      {state.last_error && <p className="mt-1 text-xs text-gray-500">{state.last_error}</p>}
      {live && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} /></div>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!state.enabled && <Button size="sm" loading={busy === 'start'} onClick={() => void act('start', 'Розкладаю. Екран можна закрити.')} data-site-sort-start>
          {state.waiting > 0 ? 'Розкласти по категоріях — і надалі розкладати нові' : 'Розкладати нові надходження самому'}</Button>}
        {state.enabled && <Button size="sm" variant="secondary" loading={busy === 'stop'} onClick={() => void act('stop')}>Зупинити</Button>}
        {(state.sorted > 0 || state.unsure > 0) && <Button size="sm" variant="ghost" loading={busy === 'undo'}
          onClick={() => { if (window.confirm(`Зняти категорії, які поставив помічник (${state.sorted}), і забути його правила? Категорії, поставлені вручну, лишаться.`)) void act('undo', 'Повернув як було.') }}>Повернути як було</Button>}
      </div>
    </section>
  )
}
