import { useState } from 'react'
import { ArrowDownCircle, ArrowUpCircle } from 'lucide-react'
import { cashOperationApi } from './cashOperationApi'
import type { CashOperationType } from '@/types/cashOperation'
import { Modal, Button, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

interface Props {
  open:    boolean
  shiftId: string
  onClose: () => void
}

export function CashOperationModal({ open, shiftId, onClose }: Props) {
  const [type, setType]       = useState<CashOperationType>('in')
  const [amount, setAmount]   = useState('')
  const [note, setNote]       = useState('')
  const [saving, setSaving]   = useState(false)

  function reset() {
    setAmount('')
    setNote('')
    setType('in')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const kopecks = Math.round(parseFloat(amount || '0') * 100)
    if (kopecks <= 0) { toast.error('Введіть суму більше 0'); return }

    setSaving(true)
    try {
      await cashOperationApi.create(shiftId, type, kopecks, note.trim() || undefined)
      const label = type === 'in' ? 'Внесення' : 'Виймання'
      toast.success(label + ' ' + formatMoney(kopecks) + ' записано')
      reset()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Готівкова операція" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Тип операції */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setType('in')}
            className={
              'flex flex-col items-center gap-2 py-4 rounded-xl border-2 transition-colors ' +
              (type === 'in'
                ? 'border-green-400 bg-green-50 text-green-700'
                : 'border-gray-200 text-gray-500 hover:border-gray-300')
            }
          >
            <ArrowDownCircle size={28} />
            <span className="text-sm font-semibold">Внесення</span>
            <span className="text-xs opacity-70">Додати готівку в касу</span>
          </button>

          <button
            type="button"
            onClick={() => setType('out')}
            className={
              'flex flex-col items-center gap-2 py-4 rounded-xl border-2 transition-colors ' +
              (type === 'out'
                ? 'border-red-400 bg-red-50 text-red-700'
                : 'border-gray-200 text-gray-500 hover:border-gray-300')
            }
          >
            <ArrowUpCircle size={28} />
            <span className="text-sm font-semibold">Виймання</span>
            <span className="text-xs opacity-70">Вийняти готівку з каси</span>
          </button>
        </div>

        {/* Сума */}
        <Input
          label="Сума (грн) *"
          type="number"
          min="0.01"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          autoFocus
          required
        />

        {/* Примітка */}
        <Input
          label="Примітка"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Напр.: Власник взяв виручку"
        />

        <div className="flex gap-3 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Скасувати
          </Button>
          <Button
            type="submit"
            loading={saving}
            className={
              'flex-1 ' +
              (type === 'out' ? 'bg-red-500 hover:bg-red-400 text-white' : '')
            }
          >
            {type === 'in' ? 'Внести' : 'Вийняти'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
