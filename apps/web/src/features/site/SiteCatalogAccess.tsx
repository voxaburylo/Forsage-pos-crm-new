import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, KeyRound, RefreshCw, Save } from 'lucide-react'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { API_BASE_URL } from '@/lib/apiBaseUrl'
import {
  ORDER_STATE_TEXT, STOCK_MODE_TEXT, categoryRows, money, priceExample, readMinOrder, readPercent,
  type SiteAdmin, type SiteCategory, type SiteOrder, type SiteSettings, type StockMode,
} from './siteModel'

const BASE = '/api/v1/site-admin'
const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback

function Switch({ checked, onChange, label, hint, name }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string; name: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2">
      <input type="checkbox" role="switch" data-site-switch={name} checked={checked} onChange={event => onChange(event.target.checked)}
        className="mt-0.5 h-5 w-5 shrink-0 rounded border-gray-300 text-accent focus:ring-accent" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-900">{label}</span>
        {hint && <span className="block text-xs text-gray-500">{hint}</span>}
      </span>
    </label>
  )
}

function Area({ label, value, onChange, max, hint }: { label: string; value: string; onChange: (value: string) => void; max: number; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
      <textarea value={value} maxLength={max} rows={3} onChange={event => onChange(event.target.value)}
        className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent" />
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  )
}

/**
 * Вкладка «Каталог для сайту» розділу «Сайт» (24.11.2026): доступ сайту до каталогу через сервер програми:
 * увімкнено чи ні, ключ для сайту, що він показує (ціни, наявність, розділи), прийом замовлень, тексти,
 * і замовлення, що прийшли. Гроші із сайту не приймаються: замовлення потрапляє в «Замовлення», оплата — на касі.
 */
