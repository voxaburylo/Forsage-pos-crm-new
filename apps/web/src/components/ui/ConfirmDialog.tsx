import { useScopedAction } from '@/hooks/useScopedAction'
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'

interface Props {
  open: boolean
  onClose: () => void
  onConfirm: () => void | boolean | Promise<void | boolean>
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
  const action = useScopedAction(String(open))
  const busy = action.busy
  const [error, setError] = useState('')
  useEffect(() => { setError('') }, [open])

  async function handleConfirm() {
    const attempt = action.begin()
    if (!attempt) return
    setError('')
    try {
      const result = await onConfirm()
      if (attempt.isCurrent() && result !== false) onClose()
    } catch (error) {
      if (attempt.isCurrent()) setError(error instanceof Error ? error.message : 'Не вдалося виконати дію. Спробуйте ще раз.')
    } finally {
      attempt.finish()
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!action.isBusy()) onClose() }} title={title} size="sm">
      <div className="space-y-4">
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
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
            onClick={() => { if (!action.isBusy()) onClose() }}
          >
            {cancelLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
