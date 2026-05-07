import { Minus, Plus, Trash2, User } from 'lucide-react'
import { usePOSStore } from '@/stores/posStore'
import { kopecksToHryvnia } from '@/types/product'
import { formatMoney } from '@/lib/utils'

interface Props {
  onPay: () => void
  onSelectCustomer: () => void
  onClear: () => void
}

export function ReceiptPanel({ onPay, onSelectCustomer, onClear }: Props) {
  const store = usePOSStore()

  return (
    <div className="flex flex-col h-full bg-[#1A1A1A]">
      {/* Шапка чека */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <span className="text-gray-400 text-sm font-medium">ЧЕК</span>
        {store.customer ? (
          <button onClick={onSelectCustomer} className="flex items-center gap-1.5 text-yellow-400 text-xs hover:text-yellow-300">
            <User size={12} />
            {store.customer.name ?? store.customer.phone}
          </button>
        ) : (
          <button onClick={onSelectCustomer} className="text-gray-600 text-xs hover:text-gray-400">
            + Клієнт
          </button>
        )}
      </div>

      {/* Позиції */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-1">
        {store.items.length === 0 ? (
          <p className="text-gray-700 text-sm text-center py-12">
            Додайте товар через пошук
          </p>
        ) : (
          store.items.map((item) => (
            <div key={item.productId} className="py-2 border-b border-gray-800/50">
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm leading-tight truncate">{item.name}</p>
                  <p className="text-gray-500 text-xs">{kopecksToHryvnia(item.unitPrice)} ₴ / {item.unit}</p>
                </div>
                <button
                  onClick={() => store.removeItem(item.productId)}
                  className="text-gray-700 hover:text-red-400 transition-colors shrink-0"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="flex items-center justify-between">
                {/* Кількість */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => store.updateQty(item.productId, +(item.qty - 1).toFixed(3))}
                    className="w-7 h-7 rounded-lg bg-[#2C2C2C] text-white hover:bg-gray-600 flex items-center justify-center"
                  >
                    <Minus size={12} />
                  </button>
                  <span className="text-white text-sm w-10 text-center">
                    {item.qty} {item.unit}
                  </span>
                  <button
                    onClick={() => store.updateQty(item.productId, +(item.qty + 1).toFixed(3))}
                    className="w-7 h-7 rounded-lg bg-[#2C2C2C] text-white hover:bg-gray-600 flex items-center justify-center"
                  >
                    <Plus size={12} />
                  </button>
                </div>
                {/* Сума */}
                <span className="text-white font-semibold text-sm">
                  {kopecksToHryvnia(item.total)} ₴
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Підсумок */}
      <div className="border-t border-gray-800 px-4 py-4 space-y-3">
        {store.items.length > 0 && (
          <div className="space-y-1 text-sm">
            <div className="flex justify-between text-gray-400">
              <span>Товарів:</span>
              <span>{store.items.reduce((s, i) => s + i.qty, 0)}</span>
            </div>
            {store.totalDiscount > 0 && (
              <div className="flex justify-between text-orange-400">
                <span>Знижка:</span>
                <span>-{formatMoney(store.totalDiscount)}</span>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-between items-baseline">
          <span className="text-gray-400 text-sm">ДО ОПЛАТИ:</span>
          <span className="text-white text-3xl font-bold">
            {formatMoney(store.total)}
          </span>
        </div>

        {/* Кнопки */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onClear}
            disabled={store.items.length === 0}
            className="py-3 rounded-xl bg-[#2C2C2C] text-gray-400 text-sm font-medium hover:bg-gray-700 disabled:opacity-30 transition-colors"
          >
            Скинути чек
          </button>
          <button
            id="pos-pay-btn"
            onClick={onPay}
            disabled={store.items.length === 0}
            className="py-3 rounded-xl bg-yellow-400 text-black text-sm font-bold hover:bg-yellow-300 disabled:opacity-30 transition-colors"
            style={{ minHeight: 56 }}
          >
            ОПЛАТА (F8)
          </button>
        </div>
      </div>
    </div>
  )
}
