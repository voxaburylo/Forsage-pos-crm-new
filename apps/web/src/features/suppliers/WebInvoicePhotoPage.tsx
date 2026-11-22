import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Camera, Plus, Trash2 } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { useTillOnline } from '@/features/tillCommands/TillEditModal'
import { WaitingOrdersNote } from '@/features/orders/WebOrderFormPage'
import { PHONE_INVOICE_MAX_ROWS, phoneInvoiceGaps, phoneInvoiceTotal, type PhoneInvoicePayload } from '@/features/tillCommands/phoneInvoiceModel'
import { WEB_INVOICE_MAX_PHOTOS, recognizeInvoicePhotos, webInvoiceFromForm, type WebInvoiceRow } from './webInvoicePhoto'

type CommandState = { status: 'pending' | 'claimed' | 'done' | 'failed' | 'expired'; result: Record<string, unknown> | null; error: string | null }
const WAIT_MS = 20_000
const emptyRow = (key: number): WebInvoiceRow => ({ key, name: '', sku: '', qty: '', price: '', extra: {} })
const errorText = (error: unknown, fallback: string) => (error as { message?: string })?.message || fallback
const emptyForm = { supplier: '', number: '', notes: '' }

/** Чекаємо відповідь каси до 20 с; довше — накладна лишається в черзі на сервері. */
async function waitForTill(operationId: string): Promise<CommandState> {
  const until = Date.now() + WAIT_MS
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 1500))
    const { data } = await api.get<{ data: CommandState }>(`/api/v1/till-commands/${operationId}`, { silent: true, timeoutMs: 10_000 })
    if (data.status === 'done' || data.status === 'failed' || data.status === 'expired') return data
  }
  return { status: 'claimed', result: null, error: null }
}

/**
 * Накладна з телефона (веб) — етап 8, 22.11.2026. Фото розпізнає помічник, людина перевіряє рядки й надсилає їх на касу.
 * Тут нічого не проводиться й не змінює залишки: каса кладе рядки у «З телефона», а проводить людина на касі.
 */
