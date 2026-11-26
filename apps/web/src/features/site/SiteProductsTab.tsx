import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, FolderUp, ImagePlus, Save, Sparkles, Trash2 } from 'lucide-react'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { productApi } from '@/features/products/productApi'
import { canImportSitePhotos, runSitePhotoImport, sitePhotoImportText } from './sitePhotoImport'
import { errorText, exactProductMatch, groupPhotoFiles, siteCall, uploadProductPhotos, type SitePhoto } from './siteGateway'

export interface Found { id: string; name: string; sku?: string | null; barcode?: string | null }
interface SiteFields { description?: string | null; specs?: Record<string, unknown> | null; hidden?: boolean; seo_title?: string | null; seo_description?: string | null; photos?: SitePhoto[] }

/** «Вʼязкість: 5W-40» по рядках → { ключ: значення }; рядки без двокрапки пропускаємо. */
export function specsFromText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf(':')
    if (at < 1) continue
    const key = line.slice(0, at).trim(), value = line.slice(at + 1).trim()
    if (key && value) out[key] = value
  }
  return out
}
export function specsToText(specs: unknown): string {
  return specs && typeof specs === 'object' && !Array.isArray(specs) ? Object.entries(specs).map(([key, value]) => `${key}: ${String(value ?? '')}`).join('\n') : ''
}

const area = 'w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent'

