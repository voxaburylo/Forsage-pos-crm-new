import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, LogOut, Printer, ArrowLeftRight, RotateCcw, Home, Keyboard, Maximize, Minimize, Lock, DollarSign } from 'lucide-react'
import { usePOS } from './usePOS'
import { SearchPanel, type SearchPanelHandle } from './SearchPanel'
import { ReceiptPanel } from './ReceiptPanel'
import { PaymentModal } from './PaymentModal'
import { ShiftCloseModal } from './ShiftCloseModal'
import { ReceiptPrint, printReceipt } from './ReceiptPrint'
import { saleApi } from './saleApi'
import { QuickCustomerModal } from '@/features/customers/QuickCustomerModal'
import { CashOperationModal } from './CashOperationModal'
import { DebtPaymentModal } from './DebtPaymentModal'
import { CashReconciliationModal } from './CashReconciliationModal'
import { FavoritesPanel } from './FavoritesPanel'
import { DashboardPanel } from './DashboardPanel'
import { CrossSellPanel } from './CrossSellPanel'
import { ReadyOrdersPanel } from './ReadyOrdersPanel'
import { HelpModal } from './HelpModal'
import { SuspendModal } from './SuspendModal'
import { SuspendedListModal } from './SuspendedListModal'
import { LockScreenOverlay, isLocked, setLocked } from './LockScreenOverlay'
import { shiftApi } from './shiftApi'
import type { POSItem, POSCustomer } from '@/stores/posStore'
import type { Customer } from '@/types/customer'
import type { Sale } from '@/types/sale'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'
import { initAudio, playCashRegister } from '@/lib/audioService'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { useServerStatus } from '@/hooks/useServerStatus'
import { useOfflineSync } from '@/hooks/useOfflineSync'
import { enqueueSale } from '@/lib/offlineDB'

const CART_KEY = 'forsage_pos_cart'

interface SavedCart {
  tabs: Array<{ items: POSItem[]; customer: POSCustomer | null; notes: string }>
  savedAt: string
  shiftId: string | null
}

function saveCart(store: { tabs: Array<{ items: POSItem[]; customer: POSCustomer | null; notes: string }>; currentShift: { id: string } | null }) {
  const hasItems = store.tabs.some((t) => t.items.length > 0)
  if (!hasItems) { localStorage.removeItem(CART_KEY); return }
  const cart: SavedCart = {
    tabs: store.tabs.map((t) => ({ items: t.items, customer: t.customer, notes: t.notes })),
    savedAt: new Date().toISOString(),
    shiftId: store.currentShift?.id ?? null,
  }
  localStorage.setItem(CART_KEY, JSON.stringify(cart))
}

function loadCart(): SavedCart | null {
  try {
    const raw = localStorage.getItem(CART_KEY)
    if (!raw) return null
    const cart = JSON.parse(raw) as SavedCart
    if (!cart.tabs?.some((t) => t.items.length > 0)) return null
    return cart
  } catch { return null }
}

function clearSavedCart() {
  localStorage.removeItem(CART_KEY)
}

