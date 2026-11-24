import { useCallback, useEffect, useState } from 'react'
import { KeyRound, RefreshCw, Save, Trash2 } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

/**
 * Налаштування → «API-ключі» (слово власника 24.11.2026): постачальники, які дають товари за ключем API.
 * Їхні товари — «чернетка під замовлення»: у номенклатуру складу не йдуть; у бланку замовлення за артикулом видно
 * ціну, склад, залишок і строк. Ключ зберігає лише сервер; тут видно тільки його кінець.
 */
interface Warehouse { id: string; code: string; name: string; city: string | null; days_to_ship: number | null; is_active: boolean }
interface Connection { id: string; provider: 'omega'; name: string; key_hint: string; enabled: boolean; syncing: boolean; sync_page: number
  last_full_sync_at: string | null; last_error: string | null; total_offers: number; offers: number; linked: number; warehouses: Warehouse[] }

const BASE = '/api/v1/supplier-api'
const message = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback

export function SupplierApiCard() {
  const [rows, setRows] = useState<Connection[] | null>(null)
  const [error, setError] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState('')
  const [days, setDays] = useState<Record<string, string>>({})

  const apply = useCallback((data: Connection[]) => {
    setRows(data)
    setDays(Object.fromEntries(data.flatMap(row => row.warehouses.map(w => [w.id, w.days_to_ship == null ? '' : String(w.days_to_ship)]))))
  }, [])
  const load = useCallback(async () => {
    try { apply((await api.get<{ data: Connection[] }>(BASE, { silent: true, timeoutMs: 15_000 })).data); setError('') }
    catch (reason) { setError(message(reason, 'Не вдалося відкрити підключення постачальників. Потрібен інтернет.')) }
  }, [apply])
  useEffect(() => { void load() }, [load])

  const omega = rows?.find(row => row.provider === 'omega') ?? null

  async function act(label: string, run: () => Promise<{ data: Connection[] }>, done: string) {
    setBusy(label)
    try { apply((await run()).data); toast.success(done) } catch (reason) { toast.error(message(reason, 'Не вдалося')) } finally { setBusy('') }
  }

  const saveKey = () => act('key', () => api.put(BASE, { provider: 'omega', name: omega?.name ?? 'Омега', enabled: true, api_key: key.trim() }, { silent: true, timeoutMs: 30_000 }), 'Ключ перевірено в Омеги й збережено')
    .then(() => setKey(''))
  const toggle = (enabled: boolean) => omega && act('toggle', () => api.put(BASE, { provider: 'omega', name: omega.name, enabled }, { silent: true, timeoutMs: 15_000 }), enabled ? 'Увімкнено' : 'Вимкнено')
  const syncNow = () => omega && act('sync', () => api.post(BASE + '/' + omega.id + '/sync', {}, undefined, { silent: true, timeoutMs: 15_000 }), 'Оновлення почнеться протягом 5 хвилин')
  const remove = () => omega && window.confirm('Видалити підключення Омеги разом із її товарами під замовлення? Ваші картки й залишки складу не зміняться.')
    && act('remove', () => api.delete(BASE + '/' + omega.id, { silent: true, timeoutMs: 15_000 }), 'Підключення видалено')
  function saveDays(w: Warehouse, isActive = w.is_active) {
    const text = (days[w.id] ?? '').trim()
    const value = text === '' ? null : Number(text)
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 60)) { toast.error('Днів до відправки: ціле число від 0 до 60'); return }
    void act('w' + w.id, () => api.put(BASE + '/warehouses/' + w.id, { days_to_ship: value, is_active: isActive }, { silent: true, timeoutMs: 15_000 }), 'Склад збережено')
  }

  if (error) return <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>
  if (!rows) return <p role="status" className="py-4 text-sm text-gray-500">Завантажуємо…</p>

  return (
    <div className="space-y-4" data-supplier-api>
      <div className="rounded-xl border border-gray-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-base font-semibold text-gray-900">Омега</p>
            <p className="text-xs text-gray-500">public.omega.page · залишки й ціни по складах, раз на годину</p>
          </div>
          {omega && <label className="flex items-center gap-2 text-sm"><input type="checkbox" role="switch" className="h-5 w-5 rounded border-gray-300 text-accent" checked={omega.enabled} onChange={event => void toggle(event.target.checked)} />Увімкнено</label>}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <Input label={omega ? `Ключ API (збережено, закінчується на ${omega.key_hint.replace('…', '')})` : 'Ключ API'} type="password" autoComplete="off" value={key}
              placeholder={omega ? 'Новий ключ — лише якщо треба замінити' : 'Вставте ключ з кабінету Омеги'} onChange={event => setKey(event.target.value)} />
          </div>
          <Button icon={<KeyRound size={14} />} loading={busy === 'key'} disabled={key.trim().length < 8} onClick={() => void saveKey()}>{omega ? 'Замінити ключ' : 'Підключити'}</Button>
        </div>
        {omega && (
          <>
            <p className="mt-3 text-sm text-gray-700" data-supplier-status>
              Товарів під замовлення: <b>{omega.offers.toLocaleString('uk-UA')}</b>{omega.total_offers ? ` з ${omega.total_offers.toLocaleString('uk-UA')}` : ''}
              {' · '}збігаються з вашими картками: <b>{omega.linked.toLocaleString('uk-UA')}</b>
              {' · '}{omega.syncing ? `оновлюється (сторінка ${omega.sync_page})` : omega.last_full_sync_at ? 'оновлено ' + new Date(omega.last_full_sync_at).toLocaleString('uk-UA') : 'ще не завантажувалось'}
            </p>
            {omega.last_error && <p role="alert" className="mt-1 text-sm text-red-700">Остання помилка: {omega.last_error}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} loading={busy === 'sync'} disabled={omega.syncing} onClick={() => void syncNow()}>Оновити зараз</Button>
              <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void load()}>Перечитати</Button>
              <Button size="sm" variant="danger-outline" icon={<Trash2 size={14} />} loading={busy === 'remove'} onClick={() => void remove()}>Видалити підключення</Button>
            </div>
          </>
        )}
      </div>
      {omega && omega.warehouses.length > 0 && (
        <div className="rounded-xl border border-gray-200 p-4">
          <p className="mb-1 text-sm font-semibold text-gray-900">Склади Омеги</p>
          <p className="mb-3 text-xs text-gray-500">«Днів до відправки клієнту» бачать менеджер у бланку замовлення й сайт. Вимкнений склад не показується ніде.</p>
          <ul className="divide-y divide-gray-100" data-supplier-warehouses>
            {omega.warehouses.map(w => (
              <li key={w.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <label className="flex min-w-[10rem] flex-1 items-center gap-2">
                  <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-gray-300 text-accent" checked={w.is_active} onChange={event => saveDays(w, event.target.checked)} />
                  <span className="break-words">{w.name}</span>
                </label>
                <input inputMode="numeric" aria-label={'Днів до відправки: ' + w.name} value={days[w.id] ?? ''} placeholder="днів"
                  onChange={event => setDays(current => ({ ...current, [w.id]: event.target.value }))}
                  className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                <Button size="sm" variant="secondary" icon={<Save size={14} />} loading={busy === 'w' + w.id} onClick={() => saveDays(w)}>Зберегти</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
