import { useRef, useState, useCallback, useEffect } from 'react'
import { Minus, Trash2, User, X, Plus as PlusIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { usePOSStore } from '@/stores/posStore'
import { useAuthStore } from '@/stores/authStore'
import { kopecksToHryvnia } from '@/types/product'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'

interface Props {
  onPay: () => void
  onSelectCustomer: () => void
  onClear: () => void
}

function canUserDiscount(): boolean {
  const session = useAuthStore.getState().session
  const role = session?.user?.user_metadata?.role as string | undefined
  return role ? ['owner', 'admin', 'manager'].includes(role) : false
}

// ================================================================
// Numpad — повноекранна цифрова клавіатура
// ================================================================

function NumpadModal({
  open,
  value,
  unit,
  onConfirm,
  onClose,
}: {
  open: boolean
  value: number
  unit: string
  onConfirm: (v: number) => void
  onClose: () => void
}) {
  const [input, setInput] = useState(String(value))

  // Синхронізуємо input при відкритті для нового товару
  useEffect(() => {
    if (open) {
      setInput(String(value))
    }
  }, [open, value])

  const handleDigit = useCallback((d: string) => {
    setInput((prev) => {
      if (prev === '0' && d !== '.') return d
      if (d === '.') {
        return prev.includes('.') ? prev : prev + '.'
      }
      return prev + d
    })
  }, [])

  const handleBackspace = useCallback(() => {
    setInput((prev) => {
      if (prev.length <= 1) return '0'
      const next = prev.slice(0, -1)
      return next
    })
  }, [])

  const handleClear = useCallback(() => {
    setInput('0')
  }, [])

  const handleConfirm = useCallback(() => {
    const num = parseFloat(input)
    if (isNaN(num) || num <= 0) { setInput('1'); return }
    onConfirm(num)
    onClose()
  }, [input, onConfirm, onClose])

  if (!open) return null

  const buttons = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['✕', '0', '⌫'],
  ]

  return (
    <div className="numpad-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="numpad-display">
        <div className="text-gray-400 text-xs mb-1">Кількість ({unit})</div>
        <div className="text-white text-5xl font-bold tabular-nums">{input}</div>
      </div>
      <div className="numpad-grid">
        {buttons.flat().map((b) => {
          if (b === '✕') return (
            <button key={b} className="numpad-btn action touch-target ripple" onClick={handleClear}>
              ✕
            </button>
          )
          if (b === '⌫') return (
            <button key={b} className="numpad-btn action touch-target ripple" onClick={handleBackspace}>
              ⌫
            </button>
          )
          return (
            <button key={b} className="numpad-btn touch-target ripple" onClick={() => handleDigit(b)}>
              {b}
            </button>
          )
        })}
      </div>
      <div className="flex gap-px bg-[#1a1a1a]">
        <button className="numpad-btn touch-target ripple flex-1 py-5" onClick={() => handleDigit('.')}>
          .
        </button>
        <button className="numpad-btn confirm touch-target ripple flex-[2] py-5 text-lg font-bold" onClick={handleConfirm}>
          ✅ Готово
        </button>
      </div>
    </div>
  )
}

// ================================================================
// ReceiptPanel
// ================================================================

