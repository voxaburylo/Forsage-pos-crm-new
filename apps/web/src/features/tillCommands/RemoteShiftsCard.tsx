import { useRef, useState } from 'react'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'
import { hryvniaToKopecks } from '@/types/product'
import { useTillOnline } from './TillEditModal'

export type RemoteShift = { id: string; cashier_id: string; cashier_name: string | null; opened_at: string; expected_cash: number }
type CommandState = { status: 'pending' | 'claimed' | 'done' | 'failed' | 'expired'; result: Record<string, unknown> | null; error: string | null }
const WAIT_MS = 20_000

async function runTillCommand(operationId: string, command: string, payload: Record<string, unknown>): Promise<CommandState> {
  await api.post('/api/v1/till-commands', { operation_id: operationId, command, payload }, undefined, { silent: true, timeoutMs: 15_000 })
  const until = Date.now() + WAIT_MS
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 1500))
    const { data } = await api.get<{ data: CommandState }>(`/api/v1/till-commands/${operationId}`, { silent: true, timeoutMs: 10_000 })
    if (data.status === 'done' || data.status === 'failed' || data.status === 'expired') return data
  }
  return { status: 'claimed', result: null, error: null }
}

/** Відповідь каси на shift.list: лише коректні рядки, інакше — помилка, а не «змін немає». */
export function parseRemoteShifts(result: Record<string, unknown> | null): RemoteShift[] {
  const rows = result?.shifts
  if (!Array.isArray(rows)) throw new Error('Каса відповіла без списку змін. Оновіть програму на касі.')
  return rows.map(row => {
    const shift = row as Partial<RemoteShift>
    if (typeof shift.id !== 'string' || typeof shift.cashier_id !== 'string' || typeof shift.opened_at !== 'string'
      || !Number.isSafeInteger(shift.expected_cash)) throw new Error('Каса повернула пошкоджений список змін')
    return { id: shift.id, cashier_id: shift.cashier_id, cashier_name: typeof shift.cashier_name === 'string' ? shift.cashier_name : null,
      opened_at: shift.opened_at, expected_cash: Number(shift.expected_cash) }
  })
}

const failure = (state: CommandState, fallback: string) => state.status === 'failed' ? (state.error || fallback)
  : state.status === 'expired' ? 'Каса не забрала команду вчасно — нічого не змінено. Перевірте, чи увімкнена програма на касі.'
    : 'Каса ще не відповіла. Оновіть список за хвилину, перш ніж повторювати.'

/**
 * 21.11.2026 (прохання власника): закрити незакриту зміну з вебу, коли головна каса в мережі.
 * Зміну закриває сама каса у своїй базі — так само, як власник закрив би її на касі.
 */
export function RemoteShiftsCard() {
  const till = useTillOnline(true)
  const [shifts, setShifts] = useState<RemoteShift[] | null>(null)
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string>('')
  const [message, setMessage] = useState('')
  const closeOperations = useRef<Record<string, string>>({})

  async function load() {
    setBusy('list'); setMessage('')
    try {
      const state = await runTillCommand(crypto.randomUUID(), 'shift.list', {})
      if (state.status !== 'done') { setMessage(failure(state, 'Каса не змогла показати зміни')); return }
      const list = parseRemoteShifts(state.result)
      setShifts(list)
      setAmounts(Object.fromEntries(list.map(shift => [shift.id, (shift.expected_cash / 100).toFixed(2)])))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не вдалося запитати зміни в каси')
    } finally { setBusy('') }
  }

  async function close(shift: RemoteShift) {
    let actual: number
    if (!(amounts[shift.id] ?? '').trim()) { setMessage('Вкажіть, скільки готівки в касі'); return }
    try { actual = hryvniaToKopecks(amounts[shift.id] ?? '') } catch (error) { setMessage(error instanceof Error ? error.message : 'Некоректна сума'); return }
    const name = shift.cashier_name || 'касира'
    if (!window.confirm(`Закрити зміну ${name}? Готівка в касі: ${formatMoney(actual)}. Очікується: ${formatMoney(shift.expected_cash)}.`)) return
    // Той самий номер операції при повторі: подвійне натискання не закриє зміну двічі.
    const operationId = closeOperations.current[shift.id] ||= crypto.randomUUID()
    setBusy(shift.id); setMessage('')
    try {
      const state = await runTillCommand(operationId, 'shift.close', {
        shift_id: shift.id, cashier_id: shift.cashier_id, actual_amount: actual, comment: 'Закрито власником з вебу',
      })
      if (state.status === 'done') {
        toast.success(`Зміну ${name} закрито на касі`)
        setShifts(prev => prev?.filter(item => item.id !== shift.id) ?? null)
        delete closeOperations.current[shift.id]
        return
      }
      if (state.status !== 'claimed') delete closeOperations.current[shift.id]
      setMessage(failure(state, 'Каса не закрила зміну'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не вдалося передати команду на касу')
    } finally { setBusy('') }
  }

  const online = till?.online === true
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-bold text-gray-900">Відкриті зміни на касі</h3>
          <p className="text-xs text-gray-500">{online ? 'Каса в мережі: зміну закриє програма на касі у своїй базі.' : 'Каса не в мережі — закрити зміну з вебу можна, коли програма на головному ПК увімкнена.'}</p>
        </div>
        <Button size="sm" variant="secondary" disabled={!online || Boolean(busy)} loading={busy === 'list'} onClick={() => void load()}>
          {shifts ? 'Оновити' : 'Показати зміни'}
        </Button>
      </div>
      {message && <p role="alert" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{message}</p>}
      {shifts && shifts.length === 0 && <p className="mt-3 text-sm text-gray-500">Відкритих змін немає.</p>}
      {shifts && shifts.length > 0 && (
        <ul className="mt-3 divide-y divide-gray-100">
          {shifts.map(shift => (
            <li key={shift.id} className="flex flex-wrap items-end gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-gray-900">{shift.cashier_name || 'Касир'}</div>
                <div className="text-xs text-gray-500">Відкрито {new Date(shift.opened_at).toLocaleString('uk-UA')} · очікується {formatMoney(shift.expected_cash)}</div>
              </div>
              <label className="text-xs text-gray-600">Готівка в касі, грн
                <input inputMode="decimal" value={amounts[shift.id] ?? ''} disabled={Boolean(busy)}
                  onChange={event => setAmounts(prev => ({ ...prev, [shift.id]: event.target.value }))}
                  className="mt-1 block w-32 rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
              </label>
              <Button size="sm" disabled={!online || Boolean(busy)} loading={busy === shift.id} onClick={() => void close(shift)}>Закрити зміну</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
