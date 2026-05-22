interface Props {
  children: React.ReactNode
  className?: string
  padding?: 'none' | 'sm' | 'md' | 'lg'
  onClick?: React.MouseEventHandler<HTMLDivElement>
}

const PADDING = { none: '', sm: 'p-4', md: 'p-6', lg: 'p-8' }

export function Card({ children, className = '', padding = 'md', onClick }: Props) {
  return (
    <div onClick={onClick} className={`bg-white rounded-xl shadow-sm border border-gray-100 ${PADDING[padding]} ${className}`}>
      {children}
    </div>
  )
}
