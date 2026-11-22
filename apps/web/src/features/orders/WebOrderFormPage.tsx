import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { useTillOnline } from '@/features/tillCommands/TillEditModal'
import { checkTillOrder, readOrderMoney, readOrderQty, TILL_ORDER_MAX_ITEMS, type TillOrderPayload } from '@/features/tillCommands/tillOrderModel'

type Row = { key: number; name: string; sku: string; qty: string; sell: string; buy: string; productId?: string; stock?: number }
type Found = { id: string; name: string; sku: string; retail_price: number; qty_on_hand: number }
type CommandState = { status: 'pending' | 'claimed' | 'done' | 'failed' | 'expired'; result: Record<string, unknown> | null; error: string | null }
const WAIT_MS = 20_000
const emptyRow = (key: number): Row => ({ key, name: '', sku: '', qty: '1', sell: '', buy: '' })
const errorText = (error: unknown) => (error as { message?: string })?.message || 'Не вдалося передати замовлення на касу'

/** Бланк із полів форми. Порожні рядки (без назви й артикула) пропускаються; помилка називає позицію. */
export function webOrderFromForm(form: { phone: string; name: string; make: string; model: string; year: string; vin: string; comment: string }, rows: Row[], author: string): TillOrderPayload {
  const filled = rows.filter(row => row.name.trim() || row.sku.trim())
  const year = form.year.trim()
  if (year && !/^\d{4}$/.test(year)) throw new Error('Перевірте рік автомобіля: чотири цифри.')
  return checkTillOrder({
    customer_phone: form.phone, customer_name: form.name, car_make: form.make, car_model: form.model,
    car_year: year ? Number(year) : null, vin: form.vin, comment: form.comment, author,
    items: filled.map((row, index) => {
      try {
        return { name: row.name, sku: row.sku, qty: readOrderQty(row.qty), sell_price: readOrderMoney(row.sell, 'Ціна продажу'),
          // Для товару зі складу закупку бере каса зі своєї картки; з вебу її не передаємо.
          ...(row.productId ? { product_id: row.productId } : { buy_price: readOrderMoney(row.buy, 'Закупка') }) }
      } catch (error) { throw new Error(`Позиція ${index + 1}: ${errorText(error)}`) }
    }),
  })
}

type Waiting = { operation_id: string; created_at: string; customer: string; items: number; state?: 'waiting' | 'failed' | 'expired'; error?: string | null }

