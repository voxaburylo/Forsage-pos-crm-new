import { useState, useRef, useEffect, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'

export interface SplitAction {
  label: string
  onClick: () => void
  icon?: React.ReactNode
  danger?: boolean
}

interface Props {
  primaryLabel: React.ReactNode
  onPrimary: () => void
  actions: SplitAction[]
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Одна кнопка з головною дією + ▾ для решти варіантів.
 * Замінює «грона» з 3+ кнопок у рядку.
 */
export function SplitButton({ primaryLabel, onPrimary, actions, size = 'md', className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({})

  function updateMenuPosition() {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const width = 180
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))
    const top = Math.min(window.innerHeight - 8, rect.bottom + 4)
    setMenuStyle({ top, left, width })
  }

  useEffect(() => {
    if (!open) return
    updateMenuPosition()
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      window.removeEventListener('mousedown', handler)
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [open])

  const pad = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm'

  return (
    <div ref={ref} className={`relative inline-flex ${className}`}>
      <button
        onClick={onPrimary}
        className={`${pad} rounded-l-lg bg-blue-50 text-blue-600 hover:bg-blue-100 font-medium transition-colors`}
      >
        {primaryLabel}
      </button>
      <button
        onClick={() => { updateMenuPosition(); setOpen((v) => !v) }}
        aria-label="Більше дій"
        className={`${size === 'sm' ? 'px-1.5' : 'px-2'} rounded-r-lg bg-blue-50 text-blue-600 hover:bg-blue-100 border-l border-blue-200/60 transition-colors flex items-center`}
      >
        <ChevronDown size={size === 'sm' ? 13 : 15} />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div ref={menuRef} style={menuStyle} className="fixed z-[220] min-w-[160px] bg-white rounded-xl border border-gray-100 shadow-2xl py-1 animate-slide-up">
          {actions.map((a, i) => (
            <button
              key={i}
              onClick={() => { setOpen(false); a.onClick() }}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-50 transition-colors ${a.danger ? 'text-red-600' : 'text-gray-700'}`}
            >
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
