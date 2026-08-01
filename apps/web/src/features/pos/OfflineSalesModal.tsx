import { useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, Printer, RefreshCw, Receipt, WifiOff, X } from 'lucide-react'
import { getCachedProductsByIds, getPendingSales, type PendingSale } from '@/lib/offlineDB'
import { formatMoney } from '@/lib/utils'
import type { Sale } from '@/types/sale'
import { printReceipt, ReceiptPrint } from './ReceiptPrint'
import { useAuthStore } from '@/stores/authStore'

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
  const scopeKey = useAuthStore((state) => state.session?.user?.id ?? '')
  const [sales, setSales] = useState<PendingSale[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [products, setProducts] = useState<Record<string, any>>({})
  const [printSale, setPrintSale] = useState<Sale | null>(null)

  async function load() {
    if (!scopeKey) {
      setSales([])
      return
    }
    setLoading(true)
    try {
      const pending = await getPendingSales(scopeKey)
      setSales(pending)
      const cached = await getCachedProductsByIds(
        pending.flatMap((sale) => sale.items.map((item) => item.product_id)),
      )
      setProducts(Object.fromEntries(cached.map((product) => [product.id, product])))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open, refreshKey, syncing, scopeKey])

  if (!open) return null

  async function sync() {
    await onSync()
    await load()
  }

  function itemInfo(sale: PendingSale, productId: string) {
    return sale.receipt_items?.find((item) => item.product_id === productId) ?? products[productId]
  }

  function handlePrint(sale: PendingSale) {
    const localSale: Sale = {
      id: sale.offline_id,
      sale_number: `OFF-${sale.offline_id.slice(0, 8).toUpperCase()}`,
      customer_id: sale.customer_id,
      cashier_id: '',
      manager_id: sale.manager_id,
      shift_id: sale.shift_id,
      status: 'completed',
      subtotal: sale.items.reduce((sum, item) => sum + item.unit_price * item.qty, 0),
      discount: sale.discount ?? sale.items.reduce((sum, item) => sum + item.discount, 0),
      total: sale.total,
      payment_method: sale.payment_method,
      is_debt: false,
      notes: sale.notes,
      completed_at: sale.created_at,
      is_fiscal: false,
      fiscal_number: null,
      bank_auth_code: null,
      cash_amount: sale.cash_amount ?? (sale.payment_method === 'cash' ? sale.total : 0),
      card_amount: 0,
      pickup_cell: null,
      customer: sale.customer_snapshot
        ? { id: sale.customer_id ?? '', ...sale.customer_snapshot }
        : null,
      sale_items: sale.items.map((item, index) => {
        const product = itemInfo(sale, item.product_id)
        return {
          id: `${sale.offline_id}-${index}`,
          product_id: item.product_id,
          qty: item.qty,
          unit_price: item.unit_price,
          discount: item.discount,
          total: item.unit_price * item.qty - item.discount,
          product: {
            id: item.product_id,
            sku: product?.sku ?? '—',
            name: product?.name ?? 'Товар',
            unit: product?.unit ?? 'шт',
          },
        }
      }),
    }
    setPrintSale(localSale)
    window.setTimeout(printReceipt, 250)
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
                  <div className="mt-3 flex items-center justify-between border-t border-gray-700/70 pt-2">
                    <button
                      type="button"
                      onClick={() => setExpanded(expanded === sale.offline_id ? null : sale.offline_id)}
                      className="flex items-center gap-1 text-xs font-semibold text-gray-300 hover:text-white"
                    >
                      <ChevronDown size={14} className={expanded === sale.offline_id ? 'rotate-180' : ''} />
                      Позиції чека
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePrint(sale)}
                      className="flex items-center gap-1.5 rounded-lg bg-gray-700 px-2.5 py-1.5 text-xs font-semibold hover:bg-gray-600"
                    >
                      <Printer size={13} /> Друк
                    </button>
                  </div>
                  {expanded === sale.offline_id && (
                    <div className="mt-2 space-y-1 rounded-lg bg-black/20 p-2">
                      {sale.items.map((item, index) => {
                        const product = itemInfo(sale, item.product_id)
                        return (
                          <div key={`${item.product_id}-${index}`} className="flex justify-between gap-3 text-xs">
                            <span className="min-w-0 truncate text-gray-300">
                              {product?.name ?? product?.sku ?? item.product_id} × {item.qty}
                            </span>
                            <span className="shrink-0 font-semibold text-gray-100">
                              {formatMoney(item.unit_price * item.qty - item.discount)}
                            </span>
                          </div>
                        )
                      })}
                      {sale.notes && <p className="pt-1 text-[11px] text-gray-500">Примітка: {sale.notes}</p>}
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
      {printSale && <ReceiptPrint sale={printSale} />}
    </div>
  )
}
