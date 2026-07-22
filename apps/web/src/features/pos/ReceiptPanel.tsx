import { useRef, useState, useCallback, useEffect } from 'react'
import { Minus, Trash2, User, X, Plus as PlusIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { usePOSStore } from '@/stores/posStore'
import type { POSItem } from '@/stores/posStore'
import { memo } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { kopecksToHryvnia } from '@/types/product'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'

interface Props {
  onPay: () => void
  onSelectCustomer: () => void
  onClear: () => void
  onClearCustomer?: () => void
}

function canUserDiscount(): boolean {
  const session = useAuthStore.getState().session
  const role = session?.user?.user_metadata?.role as string | undefined
  return role ? ['owner', 'admin', 'manager'].includes(role) : false
}

// ================================================================
// ReceiptPanel
// ================================================================

const ReceiptItemRow = memo(function ReceiptItemRow({
  item,
  isSelected,
  userCanDiscount,
}: {
  item: POSItem
  isSelected: boolean
  userCanDiscount: boolean
}) {
  const [isEditingQty, setIsEditingQty] = useState(false)
  const [qtyDraft, setQtyDraft] = useState(String(item.qty))
  const qtyInputRef = useRef<HTMLInputElement>(null)
  const remove = () => usePOSStore.getState().removeItem(item.productId)
  const updateQty = (qty: number) => usePOSStore.getState().updateQty(item.productId, qty)

  useEffect(() => {
    if (!isEditingQty) {
      setQtyDraft(String(item.qty))
      return
    }
    const frame = requestAnimationFrame(() => {
      qtyInputRef.current?.focus()
      qtyInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [isEditingQty, item.qty])

  const commitQty = () => {
    const value = Number(qtyDraft.trim().replace(',', '.'))
    setIsEditingQty(false)
    if (!Number.isFinite(value) || value <= 0) {
      setQtyDraft(String(item.qty))
      toast.warning('Введіть кількість більше нуля')
      return
    }
    const qty = +value.toFixed(3)
    if (item.qtyOnHand < qty) {
      toast.warning(item.qtyOnHand <= 0
        ? `Недостатньо на складі: ${item.name} (немає в наявності)`
        : `Недостатньо на складі: ${item.name} (доступно ${item.qtyOnHand} ${item.unit})`)
    }
    updateQty(qty)
  }

  return (
    <SwipeableItem onDelete={remove}>
      <div
        onClick={() => usePOSStore.getState().setSelectedProductId(item.productId)}
        className={`receipt-item py-3 px-3 -mx-1 rounded-xl border-2 cursor-pointer transition-all active-press ${
          isSelected ? 'border-yellow-400 bg-yellow-400/5' : 'border-transparent hover:bg-gray-800/30'
        }`}
      >
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm leading-tight truncate font-medium flex items-center gap-1.5">
              {item.name}
              {item.requiresCoreReturn && (
                <span className="shrink-0 bg-yellow-950 border border-yellow-800 text-yellow-500 text-[8px] px-1 py-0.5 rounded font-bold uppercase tracking-wider">
                  ♻️ Обмін
                </span>
              )}
            </p>
            <p className="text-gray-500 text-xs mt-0.5">
              {kopecksToHryvnia(item.unitPrice)} ₴ / {item.unit}
              {item.requiresCoreReturn && ` • Застава: +${kopecksToHryvnia(item.coreDepositAmount ?? 0)} ₴`}
            </p>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); remove() }}
            className="text-gray-700 hover:text-red-400 transition-colors shrink-0 touch-target ripple rounded-lg flex items-center justify-center"
            aria-label={`Видалити ${item.name}`}
            title="Видалити позицію"
          >
            <Trash2 size={16} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); updateQty(+(item.qty - 1).toFixed(3)) }}
              className="w-12 h-12 rounded-xl bg-[#2C2C2C] text-white hover:bg-gray-600 flex items-center justify-center active-press ripple touch-target"
              style={{ minWidth: 48, minHeight: 48 }}
              aria-label={`Зменшити кількість ${item.name}`}
            >
              <Minus size={20} />
            </button>
            {isEditingQty ? (
              <div
                className="w-20 h-12 flex items-center rounded-xl bg-[#2C2C2C] border-2 border-yellow-400 overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  ref={qtyInputRef}
                  type="text"
                  inputMode="decimal"
                  value={qtyDraft}
                  data-scanner-ignore="true"
                  onChange={(e) => setQtyDraft(e.target.value)}
                  onBlur={commitQty}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitQty()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setQtyDraft(String(item.qty))
                      setIsEditingQty(false)
                    }
                  }}
                  className="min-w-0 w-full h-full bg-transparent text-white text-lg font-semibold text-center tabular-nums outline-none"
                  aria-label={`Кількість ${item.name}`}
                />
                <span className="pr-2 text-gray-500 text-xs shrink-0">{item.unit}</span>
              </div>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  usePOSStore.getState().setSelectedProductId(item.productId)
                  setQtyDraft(String(item.qty))
                  setIsEditingQty(true)
                }}
                className="text-white text-lg font-semibold w-20 text-center h-12 flex items-center justify-center hover:bg-[#2C2C2C] rounded-xl transition-colors touch-target"
                style={{ minHeight: 48 }}
                aria-label={`Змінити кількість ${item.name}`}
                title="Натисніть і введіть кількість"
              >
                {item.qty} <span className="text-gray-500 text-xs ml-0.5">{item.unit}</span>
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation()
                const newQty = +(item.qty + 1).toFixed(3)
                if (item.qtyOnHand < newQty) {
                  toast.warning(item.qtyOnHand <= 0
                    ? `Недостатньо на складі: ${item.name} (немає в наявності)`
                    : `Недостатньо на складі: ${item.name} (доступно ${item.qtyOnHand} ${item.unit})`)
                }
                updateQty(newQty)
              }}
              className="w-12 h-12 rounded-xl bg-[#2C2C2C] text-white hover:bg-gray-600 flex items-center justify-center active-press ripple touch-target"
              style={{ minWidth: 48, minHeight: 48 }}
              aria-label={`Збільшити кількість ${item.name}`}
            >
              <PlusIcon size={20} />
            </button>
          </div>
          <span className="text-white font-bold text-base">{kopecksToHryvnia(item.total)} ₴</span>
        </div>
        {userCanDiscount && (
          <div className="mt-2 flex items-center gap-2">
            <label className="text-gray-500 text-xs">Знижка:</label>
            <input
              type="number" min="0" step="0.01"
              value={(item.discount / 100).toFixed(2)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const value = parseFloat(e.target.value) || 0
                usePOSStore.getState().setDiscount(item.productId, Math.round(value * 100))
              }}
              className="w-24 bg-[#2C2C2C] text-orange-400 text-sm text-center rounded-xl px-3 py-2 border border-gray-700 focus:outline-none focus:border-orange-400"
            />
            <span className="text-gray-500 text-xs">₴</span>
          </div>
        )}
        {isSelected && (
          <div className="mt-1.5 flex gap-3 text-gray-500 text-[10px]">
            <span>Del — видалити</span>
            <span>Натисніть кількість і введіть число</span>
          </div>
        )}
      </div>
    </SwipeableItem>
  )
})

