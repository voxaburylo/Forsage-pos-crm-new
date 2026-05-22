import { useState } from 'react'
import { usePOSStore } from '@/stores/posStore'
import { saleApi } from './saleApi'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

interface Props {
  open: boolean
  onClose: () => void
  onSuspended: () => void
}

const SUSPEND_TTL_HOURS = 24

export function SuspendModal({ open, onClose, onSuspended }: Props) {
  const store = usePOSStore()
  const [cell, setCell] = useState('')
  const [saving, setSaving] = useState(false)

  if (!open) return null

  async function handleSuspend() {
    const { currentShift, items, customer, notes, managerId } = store
    if (!currentShift || items.length === 0) return

    const expiresAt = new Date(Date.now() + SUSPEND_TTL_HOURS * 60 * 60 * 1000).toISOString()

    setSaving(true)
    try {
      await saleApi.suspend({
        shift_id:       currentShift.id,
        customer_id:    customer?.id ?? null,
        manager_id:     managerId,
        items:          items.map((i) => ({
          product_id: i.productId,
          qty:        i.qty,
          unit_price: i.unitPrice,
          discount:   i.discount,
        })),
        payment_method: 'cash',
        notes:          notes || undefined,
        pickup_cell:    cell.trim() || null,
        expires_at:     expiresAt,
      })
      store.clearReceipt()
      toast.success(`Чек відкладено${cell.trim() ? ' в ячейку ' + cell.trim() : ''}`)
      onSuspended()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full max-w-sm mx-4 p-6 space-y-4">
        <h2 className="text-white text-lg font-bold">Відкласти чек</h2>

        <p className="text-gray-400 text-sm">
          Чек на суму <span className="text-yellow-400 font-bold">{formatMoney(store.total)}</span> буде відкладено.
        </p>

        <div>
          <label className="text-gray-400 text-xs mb-1 block">
            Номер ячейки видачі <span className="text-gray-600">(необов'язково)</span>
          </label>
          <input type="text" autoFocus value={cell}
            onChange={(e) => setCell(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSuspend() }}
            placeholder="Напр. A-3, Стелаж 2..."
            className="w-full bg-[#2C2C2C] text-white text-lg rounded-xl px-4 py-3 border border-gray-700 focus:outline-none focus:border-yellow-400" />
        </div>

        <div className="flex gap-3 pt-2">
          <button onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-[#2C2C2C] text-gray-300 font-semibold hover:bg-gray-700 transition-colors">
            Скасувати
          </button>
          <button onClick={handleSuspend} disabled={saving}
            className="flex-1 py-3 rounded-xl bg-yellow-400 text-black font-bold hover:bg-yellow-300 disabled:opacity-40 transition-colors">
            {saving ? 'Відкладаємо...' : 'Відкласти'}
          </button>
        </div>
      </div>
    </div>
  )
}
