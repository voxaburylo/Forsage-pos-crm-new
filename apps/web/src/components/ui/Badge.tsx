type Color = 'green' | 'orange' | 'red' | 'blue' | 'gray' | 'yellow'

interface Props {
  color?: Color
  children: React.ReactNode
  className?: string
}

const COLORS: Record<Color, string> = {
  green:  'bg-green-100 text-green-700',
  orange: 'bg-orange-100 text-orange-700',
  red:    'bg-red-100 text-red-700',
  blue:   'bg-blue-100 text-blue-700',
  gray:   'bg-gray-100 text-gray-600',
  yellow: 'bg-yellow-100 text-yellow-800',
}

export function Badge({ color = 'gray', children, className = '' }: Props) {
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${COLORS[color]} ${className}`}>
      {children}
    </span>
  )
}
