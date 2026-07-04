import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw, Receipt, WifiOff, X } from 'lucide-react'
import { getPendingSales, type PendingSale } from '@/lib/offlineDB'
import { formatMoney } from '@/lib/utils'

interface Props {
  open: boolean
  online: boolean
  syncing: boolean
  refreshKey: number
  onClose: () => void
  onSync: () => Promise<void>
}

export function OfflineSalesModal({
  open, online, syncing, refreshKey, onClose, onSync,
}: Props) {
  const [sales, setSales] = useState<PendingSale[]>([])
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      setSales(await getPendingSales())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open, refreshKey, syncing])

  if (!open) return null

  async function sync() {
    await onSync()
    await load()
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/75" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-700 bg-[#1A1A1A] text-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Receipt size={19} className="text-yellow-400" />
              Офлайн-чеки
            </h2>
            <p className="mt-0.5 text-xs text-gray-400">
              Зберігаються в цьому браузері до успішної синхронізації
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white">
            <X size={19} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && sales.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-400">Завантаження...</p>
          ) : sales.length === 0 ? (
            <div className="py-12 text-center">
              <Receipt size={36} className="mx-auto mb-3 text-emerald-500" />
              <p className="font-semibold text-emerald-300">Черга порожня</p>
              <p className="mt-1 text-xs text-gray-500">Усі чеки передані на сервер</p>
            </div>
          ) : (
            <div className="space-y-2">
              {sales.map((sale) => (
                <div
                  key={sale.offline_id}
                  className={`rounded-xl border p-3 ${
                    sale.sync_status === 'failed'
                      ? 'border-red-500/40 bg-red-950/20'
                      : 'border-gray-700 bg-[#252525]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-bold text-yellow-300">
                          OFF-{sale.offline_id.slice(0, 8).toUpperCase()}
                        </span>
                        <span className="rounded-full bg-gray-700 px-2 py-0.5 text-[10px] text-gray-300">
                          {sale.payment_method === 'cash' ? 'Готівка' : 'Переказ'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-gray-400">
                        {new Date(sale.created_at).toLocaleString('uk-UA')} · {sale.items.length} поз.
                      </p>
                    </div>
                    <span className="text-base font-bold">{formatMoney(sale.total)}</span>
                  </div>

                  {sale.sync_status === 'failed' && (
                    <div className="mt-3 flex gap-2 rounded-lg bg-red-900/25 px-3 py-2 text-xs text-red-200">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <div>
                        <p className="font-semibold">Не синхронізовано, спроб: {sale.sync_attempts ?? 0}</p>
                        <p className="mt-0.5 break-words text-red-300/80">{sale.last_error || 'Невідома помилка'}</p>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-800 px-5 py-4">
          <div className={`flex items-center gap-2 text-xs ${online ? 'text-emerald-400' : 'text-red-400'}`}>
            {online ? <span className="h-2 w-2 rounded-full bg-emerald-400" /> : <WifiOff size={14} />}
            {online ? 'Сервер доступний' : 'Немає зв’язку'}
          </div>
          <button
            onClick={sync}
            disabled={!online || syncing || sales.length === 0}
            className="flex items-center gap-2 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-black hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw size={15} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Синхронізація...' : 'Повторити синхронізацію'}
          </button>
        </div>
      </div>
    </div>
  )
}
