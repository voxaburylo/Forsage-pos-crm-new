import { useEffect, useState } from 'react'
import { ImagePlus, Pencil, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { Button, Card, Input, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { compressWebp, errorText, isoToLocalInput, localInputToIso, putImage, siteCall, useSiteData, type UploadSlot } from './siteGateway'
import { categoryRows, type SiteCategory } from './siteModel'

type Row = Record<string, unknown> & { id?: string }

export interface CrudField {
  key: string
  label: string
  type: 'text' | 'area' | 'number' | 'bool' | 'date' | 'select' | 'image' | 'ids' | 'program_categories'
  hint?: string
  options?: Array<{ value: string; label: string }>
  /** Для картинки: точний розмір рамки (банер) — зайве обрізається по центру. */
  image?: { width: number; height: number; bytes: number }
  required?: boolean
  /** Поле не можна змінити в наявному записі. */
  lockedOnEdit?: boolean
}

export interface CrudConfig {
  name: string
  list: string; upsert: string; remove: string
  fields: CrudField[]
  empty: () => Row
  title: (row: Row) => string
  subtitle?: (row: Row) => string
  addLabel: string
  intro?: string
  /** Запис, який можна лише редагувати (інфо-сторінки сайту). */
  fixed?: (row: Row) => boolean
}

/** Значення форми → те, що піде на сайт: числа числами, дати в ISO, порожні необовʼязкові рядки — null. */
export function formToPayload(fields: CrudField[], form: Row): Row {
  const out: Row = form.id ? { id: form.id } : {}
  for (const field of fields) {
    const value = form[field.key]
    if (field.type === 'number') { const text = String(value ?? '').trim().replace(',', '.'); out[field.key] = text === '' ? null : Number(text) }
    else if (field.type === 'bool') out[field.key] = Boolean(value)
    else if (field.type === 'date') out[field.key] = localInputToIso(String(value ?? ''))
    else if (field.type === 'ids') out[field.key] = String(value ?? '').split(/[\s,;]+/).map(part => part.trim()).filter(Boolean)
    else if (field.type === 'program_categories') out[field.key] = Array.isArray(value) ? value : []
    else { const text = String(value ?? '').trim(); out[field.key] = text === '' && !field.required ? null : text }
  }
  return out
}

/** Запис із сайту → значення полів форми. */
export function rowToForm(fields: CrudField[], row: Row): Row {
  const out: Row = row.id ? { id: row.id } : {}
  for (const field of fields) {
    const value = row[field.key]
    if (field.type === 'bool') out[field.key] = value === undefined ? true : Boolean(value)
    else if (field.type === 'date') out[field.key] = isoToLocalInput(value)
    else if (field.type === 'ids') out[field.key] = Array.isArray(value) ? value.join(', ') : ''
    else if (field.type === 'program_categories') out[field.key] = Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
    else out[field.key] = value == null ? '' : String(value)
  }
  return out
}

/** Чого бракує у формі; '' — усе гаразд. */
export function formProblem(fields: CrudField[], form: Row): string {
  for (const field of fields) {
    const value = form[field.key]
    if (field.required && !String(value ?? '').trim()) return `Заповніть поле «${field.label}»`
    if (field.type === 'number' && String(value ?? '').trim() && !Number.isFinite(Number(String(value).trim().replace(',', '.')))) return `Поле «${field.label}»: потрібне число`
  }
  const [from, to] = [localInputToIso(String(form.starts_at ?? '')), localInputToIso(String(form.ends_at ?? ''))]
  if (from && to && from > to) return 'Дата початку пізніша за дату кінця'
  return ''
}

const inputClass = 'w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent'

function ImageField({ field, value, onChange }: { field: CrudField; value: string; onChange: (value: string) => void }) {
  const [busy, setBusy] = useState(false)
  async function pick(file: File | undefined) {
    if (!file) return
    setBusy(true)
    try {
      const frame = field.image ?? { width: 1200, height: 800, bytes: 150 * 1024 }
      const blob = await compressWebp(file, { side: Math.max(frame.width, frame.height), quality: 0.82, bytes: frame.bytes }, field.image ? { width: frame.width, height: frame.height } : undefined)
      const slots = await siteCall<UploadSlot[]>('photos.upload_url', { kind: 'banner', count: 1 })
      const slot = Array.isArray(slots) ? slots[0]?.full : null
      if (!slot?.upload_url || !slot.public_url) throw new Error('Сайт не видав адресу для картинки')
      await putImage(slot.upload_url, blob)
      onChange(slot.public_url)
      toast.success(`Картинку завантажено (${Math.round(blob.size / 1024)} КБ)`)
    } catch (reason) { toast.error(errorText(reason, 'Не вдалося завантажити картинку')) } finally { setBusy(false) }
  }
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-gray-700">{field.label}</span>
      {value && /^https:\/\//.test(value) && <img src={value} alt="" className="mb-2 max-h-32 rounded-lg border border-gray-100 object-contain" />}
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
          <ImagePlus size={14} aria-hidden="true" />{busy ? 'Завантажуємо…' : value ? 'Замінити картинку' : 'Вибрати картинку'}
          <input type="file" accept="image/*" className="sr-only" disabled={busy} onChange={event => { void pick(event.target.files?.[0]); event.target.value = '' }} />
        </label>
        {value && <Button size="sm" variant="secondary" onClick={() => onChange('')}>Прибрати</Button>}
      </div>
      {field.hint && <p className="mt-1 text-xs text-gray-400">{field.hint}</p>}
    </div>
  )
}

function ProgramCategoriesField({ field, value, onChange }: { field: CrudField; value: string[]; onChange: (value: string[]) => void }) {
  const [categories, setCategories] = useState<SiteCategory[]>([])
  useEffect(() => {
    let alive = true
    api.get<{ data: SiteCategory[] }>('/api/v1/site-admin/categories', { silent: true, timeoutMs: 15_000 }).then(answer => { if (alive) setCategories(answer.data) }, () => undefined)
    return () => { alive = false }
  }, [])
  const picked = new Set(value)
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-gray-700">{field.label} <span className="font-normal text-gray-500">(вибрано: {value.length})</span></span>
      <ul className="max-h-56 overflow-y-auto rounded-lg border border-gray-100" data-site-program-categories>
        {categoryRows(categories).map(row => (
          <li key={row.id}>
            <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm" style={{ paddingLeft: 12 + row.depth * 16 }}>
              <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-gray-300 text-accent" checked={picked.has(row.id)}
                onChange={event => onChange(event.target.checked ? [...value, row.id] : value.filter(id => id !== row.id))} />
              <span className="min-w-0 break-words">{row.name}</span>
            </label>
          </li>
        ))}
        {categories.length === 0 && <li className="px-3 py-2 text-sm text-gray-500">Категорії програми не завантажились.</li>}
      </ul>
      {field.hint && <p className="mt-1 text-xs text-gray-400">{field.hint}</p>}
    </div>
  )
}

function Editor({ config, row, onClose, onSaved }: { config: CrudConfig; row: Row; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Row>(() => rowToForm(config.fields, row))
  const [busy, setBusy] = useState(false)
  const set = (key: string, value: unknown) => setForm(current => ({ ...current, [key]: value }))

  async function save() {
    const problem = formProblem(config.fields, form)
    if (problem) { toast.error(problem); return }
    setBusy(true)
    try { await siteCall(config.upsert, formToPayload(config.fields, form)); toast.success('Збережено'); onSaved(); onClose() } catch (reason) { toast.error(errorText(reason)) } finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} title={row.id ? config.title(row) || 'Редагування' : config.addLabel} size="lg">
      <div className="space-y-3" data-site-editor={config.name}>
        {config.fields.map(field => {
          const value = form[field.key]
          const locked = Boolean(field.lockedOnEdit && row.id)
          if (field.type === 'bool') return (
            <label key={field.key} className="flex cursor-pointer items-center gap-3 py-1 text-sm">
              <input type="checkbox" className="h-5 w-5 shrink-0 rounded border-gray-300 text-accent" checked={Boolean(value)} onChange={event => set(field.key, event.target.checked)} />
              <span className="font-medium text-gray-900">{field.label}</span>
            </label>
          )
          if (field.type === 'image') return <ImageField key={field.key} field={field} value={String(value ?? '')} onChange={next => set(field.key, next)} />
          if (field.type === 'program_categories') return <ProgramCategoriesField key={field.key} field={field} value={Array.isArray(value) ? value as string[] : []} onChange={next => set(field.key, next)} />
          if (field.type === 'area') return (
            <label key={field.key} className="block">
              <span className="mb-1 block text-sm font-medium text-gray-700">{field.label}</span>
              <textarea rows={8} value={String(value ?? '')} onChange={event => set(field.key, event.target.value)} className={inputClass} />
              {field.hint && <span className="mt-1 block text-xs text-gray-400">{field.hint}</span>}
            </label>
          )
          if (field.type === 'select') return (
            <label key={field.key} className="block">
              <span className="mb-1 block text-sm font-medium text-gray-700">{field.label}</span>
              <select value={String(value ?? '')} disabled={locked} onChange={event => set(field.key, event.target.value)} className={inputClass}>
                {(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              {field.hint && <span className="mt-1 block text-xs text-gray-400">{field.hint}</span>}
            </label>
          )
          return <Input key={field.key} label={field.label} hint={field.hint} disabled={locked} value={String(value ?? '')}
            type={field.type === 'date' ? 'datetime-local' : 'text'} inputMode={field.type === 'number' ? 'decimal' : undefined}
            onChange={event => set(field.key, event.target.value)} />
        })}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Скасувати</Button>
          <Button icon={<Save size={14} />} loading={busy} onClick={() => void save()}>Зберегти</Button>
        </div>
      </div>
    </Modal>
  )
}

/** Одна вкладка-довідник сайту: список, додати, змінити, видалити. Вигляд і поля задає config. */
export function SiteCrudTab({ config }: { config: CrudConfig }) {
  const { data, error, loading, reload } = useSiteData<Row[]>(config.list)
  const [editing, setEditing] = useState<Row | null>(null)
  const rows = Array.isArray(data) ? data : []

  async function remove(row: Row) {
    if (!window.confirm(`Видалити «${config.title(row)}» із сайту?`)) return
    try { await siteCall(config.remove, { id: row.id }); toast.success('Видалено'); await reload() } catch (reason) { toast.error(errorText(reason)) }
  }

  return (
    <Card>
      {config.intro && <p className="mb-3 text-xs text-gray-500">{config.intro}</p>}
      <div className="mb-3 flex flex-wrap gap-2">
        <Button icon={<Plus size={14} />} onClick={() => setEditing(config.empty())} data-site-add={config.name}>{config.addLabel}</Button>
        <Button variant="secondary" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void reload()}>Оновити</Button>
      </div>
      {error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>}
      {!error && !loading && rows.length === 0 && <p className="py-6 text-center text-sm text-gray-500">Поки порожньо.</p>}
      <ul className="divide-y divide-gray-100" data-site-list={config.name}>
        {rows.map((row, index) => (
          <li key={String(row.id ?? index)} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
            <span className="min-w-0 break-words">
              <span className={`font-medium ${row.is_active === false ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{config.title(row) || 'Без назви'}</span>
              {config.subtitle && <span className="block text-xs text-gray-500">{config.subtitle(row)}</span>}
            </span>
            <span className="flex shrink-0 gap-2">
              <Button size="sm" variant="secondary" icon={<Pencil size={14} />} onClick={() => setEditing(row)}>Змінити</Button>
              {!config.fixed?.(row) && <Button size="sm" variant="secondary" icon={<Trash2 size={14} />} onClick={() => void remove(row)}>Видалити</Button>}
            </span>
          </li>
        ))}
      </ul>
      {editing && <Editor key={String(editing.id ?? 'new')} config={config} row={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
    </Card>
  )
}

// ── Довідники сайту ─────────────────────────────────────────────────────────────────────────────

const day = (value: unknown) => typeof value === 'string' && value ? new Date(value).toLocaleDateString('uk-UA') : '…'

export const BANNERS: CrudConfig = {
  name: 'banners', list: 'banners.list', upsert: 'banners.upsert', remove: 'banners.delete', addLabel: 'Додати банер',
  intro: 'Слайдер на головній сторінці. Картинки програма сама обрізає й стискає: для ПК 1600×500, для телефона 800×600.',
  empty: () => ({ is_active: true, sort_order: 0 }),
  title: row => String(row.title ?? ''),
  subtitle: row => `${day(row.starts_at)} — ${day(row.ends_at)}${row.link ? ' · ' + String(row.link) : ''}`,
  fields: [
    { key: 'title', label: 'Заголовок', type: 'text', required: true },
    { key: 'subtitle', label: 'Підзаголовок', type: 'text' },
    { key: 'image_url', label: 'Картинка для ПК (1600×500)', type: 'image', image: { width: 1600, height: 500, bytes: 180 * 1024 } },
    { key: 'image_mobile_url', label: 'Картинка для телефона (800×600)', type: 'image', image: { width: 800, height: 600, bytes: 110 * 1024 } },
    { key: 'button_text', label: 'Текст кнопки', type: 'text' },
    { key: 'link', label: 'Куди веде кнопка', type: 'text', hint: 'Адреса сторінки на сайті, наприклад /catalog/oils' },
    { key: 'starts_at', label: 'Показувати з', type: 'date' },
    { key: 'ends_at', label: 'Показувати до', type: 'date', hint: 'Порожньо — без кінця.' },
    { key: 'sort_order', label: 'Порядок (менше — раніше)', type: 'number' },
    { key: 'is_active', label: 'Показувати на сайті', type: 'bool' },
  ],
}

const PROMO_TARGET = [{ value: 'all', label: 'Усі товари' }, { value: 'category', label: 'Категорії' }, { value: 'brand', label: 'Бренди' }, { value: 'product', label: 'Окремі товари' }]
export const PROMOS: CrudConfig = {
  name: 'promos', list: 'promos.list', upsert: 'promos.upsert', remove: 'promos.delete', addLabel: 'Додати акцію',
  intro: 'Акція діє лише на сайті: сайт сам показує стару й нову ціну та «−N%». Ціну в програмі акція не змінює. Перед запуском перевірте, що ціна зі знижкою не нижча за закупку.',
  empty: () => ({ is_active: true, target_type: 'all', discount_percent: 5 }),
  title: row => String(row.title ?? ''),
  subtitle: row => `−${Number(row.discount_percent) || 0}% · ${PROMO_TARGET.find(option => option.value === row.target_type)?.label ?? ''} · ${day(row.starts_at)} — ${day(row.ends_at)}`,
  fields: [
    { key: 'title', label: 'Назва акції', type: 'text', required: true },
    { key: 'discount_percent', label: 'Знижка, %', type: 'number', required: true },
    { key: 'target_type', label: 'На що діє', type: 'select', options: PROMO_TARGET },
    { key: 'target_ids', label: 'Коди категорій, брендів або товарів', type: 'ids', hint: 'Через кому. Для «Усі товари» лишіть порожнім.' },
    { key: 'badge_text', label: 'Напис на значку', type: 'text', hint: 'Наприклад: «Акція» або «Чорна пʼятниця».' },
    { key: 'starts_at', label: 'Початок', type: 'date' },
    { key: 'ends_at', label: 'Кінець', type: 'date' },
    { key: 'is_active', label: 'Акція увімкнена', type: 'bool' },
  ],
}

export const PAGES: CrudConfig = {
  name: 'pages', list: 'pages.list', upsert: 'pages.upsert', remove: 'pages.delete', addLabel: 'Додати статтю',
  intro: 'Статті можна додавати й видаляти. Інфо-сторінки (доставка, гарантія, про нас, контакти, питання) — лише редагувати. У тексті: порожній рядок — новий абзац, короткий рядок без крапки — підзаголовок.',
  empty: () => ({ type: 'article' }),
  title: row => String(row.title ?? ''),
  subtitle: row => (row.type === 'info' ? 'Інфо-сторінка' : 'Стаття') + (row.slug ? ' · /' + String(row.slug) : ''),
  fixed: row => row.type === 'info',
  fields: [
    { key: 'type', label: 'Вид', type: 'select', lockedOnEdit: true, options: [{ value: 'article', label: 'Стаття' }, { value: 'info', label: 'Інфо-сторінка' }] },
    { key: 'title', label: 'Заголовок', type: 'text', required: true },
    { key: 'content', label: 'Текст', type: 'area', hint: 'Порожній рядок — новий абзац; короткий рядок без крапки — підзаголовок.' },
    { key: 'image_url', label: 'Картинка', type: 'image' },
  ],
}

export const CATEGORIES: CrudConfig = {
  name: 'categories', list: 'categories.list', upsert: 'categories.upsert', remove: 'categories.delete', addLabel: 'Додати категорію сайту',
  intro: 'Категорії сайту — свої. У кожній відмічаєте, які категорії програми в ній показувати: кілька можна обʼєднати в одну (наприклад «Инструмент ручной» і «Інструмент ручний»).',
  empty: () => ({ is_active: true, sort_order: 0, program_category_ids: [] }),
  title: row => String(row.name ?? ''),
  subtitle: row => `категорій програми: ${Array.isArray(row.program_category_ids) ? row.program_category_ids.length : 0}${row.slug ? ' · /' + String(row.slug) : ''}`,
  fields: [
    { key: 'name', label: 'Назва на сайті', type: 'text', required: true },
    { key: 'parent_id', label: 'Код батьківської категорії сайту', type: 'text', hint: 'Порожньо — категорія верхнього рівня.' },
    { key: 'icon', label: 'Значок', type: 'text' },
    { key: 'sort_order', label: 'Порядок (менше — раніше)', type: 'number' },
    { key: 'is_active', label: 'Показувати на сайті', type: 'bool' },
    { key: 'program_category_ids', label: 'Категорії програми в цій категорії', type: 'program_categories' },
  ],
}
