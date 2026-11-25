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
interface Connection { id: string; provider: 'omega' | 'gpl'; name: string; key_hint: string; meta?: { price_names?: string[]; purchase_price_name?: string | null }; enabled: boolean; syncing: boolean; sync_page: number
  last_full_sync_at: string | null; last_error: string | null; total_offers: number; offers: number; linked: number; crosses_done?: number; crosses_total?: number; details_done?: number; warehouses: Warehouse[] }

const BASE = '/api/v1/supplier-api'
const message = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback

export function SupplierApiCard() {
  const [rows, setRows] = useState<Connection[] | null>(null)
  const [error, setError] = useState('')
  const [key, setKey] = useState('')
  // 25.11.2026: GPL входить логіном і паролем (зберігає лише сервер; пароль назад не показується).
  const [gplLogin, setGplLogin] = useState('')
  const [gplPassword, setGplPassword] = useState('')
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
  const gpl = rows?.find(row => row.provider === 'gpl') ?? null

  async function act(label: string, run: () => Promise<{ data: Connection[] }>, done: string) {
    setBusy(label)
    try { apply((await run()).data); toast.success(done) } catch (reason) { toast.error(message(reason, 'Не вдалося')) } finally { setBusy('') }
  }

  const saveKey = () => act('key', () => api.put(BASE, { provider: 'omega', name: omega?.name ?? 'Омега', enabled: true, api_key: key.trim() }, { silent: true, timeoutMs: 30_000 }), 'Ключ перевірено в Омеги й збережено')
    .then(() => setKey(''))
  const saveGpl = () => act('gpl-key', () => api.put(BASE, { provider: 'gpl', name: gpl?.name ?? 'GPL', enabled: true, login: gplLogin.trim(), password: gplPassword }, { silent: true, timeoutMs: 30_000 }), 'Логін і пароль перевірено в GPL і збережено')
    .then(() => { setGplLogin(''); setGplPassword('') })
  const toggleOf = (conn: Connection, enabled: boolean) => act('toggle' + conn.id, () => api.put(BASE, { provider: conn.provider, name: conn.name, enabled }, { silent: true, timeoutMs: 15_000 }), enabled ? 'Увімкнено' : 'Вимкнено')
  const syncOf = (conn: Connection) => act('sync' + conn.id, () => api.post(BASE + '/' + conn.id + '/sync', {}, undefined, { silent: true, timeoutMs: 15_000 }), 'Оновлення почнеться протягом 5 хвилин')
  const removeOf = (conn: Connection) => window.confirm('Видалити підключення «' + conn.name + '» разом із його товарами під замовлення? Ваші картки й залишки складу не зміняться.')
    && act('remove' + conn.id, () => api.delete(BASE + '/' + conn.id, { silent: true, timeoutMs: 15_000 }), 'Підключення видалено')
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
          {omega && <label className="flex items-center gap-2 text-sm"><input type="checkbox" role="switch" className="h-5 w-5 rounded border-gray-300 text-accent" checked={omega.enabled} onChange={event => void toggleOf(omega, event.target.checked)} />Увімкнено</label>}
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
              {/* 25.11.2026: кроси Омеги завантажуються фоном, у межах ліміту запитів. */}
              {omega.crosses_done != null && <>{' · '}кроси отримано для <b>{omega.crosses_done.toLocaleString('uk-UA')}</b> з {omega.offers.toLocaleString('uk-UA')} товарів (номерів-аналогів: {(omega.crosses_total ?? 0).toLocaleString('uk-UA')})</>}
              {omega.details_done != null && <>{' · '}опис (OE-номери, застосовність, характеристики): <b>{omega.details_done.toLocaleString('uk-UA')}</b></>}
              {' · '}{omega.syncing ? `оновлюється (сторінка ${omega.sync_page})` : omega.last_full_sync_at ? 'оновлено ' + new Date(omega.last_full_sync_at).toLocaleString('uk-UA') : 'ще не завантажувалось'}
            </p>
            {omega.last_error && <p role="alert" className="mt-1 text-sm text-red-700">Остання помилка: {omega.last_error}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} loading={busy === 'sync' + omega.id} disabled={omega.syncing} onClick={() => void syncOf(omega)}>Оновити зараз</Button>
              <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void load()}>Перечитати</Button>
              <Button size="sm" variant="danger-outline" icon={<Trash2 size={14} />} loading={busy === 'remove' + omega.id} onClick={() => void removeOf(omega)}>Видалити підключення</Button>
            </div>
          </>
        )}
      </div>
      {/* 25.11.2026: GPL — логін і пароль; кросів в API GPL немає, аналоги для його товарів беруться з кросів Омеги за артикулом. */}
      <div className="rounded-xl border border-gray-200 p-4" data-supplier-gpl>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-base font-semibold text-gray-900">GPL</p>
            <p className="text-xs text-gray-500">online.gpl.ua · ціни, залишки по складах, опис, категорії й фото (зокрема K2), раз на 3 години</p>
          </div>
          {gpl && <label className="flex items-center gap-2 text-sm"><input type="checkbox" role="switch" className="h-5 w-5 rounded border-gray-300 text-accent" checked={gpl.enabled} onChange={event => void toggleOf(gpl, event.target.checked)} />Увімкнено</label>}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <Input label={gpl ? `Логін (збережено: ${gpl.key_hint.replace(/^логін /, '')})` : 'Логін GPL'} autoComplete="off" value={gplLogin}
              placeholder={gpl ? 'Новий логін — лише якщо треба замінити' : 'Логін від кабінету GPL'} onChange={event => setGplLogin(event.target.value)} />
          </div>
          <div className="min-w-[12rem] flex-1">
            <Input label="Пароль GPL" type="password" autoComplete="new-password" value={gplPassword} placeholder="Пароль від кабінету GPL" onChange={event => setGplPassword(event.target.value)} />
          </div>
          <Button icon={<KeyRound size={14} />} loading={busy === 'gpl-key'} disabled={gplLogin.trim().length < 2 || gplPassword.length < 4} onClick={() => void saveGpl()}>{gpl ? 'Замінити доступ' : 'Підключити'}</Button>
        </div>
        {gpl && (
          <>
            <p className="mt-3 text-sm text-gray-700" data-supplier-status>
              Товарів під замовлення: <b>{gpl.offers.toLocaleString('uk-UA')}</b>{gpl.total_offers ? ` з ${gpl.total_offers.toLocaleString('uk-UA')}` : ''}
              {' · '}збігаються з вашими картками: <b>{gpl.linked.toLocaleString('uk-UA')}</b>
              {' · '}{gpl.syncing ? `оновлюється (сторінка ${gpl.sync_page})` : gpl.last_full_sync_at ? 'оновлено ' + new Date(gpl.last_full_sync_at).toLocaleString('uk-UA') : 'ще не завантажувалось'}
            </p>
            {gpl.meta?.price_names && gpl.meta.price_names.length > 0 && (
              <p className="mt-1 text-xs text-gray-500">Ціни в прайсі GPL: {gpl.meta.price_names.join(', ')}. Закупкою взято: <b>{gpl.meta.purchase_price_name ?? '—'}</b> (найменша не роздрібна).</p>
            )}
            {gpl.last_error && <p role="alert" className="mt-1 text-sm text-red-700">Остання помилка: {gpl.last_error}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} loading={busy === 'sync' + gpl.id} disabled={gpl.syncing} onClick={() => void syncOf(gpl)}>Оновити зараз</Button>
              <Button size="sm" variant="danger-outline" icon={<Trash2 size={14} />} loading={busy === 'remove' + gpl.id} onClick={() => void removeOf(gpl)}>Видалити підключення</Button>
            </div>
          </>
        )}
      </div>
      {rows.filter(conn => conn.warehouses.length > 0).map(conn => (
        <div key={conn.id} className="rounded-xl border border-gray-200 p-4">
          <p className="mb-1 text-sm font-semibold text-gray-900">Склади: {conn.name}</p>
          <p className="mb-3 text-xs text-gray-500">«Днів до відправки клієнту» бачать менеджер у бланку замовлення й сайт. Вимкнений склад не показується ніде.</p>
          <ul className="divide-y divide-gray-100" data-supplier-warehouses>
            {conn.warehouses.map(w => (
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
      ))}
    </div>
  )
}