export default function WebInvoicePhotoPage() {
  const navigate = useNavigate()
  const user = useAuthStore(state => state.session?.user)
  const till = useTillOnline(true)
  const [form, setForm] = useState(emptyForm)
  const [rows, setRows] = useState<WebInvoiceRow[]>([])
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [note, setNote] = useState('')
  const [done, setDone] = useState<{ rows: number; queued: boolean } | null>(null)
  const [waitingReload, setWaitingReload] = useState(0)
  const nextKey = useRef(1)
  const fileInput = useRef<HTMLInputElement>(null)
  // Той самий номер операції при повторі тієї самої відправки: подвійне натискання не дасть двох накладних на касі.
  const operation = useRef<{ id: string; body: string } | null>(null)
  const locked = reading || busy

  const setField = (key: keyof typeof emptyForm) => (event: { target: { value: string } }) => setForm(prev => ({ ...prev, [key]: event.target.value }))
  const setRow = (key: number, field: 'name' | 'sku' | 'qty' | 'price', value: string) => setRows(prev => prev.map(row => row.key === key ? { ...row, [field]: value } : row))

  async function readPhotos(list: FileList | null) {
    const files = list ? Array.from(list) : []
    if (fileInput.current) fileInput.current.value = ''
    if (!files.length || locked) return
    setMessage(''); setNote(''); setReading(true)
    try {
      const found = await recognizeInvoicePhotos(files)
      if (!found.rows.length) { setMessage('На фото не знайдено товарних рядків. Спробуйте чіткіше фото або впишіть рядки вручну.'); return }
      const added = found.rows.map(row => ({ ...row, key: nextKey.current++ }))
      setRows(prev => [...prev, ...added])
      // Постачальника й номер беремо з фото лише в порожні поля: вписане людиною не перезаписуємо.
      setForm(prev => ({ ...prev, supplier: prev.supplier.trim() ? prev.supplier : found.supplier, number: prev.number.trim() ? prev.number : found.number }))
      setNote(`Розпізнано рядків: ${added.length}.${found.skipped ? ` Без назви пропущено: ${found.skipped} — звірте з папером.` : ''} Перевірте кількість і ціни перед відправкою.`)
    } catch (error) {
      setMessage(errorText(error, 'Не вдалося розпізнати фото. Рядки можна вписати вручну.'))
    } finally { setReading(false) }
  }

  let payload: PhoneInvoicePayload | null = null, formError = ''
  try { payload = webInvoiceFromForm(form, rows, String(user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? '').trim()) }
  catch (error) { formError = errorText(error, 'Перевірте рядки накладної.') }
  const gaps = payload ? phoneInvoiceGaps(payload.rows) : 0

  async function submit() {
    if (locked) return
    setMessage('')
    if (!payload) { setMessage(formError); return }
    const body = JSON.stringify(payload)
    if (operation.current?.body !== body) operation.current = { id: crypto.randomUUID(), body }
    const operationId = operation.current.id
    setBusy(true)
    try {
      const sent = await api.post<{ data: { status: string; till_online?: boolean } }>('/api/v1/till-commands', { operation_id: operationId, command: 'invoice.draft', payload }, undefined, { silent: true, timeoutMs: 20_000 })
      if (sent.data.status === 'pending' && sent.data.till_online === false) { setDone({ rows: payload.rows.length, queued: true }); return }
      const outcome = await waitForTill(operationId)
      if (outcome.status === 'done') { setDone({ rows: payload.rows.length, queued: false }); toast.success('Накладна на касі'); return }
      // Відмова й прострочення означають, що на касі нічого не з’явилось: наступна спроба — нова операція.
      if (outcome.status === 'failed') { operation.current = null; setMessage(outcome.error || 'Каса відмовила. Накладна до неї не потрапила.'); return }
      if (outcome.status === 'expired') { operation.current = null; setMessage('Каса не забрала накладну за 12 годин — вона до неї НЕ потрапила. Надішліть ще раз.'); return }
      setDone({ rows: payload.rows.length, queued: true })
    } catch (error) {
      setMessage(errorText(error, 'Не вдалося передати накладну на касу'))
    } finally { setBusy(false); setWaitingReload(value => value + 1) }
  }

  function startOver() {
    operation.current = null
    setDone(null); setRows([]); setForm(emptyForm); setMessage(''); setNote('')
  }

  if (done) return (
    <Layout title="Накладна з телефона" onBack={() => navigate('/products')}>
      <div className="mx-auto max-w-2xl">
        <Card>
          <div className="space-y-3 p-4 text-center">
            {done.queued ? (
              <>
                <p className="text-lg font-semibold text-gray-900">Накладна чекає касу</p>
                <p className="text-sm text-gray-600">Рядки збережено на сервері ({done.rows}). Програма на касі забере їх сама, щойно буде в мережі (чекаємо до 12 годин).</p>
              </>
            ) : (
              <>
                <p className="text-lg font-semibold text-gray-900">Накладна на касі</p>
                <p className="text-sm text-gray-600">Рядків: {done.rows}. На касі відкрийте «Поступлення товарів» → блок «З телефона» → «Відкрити», перевірте й натисніть «Провести».</p>
              </>
            )}
            <p className="text-xs text-gray-500">Залишки зміняться лише після проведення накладної на касі.</p>
            <Button className="w-full" onClick={startOver}>Ще одна накладна</Button>
          </div>
        </Card>
      </div>
    </Layout>
  )

  return (
    <Layout title="Накладна з телефона" onBack={() => navigate('/products')}>
      <div className="mx-auto max-w-2xl space-y-3">
        <p className={`rounded-lg px-3 py-2 text-sm ${till?.online ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
          {till?.online ? 'Каса в мережі. Накладна ляже в «Поступлення товарів → З телефона»; проводить її людина на касі.'
            : 'Каса не в мережі. Накладну можна надіслати зараз: вона почекає на сервері до 12 годин.'}
        </p>
        <WaitingOrdersNote key={waitingReload} kind="invoice" />
        <Card>
          <div className="space-y-3 p-4">
            <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" aria-label="Фото накладної"
              onChange={event => { void readPhotos(event.target.files) }} />
            <Button className="w-full" loading={reading} disabled={locked} onClick={() => fileInput.current?.click()}>
              <Camera size={16} className="mr-1 inline" />{reading ? 'Розпізнаю фото…' : rows.length ? 'Додати ще фото' : 'Сфотографувати або вибрати фото'}
            </Button>
            <p className="text-xs text-gray-500">До {WEB_INVOICE_MAX_PHOTOS} фото за раз. Розпізнавання платне (ключ помічника з налаштувань) і триває до трьох хвилин. Рядки можна вписати й вручну.</p>
            {note && <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">{note}</p>}
          </div>
        </Card>
        <Card>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Input label="Постачальник" value={form.supplier} disabled={locked} onChange={setField('supplier')} />
            <Input label="Номер накладної" value={form.number} disabled={locked} onChange={setField('number')} />
            <div className="sm:col-span-2"><Input label="Примітка для каси" value={form.notes} disabled={locked} onChange={setField('notes')} /></div>
          </div>
        </Card>
        {rows.map((row, index) => (
          <Card key={row.key}>
            <div className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700">Рядок {index + 1}{row.extra.brand_name ? ` · ${row.extra.brand_name}` : ''}</span>
                <button type="button" aria-label={`Прибрати рядок ${index + 1}`} disabled={locked} className="p-2 text-gray-400 hover:text-red-600"
                  onClick={() => setRows(prev => prev.filter(item => item.key !== row.key))}><Trash2 size={18} /></button>
              </div>
              <Input id={`invoice-row-${row.key}-name`} aria-label={`Назва, рядок ${index + 1}`} label="Назва" value={row.name} disabled={locked} onChange={event => setRow(row.key, 'name', event.target.value)} />
              <div className="grid grid-cols-3 gap-2">
                <Input id={`invoice-row-${row.key}-sku`} aria-label={`Артикул, рядок ${index + 1}`} label="Артикул" value={row.sku} disabled={locked} onChange={event => setRow(row.key, 'sku', event.target.value)} />
                <Input id={`invoice-row-${row.key}-qty`} aria-label={`Кількість, рядок ${index + 1}`} label="Кількість" inputMode="decimal" value={row.qty} disabled={locked} onChange={event => setRow(row.key, 'qty', event.target.value)} />
                <Input id={`invoice-row-${row.key}-price`} aria-label={`Закупка, грн, рядок ${index + 1}`} label="Закупка, грн" inputMode="decimal" value={row.price} disabled={locked} onChange={event => setRow(row.key, 'price', event.target.value)} />
              </div>
              {(!row.qty.trim() || !row.price.trim()) && <p className="text-xs text-amber-700">Немає кількості або ціни — впишіть із паперу, інакше касі доведеться виправляти рядок.</p>}
            </div>
          </Card>
        ))}
        <Button variant="secondary" disabled={locked || rows.length >= PHONE_INVOICE_MAX_ROWS} onClick={() => setRows(prev => [...prev, emptyRow(nextKey.current++)])}>
          <Plus size={16} className="mr-1 inline" />Додати рядок вручну
        </Button>
        {payload && (
          <p className="text-right text-sm text-gray-700">Рядків: {payload.rows.length} · разом за закупкою: <span className="font-semibold">{formatMoney(phoneInvoiceTotal(payload.rows))}</span>
            {gaps > 0 && <span className="block text-xs text-amber-700">Без кількості або ціни: {gaps}. Звірте суму з папером.</span>}
          </p>
        )}
        {message && <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{message}</p>}
        <Button className="w-full" loading={busy} disabled={locked || !rows.length} onClick={submit}>
          {busy ? 'Чекаю відповідь каси…' : till?.online ? 'Надіслати на касу' : 'Надіслати — каса забере пізніше'}
        </Button>
      </div>
    </Layout>
  )
}