export function ReceiptPanel({ onPay, onSelectCustomer, onClear }: Props) {
  const store = usePOSStore()
  const userCanDiscount = canUserDiscount()
  const [numpadTarget, setNumpadTarget] = useState<string | null>(null)
  const tabBarRef = useRef<HTMLDivElement>(null)
  const tabTouchStart = useRef(0)

  const numpadItem = numpadTarget ? store.items.find((i) => i.productId === numpadTarget) : null

  function handleSetDiscount(productId: string, discountKopecks: number) {
    if (discountKopecks > 0 && !userCanDiscount) {
      toast.warning('Тільки менеджер може застосувати знижку')
      return
    }
    store.setDiscount(productId, discountKopecks)
  }

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
    <div className="flex flex-col h-full bg-[#1A1A1A]">
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
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <span className="text-gray-400 text-sm font-medium">ЧЕК</span>
        {store.customer ? (
          <button onClick={onSelectCustomer} className="flex flex-col items-end text-xs hover:text-yellow-300 active-press touch-target">
            <div className="flex items-center gap-1.5">
              <User size={14} className="text-yellow-400" />
              <span className="text-yellow-400">{store.customer.name ?? store.customer.phone}</span>
              {store.customer.vipLevel !== 'standard' && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
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
          </button>
        ) : (
          <button onClick={onSelectCustomer} className="text-gray-600 text-xs hover:text-gray-400 touch-target ripple px-3 py-1.5 rounded-lg">
            + Клієнт
          </button>
        )}
      </div>

      {/* ========== Позиції ========== */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {store.items.length === 0 ? (
          <p className="text-gray-700 text-sm text-center py-16">
            Додайте товар через пошук
          </p>
        ) : (
          store.items.map((item) => {
            const isSelected = store.selectedProductId === item.productId
            return (
              <SwipeableItem
                key={item.productId}
                onDelete={() => store.removeItem(item.productId)}
              >
                <div
                  onClick={() => store.setSelectedProductId(item.productId)}
                  className={`py-3 px-3 -mx-1 rounded-xl border-2 cursor-pointer transition-all active-press ${
                    isSelected
                      ? 'border-yellow-400 bg-yellow-400/5'
                      : 'border-transparent hover:bg-gray-800/30'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm leading-tight truncate font-medium">{item.name}</p>
                      <p className="text-gray-500 text-xs">{kopecksToHryvnia(item.unitPrice)} ₴ / {item.unit}</p>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); store.removeItem(item.productId) }}
                      className="text-gray-700 hover:text-red-400 transition-colors shrink-0 touch-target ripple rounded-lg flex items-center justify-center"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); store.updateQty(item.productId, +(item.qty - 1).toFixed(3)) }}
                        className="w-12 h-12 rounded-xl bg-[#2C2C2C] text-white hover:bg-gray-600 flex items-center justify-center active-press ripple touch-target"
                        style={{ minWidth: 48, minHeight: 48 }}
                      >
                        <Minus size={20} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setNumpadTarget(item.productId)
                        }}
                        className="text-white text-lg font-semibold w-16 text-center h-12 flex items-center justify-center hover:bg-[#2C2C2C] rounded-xl transition-colors touch-target"
                        style={{ minHeight: 48 }}
                      >
                        {item.qty} <span className="text-gray-500 text-xs ml-0.5">{item.unit}</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          const newQty = +(item.qty + 1).toFixed(3)
                          if (item.qtyOnHand < newQty) {
                            const msg = item.qtyOnHand <= 0
                              ? 'Недостатньо на складі: ' + item.name + ' (немає в наявності)'
                              : 'Недостатньо на складі: ' + item.name + ' (доступно ' + item.qtyOnHand + ' ' + item.unit + ')'
                            toast.warning(msg)
                          }
                          store.updateQty(item.productId, newQty)
                        }}
                        className="w-12 h-12 rounded-xl bg-[#2C2C2C] text-white hover:bg-gray-600 flex items-center justify-center active-press ripple touch-target"
                        style={{ minWidth: 48, minHeight: 48 }}
                      >
                        <PlusIcon size={20} />
                      </button>
                    </div>
                    <span className="text-white font-bold text-base">
                      {kopecksToHryvnia(item.total)} ₴
                    </span>
                  </div>
                  {/* Знижка */}
                  {userCanDiscount && (
                    <div className="mt-2 flex items-center gap-2">
                      <label className="text-gray-500 text-xs">Знижка:</label>
                      <input
                        type="number" min="0" step="0.01"
                        value={(item.discount / 100).toFixed(2)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value) || 0
                          handleSetDiscount(item.productId, Math.round(val * 100))
                        }}
                        className="w-24 bg-[#2C2C2C] text-orange-400 text-sm text-center rounded-xl px-3 py-2 border border-gray-700 focus:outline-none focus:border-orange-400"
                      />
                      <span className="text-gray-500 text-xs">₴</span>
                    </div>
                  )}
                  {isSelected && (
                    <div className="mt-1.5 flex gap-3 text-gray-500 text-[10px]">
                      <span>Del — видалити</span>
                      <span>+/- — кількість</span>
                    </div>
                  )}
                </div>
              </SwipeableItem>
            )
          })
        )}
      </div>

      {/* ========== Підсумок ========== */}
      <div className="border-t border-gray-800 px-4 pt-4 pb-3 space-y-3">
        {store.items.length > 0 && (
          <div className="space-y-1.5 text-sm">
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
          <span className="text-gray-400 text-base font-semibold">ДО ОПЛАТИ:</span>
          <span className="text-white text-4xl font-bold tabular-nums">
            {formatMoney(store.total)}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onClear}
            disabled={store.items.length === 0}
            className="touch-target py-4 rounded-xl bg-[#2C2C2C] text-gray-400 text-base font-medium hover:bg-gray-700 disabled:opacity-30 transition-colors ripple active-press"
            style={{ minHeight: 64 }}
          >
            ✕ Скинути чек
          </button>
          <button
            id="pos-pay-btn"
            onClick={onPay}
            disabled={store.items.length === 0}
            className="w-full py-5 rounded-xl bg-yellow-400 text-black text-xl font-bold hover:bg-yellow-300 disabled:opacity-30 transition-all shadow-lg shadow-yellow-400/20 ripple active-press"
            style={{ minHeight: 72 }}
          >
            💰 ОПЛАТИТИ (F8)
          </button>
        </div>
      </div>

      {/* Numpad */}
      <NumpadModal
        open={numpadTarget !== null}
        value={numpadItem?.qty ?? 1}
        unit={numpadItem?.unit ?? 'шт'}
        onConfirm={(v) => {
          if (numpadTarget) store.updateQty(numpadTarget, v)
        }}
        onClose={() => setNumpadTarget(null)}
      />
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
