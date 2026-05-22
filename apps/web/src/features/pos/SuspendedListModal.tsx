import { useState, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { saleApi } from './saleApi'
import type { Sale } from '@/types/sale'
import { formatMoney, formatDateTime } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'

interface Props {
  open: boolean
  onClose: () => void
  onResume: (sale: Sale) => void
}

export function SuspendedListModal({ open, onClose, onResume }: Props) {
  const [sales, setSales] = useState<Sale[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    saleApi.listSuspended()
      .then((res) => setSales(res.data))
      .catch(() => toast.error('Помилка завантаження'))
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  const filtered = search
    ? sales.filter((s) =>
        (s.customer?.full_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (s.customer?.phone ?? '').includes(search) ||
        (s.pickup_cell ?? '').toLowerCase().includes(search.toLowerCase()) ||
        s.sale_number.toLowerCase().includes(search.toLowerCase()))
    : sales

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
          <h2 className="text-white text-lg font-bold">Відкладені чеки</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={20} /></button>
        </div>

        {/* Search */}
        <div className="px-6 py-3 border-b border-gray-800 shrink-0">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input type="text" value={search} autoFocus
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Пошук по клієнту, ячейці або номеру..."
              className="w-full bg-[#2C2C2C] text-white placeholder-gray-500 pl-9 pr-3 py-2 rounded-lg text-sm border border-gray-700 focus:outline-none focus:border-yellow-400" />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-6 py-3 space-y-2">
          {loading ? (
            <p className="text-gray-500 text-sm text-center py-8">Завантаження...</p>
          ) : filtered.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-8">{search ? 'Нічого не знайдено' : 'Немає відкладених чеків'}</p>
          ) : filtered.map((s) => (
            <div key={s.id}
              className="bg-[#2C2C2C] rounded-xl px-4 py-3 flex items-center justify-between hover:bg-gray-700 transition-colors cursor-pointer"
              onClick={() => { onResume(s); onClose() }}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-yellow-400 text-xs">#{s.sale_number}</span>
                  <span className="text-gray-400 text-xs">{formatDateTime(s.completed_at)}</span>
                </div>
                <p className="text-white text-sm mt-0.5 truncate">
                  {s.customer?.full_name ?? s.customer?.phone ?? 'Без імені'}
                </p>
                {s.notes && <p className="text-gray-500 text-xs truncate">{s.notes}</p>}
              </div>
              <div className="text-right shrink-0 ml-3">
                {s.pickup_cell && (
                  <div className="bg-yellow-400/20 border border-yellow-500/40 rounded-lg px-3 py-1 mb-1">
                    <span className="text-yellow-300 text-xs font-bold">📦 {s.pickup_cell}</span>
                  </div>
                )}
                <p className="text-white font-bold">{formatMoney(s.total)}</p>
                <p className="text-gray-500 text-xs">{s.sale_items?.length ?? 0} поз.</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