export function SiteCatalogAccess() {
  const [admin, setAdmin] = useState<SiteAdmin | null>(null)
  const [form, setForm] = useState<SiteSettings | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [pct, setPct] = useState('0')
  const [minOrder, setMinOrder] = useState('')
  const [categories, setCategories] = useState<SiteCategory[]>([])
  const [orders, setOrders] = useState<SiteOrder[]>([])
  const [newKey, setNewKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const apply = useCallback((data: SiteAdmin) => {
    setAdmin(data); setForm(data.settings); setEnabled(data.enabled)
    setPct(String(data.settings.price_change_pct).replace('.', ','))
    setMinOrder(data.settings.min_order_kopecks ? String(data.settings.min_order_kopecks / 100).replace('.', ',') : '')
  }, [])

  const loadOrders = useCallback(async () => {
    try { setOrders((await api.get<{ data: SiteOrder[] }>(BASE + '/orders', { silent: true, timeoutMs: 15_000 })).data) } catch { /* список замовлень — не привід ховати налаштування */ }
  }, [])

  useEffect(() => {
    let alive = true
    api.get<{ data: SiteAdmin }>(BASE, { silent: true, timeoutMs: 15_000 })
      .then(answer => { if (alive) apply(answer.data) }, reason => { if (alive) setError(message(reason, 'Не вдалося відкрити налаштування сайту. Потрібен інтернет.')) })
    api.get<{ data: SiteCategory[] }>(BASE + '/categories', { silent: true, timeoutMs: 15_000 }).then(answer => { if (alive) setCategories(answer.data) }, () => undefined)
    void loadOrders()
    return () => { alive = false }
  }, [apply, loadOrders])

  const rows = useMemo(() => categoryRows(categories), [categories])
  const hidden = useMemo(() => new Set(form?.hidden_category_ids ?? []), [form])
  const set = <K extends keyof SiteSettings>(key: K, value: SiteSettings[K]) => setForm(current => current ? { ...current, [key]: value } : current)
  let example = ''
  try { example = priceExample(readPercent(pct)) } catch (reason) { example = message(reason, '') }

  async function save() {
    if (!form || busy) return
    let settings: SiteSettings
    try { settings = { ...form, price_change_pct: readPercent(pct), min_order_kopecks: readMinOrder(minOrder) } } catch (reason) { toast.error(message(reason, 'Перевірте поля')); return }
    setBusy(true)
    try {
      apply((await api.put<{ data: SiteAdmin }>(BASE, { enabled, settings }, { silent: true, timeoutMs: 15_000 })).data)
      toast.success('Налаштування сайту збережено')
    } catch (reason) { toast.error(message(reason, 'Не вдалося зберегти')) } finally { setBusy(false) }
  }

  async function issueKey() {
    if (busy) return
    if (admin?.key_hint && !window.confirm('Видати новий ключ? Старий одразу перестане діяти — сайт не працюватиме, доки в нього не внесуть новий.')) return
    setBusy(true)
    try {
      const answer = (await api.post<{ data: SiteAdmin & { key: string } }>(BASE + '/key', {}, undefined, { silent: true, timeoutMs: 15_000 })).data
      setNewKey(answer.key); setAdmin(current => current ? { ...current, key_hint: answer.key_hint, key_created_at: answer.key_created_at } : current)
    } catch (reason) { toast.error(message(reason, 'Не вдалося видати ключ')) } finally { setBusy(false) }
  }

  async function revokeKey() {
    if (busy || !window.confirm('Вимкнути ключ? Сайт перестане отримувати товари й передавати замовлення.')) return
    setBusy(true)
    try {
      const answer = (await api.delete<{ data: SiteAdmin }>(BASE + '/key', { silent: true, timeoutMs: 15_000 })).data
      setNewKey(''); setAdmin(current => current ? { ...current, key_hint: answer.key_hint, key_created_at: answer.key_created_at } : current)
      toast.success('Ключ вимкнено')
    } catch (reason) { toast.error(message(reason, 'Не вдалося вимкнути ключ')) } finally { setBusy(false) }
  }

  async function copy(text: string, done: string) {
    try { await navigator.clipboard.writeText(text); toast.success(done) } catch { toast.error('Не вдалося скопіювати — виділіть і скопіюйте вручну') }
  }

  const address = API_BASE_URL.replace(/\/$/, '') + '/api/v1/site'

  return (
      <div className="space-y-4">
        <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">Запасний, безпечний спосіб для сайту читати каталог: через сервер програми, зі своїм ключем — без закупівельних цін, постачальників і клієнтів. Потрібен, якщо сайт не читатиме хмарну базу програми напряму.</p>
        {error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>}
        {!form && !error && <p role="status" className="py-8 text-center text-sm text-gray-500">Завантажуємо…</p>}
        {form && (
          <>
            <Card>
              <Switch name="enabled" checked={enabled} onChange={setEnabled} label="Сайт увімкнено"
                hint="Вимкнено — сайт не отримує ні товарів, ні цін і не може передати замовлення. Діє після «Зберегти»." />
              <p className="mt-1 text-xs text-gray-500">Сайт бере товари з хмарної копії, а не з головного ПК: він працює й тоді, коли програму закрито. Нові ціни й залишки потрапляють у хмару, коли програма на касі увімкнена.</p>
            </Card>

            <Card>
              <h2 className="mb-1 text-base font-semibold text-gray-900">Ключ для сайту</h2>
              <p className="mb-3 text-xs text-gray-500">Ключ вносить той, хто робить сайт. Його видно один раз — одразу після видачі. Нікому, крім розробника сайту, не передавайте.</p>
              <p className="text-sm text-gray-700" data-site-key-state>{admin?.key_hint ? `Ключ видано (закінчується на ${admin.key_hint.replace('…', '')})` : 'Ключа ще немає'}</p>
              {newKey && (
                <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                  <p className="mb-1 text-xs font-medium text-emerald-900">Новий ключ — скопіюйте зараз, більше він не покажеться:</p>
                  <code className="block break-all text-sm text-emerald-950" data-site-new-key>{newKey}</code>
                  <Button className="mt-2" size="sm" variant="secondary" icon={<Copy size={14} />} onClick={() => void copy(newKey, 'Ключ скопійовано')}>Скопіювати ключ</Button>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={<KeyRound size={14} />} loading={busy} onClick={() => void issueKey()}>{admin?.key_hint ? 'Видати новий ключ' : 'Видати ключ'}</Button>
                {admin?.key_hint && <Button size="sm" variant="secondary" onClick={() => void revokeKey()}>Вимкнути ключ</Button>}
              </div>
              <div className="mt-3 border-t border-gray-100 pt-3">
                <p className="text-xs text-gray-500">Адреса для сайту:</p>
                <code className="block break-all text-sm text-gray-800">{address}</code>
                <Button className="mt-2" size="sm" variant="secondary" icon={<Copy size={14} />} onClick={() => void copy(address, 'Адресу скопійовано')}>Скопіювати адресу</Button>
              </div>
            </Card>

            <Card>
              <h2 className="mb-2 text-base font-semibold text-gray-900">Що показувати на сайті</h2>
              <Switch name="show_prices" checked={form.show_prices} onChange={value => set('show_prices', value)} label="Показувати ціни" hint="Вимкнено — сайт не отримує цін узагалі." />
              <div className="py-2">
                <Input label="Ціна на сайті, % до ціни продажу" inputMode="decimal" value={pct} onChange={event => setPct(event.target.value)} data-site-pct
                  hint={example + '. Нижче закупівельної ціни товар не піде ніколи.'} />
              </div>
              <label className="block py-2">
                <span className="mb-1 block text-sm font-medium text-gray-700">Наявність</span>
                <select value={form.stock_mode} onChange={event => set('stock_mode', event.target.value as StockMode)} data-site-stock
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                  {(Object.keys(STOCK_MODE_TEXT) as StockMode[]).map(mode => <option key={mode} value={mode}>{STOCK_MODE_TEXT[mode]}</option>)}
                </select>
              </label>
              <Switch name="only_in_stock" checked={form.only_in_stock} onChange={value => set('only_in_stock', value)} label="Лише товари, які є на складі" hint="Товар, що закінчився, зникає із сайту й повертається після приходу." />
              <p className="mt-1 text-xs text-gray-500">Закупівельні ціни, постачальники й клієнти сайту не передаються. Послуги (шиномонтаж) на сайт не йдуть.</p>
            </Card>

            <Card>
              <h2 className="mb-1 text-base font-semibold text-gray-900">Розділи каталогу</h2>
              <p className="mb-2 text-xs text-gray-500">Зніміть галочку — розділ разом із вкладеними зникне із сайту. Зараз приховано: {hidden.size}.</p>
              {rows.length === 0 ? <p className="text-sm text-gray-500">Розділів немає або список не завантажився.</p> : (
                <ul className="max-h-80 overflow-y-auto rounded-lg border border-gray-100" data-site-categories>
                  {rows.map(row => (
                    <li key={row.id} className="border-b border-gray-50 last:border-b-0">
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm" style={{ paddingLeft: 12 + row.depth * 18 }}>
                        <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-gray-300 text-accent" checked={!hidden.has(row.id)}
                          onChange={event => set('hidden_category_ids', event.target.checked ? form.hidden_category_ids.filter(id => id !== row.id) : [...form.hidden_category_ids, row.id])} />
                        <span className="min-w-0 break-words text-gray-800">{row.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <h2 className="mb-2 text-base font-semibold text-gray-900">Замовлення із сайту</h2>
              <Switch name="accept_orders" checked={form.accept_orders} onChange={value => set('accept_orders', value)} label="Приймати замовлення"
                hint="Замовлення саме зʼявляється в «Замовленнях» програми. Оплату приймає лише каса." />
              <div className="py-2">
                <Input label="Найменша сума замовлення, грн" inputMode="decimal" value={minOrder} onChange={event => setMinOrder(event.target.value)} hint="Порожньо — без обмеження." />
              </div>
            </Card>

            <Card>
              <h2 className="mb-2 text-base font-semibold text-gray-900">Тексти й контакти на сайті</h2>
              <div className="space-y-3">
                <Input label="Назва магазину" value={form.title} maxLength={120} onChange={event => set('title', event.target.value)} hint="Порожньо — назва з налаштувань магазину." />
                <Input label="Телефон" value={form.phone} maxLength={60} onChange={event => set('phone', event.target.value)} />
                <Input label="Адреса" value={form.address} maxLength={300} onChange={event => set('address', event.target.value)} />
                <Input label="Години роботи" value={form.working_hours} maxLength={300} onChange={event => set('working_hours', event.target.value)} />
                <Input label="Оголошення вгорі сайту" value={form.banner_text} maxLength={300} onChange={event => set('banner_text', event.target.value)} hint="Наприклад: «Знижка 5% на оливи до кінця тижня». Порожньо — без оголошення." />
                <Area label="Про магазин" value={form.about} max={4000} onChange={value => set('about', value)} />
                <Area label="Доставка" value={form.delivery_text} max={4000} onChange={value => set('delivery_text', value)} />
                <Area label="Оплата" value={form.payment_text} max={4000} onChange={value => set('payment_text', value)} />
              </div>
              <Button className="mt-4" icon={<Save size={14} />} loading={busy} onClick={() => void save()}>Зберегти</Button>
            </Card>

            <Card>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-gray-900">Що прийшло із сайту</h2>
                <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void loadOrders()}>Оновити</Button>
              </div>
              {orders.length === 0 ? <p className="text-sm text-gray-500">Замовлень із сайту ще не було.</p> : (
                <ul className="divide-y divide-gray-100" data-site-orders>
                  {orders.map(order => (
                    <li key={order.id} className="py-3 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="font-medium text-gray-900">№ {order.external_id} · {order.customer_name} · {order.customer_phone}</span>
                        <span className="text-gray-700">{money(order.total_amount)}</span>
                      </div>
                      <p className="text-xs text-gray-500">{new Date(order.created_at).toLocaleString('uk-UA')} · позицій: {order.items.length}
                        {' · '}<span className={order.state === 'in_program' ? 'text-emerald-700' : order.state === 'waiting' ? 'text-amber-700' : 'text-red-700'}>
                          {ORDER_STATE_TEXT[order.state]}{order.order_number ? ` (замовлення № ${order.order_number})` : ''}</span>
                      </p>
                      {order.delivery && <p className="text-xs text-gray-600">Доставка: {order.delivery}</p>}
                      {order.error && <p className="text-xs text-red-700">Причина: {order.error}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
  )
}
