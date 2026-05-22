import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline' | 'danger-outline'
type Size = 'sm' | 'md' | 'lg'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: React.ReactNode
}

const VARIANTS: Record<Variant, string> = {
  primary:        'bg-accent hover:bg-accent-dark text-black font-semibold',
  secondary:      'bg-white border border-gray-200 text-gray-700 hover:border-gray-300 hover:bg-gray-50',
  danger:         'bg-red-500 hover:bg-red-600 text-white font-semibold',
  ghost:          'text-gray-600 hover:bg-gray-100',
  outline:        'bg-white border border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50',
  'danger-outline': 'bg-white border border-red-300 text-red-600 hover:bg-red-50 hover:border-red-400',
}

const SIZES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs rounded-lg',
  md: 'px-4 py-2.5 text-sm rounded-lg',
  lg: 'px-6 py-3 text-base rounded-xl min-h-[56px]',
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  children,
  disabled,
  className = '',
  ...props
}: Props) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={`
        inline-flex items-center justify-center gap-2 transition-colors
        disabled:opacity-50 disabled:cursor-not-allowed
        ${VARIANTS[variant]} ${SIZES[size]} ${className}
      `}
    >
      {loading ? (
        <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
      ) : icon}
      {children}
    </button>
  )
}