/** Бланки з вебу, які ще чекають касу: щоб було видно, що вони не загубилися. Порожньо — нічого не показуємо. */
export function WaitingOrdersNote() {
  const [waiting, setWaiting] = useState<Waiting[] | null>(null)
  useEffect(() => {
    let stopped = false
    const load = () => api.get<{ data: Waiting[] }>('/api/v1/till-commands/waiting', { silent: true, timeoutMs: 10_000 })
      .then(res => { if (!stopped) setWaiting(Array.isArray(res.data) ? res.data : []) }).catch(() => { if (!stopped) setWaiting(null) })
    void load()
    const timer = window.setInterval(load, 20_000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [])
  if (!waiting?.length) return null
  const time = (value: string) => new Date(value).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
  const queued = waiting.filter(order => order.state !== 'failed' && order.state !== 'expired')
  const refused = waiting.filter(order => order.state === 'failed' || order.state === 'expired')
  return (
    <div className="mb-3 space-y-2">
      {queued.length > 0 && (
        <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-semibold">Чекають касу: {queued.length}</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {queued.map(order => <li key={order.operation_id}>{order.customer || 'Без імені'} · позицій: {order.items} · надіслано {time(order.created_at)}</li>)}
          </ul>
          <p className="mt-1 text-xs">Каса створить ці замовлення, щойно програма на ній буде в мережі.</p>
        </div>
      )}
      {refused.length > 0 && (
        <div role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-900">
          <p className="font-semibold">Не створено: {refused.length}</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {refused.map(order => (
              <li key={order.operation_id}>{order.customer || 'Без імені'} · надіслано {time(order.created_at)} — {order.state === 'expired'
                ? 'каса не забрала за 12 годин' : (order.error || 'каса відмовила')}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs">Ці бланки треба оформити ще раз. Запис зникне звідси за добу.</p>
        </div>
      )}
    </div>
  )
}

/**
 * Замовлення з телефона (веб) — етап 8. Бланк іде командою на касу; замовлення створює каса у своїй базі.
 * Грошей тут немає: передоплата й видача — на касі. Працює лише коли програма на касі в мережі.
 */
export default function WebOrderFormPage() {
  const navigate = useNavigate()
  const user = useAuthStore(state => state.session?.user)
  const till = useTillOnline(true)
  const [form, setForm] = useState({ phone: '', name: '', make: '', model: '', year: '', vin: '', comment: '' })
  const [rows, setRows] = useState<Row[]>([emptyRow(1)])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [done, setDone] = useState<{ number: string; total: number; queued?: boolean } | null>(null)
  const nextKey = useRef(2)
  // Той самий номер операції при повторі тієї самої відправки: подвійне натискання не дасть двох замовлень.
  const operation = useRef<{ id: string; body: string } | null>(null)

  const setField = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm(prev => ({ ...prev, [key]: event.target.value }))
  // Зміна назви чи артикула вручну відв’язує рядок від картки складу: інакше каса записала б інший товар, ніж бачить людина.
  const setRow = (key: number, field: 'name' | 'sku' | 'qty' | 'sell' | 'buy', value: string) => setRows(prev => prev.map(row => row.key !== key ? row
    : field === 'name' || field === 'sku' ? { ...row, [field]: value, productId: undefined, stock: undefined } : { ...row, [field]: value }))
  const [search, setSearch] = useState<{ key: number; state: 'loading' | 'ready' | 'error'; found: Found[] } | null>(null)
  const searchRun = useRef(0)
  async function findInStock(row: Row) {
    const query = (row.sku.trim() || row.name.trim())
    if (query.length < 2) { setMessage('Введіть назву або артикул (хоча б 2 символи), потім натисніть «Знайти на складі».'); return }
    const run = ++searchRun.current
    setSearch({ key: row.key, state: 'loading', found: [] })
    try {
      const { data } = await api.get<{ data: Found[] }>(`/api/v1/products/search?q=${encodeURIComponent(query)}&limit=8`, { silent: true, timeoutMs: 10_000 })
      if (run === searchRun.current) setSearch({ key: row.key, state: 'ready', found: Array.isArray(data) ? data : [] })
    } catch { if (run === searchRun.current) setSearch({ key: row.key, state: 'error', found: [] }) }
  }
  const pick = (key: number, product: Found) => {
    setRows(prev => prev.map(row => row.key === key ? { ...row, name: product.name, sku: product.sku ?? '', sell: (Number(product.retail_price) / 100).toFixed(2), buy: '',
      productId: product.id, stock: Number(product.qty_on_hand) } : row))
    setSearch(null)
  }

  let total = 0, totalKnown = true
  for (const row of rows) {
    if (!row.name.trim() && !row.sku.trim()) continue
    try { total += Math.round(readOrderQty(row.qty) * readOrderMoney(row.sell, 'Ціна продажу')) } catch { totalKnown = false }
  }

  async function waitForTill(operationId: string): Promise<CommandState> {
    const until = Date.now() + WAIT_MS
    while (Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      const { data } = await api.get<{ data: CommandState }>(`/api/v1/till-commands/${operationId}`, { silent: true, timeoutMs: 10_000 })
      if (data.status === 'done' || data.status === 'failed' || data.status === 'expired') return data
    }
    return { status: 'claimed', result: null, error: null }
  }

  async function submit() {
    if (busy) return
    setMessage('')
    let payload: TillOrderPayload
    try {
      payload = webOrderFromForm(form, rows, String(user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? '').trim())
    } catch (error) { setMessage(errorText(error)); return }
    const body = JSON.stringify(payload)
    if (operation.current?.body !== body) operation.current = { id: crypto.randomUUID(), body }
    const operationId = operation.current.id
    setBusy(true)
    try {
      const sent = await api.post<{ data: { status: string; till_online?: boolean } }>('/api/v1/till-commands', { operation_id: operationId, command: 'order.save', payload }, undefined, { silent: true, timeoutMs: 15_000 })
      // Каса не в мережі: бланк лежить на сервері й чекає її до 12 годин. Чекати відповідь зараз немає сенсу.
      if (sent.data.status === 'pending' && sent.data.till_online === false) { setDone({ number: '', total, queued: true }); return }
      const outcome = await waitForTill(operationId)
      if (outcome.status === 'done') {
        const number = outcome.result?.order_number == null ? '' : String(outcome.result.order_number)
        setDone({ number, total: Number(outcome.result?.total_amount ?? total) })
        toast.success('Замовлення створено на касі')
        return
      }
      // Відмова й прострочення означають, що каса нічого не записала: наступна спроба — нова операція.
      if (outcome.status === 'failed') { operation.current = null; setMessage(outcome.error || 'Каса відмовила. Замовлення не створено.'); return }
      if (outcome.status === 'expired') { operation.current = null; setMessage('Каса не забрала замовлення за 12 годин — його НЕ створено. Надішліть ще раз.'); return }
      // Каса ще не забрала або ще виконує: бланк не губиться — він чекає на сервері, дубля повтор не дасть.
      setDone({ number: '', total, queued: true })
    } catch (error) {
      setMessage(errorText(error))
    } finally { setBusy(false) }
  }

  if (done) return (
    <Layout title="Замовлення створено" onBack={() => navigate('/orders')}>
      <Card>
        <div className="space-y-3 p-4 text-center">
          {done.queued ? (
            <>
              <p className="text-lg font-semibold text-gray-900">Замовлення чекає касу</p>
              <p className="text-sm text-gray-600">Бланк збережено на сервері. Програма на касі забере його сама, щойно буде в мережі (чекаємо до 12 годин), і створить замовлення.</p>
              <p className="text-xs text-gray-500">Поки каса його не створила, у списку замовлень його немає — він видно в рядку «Чекають касу».</p>
            </>
          ) : (
            <>
              <p className="text-lg font-semibold text-gray-900">Замовлення{done.number ? ` № ${done.number}` : ''} створено на касі</p>
              <p className="text-sm text-gray-600">Сума: {formatMoney(done.total)}. Передоплату й видачу оформлюють на касі.</p>
              <p className="text-xs text-gray-500">У списку тут воно з’явиться, коли каса передасть дані на сервер (зазвичай до хвилини).</p>
            </>
          )}
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => { operation.current = null; setDone(null); setRows([emptyRow(nextKey.current++)]); setForm({ phone: '', name: '', make: '', model: '', year: '', vin: '', comment: '' }) }}>Ще одне</Button>
            <Button className="flex-1" variant="secondary" onClick={() => navigate('/orders')}>До списку</Button>
          </div>
        </div>
      </Card>
    </Layout>
  )

  return (
    <Layout title="Нове замовлення" onBack={() => navigate('/orders')}>
      <div className="mx-auto max-w-2xl space-y-3">
        <p className={`rounded-lg px-3 py-2 text-sm ${till?.online ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
          {till?.online ? 'Каса в мережі. Замовлення створить програма на касі; гроші приймає тільки каса.'
            : 'Каса не в мережі. Бланк можна надіслати зараз: він почекає на сервері до 12 годин, і каса створить замовлення, щойно з’явиться в мережі.'}
        </p>
        <Card>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Input label="Телефон клієнта" inputMode="tel" value={form.phone} disabled={busy} onChange={setField('phone')} placeholder="0671234567" />
            <Input label="Ім’я клієнта" value={form.name} disabled={busy} onChange={setField('name')} />
            <Input label="Марка авто" value={form.make} disabled={busy} onChange={setField('make')} />
            <Input label="Модель" value={form.model} disabled={busy} onChange={setField('model')} />
            <Input label="Рік" inputMode="numeric" value={form.year} disabled={busy} onChange={setField('year')} />
            <Input label="VIN" value={form.vin} disabled={busy} onChange={setField('vin')} />
            <div className="sm:col-span-2"><Input label="Коментар" value={form.comment} disabled={busy} onChange={setField('comment')} /></div>
          </div>
        </Card>
        {rows.map((row, index) => (
          <Card key={row.key}>
            <div className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700">Позиція {index + 1}</span>
                {rows.length > 1 && (
                  <button type="button" aria-label={`Прибрати позицію ${index + 1}`} disabled={busy} className="p-2 text-gray-400 hover:text-red-600"
                    onClick={() => setRows(prev => prev.filter(item => item.key !== row.key))}><Trash2 size={18} /></button>
                )}
              </div>
              <Input id={`order-row-${row.key}-name`} aria-label={`Назва, позиція ${index + 1}`} label="Назва" value={row.name} disabled={busy} onChange={event => setRow(row.key, 'name', event.target.value)} />
              {row.productId
                ? <p className="text-xs text-green-700">Товар зі складу{Number.isFinite(row.stock) ? ` · залишок за копією: ${row.stock}` : ''}. Назву, артикул і закупку каса візьме зі своєї картки.</p>
                : <button type="button" disabled={busy} onClick={() => { void findInStock(row) }} className="text-sm font-medium text-blue-700 underline">Знайти на складі</button>}
              {search?.key === row.key && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-2 text-sm">
                  {search.state === 'loading' && <p className="text-gray-500">Шукаю…</p>}
                  {search.state === 'error' && <p role="alert" className="text-amber-800">Пошук не вдався. Позицію можна залишити вписаною вручну.</p>}
                  {search.state === 'ready' && !search.found.length && <p className="text-gray-500">На складі не знайдено. Позиція піде як «під замовлення».</p>}
                  {search.found.map(product => (
                    <button key={product.id} type="button" onClick={() => pick(row.key, product)} className="block w-full rounded px-2 py-2 text-left hover:bg-white">
                      <span className="font-medium text-gray-900">{product.name}</span>
                      <span className="block text-xs text-gray-500">{product.sku} · {formatMoney(Number(product.retail_price))} · залишок {Number(product.qty_on_hand)}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Input id={`order-row-${row.key}-sku`} aria-label={`Артикул, позиція ${index + 1}`} label="Артикул" value={row.sku} disabled={busy} onChange={event => setRow(row.key, 'sku', event.target.value)} />
                <Input id={`order-row-${row.key}-qty`} aria-label={`Кількість, позиція ${index + 1}`} label="Кількість" inputMode="decimal" value={row.qty} disabled={busy} onChange={event => setRow(row.key, 'qty', event.target.value)} />
                <Input id={`order-row-${row.key}-sell`} aria-label={`Ціна продажу, грн, позиція ${index + 1}`} label="Ціна продажу, грн" inputMode="decimal" value={row.sell} disabled={busy} onChange={event => setRow(row.key, 'sell', event.target.value)} />
                {!row.productId && <Input id={`order-row-${row.key}-buy`} aria-label={`Закупка, грн, позиція ${index + 1}`} label="Закупка, грн" inputMode="decimal" value={row.buy} disabled={busy} onChange={event => setRow(row.key, 'buy', event.target.value)} />}
              </div>
            </div>
          </Card>
        ))}
        <Button variant="secondary" disabled={busy || rows.length >= TILL_ORDER_MAX_ITEMS} onClick={() => setRows(prev => [...prev, emptyRow(nextKey.current++)])}>
          <Plus size={16} className="mr-1 inline" />Додати позицію
        </Button>
        <p className="text-right text-sm text-gray-700">Разом: <span className="font-semibold">{totalKnown ? formatMoney(total) : 'перевірте кількість і ціни'}</span></p>
        {message && <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{message}</p>}
        <Button className="w-full" loading={busy} onClick={submit}>
          {busy ? 'Чекаю відповідь каси…' : till?.online ? 'Надіслати на касу' : 'Надіслати — каса забере пізніше'}
        </Button>
      </div>
    </Layout>
  )
}
