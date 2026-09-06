import { inventoryPage } from './inventoryPaging'

export function InventoryPager({ total, page, onChange }: { total: number; page: number; onChange: (page: number) => void }) {
  const range = inventoryPage(total, page)
  if (range.pages === 1) return null
  return <div className="flex items-center justify-between gap-2 border-t px-4 py-3 text-sm">
    <button type="button" disabled={range.page === 0} onClick={() => onChange(range.page - 1)} className="rounded border px-3 py-2 disabled:opacity-40">← Назад</button>
    <span>{range.start + 1}–{range.end} із {total}</span>
    <button type="button" disabled={range.page + 1 === range.pages} onClick={() => onChange(range.page + 1)} className="rounded border px-3 py-2 disabled:opacity-40">Далі →</button>
  </div>
}
