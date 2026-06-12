// Кістякові заглушки замість тексту «Завантаження…» — відчуття швидкості.
interface SkeletonProps {
  className?: string
}

/** Базовий блок-привид із мерехтінням. */
export function Skeleton({ className = '' }: SkeletonProps) {
  return <div className={`animate-shimmer rounded bg-gray-200/80 ${className}`} />
}

/** Рядки-привиди для таблиць. */
export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-gray-50">
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-4 py-3">
              <Skeleton className={`h-4 ${c === 0 ? 'w-3/4' : c === cols - 1 ? 'w-12 ml-auto' : 'w-1/2'}`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}