/** Те, що бачить лише сайт: фото, опис, характеристики, «сховати». 26.11.2026 — відкривається з картки товару у «Товари → Усі товари». */
export function ProductEditor({ product }: { product: Found }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [description, setDescription] = useState('')
  const [specs, setSpecs] = useState('')
  const [hidden, setHidden] = useState(false)
  const [seoTitle, setSeoTitle] = useState('')
  const [seoDescription, setSeoDescription] = useState('')
  const [photos, setPhotos] = useState<SitePhoto[]>([])
  const [busy, setBusy] = useState('')
  const [drag, setDrag] = useState(false)

  useEffect(() => {
    let alive = true
    siteCall<SiteFields | null>('products.site_fields.get', { program_product_id: product.id }).then(fields => {
      if (!alive) return
      setDescription(fields?.description ?? ''); setSpecs(specsToText(fields?.specs)); setHidden(Boolean(fields?.hidden))
      setSeoTitle(fields?.seo_title ?? ''); setSeoDescription(fields?.seo_description ?? '')
      setPhotos(Array.isArray(fields?.photos) ? fields.photos.filter(photo => photo && typeof photo.full === 'string') : [])
      setLoaded(true)
    }, reason => { if (alive) setError(errorText(reason, 'Не вдалося отримати дані товару із сайту')) })
    return () => { alive = false }
  }, [product.id])

  async function save() {
    setBusy('save')
    try {
      await siteCall('products.site_fields.set', { program_product_id: product.id, description: description.trim(), specs: specsFromText(specs), hidden,
        seo_title: seoTitle.trim(), seo_description: seoDescription.trim() })
      toast.success('Збережено. На сайті зʼявиться за кілька хвилин.')
    } catch (reason) { toast.error(errorText(reason)) } finally { setBusy('') }
  }

  async function generate() {
    if (description.trim() && !window.confirm('Замінити наявний опис новим від ШІ? Зберігається лише після «Зберегти».')) return
    setBusy('ai')
    try {
      const { aiApi } = await import('@/features/ai/aiApi')
      const answer = await aiApi.chat({ message: `Напиши опис товару для сторінки інтернет-магазину автозапчастин українською, 3–5 речень. Товар: «${product.name}»`
        + (product.sku ? `, артикул ${product.sku}` : '') + '. Пиши лише те, що випливає з назви: без вигаданих характеристик, без цін, без обіцянок гарантії й доставки. Поверни лише текст опису, без заголовків і списків.' })
      const text = String(answer.data.reply ?? '').trim()
      if (!text) throw new Error('ШІ не повернув текст')
      setDescription(text)
      toast.success('Опис підготовлено — перечитайте й натисніть «Зберегти»')
    } catch (reason) { toast.error(errorText(reason, 'ШІ не зміг написати опис')) } finally { setBusy('') }
  }

  async function addPhotos(files: File[]) {
    const images = files.filter(file => file.type.startsWith('image/'))
    if (!images.length) return
    setBusy('photos')
    try {
      const uploaded = await uploadProductPhotos(product.id, images)
      const next = [...photos, ...uploaded]
      await siteCall('photos.attach', { program_product_id: product.id, photos: next })
      setPhotos(next)
      toast.success(`Додано фото: ${uploaded.length}`)
    } catch (reason) { toast.error(errorText(reason, 'Не вдалося завантажити фото')) } finally { setBusy('') }
  }

  async function reorder(index: number, step: number) {
    if (index + step < 0 || index + step >= photos.length) return
    const next = [...photos]; [next[index], next[index + step]] = [next[index + step], next[index]]
    setBusy('photos')
    try { await siteCall('photos.attach', { program_product_id: product.id, photos: next }); setPhotos(next) } catch (reason) { toast.error(errorText(reason)) } finally { setBusy('') }
  }

  async function removePhoto(photo: SitePhoto) {
    if (!window.confirm('Прибрати це фото із сайту?')) return
    setBusy('photos')
    try { await siteCall('photos.remove', { program_product_id: product.id, full: photo.full }); setPhotos(current => current.filter(item => item.full !== photo.full)) }
    catch (reason) { toast.error(errorText(reason)) } finally { setBusy('') }
  }

  if (error) return <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>
  if (!loaded) return <p role="status" className="py-6 text-center text-sm text-gray-500">Завантажуємо…</p>

  return (
    <div className="space-y-4" data-site-product={product.id}>
      <div>
        <h3 className="text-base font-semibold text-gray-900">{product.name}</h3>
        <p className="text-xs text-gray-500">{[product.sku ? 'Артикул ' + product.sku : '', product.barcode ? 'Штрихкод ' + product.barcode : ''].filter(Boolean).join(' · ')}</p>
      </div>

      <div onDragOver={event => { event.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
        onDrop={event => { event.preventDefault(); setDrag(false); void addPhotos([...event.dataTransfer.files]) }}
        className={`rounded-xl border-2 border-dashed p-3 ${drag ? 'border-accent bg-amber-50' : 'border-gray-200'}`}>
        <p className="mb-2 text-sm font-medium text-gray-700">Фото <span className="font-normal text-gray-500">— перше головне; перетягніть сюди файли. Програма сама стискає кожне до двох розмірів.</span></p>
        <ul className="flex flex-wrap gap-3" data-site-photos>
          {photos.map((photo, index) => (
            <li key={photo.full} className="w-28">
              <img src={photo.thumb || photo.full} alt="" className="h-28 w-28 rounded-lg border border-gray-100 object-contain" />
              <div className="mt-1 flex justify-between">
                <button type="button" aria-label="Лівіше" disabled={index === 0 || busy !== ''} onClick={() => void reorder(index, -1)} className="rounded p-1 text-gray-600 hover:bg-gray-100 disabled:opacity-30"><ArrowLeft size={14} /></button>
                <button type="button" aria-label="Прибрати" disabled={busy !== ''} onClick={() => void removePhoto(photo)} className="rounded p-1 text-red-600 hover:bg-red-50 disabled:opacity-30"><Trash2 size={14} /></button>
                <button type="button" aria-label="Правіше" disabled={index === photos.length - 1 || busy !== ''} onClick={() => void reorder(index, 1)} className="rounded p-1 text-gray-600 hover:bg-gray-100 disabled:opacity-30"><ArrowRight size={14} /></button>
              </div>
            </li>
          ))}
          <li>
            <label className="flex h-28 w-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-gray-200 text-xs text-gray-600 hover:bg-gray-50">
              <ImagePlus size={18} aria-hidden="true" />{busy === 'photos' ? 'Завантажуємо…' : 'Додати фото'}
              <input type="file" accept="image/*" multiple className="sr-only" disabled={busy !== ''} onChange={event => { void addPhotos([...(event.target.files ?? [])]); event.target.value = '' }} />
            </label>
          </li>
        </ul>
      </div>

      <label className="block">
        <span className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-gray-700">Опис на сайті
          <Button size="sm" variant="secondary" icon={<Sparkles size={14} />} loading={busy === 'ai'} onClick={() => void generate()}>Згенерувати ШІ</Button></span>
        <textarea rows={6} value={description} maxLength={6000} onChange={event => setDescription(event.target.value)} className={area} />
        <span className="mt-1 block text-xs text-gray-400">ШІ лише готує чернетку — на сайт вона потрапляє після вашого «Зберегти». Запит до ШІ платний, як у помічнику.</span>
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-gray-700">Характеристики</span>
        <textarea rows={5} value={specs} placeholder={'Вʼязкість: 5W-40\nОбʼєм: 4 л'} onChange={event => setSpecs(event.target.value)} className={area} />
        <span className="mt-1 block text-xs text-gray-400">Кожна з нового рядка: «назва: значення».</span>
      </label>
      <Input label="Заголовок для пошуковиків" value={seoTitle} maxLength={200} onChange={event => setSeoTitle(event.target.value)} />
      <Input label="Опис для пошуковиків" value={seoDescription} maxLength={400} onChange={event => setSeoDescription(event.target.value)} />
      <label className="flex cursor-pointer items-center gap-3 text-sm">
        <input type="checkbox" className="h-5 w-5 shrink-0 rounded border-gray-300 text-accent" checked={hidden} onChange={event => setHidden(event.target.checked)} data-site-hidden />
        <span className="font-medium text-gray-900">Сховати на сайті</span>
      </label>
      <Button icon={<Save size={14} />} loading={busy === 'save'} onClick={() => void save()}>Зберегти</Button>
    </div>
  )
}

/** Масове завантаження: файли в папці названі артикулом чи штрихкодом — програма сама знаходить товар. */
function BulkPhotos() {
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const stop = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.setAttribute('webkitdirectory', ''); return () => { stop.current = true } }, [])

  async function run(files: File[]) {
    const groups = groupPhotoFiles(files)
    if (!groups.size) { toast.error('У папці немає зображень'); return }
    if (!window.confirm(`Знайдено фото для ${groups.size} артикулів. Завантажити на сайт? Наявні фото цих товарів буде замінено новими.`)) return
    setBusy(true); stop.current = false
    const lines: string[] = []
    const say = (line: string) => { lines.push(line); setLog([...lines]) }
    let done = 0
    for (const [key, group] of groups) {
      if (stop.current) break
      try {
        const found = (await productApi.search(key, 10)).data as Found[]
        const product = exactProductMatch(key, found)
        if (!product) { say(`✗ ${key}: товар не знайдено за артикулом чи штрихкодом (або таких кілька)`); continue }
        const uploaded = await uploadProductPhotos(product.id, group)
        await siteCall('photos.attach', { program_product_id: product.id, photos: uploaded })
        done += 1
        say(`✓ ${key}: ${product.name} — фото: ${uploaded.length}`)
      } catch (reason) { say(`✗ ${key}: ${errorText(reason)}`) }
    }
    say(`Готово: товарів із фото — ${done} з ${groups.size}.`)
    setBusy(false)
  }

  return (
    <Card>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Фото з папки</h2>
      <p className="mb-3 text-xs text-gray-500">Назвіть файли артикулом або штрихкодом товару: «WB-1065.jpg». Кілька фото одного товару — «WB-1065_2.jpg», «WB-1065_3.jpg». Програма бере лише точний збіг.</p>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50">
        <FolderUp size={16} aria-hidden="true" />{busy ? 'Завантажуємо…' : 'Вибрати папку з фото'}
        <input ref={input} type="file" multiple className="sr-only" disabled={busy} onChange={event => { void run([...(event.target.files ?? [])]); event.target.value = '' }} />
      </label>
      {busy && <Button className="ml-2" size="sm" variant="secondary" onClick={() => { stop.current = true }}>Зупинити</Button>}
      {log.length > 0 && <ul className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-gray-100 p-2 text-xs text-gray-700" data-site-bulk-log>{log.map((line, index) => <li key={index} className="break-words py-0.5">{line}</li>)}</ul>}
    </Card>
  )
}

/** Фото, які сайт знайшов сам: головний ПК забирає їх раз на годину; тут — те саме кнопкою. */
function AutoPhotoImport() {
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const able = canImportSitePhotos()
  async function run() {
    setBusy(true)
    try {
      const result = await runSitePhotoImport()
      setText(result ? sitePhotoImportText(result) : 'Імпорт працює лише на головному ПК каси.')
    } catch (reason) { setText(errorText(reason, 'Не вдалося отримати фото із сайту')) } finally { setBusy(false) }
  }
  return (
    <Card>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Фото, які знайшов сайт</h2>
      <p className="mb-3 text-xs text-gray-500">Сайт сам шукає фото товарів і перевіряє їх. Головний ПК забирає їх раз на годину й ставить у картки, де фото ще немає. Своє фото програми не замінюється ніколи.</p>
      <Button variant="secondary" icon={<ImagePlus size={14} />} loading={busy} disabled={!able} onClick={() => void run()} data-site-auto-photos>Імпортувати зараз</Button>
      {!able && <p className="mt-2 text-xs text-gray-500">Кнопка працює на головному ПК каси: фото зберігаються в його базі.</p>}
      {text && <p role="status" className="mt-2 text-sm text-gray-700">{text}</p>}
    </Card>
  )
}

/** «Товари → Фото» (26.11.2026, власник: чітка ієрархія): усе масове про фото — в одному місці. Фото одного товару — у його картці. */
export function SitePhotosTab() {
  return (
    <div className="space-y-4" data-site-photos-tab>
      <BulkPhotos />
      <AutoPhotoImport />
    </div>
  )
}
