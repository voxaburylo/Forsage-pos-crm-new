import { useRef, useState } from 'react'
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

type Row = { key: number; name: string; sku: string; qty: string; sell: string; buy: string }
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
        return { name: row.name, sku: row.sku, qty: readOrderQty(row.qty), sell_price: readOrderMoney(row.sell, 'Ціна продажу'), buy_price: readOrderMoney(row.buy, 'Закупка') }
      } catch (error) { throw new Error(`Позиція ${index + 1}: ${errorText(error)}`) }
    }),
  })
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
  const [done, setDone] = useState<{ number: string; total: number } | null>(null)
  const nextKey = useRef(2)
  // Той самий номер операції при повторі тієї самої відправки: подвійне натискання не дасть двох замовлень.
  const operation = useRef<{ id: string; body: string } | null>(null)

  const setField = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm(prev => ({ ...prev, [key]: event.target.value }))
  const setRow = (key: number, field: keyof Omit<Row, 'key'>, value: string) => setRows(prev => prev.map(row => row.key === key ? { ...row, [field]: value } : row))

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
      await api.post('/api/v1/till-commands', { operation_id: operationId, command: 'order.save', payload }, undefined, { silent: true, timeoutMs: 15_000 })
      const outcome = await waitForTill(operationId)
      if (outcome.status === 'done') {
        const number = outcome.result?.order_number == null ? '' : String(outcome.result.order_number)
        setDone({ number, total: Number(outcome.result?.total_amount ?? total) })
        toast.success('Замовлення створено на касі')
        return
      }
      // Відмова й прострочення означають, що каса нічого не записала: наступна спроба — нова операція.
      if (outcome.status === 'failed') { operation.current = null; setMessage(outcome.error || 'Каса відмовила. Замовлення не створено.'); return }
      if (outcome.status === 'expired') { operation.current = null; setMessage('Каса не забрала замовлення вчасно — його НЕ створено. Перевірте, чи увімкнена програма на касі, і натисніть ще раз.'); return }
      setMessage('Каса ще не відповіла. Замовлення могло створитися — перевірте список замовлень за хвилину. Повторне натискання дубля не створить.')
    } catch (error) {
      setMessage(errorText(error))
    } finally { setBusy(false) }
  }

  if (done) return (
    <Layout title="Замовлення створено" onBack={() => navigate('/orders')}>
      <Card>
        <div className="space-y-3 p-4 text-center">
          <p className="text-lg font-semibold text-gray-900">Замовлення{done.number ? ` № ${done.number}` : ''} створено на касі</p>
          <p className="text-sm text-gray-600">Сума: {formatMoney(done.total)}. Передоплату й видачу оформлюють на касі.</p>
          <p className="text-xs text-gray-500">У списку тут воно з’явиться, коли каса передасть дані на сервер (зазвичай до хвилини).</p>
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
            : 'Каса не в мережі. Замовлення можна надіслати лише тоді, коли програма на касі увімкнена й має інтернет.'}
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
              <Input label="Назва" value={row.name} disabled={busy} onChange={event => setRow(row.key, 'name', event.target.value)} />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Input label="Артикул" value={row.sku} disabled={busy} onChange={event => setRow(row.key, 'sku', event.target.value)} />
                <Input label="Кількість" inputMode="decimal" value={row.qty} disabled={busy} onChange={event => setRow(row.key, 'qty', event.target.value)} />
                <Input label="Ціна продажу, грн" inputMode="decimal" value={row.sell} disabled={busy} onChange={event => setRow(row.key, 'sell', event.target.value)} />
                <Input label="Закупка, грн" inputMode="decimal" value={row.buy} disabled={busy} onChange={event => setRow(row.key, 'buy', event.target.value)} />
              </div>
            </div>
          </Card>
        ))}
        <Button variant="secondary" disabled={busy || rows.length >= TILL_ORDER_MAX_ITEMS} onClick={() => setRows(prev => [...prev, emptyRow(nextKey.current++)])}>
          <Plus size={16} className="mr-1 inline" />Додати позицію
        </Button>
        <p className="text-right text-sm text-gray-700">Разом: <span className="font-semibold">{totalKnown ? formatMoney(total) : 'перевірте кількість і ціни'}</span></p>
        {message && <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{message}</p>}
        <Button className="w-full" loading={busy} disabled={!till?.online} onClick={submit}>
          {busy ? 'Чекаю відповідь каси…' : till?.online ? 'Надіслати на касу' : 'Каса не в мережі'}
        </Button>
      </div>
    </Layout>
  )
}