export function ReceiptPanel({ onPay, onSelectCustomer, onClear, onClearCustomer }: Props) {
  const store = usePOSStore()
  const userCanDiscount = canUserDiscount()
  const tabBarRef = useRef<HTMLDivElement>(null)
  const tabTouchStart = useRef(0)

  // Swipe між вкладками
  const handleTabTouchStart = useCallback((e: React.TouchEvent) => {
    const target = e.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    // Тільки у верхній частині (зона вкладок)
    if (e.touches[0].clientY - rect.top < 60) {
      tabTouchStart.current = e.touches[0].clientX
    } else {
      tabTouchStart.current = 0
    }
  }, [])

  const handleTabTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!tabTouchStart.current) return
    const dx = tabTouchStart.current - e.changedTouches[0].clientX
    const currentIdx = store.tabs.findIndex((t) => t.id === store.activeTabId)
    if (Math.abs(dx) > 60) {
      if (dx > 0 && currentIdx < store.tabs.length - 1) {
        store.setActiveTab(store.tabs[currentIdx + 1].id)
      } else if (dx < 0 && currentIdx > 0) {
        store.setActiveTab(store.tabs[currentIdx - 1].id)
      }
    }
    tabTouchStart.current = 0
  }, [store])

  return (
    <div className="receipt-panel flex h-full min-h-0 flex-col overflow-hidden bg-[#1A1A1A]">
      {/* ========== Панель вкладок (із свайпом) ========== */}
      <div
        ref={tabBarRef}
        onTouchStart={handleTabTouchStart}
        onTouchEnd={handleTabTouchEnd}
        className="flex items-center gap-0.5 px-2 pt-2 pb-0 overflow-x-auto shrink-0 touch-pan-x select-none"
      >
        {store.tabs.length > 1 && (
          <button
            onClick={() => {
              const idx = store.tabs.findIndex((t) => t.id === store.activeTabId)
              if (idx > 0) store.setActiveTab(store.tabs[idx - 1].id)
            }}
            className="shrink-0 text-gray-500 hover:text-white p-1 touch-target"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        {store.tabs.map((tab) => {
          const isActive = tab.id === store.activeTabId
          const tabLabel = tab.customer?.name ?? tab.customer?.phone ?? `Чек #${(store.tabs.indexOf(tab) + 1)}`
          const itemCount = tab.items.length
          return (
            <div
              key={tab.id}
              onClick={() => store.setActiveTab(tab.id)}
              className={`group flex items-center gap-1.5 px-3 py-2 rounded-t-lg text-xs cursor-pointer select-none transition-colors min-w-0 max-w-[140px] touch-target ${
                isActive
                  ? 'bg-[#2C2C2C] text-white'
                  : 'bg-[#1A1A1A] text-gray-500 hover:text-gray-300 hover:bg-[#242424]'
              }`}
            >
              <span className="truncate">{tabLabel}</span>
              {itemCount > 0 && (
                <span className={`text-[10px] px-1.5 rounded-full ${isActive ? 'bg-yellow-400 text-black' : 'bg-gray-700 text-gray-300'}`}>
                  {itemCount}
                </span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); store.closeTab(tab.id) }}
                aria-label={`Закрити ${tabLabel}`}
                className="opacity-60 hover:opacity-100 hover:text-red-400 transition-all shrink-0 flex items-center justify-center rounded-lg hover:bg-red-900/30"
                style={{ minWidth: 36, minHeight: 36 }}
              >
                <X size={18} />
              </button>
            </div>
          )
        })}
        {store.tabs.length > 1 && (
          <button
            onClick={() => {
              const idx = store.tabs.findIndex((t) => t.id === store.activeTabId)
              if (idx < store.tabs.length - 1) store.setActiveTab(store.tabs[idx + 1].id)
            }}
            className="shrink-0 text-gray-500 hover:text-white p-1 touch-target"
          >
            <ChevronRight size={16} />
          </button>
        )}
        {store.tabs.length < 5 && (
          <button
            onClick={() => store.addTab()}
            className="p-2 text-gray-500 hover:text-white hover:bg-[#242424] rounded-t-lg transition-colors shrink-0 touch-target"
            title="Новий чек"
          >
            <PlusIcon size={14} />
          </button>
        )}
      </div>

      {/* ========== Шапка чека ========== */}
      <div className="receipt-header shrink-0 px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <span className="text-gray-400 text-sm font-medium">ЧЕК</span>
        {store.customer ? (
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <div className="flex min-w-0 flex-1 flex-col items-start leading-tight">
              <div className="flex max-w-full items-center gap-1.5">
                <User size={14} className="shrink-0 text-yellow-400" />
                <span className="truncate font-semibold text-yellow-400">{store.customer.name ?? store.customer.phone}</span>
                {store.customer.vipLevel !== 'standard' && (
                  <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    store.customer.vipLevel === 'gold' ? 'bg-yellow-500 text-black' :
                    store.customer.vipLevel === 'silver' ? 'bg-gray-300 text-gray-800' :
                    'bg-orange-400 text-white'
                  }`}>
                    {store.customer.vipLevel === 'gold' ? '🥇' : store.customer.vipLevel === 'silver' ? '🥈' : '🥉'}
                    {store.customer.vipLevel.charAt(0).toUpperCase() + store.customer.vipLevel.slice(1)}
                  </span>
                )}
              </div>
              {store.customer.riskProfile === 'high' && (
                <span className="text-red-400 text-[10px] mt-0.5">⚠️ Проблемний клієнт</span>
              )}
              {store.customer.tierName && (
                <span className="text-yellow-600 text-[10px]">
                  {store.customer.tierName} -{store.customer.tierDiscountPct}%
                </span>
              )}
            </div>
            <button
              onClick={onSelectCustomer}
              className="shrink-0 rounded-lg border border-gray-700 px-2 py-1 text-[10px] text-gray-400 hover:border-yellow-500 hover:text-yellow-300"
              title="Обрати іншого клієнта"
            >
              змінити
            </button>
            <button
              onClick={onClearCustomer}
              className="shrink-0 rounded-lg border border-gray-700 px-2 py-1 text-[10px] font-bold text-gray-500 hover:border-red-500 hover:text-red-300"
              title="Прибрати клієнта з чека"
            >
              ×
            </button>
          </div>
        ) : (
          <button onClick={onSelectCustomer} className="rounded-xl border-2 border-yellow-400 bg-yellow-400 px-4 py-2 text-sm font-bold text-black shadow-sm hover:bg-yellow-300 touch-target ripple">
            + Додати клієнта
          </button>
        )}
      </div>

      {/* ========== Позиції ========== */}
      <div className="receipt-items min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 space-y-1">
        {store.items.length === 0 ? (
          <p className="text-gray-700 text-sm text-center py-16">
            Додайте товар через пошук
          </p>
        ) : (
          store.items.map((item) => (
            <ReceiptItemRow
              key={item.productId}
              item={item}
              isSelected={store.selectedProductId === item.productId}
              userCanDiscount={userCanDiscount}
            />
          ))
        )}
      </div>

      {/* ========== Підсумок ========== */}
      <div className="receipt-summary shrink-0 border-t border-gray-800 px-4 pt-4 pb-3 space-y-3">
        {store.items.length > 0 && (
          <div className="receipt-secondary-summary space-y-1.5 text-sm">
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
            {store.totalCoreDeposit > 0 && (
              <div className="flex justify-between text-yellow-500 font-medium">
                <span>Застава за старі деталі:</span>
                <span>+{formatMoney(store.totalCoreDeposit)}</span>
              </div>
            )}
          </div>
        )}

        {store.totalCoreDeposit > 0 && (
          <div className="receipt-core-warning p-3 bg-yellow-950/25 border border-yellow-800/40 rounded-xl flex items-start gap-2.5 text-yellow-500 text-xs mt-2">
            <span className="mt-0.5 text-sm">⚠️</span>
            <div>
              <p className="font-bold">Необхідно обміняти старі деталі!</p>
              <p className="text-[10px] text-yellow-600/90 leading-tight mt-0.5">Прийміть стару деталь від клієнта або візьміть заставну вартість.</p>
            </div>
          </div>
        )}

        <div className="flex justify-between items-baseline">
          <span className="text-gray-400 text-base font-semibold">ДО ОПЛАТИ:</span>
          <span className="receipt-total text-white text-4xl font-bold tabular-nums">
            {formatMoney(store.total)}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onClear}
            disabled={store.items.length === 0}
            className="receipt-action touch-target py-4 rounded-xl bg-[#2C2C2C] text-gray-400 text-base font-medium hover:bg-gray-700 disabled:opacity-30 transition-colors ripple active-press"
            style={{ minHeight: 64 }}
          >
            ✕ Скинути чек
          </button>
          <button
            id="pos-pay-btn"
            type="button"
            onClick={onPay}
            disabled={store.items.length === 0}
            className="receipt-action w-full py-5 rounded-xl bg-yellow-400 text-black text-xl font-bold hover:bg-yellow-300 disabled:opacity-30 transition-all shadow-lg shadow-yellow-400/20 ripple active-press"
            style={{ minHeight: 72 }}
          >
            💰 ОПЛАТИТИ (F2)
          </button>
        </div>
      </div>

    </div>
  )
}

// ================================================================
// SwipeableItem — обгортка зі свайпом вліво
// ================================================================

function SwipeableItem({
  children,
  onDelete,
}: {
  children: React.ReactNode
  onDelete: () => void
}) {
  const [swiped, setSwiped] = useState(false)
  const startX = useRef(0)

  const handleTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    const dx = startX.current - e.touches[0].clientX
    if (dx > 50) setSwiped(true)
    if (dx < -20) setSwiped(false)
  }

  const handleTouchEnd = () => {
    // Якщо свайпнули — тримаємо відкритим
  }

  return (
    <div className="swipe-container" onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
      <div className={`swipe-content ${swiped ? 'open' : ''}`}>
        {children}
      </div>
      <div className={`swipe-reveal ${swiped ? 'open' : ''}`}>
        <button
          onClick={() => { onDelete(); setSwiped(false) }}
          className="h-full bg-red-600 text-white text-xs font-bold px-4 flex items-center gap-1.5 rounded-l-xl active-press"
          style={{ minHeight: 64 }}
        >
          <Trash2 size={16} />
          Видалити
        </button>
      </div>
    </div>
  )
}
