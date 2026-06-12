import { useEffect } from 'react'
import { X } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
  width?: 'sm' | 'md' | 'lg'
  footer?: React.ReactNode
}

const WIDTHS = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl' }

/**
 * Бічна панель справа — для перегляду/редагування в контексті списку.
 * Список лишається видимим ліворуч (на відміну від Modal, що перекриває центр).
 */
export function Drawer({ open, onClose, title, children, width = 'md', footer }: Props) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className={`absolute right-0 top-0 h-full w-full ${WIDTHS[width]} bg-white shadow-2xl flex flex-col animate-slide-left`}>
        {title !== undefined && (
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 bg-white/80 backdrop-blur-md shrink-0">
            <div className="text-base font-semibold text-gray-900 min-w-0">{title}</div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors p-1 shrink-0" aria-label="Закрити">
              <X size={20} />
            </button>
          </div>
        )}
        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && (
          <div className="px-5 py-3 border-t border-gray-100 bg-white/80 backdrop-blur-md shrink-0">{footer}</div>
        )}
      </div>
    </div>
  )
}
