import { useState, useRef, useEffect } from 'react'
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

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
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
        onClick={() => setOpen((v) => !v)}
        aria-label="Більше дій"
        className={`${size === 'sm' ? 'px-1.5' : 'px-2'} rounded-r-lg bg-blue-50 text-blue-600 hover:bg-blue-100 border-l border-blue-200/60 transition-colors flex items-center`}
      >
        <ChevronDown size={size === 'sm' ? 13 : 15} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[160px] bg-white rounded-xl border border-gray-100 shadow-lg py-1 animate-slide-up">
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
        </div>
      )}
    </div>
  )
}
