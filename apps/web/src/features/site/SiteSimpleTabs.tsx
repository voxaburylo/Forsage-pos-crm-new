import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Check, EyeOff, RefreshCw, Save, Trash2 } from 'lucide-react'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { errorText, siteCall, useSiteData } from './siteGateway'

function Problem({ text }: { text: string }) {
  return text ? <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{text}</p> : null
}

// ── Клієнти сайту ───────────────────────────────────────────────────────────────────────────────

interface SiteCustomer { id: string; email?: string | null; full_name?: string | null; phone?: string | null; created_at: string; orders_count?: number }

export function SiteCustomersTab() {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 400); return () => window.clearTimeout(timer) }, [search])
  const { data, error, loading, reload } = useSiteData<SiteCustomer[]>('customers.list', { ...(query ? { search: query } : {}), limit: 100, offset: 0 })
  const rows = Array.isArray(data) ? data : []
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1"><Input label="Пошук" placeholder="Імʼя, телефон або пошта" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <Button variant="secondary" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void reload()}>Оновити</Button>
      </div>
      <Problem text={error} />
      {!error && !loading && rows.length === 0 && <p data-site-empty className="mx-auto max-w-xl py-8 text-center text-sm text-gray-500">На сайті ще ніхто не зареєструвався.</p>}
      <ul className="divide-y divide-gray-100">
        {rows.map(row => (
          <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2.5 text-sm">
            <span className="min-w-0 break-words"><span className="font-medium text-gray-900">{row.full_name || 'Без імені'}</span>
              <span className="text-gray-500"> · {row.phone || '—'} · {row.email || '—'}</span></span>
            <span className="shrink-0 text-xs text-gray-500">замовлень: {row.orders_count ?? 0} · з {new Date(row.created_at).toLocaleDateString('uk-UA')}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-gray-500">Це клієнти, що зареєструвались на сайті. З клієнтами програми вони не зливаються.</p>
    </Card>
  )
}

// ── Відгуки ─────────────────────────────────────────────────────────────────────────────────────

interface SiteReview { id: string; product_title?: string | null; author_name?: string | null; rating?: number; body?: string | null; created_at: string; approved: boolean }

export function SiteReviewsTab() {
  const [filter, setFilter] = useState<'all' | 'wait' | 'shown'>('wait')
  const { data, error, loading, reload } = useSiteData<SiteReview[]>('reviews.list', filter === 'all' ? {} : { approved: filter === 'shown' })
  const [busy, setBusy] = useState('')
  const rows = Array.isArray(data) ? data : []

  async function act(id: string, run: () => Promise<unknown>, done: string) {
    setBusy(id)
    try { await run(); toast.success(done); await reload() } catch (reason) { toast.error(errorText(reason)) } finally { setBusy('') }
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap gap-2">
        {([['wait', 'Чекають перевірки'], ['shown', 'Показані'], ['all', 'Усі']] as const).map(([value, label]) => (
          <Button key={value} size="sm" variant={filter === value ? 'primary' : 'secondary'} onClick={() => setFilter(value)}>{label}</Button>
        ))}
      </div>
      <Problem text={error} />
      {!error && !loading && rows.length === 0 && <p data-site-empty className="mx-auto max-w-xl py-8 text-center text-sm text-gray-500">{filter === 'wait' ? 'Нових відгуків, що чекають вашої перевірки, немає. Коли покупець залишить відгук, він зʼявиться тут.' : 'Відгуків за цим відбором немає.'}</p>}
      <ul className="divide-y divide-gray-100">
        {rows.map(row => (
          <li key={row.id} className="py-3 text-sm">
            <p className="font-medium text-gray-900">{row.author_name || 'Без імені'} · {'★'.repeat(Math.max(0, Math.min(5, Number(row.rating) || 0)))}
              <span className="font-normal text-gray-500"> · {row.product_title || 'товар'} · {new Date(row.created_at).toLocaleDateString('uk-UA')}</span></p>
            <p className="mt-1 whitespace-pre-wrap break-words text-gray-700">{row.body}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {row.approved
                ? <Button size="sm" variant="secondary" icon={<EyeOff size={14} />} loading={busy === row.id} onClick={() => void act(row.id, () => siteCall('reviews.moderate', { id: row.id, approved: false }), 'Відгук сховано')}>Сховати</Button>
                : <Button size="sm" icon={<Check size={14} />} loading={busy === row.id} onClick={() => void act(row.id, () => siteCall('reviews.moderate', { id: row.id, approved: true }), 'Відгук показано на сайті')}>Показати на сайті</Button>}
              <Button size="sm" variant="secondary" icon={<Trash2 size={14} />} onClick={() => { if (window.confirm('Видалити відгук назавжди?')) void act(row.id, () => siteCall('reviews.delete', { id: row.id }), 'Відгук видалено') }}>Видалити</Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ── Головна сторінка ────────────────────────────────────────────────────────────────────────────

export const HOME_BLOCK_TEXT: Record<string, string> = {
  banners: 'Банери (слайдер)', size_search: 'Підбір шин за розміром', categories: 'Категорії', hits: 'Хіти продажу',
  promos: 'Акції', benefits: 'Переваги магазину', reviews: 'Відгуки', articles: 'Статті',
}
export interface HomeBlock { type: string; enabled: boolean; title?: string }

/** Блоки з сайту + ті, яких у відповіді бракує (вимкнені, в кінці). Невідомі типи лишаємо як є — сайт міг додати нові. */
export function completeHomeBlocks(blocks: unknown): HomeBlock[] {
  const known = Array.isArray(blocks) ? blocks.filter((block): block is HomeBlock => Boolean(block) && typeof block === 'object' && typeof (block as HomeBlock).type === 'string')
    .map(block => ({ type: block.type, enabled: Boolean(block.enabled), ...(typeof block.title === 'string' ? { title: block.title } : {}) })) : []
  const seen = new Set(known.map(block => block.type))
  return [...known, ...Object.keys(HOME_BLOCK_TEXT).filter(type => !seen.has(type)).map(type => ({ type, enabled: false }))]
}

export function SiteHomeTab() {
  const { data, error, loading } = useSiteData<{ blocks?: unknown }>('home.get')
  const [blocks, setBlocks] = useState<HomeBlock[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (data) setBlocks(completeHomeBlocks(data.blocks)) }, [data])

  const move = (index: number, step: number) => setBlocks(current => {
    if (!current || index + step < 0 || index + step >= current.length) return current
    const next = [...current]; [next[index], next[index + step]] = [next[index + step], next[index]]
    return next
  })
  const patch = (index: number, change: Partial<HomeBlock>) => setBlocks(current => current ? current.map((block, at) => at === index ? { ...block, ...change } : block) : current)

  async function save() {
    if (!blocks) return
    setBusy(true)
    try { await siteCall('home.set', { blocks }); toast.success('Головну сторінку збережено') } catch (reason) { toast.error(errorText(reason)) } finally { setBusy(false) }
  }

  return (
    <Card>
      <p className="mb-3 text-xs text-gray-500">Порядок і склад головної сторінки сайту. Стрілки міняють місце блоку, галочка — показувати чи ні.</p>
      <Problem text={error} />
      {loading && !blocks && <p role="status" className="py-6 text-center text-sm text-gray-500">Завантажуємо…</p>}
      {blocks && (
        <>
          <ul className="divide-y divide-gray-100" data-site-home>
            {blocks.map((block, index) => (
              <li key={block.type} className="flex flex-wrap items-center gap-2 py-2.5">
                <input type="checkbox" className="h-5 w-5 shrink-0 rounded border-gray-300 text-accent" checked={block.enabled} onChange={event => patch(index, { enabled: event.target.checked })} aria-label={'Показувати: ' + (HOME_BLOCK_TEXT[block.type] ?? block.type)} />
                <span className="w-48 shrink-0 text-sm font-medium text-gray-900">{HOME_BLOCK_TEXT[block.type] ?? block.type}</span>
                <input value={block.title ?? ''} maxLength={120} placeholder="Заголовок (необовʼязково)" onChange={event => patch(index, { title: event.target.value })}
                  className="min-w-[10rem] flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                <Button size="sm" variant="secondary" icon={<ArrowUp size={14} />} disabled={index === 0} onClick={() => move(index, -1)} aria-label="Вище">{''}</Button>
                <Button size="sm" variant="secondary" icon={<ArrowDown size={14} />} disabled={index === blocks.length - 1} onClick={() => move(index, 1)} aria-label="Нижче">{''}</Button>
              </li>
            ))}
          </ul>
          <Button className="mt-4" icon={<Save size={14} />} loading={busy} onClick={() => void save()}>Зберегти</Button>
        </>
      )}
    </Card>
  )
}

// ── Налаштування сайту ──────────────────────────────────────────────────────────────────────────

export const SITE_SETTING_FIELDS: Array<{ key: string; label: string; hint?: string }> = [
  { key: 'contact_phone1', label: 'Телефон 1' }, { key: 'contact_phone2', label: 'Телефон 2' },
  { key: 'contact_address', label: 'Адреса' }, { key: 'contact_viber', label: 'Viber' }, { key: 'contact_telegram', label: 'Telegram' },
  { key: 'seo_title', label: 'Заголовок сайту для пошуковиків' }, { key: 'seo_description', label: 'Опис сайту для пошуковиків' },
  { key: 'legal_seller_name', label: 'Продавець (назва або ПІБ)' }, { key: 'legal_seller_code', label: 'Код ЄДРПОУ / ІПН' },
  { key: 'legal_seller_address', label: 'Адреса продавця' }, { key: 'legal_seller_email', label: 'Пошта продавця' },
  { key: 'ga_measurement_id', label: 'Google Analytics (ID)', hint: 'Вигляду G-XXXXXXXXXX. Порожньо — лічильник вимкнено.' },
  { key: 'fb_pixel_id', label: 'Facebook Pixel (ID)', hint: 'Порожньо — піксель вимкнено.' },
]

export function SiteSettingsTab() {
  const { data, error, loading } = useSiteData<Record<string, unknown>>('settings.get')
  const [values, setValues] = useState<Record<string, string> | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (data) setValues(Object.fromEntries(SITE_SETTING_FIELDS.map(field => [field.key, data[field.key] == null ? '' : String(data[field.key])]))) }, [data])

  async function save() {
    if (!values) return
    setBusy(true)
    try { await siteCall('settings.set', { values }); toast.success('Налаштування сайту збережено') } catch (reason) { toast.error(errorText(reason)) } finally { setBusy(false) }
  }

  return (
    <Card>
      <Problem text={error} />
      {loading && !values && <p role="status" className="py-6 text-center text-sm text-gray-500">Завантажуємо…</p>}
      {values && (
        <div className="space-y-3">
          {SITE_SETTING_FIELDS.map(field => (
            <Input key={field.key} label={field.label} hint={field.hint} value={values[field.key] ?? ''} maxLength={500}
              onChange={event => setValues(current => current ? { ...current, [field.key]: event.target.value } : current)} />
          ))}
          <Button icon={<Save size={14} />} loading={busy} onClick={() => void save()}>Зберегти</Button>
        </div>
      )}
    </Card>
  )
}