function OpenShiftScreen({ onOpened }: { onOpened: () => void }) {
  const [cash, setCash]       = useState('')
  const [loading, setLoading] = useState(false)

  async function handleOpen() {
    const kopecks = Math.round(parseFloat(cash || '0') * 100)
    setLoading(true)
    try {
      await shiftApi.open(kopecks)
      toast.success('Зміну відкрито')
      onOpened()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
      <div className="bg-[#2C2C2C] rounded-2xl p-10 w-full max-w-sm text-center border border-gray-700">
        <Zap size={40} className="text-yellow-400 mx-auto mb-4" />
        <h1 className="text-white text-2xl font-bold mb-1">Відкрити зміну</h1>
        <p className="text-gray-500 text-sm mb-6">Введіть початковий залишок готівки в касі</p>
        <input
          type="number" min="0" step="0.01" autoFocus
          value={cash}
          onChange={(e) => setCash(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleOpen() }}
          placeholder="0.00 ₴"
          className="w-full bg-[#1A1A1A] text-white text-2xl font-bold text-center rounded-xl px-4 py-4 border border-gray-700 focus:outline-none focus:border-yellow-400 mb-4"
        />
        <button onClick={handleOpen} disabled={loading} style={{ minHeight: 56 }}
          className="w-full bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-lg rounded-xl py-4 disabled:opacity-50 transition-colors">
          {loading ? 'Відкриваємо...' : 'Відкрити зміну'}
        </button>
      </div>
    </div>
  )
}

const PAYMENT_ATTEMPT_KEY = 'forsage_last_payment_attempt'

export default function POSPage() {
  const navigate = useNavigate()
  const { store, completeSale } = usePOS()
  const [payOpen, setPayOpen]           = useState(false)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [closeOpen, setCloseOpen]       = useState(false)
  const [cashOpen, setCashOpen]         = useState(false)
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [debtPayOpen, setDebtPayOpen] = useState(false)
  const [suspendOpen, setSuspendOpen]   = useState(false)
  const [suspendedOpen, setSuspendedOpen] = useState(false)
  const [suspendedCount, setSuspendedCount] = useState(0)
  const [lastSale, setLastSale]         = useState<Sale | null>(null)
  const [recoverCart, setRecoverCart]   = useState<SavedCart | null>(null)
  const [crashSale, setCrashSale]       = useState<Sale | null>(null)
  const [helpOpen, setHelpOpen]         = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isLockedPIN, setLockedPIN]     = useState(isLocked())
  const serverOnline = useServerStatus()
  const { pendingCount, syncing, incrementPending } = useOfflineSync(serverOnline)

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {})
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {})
    }
  }

  function handleLock() {
    setLocked(true)
    setLockedPIN(true)
  }
  const [staffUsers, setStaffUsers]     = useState<Array<{ id: string; full_name: string; role: string }>>([])
  const session = useAuthStore((s) => s.session)
  const searchRef = useRef<SearchPanelHandle>(null)

  const shift = store.currentShift
  const [mobileTab, setMobileTab] = useState<'search' | 'cart'>('search')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Завантажуємо список співробітників для селектора менеджера
  useEffect(() => {
    api.get<{ data: Array<{ id: string; full_name: string; role: string }> }>('/api/v1/admin/users')
      .then((res) => {
        setStaffUsers(res.data)
        // За замовчуванням — поточний користувач
        const currentId = session?.user?.id
        if (currentId && !store.managerId) {
          store.setManagerId(currentId)
        }
      })
      .catch(() => {})
    // Лічильник відкладених чеків
    saleApi.listSuspended().then((res) => setSuspendedCount(res.data.length)).catch(() => {})
  }, [])

  // Ініціалізація аудіо при першій взаємодії (через гарячі клавіші)
  useEffect(() => {
    function handleFirstInteraction() {
      initAudio()
    }
    window.addEventListener('keydown', handleFirstInteraction, { once: true })
    window.addEventListener('click', handleFirstInteraction, { once: true })
    return () => {
      window.removeEventListener('keydown', handleFirstInteraction)
      window.removeEventListener('click', handleFirstInteraction)
    }
  }, [])

  // Crash Recovery — перевірка збереженого кошика при монтуванні
  useEffect(() => {
    const saved = loadCart()
    if (saved && saved.tabs.length > 0) {
      const hasItems = saved.tabs.some((t) => t.items.length > 0)
      if (hasItems) setRecoverCart(saved)
    }
  }, [])

  // Crash Recovery — перевірка чи продаж пройшов (якщо є незавершена спроба)
  useEffect(() => {
    const raw = localStorage.getItem(PAYMENT_ATTEMPT_KEY)
    if (!raw) return
    try {
      const attempt = JSON.parse(raw) as { shift_id: string; attempt_at: string }
      saleApi.checkAfterPayment(attempt.shift_id, attempt.attempt_at)
        .then(({ data }) => {
          if (data?.id) {
            setCrashSale(data as Sale)
            localStorage.removeItem(PAYMENT_ATTEMPT_KEY)
          }
        })
        .catch(() => {})
    } catch { localStorage.removeItem(PAYMENT_ATTEMPT_KEY) }
  }, [])

  // Crash Recovery — авто-збереження всіх вкладок (зберігаємо і shift_id)
  useEffect(() => {
    saveCart(store)
  }, [store.tabs, store.currentShift])

  // Очистити localStorage після успішного продажу або скидання
  const originalClear = useCallback(() => {
    const { tabs, activeTabId } = store
    const tab = tabs.find((t) => t.id === activeTabId)
    if (tab && tab.items.length > 0) {
      store.clearReceipt()
    }
    clearSavedCart()
  }, [store])

  // Гарячі клавіші
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      // Не перехоплюємо якщо фокус на input (крім F-клавіш)
      const isInput = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA'
      const isFKey = e.key.startsWith('F')

      if (e.key === 'F1') {
        e.preventDefault()
        setHelpOpen(true)
      }
      if (e.key === 'F2') {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'F3') {
        e.preventDefault()
        if (store.tabs.length < 5) store.addTab()
      }
      if (e.key === 'F4') {
        e.preventDefault()
        setCustomerOpen(true)
      }
      if (e.key === 'F5') {
        e.preventDefault()
        if (store.items.length > 0) setSuspendOpen(true)
      }
      if (e.key === 'F6') {
        e.preventDefault()
        setSuspendedOpen(true)
      }
      if (e.key === 'F12' || (e.key === 'l' && e.ctrlKey)) {
        e.preventDefault()
        handleLock()
      }
      if (e.key === 'F8') {
        e.preventDefault()
        if (store.items.length > 0) setPayOpen(true)
      }
      if (e.key === 'Escape' && !isInput) {
        searchRef.current?.clear()
      }

      // Навігація по чеку — тільки коли не в полі пошуку
      if (!isInput && !isFKey) {
        if (e.key === 'Delete' || e.key === 'Del') {
          e.preventDefault()
          const selId = store.selectedProductId
          if (selId) store.removeItem(selId)
        }
        if (e.key === '+' || e.key === '=') {
          e.preventDefault()
          const selId = store.selectedProductId
          if (selId) {
            const item = store.items.find(i => i.productId === selId)
            if (item) store.updateQty(selId, +(item.qty + 1).toFixed(3))
          }
        }
        if (e.key === '-') {
          e.preventDefault()
          const selId = store.selectedProductId
          if (selId) {
            const item = store.items.find(i => i.productId === selId)
            if (item) store.updateQty(selId, +(item.qty - 1).toFixed(3))
          }
        }
      }

      // В фокусі пошуку Enter додає перший результат — це вже оброблено в SearchPanel
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [store.items, store.selectedProductId, store.removeItem, store.updateQty])

  if (!shift) {
    return (
      <OpenShiftScreen
        onOpened={() => {
          shiftApi.current().then(({ data }) => store.setCurrentShift(data))
        }}
      />
    )
  }

  async function handleConfirmPayment(
    method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer',
    cashReceived?: number,
    bonusRedeemed?: number,
    split?: { cash_amount: number; card_amount: number },
    isFiscal?: boolean,
    terminalAuthCode?: string,
  ) {
    // Офлайн-режим: тільки готівкові продажі без ПРРО
    if (!serverOnline) {
      if (method === 'card' || method === 'debt') {
        toast.error('Оплата карткою та в борг недоступна в офлайн-режимі')
        return
      }
      const { currentShift, items, customer, notes, managerId, total, getActiveTab } = store
      if (!currentShift || !items.length) return

      const offlineSale = {
        offline_id:      crypto.randomUUID(),
        created_at:      new Date().toISOString(),
        shift_id:        currentShift.id,
        customer_id:     customer?.id ?? null,
        manager_id:      managerId,
        items:           items.map((i) => ({ product_id: i.productId, qty: i.qty, unit_price: i.unitPrice, discount: i.discount })),
        payment_method:  method,
        total,
        notes:           notes || null,
        idempotency_key: getActiveTab()?.idempotencyKey ?? crypto.randomUUID(),
      }
      await enqueueSale(offlineSale)
      incrementPending()
      store.clearReceipt()
      clearSavedCart()
      setPayOpen(false)
      playCashRegister()
      toast.success(`Продаж збережено офлайн (${offlineSale.offline_id.slice(0,8)})`)
      return
    }

    const sale = await completeSale(method, { cashReceived, bonusRedeemed, split, isFiscal, terminalAuthCode })
    if (sale) {
      setLastSale(sale as Sale)
      clearSavedCart()
      setPayOpen(false)
      playCashRegister()
    }
  }

  function handleRestoreCart(cart: SavedCart) {
    cart.tabs.forEach((savedTab, idx) => {
      if (idx > 0) store.addTab()
      savedTab.items.forEach(item => store.addItem(item))
      if (savedTab.customer) store.setCustomer(savedTab.customer)
      if (savedTab.notes) store.setNotes(savedTab.notes)
    })
    setRecoverCart(null)
    clearSavedCart()
    toast.success('Вкладки відновлено')
  }

  function handleDismissRecover() {
    clearSavedCart()
    setRecoverCart(null)
  }

  return (
    <div className="h-screen-pos flex flex-col bg-[#1A1A1A] overflow-hidden">
      {/* Lock Screen */}
      {isLockedPIN && (
        <LockScreenOverlay onUnlock={() => setLockedPIN(false)} />
      )}

      {/* Crash Recovery — банер відновлення */}
      {recoverCart && (
        <div className="bg-yellow-500/10 border-b border-yellow-500/30 px-4 py-2 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-yellow-300 text-sm">
            <RotateCcw size={14} />
            <span>Знайдено збережений кошик від {new Date(recoverCart.savedAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })} ({recoverCart.tabs.length} вкл., {recoverCart.tabs.reduce((s, t) => s + t.items.reduce((s2, i) => s2 + i.total, 0), 0) / 100} грн)</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => handleRestoreCart(recoverCart)}
              className="px-3 py-1 bg-yellow-500/20 text-yellow-300 text-xs font-medium rounded-lg hover:bg-yellow-500/30 transition-colors">
              Відновити
            </button>
            <button onClick={handleDismissRecover}
              className="px-3 py-1 bg-gray-700 text-gray-400 text-xs rounded-lg hover:text-white transition-colors">
              Скасувати
            </button>
          </div>
        </div>
      )}

      {/* Connectivity banner */}
      {!serverOnline && (
        <div className="shrink-0 bg-red-900/80 border-b border-red-500 px-4 py-2 flex items-center gap-2 text-red-200 text-sm font-medium">
          <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse inline-block" />
          <span>ОФЛАЙН — продажі зберігаються локально і відправляться при відновленні зв'язку</span>
          {pendingCount > 0 && (
            <span className="ml-2 px-2 py-0.5 bg-red-700 rounded-full text-xs font-bold">{pendingCount} в черзі</span>
          )}
        </div>
      )}
      {serverOnline && syncing && (
        <div className="shrink-0 bg-blue-900/60 border-b border-blue-500 px-4 py-1.5 flex items-center gap-2 text-blue-200 text-xs">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-300 animate-pulse inline-block" />
          Синхронізація офлайн-продажів...
        </div>
      )}

      {/* Crash Recovery — знайдено продаж після можливого краша */}
      {crashSale && (
        <div className="bg-blue-900/20 border-b border-blue-500/30 px-4 py-2 flex items-center justify-between shrink-0">
          <span className="text-blue-300 text-sm">
            Знайдено продаж <strong>#{crashSale.sale_number}</strong> на {((crashSale.total ?? 0) / 100).toFixed(2)} ₴ — можливо він пройшов після збою
          </span>
          <button onClick={() => setCrashSale(null)}
            className="ml-4 px-3 py-1 bg-gray-700 text-gray-300 text-xs rounded-lg hover:text-white transition-colors">
            Зрозуміло
          </button>
        </div>
      )}

      {/* Хедер */}
      <header className="bg-[#0D0D0D] border-b border-gray-800 px-3 flex items-center justify-between shrink-0 gap-1" style={{ minHeight: 52 }}>
        {/* Ліва частина — бренд + статус */}
        <div className="flex items-center gap-1.5">
          <button onClick={() => navigate('/dashboard')}
            className="flex items-center justify-center text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 w-10 h-10"
            title="На головну">
            <Home size={18} />
          </button>
          <div className="flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-lg bg-gray-900/50">
            <Zap size={16} className="text-yellow-400" />
            <span className="text-white font-semibold text-sm tracking-wide">Форсаж</span>
            <span className="text-emerald-400 text-[10px] font-medium bg-emerald-900/40 px-2 py-0.5 rounded-full border border-emerald-800/30">Зміна</span>
          </div>
          {/* Manager select — тільки desktop */}
          <select value={store.managerId ?? session?.user?.id ?? ''}
            onChange={(e) => store.setManagerId(e.target.value || null)}
            className="hidden md:block bg-transparent text-gray-400 text-xs border border-gray-800 rounded-lg px-2 py-1.5 focus:outline-none focus:border-yellow-400/50 max-w-[110px] cursor-pointer hover:text-gray-300 appearance-none"
            style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center', paddingRight: '22px' }}>
            {staffUsers.filter((u) => ['owner','admin','manager','cashier'].includes(u.role)).map((u) => (
              <option key={u.id} value={u.id} className="bg-[#1A1A1A]">{u.full_name || u.id.slice(0, 6)}</option>
            ))}
          </select>
        </div>

        {/* Desktop права частина — всі кнопки */}
        <div className="hidden md:flex items-center gap-0.5">
          {lastSale && (
            <button onClick={printReceipt}
              className="flex items-center justify-center text-gray-500 hover:text-white rounded-xl hover:bg-gray-800 w-11 h-11"
              title="Друк чека">
              <Printer size={16} />
            </button>
          )}
          <ReadyOrdersPanel />
          <button onClick={() => setSuspendedOpen(true)}
            className="flex items-center justify-center text-gray-500 hover:text-white rounded-lg hover:bg-gray-800 w-9 h-9 relative"
            title="Відкладені чеки">
            <span className="text-base leading-none">📦</span>
            {suspendedCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[8px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                {suspendedCount > 9 ? '9+' : suspendedCount}
              </span>
            )}
          </button>
          <button onClick={() => setCashOpen(true)}
            className="flex items-center justify-center text-gray-500 hover:text-white rounded-xl hover:bg-gray-800 w-11 h-11"
            title="Касові операції">
            <ArrowLeftRight size={16} />
          </button>
          <button onClick={() => setDebtPayOpen(true)}
            className="flex items-center justify-center text-red-500 hover:text-red-400 rounded-xl hover:bg-gray-800 w-11 h-11"
            title="Оплата боргу">
            <DollarSign size={16} />
          </button>
          <button onClick={() => setReconcileOpen(true)}
            className="flex items-center justify-center text-gray-500 hover:text-yellow-400 rounded-xl hover:bg-gray-800 w-11 h-11"
            title="Звірка">
            <span className="text-sm leading-none">📊</span>
          </button>
          <button onClick={handleLock}
            className="flex items-center justify-center text-gray-500 hover:text-yellow-400 rounded-xl hover:bg-gray-800 w-11 h-11"
            title="Заблокувати">
            <Lock size={16} />
          </button>
          <button onClick={() => setHelpOpen(true)}
            className="flex items-center justify-center text-gray-500 hover:text-white rounded-xl hover:bg-gray-800 w-11 h-11"
            title="Довідка (F1)">
            <Keyboard size={16} />
          </button>
          <button onClick={toggleFullscreen}
            className="flex items-center justify-center text-gray-500 hover:text-white rounded-xl hover:bg-gray-800 w-11 h-11"
            title="На весь екран">
            {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
          <div className="w-px h-7 bg-gray-800 mx-1.5" />
          <div className="flex items-center gap-2 mr-1">
            <span className="text-yellow-400 font-bold text-lg tabular-nums tracking-tight">{formatMoney(store.total)}</span>
            <button onClick={() => setCloseOpen(true)}
              className="flex items-center gap-2 bg-red-900/40 hover:bg-red-800/60 text-red-300 text-sm font-bold px-4 rounded-xl transition-colors h-11 border-2 border-red-900/40 hover:border-red-700/60"
              title="Закрити зміну">
              <LogOut size={16} /> Закрити
            </button>
          </div>
        </div>

        {/* Mobile права частина — тільки найважливіше */}
        <div className="flex md:hidden items-center gap-1">
          <span className="text-yellow-400 font-bold tabular-nums text-base mr-1">{formatMoney(store.total)}</span>
          <button onClick={() => setMobileMenuOpen(true)}
            className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-400 hover:text-white hover:bg-gray-800 active:bg-gray-700 transition-colors text-lg font-bold"
            title="Меню">
            ≡
          </button>
          <button onClick={() => setCloseOpen(true)}
            className="h-10 px-3 bg-red-900/40 text-red-300 text-xs font-bold rounded-xl border border-red-900/40 flex items-center gap-1"
            title="Закрити зміну">
            <LogOut size={14} />
          </button>
        </div>
      </header>

      {/* ─── Мобільне меню-шторка ─────────────────────────────────── */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileMenuOpen(false)} />
          <div className="absolute bottom-0 left-0 right-0 bg-[#1A1A1A] rounded-t-2xl border-t border-gray-800 p-4 pb-safe">
            <div className="w-10 h-1 bg-gray-700 rounded-full mx-auto mb-5" />

            {/* Вибір менеджера */}
            <div className="mb-4">
              <p className="text-gray-500 text-xs mb-1.5 uppercase tracking-wider">Менеджер</p>
              <select value={store.managerId ?? session?.user?.id ?? ''}
                onChange={(e) => store.setManagerId(e.target.value || null)}
                className="w-full bg-[#2C2C2C] text-gray-300 text-sm border border-gray-700 rounded-xl px-4 py-3 focus:outline-none focus:border-yellow-400/50">
                {staffUsers.filter((u) => ['owner','admin','manager','cashier'].includes(u.role)).map((u) => (
                  <option key={u.id} value={u.id} className="bg-[#1A1A1A]">{u.full_name || u.id.slice(0, 6)}</option>
                ))}
              </select>
            </div>

            {/* Сітка дій */}
            <div className="grid grid-cols-4 gap-3 mb-4">
              {[
                { icon: '🖨️', label: 'Друк', action: () => { printReceipt(); setMobileMenuOpen(false) }, disabled: !lastSale },
                { icon: '📦', label: 'Відкладені', action: () => { setSuspendedOpen(true); setMobileMenuOpen(false) }, badge: suspendedCount },
                { icon: '↔️', label: 'Каса', action: () => { setCashOpen(true); setMobileMenuOpen(false) } },
                { icon: '💸', label: 'Борг', action: () => { setDebtPayOpen(true); setMobileMenuOpen(false) } },
                { icon: '📊', label: 'Звірка', action: () => { setReconcileOpen(true); setMobileMenuOpen(false) } },
                { icon: '🔒', label: 'Блок', action: () => { handleLock(); setMobileMenuOpen(false) } },
                { icon: '❓', label: 'Довідка', action: () => { setHelpOpen(true); setMobileMenuOpen(false) } },
                { icon: isFullscreen ? '⬜' : '⛶', label: 'Екран', action: () => { toggleFullscreen(); setMobileMenuOpen(false) } },
              ].map(({ icon, label, action, disabled, badge }) => (
                <button key={label} onClick={action} disabled={disabled}
                  className="relative flex flex-col items-center gap-1.5 p-3 bg-[#2C2C2C] rounded-xl active:bg-gray-600 disabled:opacity-30 transition-colors">
                  <span className="text-2xl leading-none">{icon}</span>
                  <span className="text-[11px] text-gray-400">{label}</span>
                  {!!badge && badge > 0 && (
                    <span className="absolute top-1.5 right-1.5 bg-red-500 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Кнопка закриття зміни */}
            <button
              onClick={() => { setCloseOpen(true); setMobileMenuOpen(false) }}
              className="w-full py-4 bg-red-900/50 hover:bg-red-800/60 text-red-300 font-bold rounded-xl border border-red-800/30 flex items-center justify-center gap-2 active:bg-red-800/80 transition-colors">
              <LogOut size={18} /> Закрити зміну
            </button>
          </div>
        </div>
      )}

      {/* Mobile tabs — тільки на телефоні */}
      <div className="md:hidden flex border-b border-gray-800 shrink-0 bg-[#0D0D0D]">
        <button
          onClick={() => setMobileTab('search')}
          className={`flex-1 py-3 text-sm font-semibold transition-colors ${mobileTab === 'search' ? 'text-yellow-400 border-b-2 border-yellow-400' : 'text-gray-500'}`}
        >
          🔍 Пошук
        </button>
        <button
          onClick={() => setMobileTab('cart')}
          className={`flex-1 py-3 text-sm font-semibold transition-colors flex flex-col items-center gap-0.5 ${mobileTab === 'cart' ? 'text-yellow-400 border-b-2 border-yellow-400' : 'text-gray-500'}`}
        >
          <span className="flex items-center gap-1.5">
            🛒 Кошик
            {store.items.length > 0 && (
              <span className="min-w-[18px] h-[18px] bg-yellow-400 text-black text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                {store.items.length}
              </span>
            )}
          </span>
          {store.total > 0 && (
            <span className="text-[11px] text-yellow-400/80 tabular-nums font-medium leading-none">
              {formatMoney(store.total)} ₴
            </span>
          )}
        </button>
      </div>

      {/* Основна панель POS */}
      <div className="flex-1 flex min-h-0">
        <div className={`flex-1 border-r border-gray-800 min-h-0 ${mobileTab === 'cart' ? 'hidden md:flex md:flex-col' : 'flex flex-col'}`}>
          <SearchPanel ref={searchRef} />
          <DashboardPanel onSearch={(q) => searchRef.current?.search(q)} />
          <CrossSellPanel />
        </div>
        <div className={`md:w-[35%] md:min-w-[320px] lg:w-[40%] xl:w-[420px] min-h-0 flex flex-col w-full ${mobileTab === 'search' ? 'hidden md:flex' : 'flex'}`}>
          <ReceiptPanel
            onPay={() => { setPayOpen(true) }}
            onSelectCustomer={() => setCustomerOpen(true)}
            onClear={originalClear}
          />
        </div>
      </div>

      <FavoritesPanel />

      {/* Модалки */}
      <ShiftCloseModal
        open={closeOpen}
        shiftId={shift.id}
        onClose={() => setCloseOpen(false)}
        onClosed={() => {
          store.setCurrentShift(null)
          clearSavedCart()
          store.clearReceipt()
          setCloseOpen(false)
        }}
      />

      <PaymentModal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        onConfirm={handleConfirmPayment}
      />

      <QuickCustomerModal
        open={customerOpen}
        onClose={() => setCustomerOpen(false)}
        onCreated={(c: Customer) => {
          store.setCustomer({
            id:              c.id,
            phone:           c.phone,
            name:            c.full_name,
            debtBalance:     c.debt_balance,
            tierDiscountPct: c.price_tier?.discount_pct ?? 0,
            tierName:        c.price_tier?.name ?? null,
            vipLevel:        c.vip_level ?? 'standard',
            riskProfile:     c.risk_profile ?? 'low',
          })
        }}
      />

      <CashOperationModal
        open={cashOpen}
        shiftId={shift.id}
        onClose={() => setCashOpen(false)}
      />
      <CashReconciliationModal
        open={reconcileOpen}
        onClose={() => setReconcileOpen(false)}
      />
      <DebtPaymentModal
        open={debtPayOpen}
        onClose={() => setDebtPayOpen(false)}
        onPaid={() => {}}
      />

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SuspendModal open={suspendOpen} onClose={() => setSuspendOpen(false)} onSuspended={() => setSuspendOpen(false)} />
      <SuspendedListModal open={suspendedOpen} onClose={() => setSuspendedOpen(false)}
        onResume={(sale) => {
          // Resume logic: load items from sale into current tab
          sale.sale_items?.forEach((item) => {
            store.addItem({
              productId: item.product_id,
              sku: item.product?.sku ?? '',
              name: item.product?.name ?? '',
              unit: item.product?.unit ?? 'шт',
              qty: item.qty,
              unitPrice: item.unit_price,
              discount: item.discount,
              qtyOnHand: 0,
            })
          })
          if (sale.customer) {
            store.setCustomer({
              id: sale.customer.id,
              phone: sale.customer.phone,
              name: sale.customer.full_name ?? null,
              debtBalance: 0,
              tierDiscountPct: 0,
              tierName: null,
              vipLevel: 'standard',
              riskProfile: 'low',
            })
          }
        }} />

      {/* Hotkeys cheat sheet — постійна підказка для касира */}
      <div className="shrink-0 bg-[#0D0D0D] border-t border-gray-800 px-4 py-1 flex items-center gap-4 overflow-x-auto select-none print:hidden">
        {[
          ['F1', 'Довідка'],
          ['F2', 'Пошук'],
          ['F3', '+Вкладка'],
          ['F4', 'Клієнт'],
          ['F5', 'Відкласти'],
          ['F6', 'Відкладені'],
          ['F8', 'Оплата'],
          ['Del', 'Видалити'],
          ['+/−', 'К-сть'],
        ].map(([key, label]) => (
          <span key={key} className="flex items-center gap-1 whitespace-nowrap">
            <kbd className="text-[10px] font-mono bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded border border-gray-700">{key}</kbd>
            <span className="text-[10px] text-gray-500">{label}</span>
          </span>
        ))}
      </div>

      {/* Прихований чек для друку */}
      {lastSale && <ReceiptPrint sale={lastSale} />}
    </div>
  )
}
