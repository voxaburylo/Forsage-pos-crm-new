import { useEffect, useRef, useState } from 'react'
import { Search, Loader2, Printer } from 'lucide-react'
import { Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDateTime } from '@/lib/utils'
import { saleApi } from './saleApi'
import type { Sale } from '@/types/sale'

interface Props {
  open:     boolean
  onClose:  () => void
  /** Викликається з id обраного чека — батьківський компонент завантажує його у слот друку й друкує */
  onSelect: (saleId: string) => void
}

const PAY_LABEL: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', debt: 'Борг', mixed: 'Змішано', transfer: 'Переказ',
}

const RECEIPT_SEARCH_TIMEOUT_MS = 10_000

function recentReceiptsFrom() {
  const date = new Date()
  date.setDate(date.getDate() - 14)
  return date.toISOString()
}

function normalizeBarcode(value: string) {
  return value.replace(/\s/g, '').trim()
}

function looksLikeProductBarcode(value: string) {
  const code = normalizeBarcode(value)
  return /^\d{5,}$/.test(code) || (code.length >= 6 && /^[A-Za-z0-9._/-]+$/.test(code) && /\d/.test(code))
}

/**
 * Пошук і повторний друк чеків прямо з каси.
 * За замовчуванням показує останні 14 днів; скан товару знаходить чеки з цим товаром.
 */
export function ReceiptFinderModal({ open, onClose, onSelect }: Props) {
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState<Sale[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Автофокус при відкритті + скидання стану при закритті
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (event: Event) => {
      const code = normalizeBarcode(String((event as CustomEvent<{ code?: string }>).detail?.code ?? ''))
      if (!code) return
      setQuery(code)
      setTimeout(() => inputRef.current?.select(), 20)
    }
    window.addEventListener('forsage:receipt-finder-scan', handler as EventListener)
    return () => window.removeEventListener('forsage:receipt-finder-scan', handler as EventListener)
  }, [open])

  // Пошук із debounce
  useEffect(() => {
    if (!open) return
    const term = query.trim()
    const handle = setTimeout(async () => {
      setLoading(true)
      try {
        const base = { status: 'completed', date_from: recentReceiptsFrom() }
        const barcode = normalizeBarcode(term)
        const requests = term
          ? (looksLikeProductBarcode(term)
              ? [
                  { ...base, product_barcode: barcode, per_page: 30 },
                  { ...base, search: term, per_page: 30 },
                ]
              : [{ ...base, search: term, per_page: 30 }])
          : [{ ...base, per_page: 50 }]

        let found: Sale[] = []
        for (const params of requests) {
          const res = await saleApi.list(params, { silent: true, timeoutMs: RECEIPT_SEARCH_TIMEOUT_MS })
          found = (res as any).data ?? []
          if (found.length > 0 || !term) break
        }
        setResults(found)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не вдалося завантажити чеки')
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => clearTimeout(handle)
  }, [query, open])

  return (
    <Modal open={open} onClose={onClose} title="Пошук чека" size="md">
      <div className="space-y-3">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Номер чека, телефон, ім'я, VIN або штрихкод товару…"
            className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
          />
        </div>

        <div className="border border-gray-200 rounded-xl overflow-hidden max-h-[55vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : results.length === 0 ? (
            <div className="py-10 text-center text-sm text-gray-400">
              {query.trim() ? 'Нічого не знайдено за останні 14 днів' : 'Останні чеки за 14 днів'}
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {results.map((s) => {
                const firstItems = (s.sale_items ?? []).slice(0, 2)
                return (
                <li key={s.id}>
                  <button
                    onClick={() => { onSelect(s.id); onClose() }}
                    className="w-full flex items-start justify-between gap-3 px-4 py-3 text-left hover:bg-yellow-50 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-yellow-700">#{s.sale_number}</span>
                        {s.status !== 'completed' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{s.status}</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 truncate">
                        {s.completed_at ? formatDateTime(s.completed_at) : ''}
                        {s.customer?.full_name ? ` · ${s.customer.full_name}` : ''}
                        {` · ${PAY_LABEL[s.payment_method] ?? s.payment_method}`}
                      </div>
                      {firstItems.length > 0 && (
                        <div className="mt-1.5 space-y-0.5">
                          {firstItems.map((item) => (
                            <div key={item.id} className="truncate text-xs text-gray-600">
                              {item.product?.name ?? item.product?.sku ?? 'Товар'}
                              {item.qty !== 1 ? ` × ${item.qty}` : ''}
                            </div>
                          ))}
                          {(s.sale_items?.length ?? 0) > 2 && (
                            <div className="text-[11px] text-gray-400">
                              + ще {(s.sale_items?.length ?? 0) - 2}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="font-semibold text-gray-800 text-sm">{formatMoney(s.total)}</span>
                      <Printer size={15} className="text-gray-400" />
                    </div>
                  </button>
                </li>
                )
              })}
            </ul>
          )}
        </div>

        <p className="text-xs text-gray-400">
          Показані чеки за останні 14 днів. Натисніть на чек, щоб роздрукувати його повторно.
        </p>
      </div>
    </Modal>
  )
}
