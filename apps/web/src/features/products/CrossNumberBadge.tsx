import { Link2 } from 'lucide-react'

// Counts recorded cross numbers, not matching products or verified compatibility.
export function CrossNumberBadge({ count, onEdit }: { count?: number; onEdit: () => void }) {
  const known = typeof count === 'number' && Number.isFinite(count) && count >= 0
  const title = !known ? 'Кількість крос-номерів не завантажена. Відкрити картку'
    : count === 0 ? 'Крос-номери не заповнені. Натисніть, щоб додати'
      : `Записано крос-номерів: ${count}. Це не кількість товарів у наявності й не підтвердження сумісності. Відкрити картку`
  return <button type="button" onClick={onEdit} title={title} aria-label={title}
    className={`inline-flex items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-yellow-500 ${!known ? 'text-gray-400 bg-gray-50' : count === 0 ? 'text-red-400 bg-red-50 hover:bg-red-100' : 'text-slate-500 bg-slate-100 hover:bg-slate-200'}`}>
    <Link2 size={12} aria-hidden="true" /><span>{known ? count : '—'}</span>
  </button>
}
