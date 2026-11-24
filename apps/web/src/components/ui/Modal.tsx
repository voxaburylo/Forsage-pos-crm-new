import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useDialogEscape } from '@/hooks/useDialogEscape'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-5xl' }

export function Modal({ open, onClose, title, children, size = 'md' }: Props) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogEscape(open, onClose)

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? []).filter((element) => element.offsetParent !== null)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', handler)
    window.setTimeout(() => {
      const preferred = dialogRef.current?.querySelector<HTMLElement>('[autofocus], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])')
      preferred?.focus()
    }, 0)
    return () => {
      window.removeEventListener('keydown', handler)
      previouslyFocused?.focus()
    }
  }, [open])

  if (!open) return null

  // 24.11.2026: вікно малюється прямо в body, а не всередині робочої області. На телефоні (Safari/Chrome iOS)
  // область із власною прокруткою обрізає «fixed»-вікно: шапка з хрестиком ховалась під верхню панель (фото власника).
  // Відступи — з урахуванням вирізів екрана, щоб хрестик і низ вікна не потрапляли під панелі телефона.
  return createPortal(
    <div className="modal-layer fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3 sm:p-4" data-modal-layer>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative bg-white rounded-2xl shadow-xl w-full ${SIZES[size]} animate-slide-up flex flex-col max-h-full`}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 shrink-0">
          <h2 id={titleId} className="text-base font-semibold text-gray-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1"
            aria-label="Закрити"
            title="Закрити"
          >
            <X size={20} />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
