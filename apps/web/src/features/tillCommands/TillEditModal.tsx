import { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { hryvniaToKopecks, type Product } from '@/types/product'
import { buildTillUpdate, cardFields, type TillProductFields } from './tillCommandModel'

type Status = { online: boolean; seen_at: string | null }
type CommandState = { status: 'pending' | 'claimed' | 'done' | 'failed' | 'expired'; error: string | null }
// 22.11.2026: каса питає сервер раз на 30 с (плюс сигнал одразу); чекаємо довше за строк життя команди (45 с).
const WAIT_MS = 50_000

const errorText = (error: unknown) => (error as { message?: string })?.message || 'Не вдалося передати зміну на касу'

/** Чи каса в мережі: кнопку «Змінити через касу» показуємо лише тоді. */
export function useTillOnline(enabled: boolean): Status | null {
  const [status, setStatus] = useState<Status | null>(null)
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    const load = () => api.get<{ data: Status }>('/api/v1/till-commands/status', { silent: true, timeoutMs: 10_000 })
      .then(res => { if (!stopped) setStatus(res.data) }).catch(() => { if (!stopped) setStatus(null) })
    void load()
    const timer = window.setInterval(load, 15_000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [enabled])
  return status
}

/**
 * Правка картки з вебу: зміну виконує каса у своїй базі (без черги). Чекаємо відповідь до 20 с;
 * якщо каса не забрала команду за 30 с, вона не виконається ніколи — працівник бачить це прямо.
 */
export function TillEditModal({ product, open, onClose, onSaved }: { product: Product; open: boolean; onClose: () => void; onSaved: (changes: TillProductFields) => void }) {
  const [form, setForm] = useState({ name: '', sku: '', barcode: '', retail: '', storage_bin: '', notes: '' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const operation = useRef<string>('')

  useEffect(() => {
    if (!open) return
    operation.current = ''
    setMessage('')
    setForm({ name: product.name, sku: product.sku, barcode: product.barcode ?? '', retail: (product.retail_price / 100).toFixed(2),
      storage_bin: product.storage_bin ?? '', notes: product.notes ?? '' })
  }, [open, product])

  async function waitForTill(operationId: string): Promise<CommandState> {
    const until = Date.now() + WAIT_MS
    while (Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      const { data } = await api.get<{ data: CommandState }>(`/api/v1/till-commands/${operationId}`, { silent: true, timeoutMs: 10_000 })
      if (data.status === 'done' || data.status === 'failed' || data.status === 'expired') return data
    }
    return { status: 'claimed', error: null }
  }

  async function submit() {
    setMessage('')
    let retail: number
    try { retail = hryvniaToKopecks(form.retail) } catch (error) { setMessage(errorText(error)); return }
    const update = buildTillUpdate(product.id, product, {
      name: form.name, sku: form.sku, barcode: form.barcode || null, retail_price: retail, storage_bin: form.storage_bin || null, notes: form.notes || null,
    })
    if (!update) { onClose(); return }
    // Той самий номер операції при повторі: подвійне натискання не дасть двох змін.
    operation.current ||= crypto.randomUUID()
    setBusy(true)
    try {
      await api.post('/api/v1/till-commands', { operation_id: operation.current, command: 'product.update', payload: update }, undefined, { silent: true, timeoutMs: 15_000 })
      const outcome = await waitForTill(operation.current)
      if (outcome.status === 'done') { toast.success('Збережено на касі'); onSaved(update.changes); onClose(); return }
      if (outcome.status === 'failed') { operation.current = ''; setMessage(outcome.error || 'Каса відмовила у зміні'); return }
      if (outcome.status === 'expired') { operation.current = ''; setMessage('Каса не забрала зміну вчасно — її НЕ внесено. Перевірте, чи увімкнена програма на касі, і спробуйте ще раз.'); return }
      setMessage('Каса ще не відповіла. Зміна могла записатися — оновіть картку за хвилину й перевірте, перш ніж повторювати.')
    } catch (error) {
      setMessage(errorText(error))
    } finally { setBusy(false) }
  }

  const field = (key: keyof typeof form, label: string) => (
    <Input label={label} value={form[key]} disabled={busy} onChange={event => setForm(prev => ({ ...prev, [key]: event.target.value }))} />
  )
  const changed = buildTillUpdate(product.id, product, { ...cardFields(product), name: form.name, sku: form.sku, barcode: form.barcode || null,
    retail_price: (() => { try { return hryvniaToKopecks(form.retail) } catch { return -1 } })(), storage_bin: form.storage_bin || null, notes: form.notes || null })
  return (
    <Modal open={open} onClose={() => { if (!busy) onClose() }} title="Змінити картку через касу">
      <div className="space-y-3">
        <p className="text-xs text-slate-600">Зміну виконає програма на касі у своїй базі. Залишки, закупка, продажі й оплати змінюються лише на касі.</p>
        {field('name', 'Назва')}
        {field('sku', 'Артикул')}
        {field('barcode', 'Штрихкод')}
        {field('retail', 'Ціна продажу, грн')}
        {field('storage_bin', 'Комірка')}
        {field('notes', 'Примітка')}
        {message && <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{message}</p>}
        <div className="flex gap-2">
          <Button className="flex-1" loading={busy} disabled={!changed} onClick={submit}>{busy ? 'Чекаю відповідь каси…' : 'Зберегти через касу'}</Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Скасувати</Button>
        </div>
      </div>
    </Modal>
  )
}
