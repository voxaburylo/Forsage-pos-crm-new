import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'

interface Props {
  open: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
  title: string
  message?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Красная кнопка для деструктивных действий */
  danger?: boolean
}

export function ConfirmDialog({
  open, onClose, onConfirm,
  title, message,
  confirmLabel = 'Підтвердити',
  cancelLabel  = 'Скасувати',
  danger = false,
}: Props) {
  const [busy, setBusy] = useState(false)

  async function handleConfirm() {
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose() }} title={title} size="sm">
      <div className="space-y-4">
        {message && (
          <div className={`flex gap-3 p-3 rounded-lg ${danger ? 'bg-red-50 border border-red-200' : 'bg-gray-50 border border-gray-200'}`}>
            {danger && <AlertTriangle size={18} className="text-red-600 shrink-0 mt-0.5" />}
            <div className={`text-sm ${danger ? 'text-red-900' : 'text-gray-700'}`}>
              {message}
            </div>
          </div>
        )}
        <div className="flex gap-3">
          <Button
            type="button"
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={handleConfirm}
            className="flex-1"
          >
            {confirmLabel}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            {cancelLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
