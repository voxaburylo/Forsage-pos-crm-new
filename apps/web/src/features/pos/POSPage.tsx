import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, LogOut, ArrowLeftRight, RotateCcw, Home, LayoutGrid, CircleDollarSign, Wrench, ReceiptText } from 'lucide-react'
import { usePOS } from './usePOS'
import { SearchPanel, type SearchPanelHandle } from './SearchPanel'
import { ReceiptPanel } from './ReceiptPanel'
import { PaymentModal } from './PaymentModal'
import { ShiftCloseModal } from './ShiftCloseModal'
import { ReceiptPrint, printReceipt } from './ReceiptPrint'
import { ReceiptFinderModal } from './ReceiptFinderModal'
import { saleApi } from './saleApi'
import { QuickCustomerModal } from '@/features/customers/QuickCustomerModal'
import { QuickCustomerEditModal } from '@/features/customers/QuickCustomerEditModal'
import { customerApi } from '@/features/customers/customerApi'
import { CashOperationModal } from './CashOperationModal'
import { DebtPaymentModal } from './DebtPaymentModal'
import { CashReconciliationModal } from './CashReconciliationModal'
import { FavoritesPanel } from './FavoritesPanel'
import { CrossSellPanel } from './CrossSellPanel'
import { ReadyOrdersPanel } from './ReadyOrdersPanel'
import { QuickChargeModal } from './QuickChargeModal'
import { HelpModal } from './HelpModal'
import { SuspendModal } from './SuspendModal'
import { SuspendedListModal } from './SuspendedListModal'
import { LockScreenOverlay, isLocked } from './LockScreenOverlay'
import { shiftApi } from './shiftApi'
import { usePOSStore, type POSItem, type POSCustomer } from '@/stores/posStore'
import type { Customer } from '@/types/customer'
import type { Sale } from '@/types/sale'
import type { Shift } from '@/types/shift'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'
import { initAudio, playCashRegister } from '@/lib/audioService'
import { api } from '@/lib/api'
import { adminApi } from '@/features/admin/adminApi'
import { useAuthStore } from '@/stores/authStore'
import { useServerStatus } from '@/hooks/useServerStatus'
import { useOfflineSync } from '@/hooks/useOfflineSync'
import { cacheCurrentShift, decrementCachedStock, enqueueSale, getCachedStaff } from '@/lib/offlineDB'
import { OfflineSalesModal } from './OfflineSalesModal'
import { usePOSBarcodeScanner } from './usePOSBarcodeScanner'
import { desktopBridge } from '@/lib/desktopBridge'

const CART_KEY = 'forsage_pos_cart'

interface SavedCart {
  tabs: Array<{ idempotencyKey: string; items: POSItem[]; customer: POSCustomer | null; notes: string }>
  savedAt: string
  shiftId: string | null
}

function saveCart(store: { tabs: Array<{ idempotencyKey: string; items: POSItem[]; customer: POSCustomer | null; notes: string }>; currentShift: { id: string } | null }) {
  try {
    const hasItems = store.tabs.some((t) => Array.isArray(t.items) && t.items.length > 0)
    if (!hasItems) { localStorage.removeItem(CART_KEY); return }
    const cart: SavedCart = {
      tabs: store.tabs.map((t) => ({ idempotencyKey: t.idempotencyKey, items: t.items, customer: t.customer, notes: t.notes })),
      savedAt: new Date().toISOString(),
      shiftId: store.currentShift?.id ?? null,
    }
    localStorage.setItem(CART_KEY, JSON.stringify(cart))
  } catch (error) {
    console.warn('Не вдалося зберегти аварійну копію кошика', error)
  }
}

function loadCart(): SavedCart | null {
  try {
    const raw = localStorage.getItem(CART_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedCart>
    if (!Array.isArray(parsed.tabs)) {
      localStorage.removeItem(CART_KEY)
      return null
    }
    const tabs = parsed.tabs.slice(0, 5).flatMap((tab) => {
      if (!tab || !Array.isArray(tab.items)) return []
      const savedOperationId = typeof tab.idempotencyKey === 'string'
        && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(tab.idempotencyKey.trim())
        ? tab.idempotencyKey.trim()
        : crypto.randomUUID()
      const items = tab.items.flatMap((rawItem) => {
        const item = rawItem as Partial<POSItem>
        const qty = Number(item.qty)
        const unitPrice = Number(item.unitPrice)
        if (!item.productId || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) return []
        const discount = Math.max(0, Math.min(Number(item.discount) || 0, unitPrice * qty))
        return [{
          productId: String(item.productId),
          sku: String(item.sku ?? ''),
          name: String(item.name ?? item.sku ?? 'Товар'),
          unit: String(item.unit ?? 'шт'),
          qty,
          unitPrice,
          discount,
          discountPct: Number.isFinite(Number(item.discountPct)) ? Number(item.discountPct) : undefined,
          total: unitPrice * qty - discount,
          qtyOnHand: Number(item.qtyOnHand) || 0,
          requiresCoreReturn: Boolean(item.requiresCoreReturn),
          coreDepositAmount: Number(item.coreDepositAmount) || 0,
        }]
      })
      return items.length > 0 ? [{
        idempotencyKey: savedOperationId,
        items,
        customer: tab.customer ?? null,
        notes: String(tab.notes ?? ''),
      }] : []
    })
    if (tabs.length === 0) {
      localStorage.removeItem(CART_KEY)
      return null
    }
    return {
      tabs,
      savedAt: Number.isFinite(Date.parse(parsed.savedAt ?? '')) ? String(parsed.savedAt) : new Date().toISOString(),
      shiftId: typeof parsed.shiftId === 'string' ? parsed.shiftId : null,
    }
  } catch {
    try { localStorage.removeItem(CART_KEY) } catch { /* storage may be unavailable */ }
    return null
  }
}

function clearSavedCart() {
  try { localStorage.removeItem(CART_KEY) } catch { /* storage may be unavailable */ }
}

function posCustomerFromCustomer(c: Customer): POSCustomer {
  const tierDiscountPct = (c as any).loyalty_mode === 'cashback' ? 0 : (c.price_tier?.discount_pct ?? c.discount_pct ?? 0)
  return {
    id: c.id,
    phone: c.phone,
    name: c.full_name,
    debtBalance: c.debt_balance,
    tierDiscountPct,
    tierName: c.price_tier?.name ?? null,
    vipLevel: c.vip_level ?? 'standard',
    riskProfile: c.risk_profile ?? 'low',
  }
}
function savedCartTotal(cart: SavedCart): number {
  return cart.tabs.reduce(
    (sum, tab) => sum + tab.items.reduce((itemSum, item) => itemSum + (Number(item.total) || 0), 0),
    0,
  )
}

const LAST_CLOSE_CASH_KEY = 'forsage_last_shift_close_cash'
const POS_READ_TIMEOUT_MS = 10_000
const POS_ACTIVE_ORDER_STATUSES = 'lead,quoted,new,in_progress,ordered,arrived,called,no_answer,ready'

function isShiftAlreadyOpenError(error: unknown) {
  const status = (error as { status?: number } | null)?.status
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return status === 409 || message.includes('вже є відкрита зміна') || message.includes('already open')
}

function OpenShiftScreen({ onOpened, onBack }: { onOpened: (shift?: Shift) => void; onBack: () => void }) {
  // Підставляємо залишок із закриття попередньої зміни (та сама каса)
  const [cash, setCash]       = useState(() => localStorage.getItem(LAST_CLOSE_CASH_KEY) ?? '')
  const [loading, setLoading] = useState(false)
  const parsedCash = cash.trim() === '' ? 0 : Number(cash)
  const cashValid = Number.isFinite(parsedCash) && parsedCash >= 0

  async function handleOpen() {
    if (loading || !cashValid) return
    const kopecks = Math.round(parsedCash * 100)
    setLoading(true)
    try {
      const desktop = desktopBridge()
      const cashierId = useAuthStore.getState().session?.user?.id ?? ''
      if (desktop && cashierId) {
        await desktop.pos.openShift({ cashier_id: cashierId, opening_cash: kopecks })
        window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      } else {
        const { data } = await shiftApi.open(kopecks, undefined, { silent: true })
        onOpened(data)
        toast.success('Зміну відкрито')
        return
      }
      toast.success('Зміну відкрито')
      onOpened()
    } catch (e) {
      if (isShiftAlreadyOpenError(e)) {
        toast.warning('Зміна вже відкрита. Оновлюємо касу...')
        onOpened()
        return
      }
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
      <div className="bg-[#2C2C2C] rounded-2xl p-10 w-full max-w-sm text-center border border-gray-700">
        <button
          type="button"
          onClick={onBack}
          className="mb-5 text-gray-400 hover:text-white text-sm transition-colors"
        >
          ← На головну
        </button>
        <Zap size={40} className="text-yellow-400 mx-auto mb-4" />
        <h1 className="text-white text-2xl font-bold mb-1">Відкрити зміну</h1>
        <p className="text-gray-500 text-sm mb-6">Введіть початковий залишок готівки в касі</p>
        <input
          type="number" min="0" step="0.01" autoFocus
          value={cash}
          onChange={(e) => setCash(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !loading && cashValid) handleOpen() }}
          placeholder="0.00 ₴"
          aria-label="Початковий залишок готівки"
          className="w-full bg-[#1A1A1A] text-white text-2xl font-bold text-center rounded-xl px-4 py-4 border border-gray-700 focus:outline-none focus:border-yellow-400 mb-4"
        />
        {!cashValid && <p className="text-red-400 text-xs -mt-2 mb-3">Вкажіть невід’ємну суму</p>}
        <button onClick={handleOpen} disabled={loading || !cashValid} style={{ minHeight: 56 }}
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
  const { store, completeSale, checkShift, fiscalRecovery, resolveFiscalRecovery } = usePOS()
  const setPriceRounding = usePOSStore((state) => state.setPriceRounding)
  const [payOpen, setPayOpen]           = useState(false)
  const [fiscalRecoveryText, setFiscalRecoveryText] = useState('')
  const [resolvingFiscal, setResolvingFiscal] = useState(false)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [customerEditOpen, setCustomerEditOpen] = useState(false)
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
  const [closeOpen, setCloseOpen]       = useState(false)
  const [cashOpen, setCashOpen]         = useState(false)
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [debtPayOpen, setDebtPayOpen] = useState(false)
  const [debtCustomer, setDebtCustomer] = useState<Customer | null>(null)
  const [suspendOpen, setSuspendOpen]   = useState(false)
  const [suspendedOpen, setSuspendedOpen] = useState(false)
  const [, setSuspendedCount] = useState(0)
  const [lastSale, setLastSale]         = useState<Sale | null>(null)
  const autoPrintRef                    = useRef(false)
  const paymentPrintChoiceRef           = useRef<boolean | null>(null)
  const skipNextAutoPrintRef            = useRef(false)
  const [findReceiptOpen, setFindReceiptOpen] = useState(false)
  const [offlineSalesOpen, setOfflineSalesOpen] = useState(false)

  // Повторний друк будь-якого чека, обраного у вікні пошуку (ReceiptFinderModal).
  // Реюз єдиного слота lastSale + ReceiptPrint, щоб не монтувати два чеки одночасно
  // (інакше window.print() надрукував би обидва — селектор друку не прив'язаний до екземпляра).
  async function handleReprintSale(saleId: string) {
    try {
      const { data } = await saleApi.get(saleId, { silent: true })
      paymentPrintChoiceRef.current = null
      skipNextAutoPrintRef.current = true   // це повторний друк, не новий продаж — не плутати з авто-друком
      setLastSale(data as Sale)
      setTimeout(() => printReceipt(), 300)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося завантажити чек')
    }
  }
  const [recoverCart, setRecoverCart]   = useState<SavedCart | null>(null)
  const [crashSale, setCrashSale]       = useState<Sale | null>(null)
  const [helpOpen, setHelpOpen]         = useState(false)
  const [isLockedPIN, setLockedPIN]     = useState(isLocked())
  const serverOnline = useServerStatus()
  const desktopRuntime = Boolean(desktopBridge())
  const effectiveOnline = desktopRuntime || serverOnline
  const { pendingCount, syncing, incrementPending, syncPendingSales } = useOfflineSync(serverOnline)
  const [isEmployeeSale] = useState(false)
  const [staffUsers, setStaffUsers]     = useState<Array<{ id: string; full_name: string; role: string }>>([])
  const session = useAuthStore((s) => s.session)
  // Dashboard is restricted to office roles. Sending a cashier there caused
  // ProtectedRoute to redirect back to POS, which looked like a frozen Home
  // button. Use the regular application menu for non-office roles instead.
  const role = (session?.user?.app_metadata?.role as string) ?? 'cashier'
  const homeRoute = ['owner', 'admin', 'manager'].includes(role) ? '/dashboard' : '/products'
  const searchRef = useRef<SearchPanelHandle>(null)
  const earlyBarcodeScans = useRef<string[]>([])
  const routeBarcodeScan = useCallback((code: string) => {
    if (findReceiptOpen) {
      window.dispatchEvent(new CustomEvent('forsage:receipt-finder-scan', { detail: { code } }))
      return
    }
    const panel = searchRef.current
    if (panel) {
      panel.scanBarcode(code)
      return
    }
    // Перший скан може прийти між підключенням глобального HID-обробника
    // та монтуванням SearchPanel. Не втрачаємо його.
    earlyBarcodeScans.current.push(code)
  }, [findReceiptOpen])
  usePOSBarcodeScanner({
    onScan: routeBarcodeScan,
  })

  useEffect(() => {
    if (store.isInitializing) return
    const frame = window.requestAnimationFrame(() => {
      const panel = searchRef.current
      if (!panel || earlyBarcodeScans.current.length === 0) return
      const queued = earlyBarcodeScans.current.splice(0)
      for (const code of queued) panel.scanBarcode(code)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [store.isInitializing])

  async function handleEditCustomerFromSearch(customer: Customer) {
    try {
      const { data } = await customerApi.get(customer.id)
      setEditingCustomer(data)
      setCustomerOpen(false)
      setCustomerEditOpen(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося завантажити клієнта')
    }
  }

  const refreshSuspendedCount = useCallback(() => {
    saleApi.listSuspended({ silent: true }).then((res) => setSuspendedCount(res.data.length)).catch(() => {})
  }, [])

  const shift = store.currentShift
  const [mobileTab, setMobileTab] = useState<'search' | 'cart' | 'ready_orders'>('search')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickCharge, setQuickCharge] = useState<'tire_service' | 'free_sale' | null>(null)
  const [readyOrdersCount, setReadyOrdersCount] = useState(0)

  // Завантажуємо список співробітників для шиномонтажу + знижку працівника
  useEffect(() => {
    const localStaff = desktopBridge()?.catalog.listStaff
    const staffRequest = localStaff
      ? localStaff().then((data) => ({ data }))
      : api.get<{ data: Array<{ id: string; full_name: string; role: string }> }>('/api/v1/admin/staff-options', {
          silent: true,
          timeoutMs: POS_READ_TIMEOUT_MS,
        })
    staffRequest
      .then((res) => setStaffUsers(res.data))
      .catch(() => {
        if (session?.user?.id) {
          getCachedStaff(session.user.id).then(setStaffUsers).catch(() => {})
        }
      })    // Лічильник відкладених чеків
    refreshSuspendedCount()
    // Знижка працівника та конфігурація швидких товарів
    adminApi.getSettings()
      .then((res: any) => {
        const data = res.data
        autoPrintRef.current = data.auto_print_receipt ?? false
        localStorage.setItem('forsage_receipt_width_mm', String(data.receipt_width_mm ?? 58))
        setPriceRounding({
          enabled: data.price_rounding_enabled === true,
          step: Number(data.price_rounding_step) || 100,
          dir: data.price_rounding_dir === 'up' || data.price_rounding_dir === 'down' ? data.price_rounding_dir : 'nearest',
        })
      })
      .catch(() => {})

    // Кількість активних замовлень для мобільного таба
    const loadReadyCount = () => {
      const localReady = desktopBridge()?.orders?.listReady
      if (localReady) {
        localReady({ limit: 80 }).then((data) => setReadyOrdersCount(data.length)).catch(() => {})
        return
      }
      api.get(`/api/v1/customer-orders?status=${POS_ACTIVE_ORDER_STATUSES}&per_page=80`, { silent: true, timeoutMs: POS_READ_TIMEOUT_MS })
        .then((res: any) => {
          const data = res.data
          if (Array.isArray(data)) setReadyOrdersCount(data.length)
        })
        .catch(() => {})
    }
    loadReadyCount()
    const id = setInterval(loadReadyCount, 10000)
    return () => clearInterval(id)
  }, [refreshSuspendedCount, setPriceRounding])

  // Авто-друк чека після продажу (вмикається в Налаштуваннях).
  // Чекаємо рендер прихованого <ReceiptPrint> перед window.print().
  useEffect(() => {
    if (!lastSale) return
    // Повторний друк зі списку чеків сам викликає друк — не дублюємо авто-друком
    if (skipNextAutoPrintRef.current) { skipNextAutoPrintRef.current = false; return }
    const explicitChoice = paymentPrintChoiceRef.current
    paymentPrintChoiceRef.current = null
    if (explicitChoice === true || (explicitChoice === null && autoPrintRef.current)) {
      const t = setTimeout(() => printReceipt(), 250)
      return () => clearTimeout(t)
    }
  }, [lastSale])

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
      saleApi.checkAfterPayment(attempt.shift_id, attempt.attempt_at, { silent: true })
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
    // Під час серії сканів не серіалізуємо весь чек після кожного товару.
    // Останній стан зберігається одразу після короткої паузи.
    const timer = window.setTimeout(() => saveCart(store), 180)
    return () => window.clearTimeout(timer)
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
      // Не перехоплюємо якщо фокус на input (крім F-клавіш та Esc)
      const isInput = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA'
      // Escape закриває відкриті модалки
      const anyModalOpen = payOpen || customerOpen || customerEditOpen || closeOpen || cashOpen || reconcileOpen || debtPayOpen || suspendOpen || suspendedOpen || helpOpen || findReceiptOpen
      if (e.key === 'Escape' && anyModalOpen) {
        e.preventDefault()
        setPayOpen(false)
        setCustomerOpen(false)
        setCustomerEditOpen(false)
        setCloseOpen(false)
        setCashOpen(false)
        setReconcileOpen(false)
        setDebtPayOpen(false)
        setSuspendOpen(false)
        setSuspendedOpen(false)
        setHelpOpen(false)
        setFindReceiptOpen(false)
        return
      }

      if (e.key === 'Escape' && !isInput) {
        searchRef.current?.clear()
      }

      // Навігація по чеку — тільки коли не в полі пошуку
      if (!isInput) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (store.items.length > 0) {
            const currentIdx = store.items.findIndex(i => i.productId === store.selectedProductId)
            const nextIdx = currentIdx === -1 || currentIdx === store.items.length - 1 ? 0 : currentIdx + 1
            store.setSelectedProductId(store.items[nextIdx].productId)
          }
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (store.items.length > 0) {
            const currentIdx = store.items.findIndex(i => i.productId === store.selectedProductId)
            const prevIdx = currentIdx === -1 || currentIdx === 0 ? store.items.length - 1 : currentIdx - 1
            store.setSelectedProductId(store.items[prevIdx].productId)
          }
        }
        if (e.key === 'Delete' || e.key === 'Del') {
          e.preventDefault()
          const selId = store.selectedProductId
          if (selId) store.removeItem(selId)
        }
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [store.items, store.selectedProductId, store.removeItem, store.updateQty, payOpen, customerOpen, customerEditOpen, closeOpen, cashOpen, reconcileOpen, debtPayOpen, suspendOpen, suspendedOpen, helpOpen, findReceiptOpen])

  if (store.isInitializing) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex flex-col items-center justify-center">
        <div className="animate-pulse flex flex-col items-center">
          <Zap size={48} className="text-yellow-400 animate-spin mb-4" style={{ animationDuration: '3s' }} />
          <h2 className="text-white text-xl font-bold mb-2">Ініціалізація каси...</h2>
          <p className="text-gray-500 text-sm">Перевіряємо статус касової зміни</p>
        </div>
      </div>
    )
  }

  if (store.initError) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <div className="bg-[#2C2C2C] rounded-2xl p-10 w-full max-w-md text-center border border-red-900/30 shadow-xl">
          <div className="w-16 h-16 rounded-full bg-red-900/20 border border-red-500/30 flex items-center justify-center mx-auto mb-4">
            <span className="text-red-400 text-3xl">⚠️</span>
          </div>
          <h1 className="text-white text-2xl font-bold mb-2">Помилка з'єднання</h1>
          <p className="text-gray-400 text-sm mb-6">{store.initError}</p>
          <button onClick={checkShift} style={{ minHeight: 52 }}
            className="w-full bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-lg rounded-xl py-3 active:scale-95 transition-all">
            Спробувати знову
          </button>
        </div>
      </div>
    )
  }

  if (!shift) {
    return (
      <OpenShiftScreen
        onBack={() => navigate(homeRoute)}
        onOpened={(openedShift) => {
          if (openedShift) store.setCurrentShift(openedShift)
          else checkShift()
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
    printAfterPayment?: boolean,
  ): Promise<boolean> {
    async function saveOfflineSale() {
      const scopeKey = session?.user?.id ?? ''
      if (!scopeKey) {
        toast.error('??? ???????? ??????-???, ???????? ?? ????? ?????????? ??????')
        return null
      }
      if (method === 'card' || method === 'debt' || method === 'mixed') {
        toast.error('Офлайн доступні лише готівка та переказ')
        return null
      }
      if (isFiscal) {
        toast.error('ПРРО потребує інтернету. Вимкніть «Фіскальний чек» або дочекайтеся зв’язку')
        return null
      }
      if ((bonusRedeemed ?? 0) > 0) {
        toast.error('Списання бонусів потребує інтернету')
        return null
      }

      const {
        currentShift, items, customer, customerOrderId, notes, managerId,
        total, totalDiscount, getActiveTab,
      } = store
      if (!currentShift || !items.length) return null
      const hasTireService = items.some((item) => item.sku === 'POS-TIRE-SERVICE')
      const saleManagerId = hasTireService ? (managerId ?? currentShift.cashier_id ?? null) : (currentShift.cashier_id ?? session?.user?.id ?? null)

      const offlineId = crypto.randomUUID()
      const createdAt = new Date().toISOString()
      const idempotencyKey = getActiveTab()?.idempotencyKey ?? crypto.randomUUID()
      const offlineSale = {
        offline_id:      offlineId,
        scope_key:      scopeKey,
        created_at:      createdAt,
        shift_id:        currentShift.id,
        customer_id:     customer?.id ?? null,
        customer_order_id: customerOrderId || null,
        manager_id:      saleManagerId,
        items:           items.map((i) => ({
          product_id: i.productId,
          qty: i.qty,
          unit_price: i.unitPrice,
          discount: i.discount,
        })),
        receipt_items:   items.map((i) => ({
          product_id: i.productId,
          sku: i.sku,
          name: i.name,
          unit: i.unit,
        })),
        customer_snapshot: customer
          ? { phone: customer.phone, full_name: customer.name }
          : null,
        payment_method:  method,
        total,
        notes:           notes || null,
        is_fiscal:       false as const,
        terminal_auth_code: null,
        discount:        totalDiscount,
        bonuses_spent:   0 as const,
        cash_amount:     method === 'cash' ? total : 0,
        card_amount:     0 as const,
        idempotency_key: idempotencyKey,
        sync_status:     'pending' as const,
        sync_attempts:   0,
        last_error:      null,
      }

      try {
        await enqueueSale(offlineSale)
      } catch {
        toast.error('Не вдалося зберегти чек у браузері. Не приймайте оплату та повторіть')
        return null
      }

      await decrementCachedStock(offlineSale.items).catch(() => {})
      incrementPending()
      const localReceipt: Sale = {
        id: offlineId,
        sale_number: `OFF-${offlineId.slice(0, 8).toUpperCase()}`,
        customer_id: customer?.id ?? null,
        cashier_id: scopeKey,
        manager_id: saleManagerId,
        shift_id: currentShift.id,
        status: 'completed',
        subtotal: items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0),
        discount: totalDiscount,
        total,
        payment_method: method,
        is_debt: false,
        notes: notes || null,
        completed_at: createdAt,
        is_fiscal: false,
        fiscal_number: null,
        bank_auth_code: null,
        cash_amount: method === 'cash' ? total : 0,
        card_amount: 0,
        pickup_cell: null,
        customer: customer ? { id: customer.id, phone: customer.phone, full_name: customer.name } : null,
        sale_items: items.map((item) => ({
          id: `${offlineId}-${item.productId}`,
          product_id: item.productId,
          qty: item.qty,
          unit_price: item.unitPrice,
          discount: item.discount,
          total: item.unitPrice * item.qty - item.discount,
          product: { id: item.productId, sku: item.sku, name: item.name, unit: item.unit },
        })),
      }
      paymentPrintChoiceRef.current = printAfterPayment === true
      setLastSale(localReceipt)
      store.clearReceipt()
      clearSavedCart()
      setPayOpen(false)
      playCashRegister()
      toast.success(`Офлайн-чек ${localReceipt.sale_number} збережено і буде синхронізовано`)
      return localReceipt
    }

    // Браузерна PWA без інтернету пише продажі в IndexedDB-чергу.
    // Desktop/EXE має власну SQLite-касу, тому навіть без інтернету йде через
    // completeSale() і не дублює чек у браузерному кеші.
    if (!serverOnline && !desktopBridge()) {
      return Boolean(await saveOfflineSale())
    }

    try {
      const sale = await completeSale(method, { cashReceived, bonusRedeemed, split, isFiscal, terminalAuthCode })
      if (sale) {
        paymentPrintChoiceRef.current = printAfterPayment === true
        setLastSale(sale as Sale)
        clearSavedCart()
        setPayOpen(false)
        playCashRegister()
        return true
      }
      return false
    } catch {
      // Зв'язок міг зникнути після останньої health-перевірки. Той самий
      // idempotency key гарантує, що при синхронізації дубль не створиться.
      return Boolean(await saveOfflineSale())
    }
  }

  function handleRestoreCart(cart: SavedCart) {
    try {
      const availableTargets = store.tabs.filter((tab) => tab.items.length === 0).length + Math.max(0, 5 - store.tabs.length)
      if (cart.tabs.length > availableTargets) {
        toast.error(`Потрібно вільних вкладок: ${cart.tabs.length}. Закрийте зайві чеки та повторіть.`)
        return
      }
      let restored = 0
      for (const savedTab of cart.tabs) {
        const ok = store.restoreReceipt({
          idempotencyKey: savedTab.idempotencyKey,
          items: savedTab.items,
          customer: savedTab.customer,
          notes: savedTab.notes,
        })
        if (!ok) break
        restored++
      }
      if (restored !== cart.tabs.length) {
        toast.error('Не вистачає вільних вкладок або кошик пошкоджений. Закрийте зайву вкладку й повторіть.')
        return
      }
      setRecoverCart(null)
      clearSavedCart()
      toast.success(restored > 1 ? `Відновлено вкладок: ${restored}` : 'Кошик відновлено')
    } catch (error) {
      console.error('Помилка відновлення збереженого кошика', error)
      toast.error('Кошик пошкоджений. Його можна безпечно видалити кнопкою поруч.')
    }
  }

  function handleDismissRecover() {
    setRecoverCart(null)
    clearSavedCart()
    toast.success('Збережену копію кошика видалено')
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#1A1A1A]">
      <div
        className="pos-app-shell flex h-full w-full flex-col overflow-hidden bg-[#1A1A1A]"
      >
      {/* Lock Screen */}
      {isLockedPIN && (
        <LockScreenOverlay onUnlock={() => setLockedPIN(false)} />
      )}

      {/* Crash Recovery — банер відновлення */}
      {recoverCart && (
        <div className="bg-yellow-500/10 border-b border-yellow-500/30 px-4 py-2 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-yellow-300 text-sm">
            <RotateCcw size={14} />
            <span>Знайдено збережений кошик від {new Date(recoverCart.savedAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })} ({recoverCart.tabs.length} вкл., {(savedCartTotal(recoverCart) / 100).toFixed(2)} грн)</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => handleRestoreCart(recoverCart)}
              className="px-3 py-1 bg-yellow-500/20 text-yellow-300 text-xs font-medium rounded-lg hover:bg-yellow-500/30 transition-colors">
              Відновити
            </button>
            <button onClick={handleDismissRecover}
              className="px-3 py-1 bg-gray-700 text-gray-400 text-xs rounded-lg hover:text-white transition-colors">
              Видалити копію
            </button>
          </div>
        </div>
      )}

      {/* Connectivity banner */}
      {!desktopRuntime && !serverOnline && (
        <div className="shrink-0 bg-red-900/80 border-b border-red-500 px-4 py-2 flex items-center gap-2 text-red-200 text-sm font-medium">
          <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse inline-block" />
          <span>ОФЛАЙН — продажі зберігаються локально і відправляться при відновленні зв'язку</span>
          {pendingCount > 0 && (
            <span className="ml-2 px-2 py-0.5 bg-red-700 rounded-full text-xs font-bold">{pendingCount} в черзі</span>
          )}
          <button
            type="button"
            onClick={() => setOfflineSalesOpen(true)}
            className="ml-auto rounded-lg bg-red-700 px-3 py-1 text-xs font-bold text-white hover:bg-red-600"
          >
            Журнал
          </button>
        </div>
      )}


      {/* Crash Recovery — знайдено продаж після можливого краша */}
      {crashSale && (
        <div className="bg-blue-900/20 border-b border-blue-500/30 px-4 py-2 flex items-center justify-between gap-3 shrink-0">
          <span className="text-blue-300 text-sm">
            Знайдено продаж <strong>#{crashSale.sale_number}</strong> на {((crashSale.total ?? 0) / 100).toFixed(2)} ₴ — схоже, він пройшов після збою. Не пробивайте повторно, якщо це той самий чек.
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { handleReprintSale(crashSale.id); setCrashSale(null) }}
              className="px-3 py-1 bg-blue-700 text-white text-xs rounded-lg hover:bg-blue-600 transition-colors">
              Друк чека
            </button>
            <button
              onClick={() => { store.clearReceipt(); clearSavedCart(); setRecoverCart(null); setCrashSale(null) }}
              className="px-3 py-1 bg-emerald-700 text-white text-xs rounded-lg hover:bg-emerald-600 transition-colors">
              Це той самий — очистити кошик
            </button>
            <button onClick={() => setCrashSale(null)}
              className="px-3 py-1 bg-gray-700 text-gray-300 text-xs rounded-lg hover:text-white transition-colors">
              Це інший продаж
            </button>
          </div>
        </div>
      )}

      {/* Хедер */}
      <header className="bg-[#0D0D0D] border-b border-gray-800 px-2 md:px-3 flex items-center justify-between shrink-0 gap-1 h-11 md:h-13">
        {/* Ліва частина — бренд + статус */}
        <div className="flex items-center gap-1 md:gap-1.5">
          <button onClick={() => navigate(homeRoute)}
            className="flex items-center justify-center text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 w-8 h-8 md:w-10 md:h-10"
            title="На головну">
            <Home className="size-4 md:size-[18px]" />
          </button>
          <div className="flex items-center gap-1 pl-1 pr-1.5 py-0.5 md:pl-1.5 md:pr-2 md:py-1 rounded-lg bg-gray-900/50">
            <Zap className="text-yellow-400 size-3.5 md:size-4" />
            <span className="text-white font-semibold text-xs md:text-sm tracking-wide">Форсаж</span>
          </div>
        </div>

        {/* Desktop права частина — щоденні дії з підписами, решта в меню «Ще» */}
        <div className="hidden md:flex items-center gap-0.5">
          <ReadyOrdersPanel />
          <button onClick={() => setCashOpen(true)}
            className="flex items-center gap-1.5 h-10 px-2.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors text-xs font-medium"
            title="Внесення та витрата готівки">
            <ArrowLeftRight size={15} /><span className="hidden xl:inline">Каса</span>
          </button>
          <button onClick={() => navigate('/returns')}
            className="flex items-center gap-1.5 h-10 px-2.5 rounded-lg text-orange-400 hover:text-orange-300 hover:bg-gray-800 transition-colors text-xs font-medium"
            title="Повернення товару за чеком">
            <RotateCcw size={15} /><span className="hidden xl:inline">Повернення</span>
          </button>
          <button onClick={() => setFindReceiptOpen(true)}
            className="flex items-center gap-1.5 h-10 px-2.5 rounded-lg text-blue-300 hover:text-blue-200 hover:bg-gray-800 transition-colors text-xs font-medium"
            title="Останні чеки за 14 днів, пошук і повторний друк">
            <ReceiptText size={15} /><span className="hidden xl:inline">Чеки</span>
          </button>
          <div className="w-px h-7 bg-gray-800 mx-1" />
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
        <div className="flex md:hidden items-center gap-2">
          <span className="text-yellow-400 font-bold tabular-nums text-sm mr-1">{formatMoney(store.total)}</span>
          <button onClick={() => setMobileMenuOpen(true)}
            className="w-9 h-9 flex items-center justify-center rounded-xl bg-[#2C2C2C] text-gray-400 hover:text-white hover:bg-gray-750 active:bg-gray-700 transition-colors text-lg font-bold border border-gray-700"
            title="Меню">
            ≡
          </button>
        </div>
      </header>

      {/* ─── Мобільне меню-шторка ─────────────────────────────────── */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileMenuOpen(false)} />
          <div className="absolute bottom-0 left-0 right-0 bg-[#1A1A1A] rounded-t-2xl border-t border-gray-800 p-4 pb-safe">
            <div className="w-10 h-1 bg-gray-700 rounded-full mx-auto mb-5" />

            {/* Сітка дій */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              {[
                { icon: '🛞', label: 'Шиномонтаж', action: () => { setQuickCharge('tire_service'); setMobileMenuOpen(false) } },
                { icon: '💰', label: 'Вільна сума', action: () => { setQuickCharge('free_sale'); setMobileMenuOpen(false) } },
                { icon: '↔️', label: 'Каса', action: () => { setCashOpen(true); setMobileMenuOpen(false) } },
                { icon: '↩️', label: 'Повернення', action: () => { setMobileMenuOpen(false); navigate('/returns') } },
                { icon: '🧾', label: 'Чеки', action: () => { setFindReceiptOpen(true); setMobileMenuOpen(false) } },
              ].map(({ icon, label, action }) => (
                <button key={label} onClick={action}
                  className="relative flex flex-col items-center gap-1.5 p-3 bg-[#2C2C2C] rounded-xl active:bg-gray-600 disabled:opacity-30 transition-colors">
                  <span className="text-2xl leading-none">{icon}</span>
                  <span className="text-[11px] text-gray-400">{label}</span>
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

      {/* Основна панель POS */}
      <div className="flex-1 flex min-h-0 min-w-0">
        {mobileTab === 'ready_orders' ? (
          <div className="flex-1 flex flex-col min-h-0 min-w-0 md:hidden bg-[#1A1A1A]">
            <ReadyOrdersPanel isMobileInline onCloseMobile={() => setMobileTab('search')} />
          </div>
        ) : (
          <>
            <div className={`flex-1 border-r border-gray-800 min-h-0 min-w-0 ${mobileTab === 'cart' ? 'hidden md:flex md:flex-col' : 'flex flex-col'}`}>
              <SearchPanel ref={searchRef} />
              <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-gray-800 bg-[#111] px-2 py-2">
                <button onClick={() => setQuickCharge('tire_service')}
                  className="flex h-10 shrink-0 items-center gap-2 rounded-xl border border-emerald-700/50 bg-emerald-900/30 px-4 text-sm font-bold text-emerald-300 hover:bg-emerald-900/50"
                  title="Прийняти оплату за шиномонтаж і зарахувати роботу працівнику">
                  <Wrench size={16} /> Шиномонтаж
                </button>
                <button onClick={() => setQuickCharge('free_sale')}
                  className="flex h-10 shrink-0 items-center gap-2 rounded-xl border border-orange-700/50 bg-orange-900/30 px-4 text-sm font-bold text-orange-300 hover:bg-orange-900/50"
                  title="Продаж за довільною сумою без товару в каталозі">
                  <CircleDollarSign size={16} /> Вільна сума
                </button>
                <button onClick={() => setQuickOpen(true)}
                  className="flex h-10 shrink-0 items-center gap-2 rounded-xl border border-gray-700 bg-gray-800 px-4 text-sm font-semibold text-gray-300 hover:bg-gray-700">
                  <LayoutGrid size={16} /> Товари швидкого доступу
                </button>
              </div>
              <div className="hidden md:block">
                <CrossSellPanel />
              </div>
            </div>
            <div className={`md:w-[35%] md:min-w-[320px] lg:w-[40%] xl:w-[420px] min-h-0 flex flex-col w-full ${mobileTab === 'search' ? 'hidden md:flex' : 'flex'}`}>
              <ReceiptPanel
                onPay={() => { setPayOpen(true) }}
                onSelectCustomer={() => setCustomerOpen(true)}
                onClear={originalClear}
                onClearCustomer={() => { store.setCustomer(null); store.setAutomaticDiscountPct(0) }}
              />
            </div>
          </>
        )}
      </div>

      {/* Mobile tabs — тільки на телефоні (тепер знизу з відступом safe-area) */}
      <div className="md:hidden flex border-t border-gray-800 shrink-0 bg-[#0D0D0D] pb-safe">
        <button
          onClick={() => { setMobileTab('search'); setQuickOpen(true); }}
          className={`flex-1 py-2 text-[11px] font-semibold transition-all flex flex-col items-center justify-center ${mobileTab === 'search' ? 'text-yellow-400 bg-gray-900/40' : 'text-gray-500'}`}
        >
          <span className="text-lg mb-0.5">🍔</span>
          <span>Меню</span>
        </button>
        
        <button
          onClick={() => setMobileTab('ready_orders')}
          className={`flex-1 py-2 text-[11px] font-semibold transition-all flex flex-col items-center justify-center ${mobileTab === 'ready_orders' ? 'text-yellow-400 bg-gray-900/40' : 'text-gray-500'}`}
        >
          <span className="relative text-lg mb-0.5">
            📦
            {readyOrdersCount > 0 && (
              <span className="absolute -top-1 -right-2 min-w-[16px] h-[16px] bg-orange-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-0.5">
                {readyOrdersCount}
              </span>
            )}
          </span>
          <span>Замовлення</span>
        </button>

        <button
          onClick={() => setMobileTab('cart')}
          className={`flex-1 py-2 text-[11px] font-semibold transition-all flex flex-col items-center justify-center ${mobileTab === 'cart' ? 'text-yellow-400 bg-gray-900/40' : 'text-gray-500'}`}
        >
          <span className="relative text-lg mb-0.5">
            🛒
            {store.items.length > 0 && (
              <span className="absolute -top-1 -right-2 min-w-[16px] h-[16px] bg-yellow-400 text-black text-[9px] font-bold rounded-full flex items-center justify-center px-0.5">
                {store.items.length}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1">
            Кошик
            {store.total > 0 && (
              <span className="text-[10px] text-yellow-400/80 tabular-nums">
                ({formatMoney(store.total)})
              </span>
            )}
          </span>
        </button>
      </div>

      <FavoritesPanel open={quickOpen} onClose={() => setQuickOpen(false)} />
      <QuickChargeModal
        open={quickCharge !== null}
        kind={quickCharge ?? 'free_sale'}
        staff={staffUsers.filter((u) => ['admin','manager','cashier','sto_viewer','tire_worker'].includes(u.role))}
        offline={!effectiveOnline}
        onClose={() => setQuickCharge(null)}
      />
      <OfflineSalesModal
        open={offlineSalesOpen}
        online={effectiveOnline}
        syncing={syncing}
        refreshKey={pendingCount}
        onClose={() => setOfflineSalesOpen(false)}
        onSync={syncPendingSales}
      />

      {/* Модалки */}
      <ShiftCloseModal
        open={closeOpen}
        shiftId={shift.id}
        offline={!effectiveOnline}
        pendingOfflineSales={pendingCount}
        onClose={() => setCloseOpen(false)}
        onClosed={() => {
          store.setCurrentShift(null)
          if (session?.user?.id) cacheCurrentShift(null, session.user.id).catch(() => {})
          clearSavedCart()
          store.clearReceipt()
          setCloseOpen(false)
          // After a successful shift close, leave the full-screen POS instead
          // of keeping the cashier on the empty OpenShiftScreen.
          navigate(homeRoute)
        }}
      />

      <PaymentModal
        open={payOpen}
        offline={!effectiveOnline}
        onClose={() => setPayOpen(false)}
        onConfirm={handleConfirmPayment}
      />
      {fiscalRecovery && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/85 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fiscal-recovery-title"
        >
          <div className="w-full max-w-lg rounded-2xl border border-red-500/50 bg-[#181818] p-6 shadow-2xl">
            <h2 id="fiscal-recovery-title" className="text-xl font-bold text-red-300">
              Не повторюйте оплату
            </h2>
            <p className="mt-3 text-sm leading-6 text-gray-200">
              Програма не може підтвердити результат попередньої фіскалізації.
              Спочатку відкрийте Cashalot і перевірте, чи з’явився там цей чек.
            </p>
            <p className="mt-3 rounded-lg bg-black/30 p-3 text-sm text-yellow-200">
              {fiscalRecovery.message}
            </p>
            <p className="mt-2 break-all text-xs text-gray-500">
              Операція: {fiscalRecovery.operationId}
            </p>
            <div className="mt-5 rounded-xl border border-gray-700 bg-[#101010] p-4">
              <p className="text-sm font-semibold text-white">
                Лише якщо чека в Cashalot немає
              </p>
              <p className="mt-1 text-xs leading-5 text-gray-400">
                Введіть «ЧЕКА НЕМАЄ». Якщо чек є — не розблоковуйте операцію:
                це захищає від подвійного списання з клієнта.
              </p>
              <input
                autoFocus
                value={fiscalRecoveryText}
                onChange={(event) => setFiscalRecoveryText(event.target.value)}
                placeholder="ЧЕКА НЕМАЄ"
                className="mt-3 w-full rounded-xl border border-gray-600 bg-[#222] px-4 py-3 text-white outline-none focus:border-yellow-400"
              />
              <button
                type="button"
                disabled={resolvingFiscal || fiscalRecoveryText.trim().toUpperCase() !== 'ЧЕКА НЕМАЄ'}
                onClick={async () => {
                  setResolvingFiscal(true)
                  const resolved = await resolveFiscalRecovery()
                  if (resolved) setFiscalRecoveryText('')
                  setResolvingFiscal(false)
                }}
                className="mt-3 w-full rounded-xl bg-yellow-400 px-4 py-3 font-bold text-black disabled:cursor-not-allowed disabled:opacity-40"
              >
                {resolvingFiscal ? 'Перевіряємо...' : 'Я перевірив: чека немає, розблокувати'}
              </button>
            </div>
          </div>
        </div>
      )}

      <QuickCustomerModal
        open={customerOpen}
        offline={!effectiveOnline}
        onClose={() => setCustomerOpen(false)}
        onEdit={handleEditCustomerFromSearch}
        onPayDebt={(c) => {
          setCustomerOpen(false)
          setDebtCustomer(c)
          setDebtPayOpen(true)
        }}
        onCreated={(c: Customer) => {
          const posCustomer = posCustomerFromCustomer(c)
          store.setCustomer(posCustomer)
          if (!isEmployeeSale) store.setAutomaticDiscountPct(posCustomer.tierDiscountPct)
        }}
      />

      <QuickCustomerEditModal
        customer={editingCustomer}
        open={customerEditOpen}
        onClose={() => setCustomerEditOpen(false)}
        onSaved={(c) => {
          const posCustomer = posCustomerFromCustomer(c)
          if (store.customer?.id === c.id) {
            store.setCustomer(posCustomer)
            if (!isEmployeeSale) store.setAutomaticDiscountPct(posCustomer.tierDiscountPct)
          }
          setEditingCustomer(c)
          setCustomerEditOpen(false)
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
        initialCustomer={debtCustomer}
        onClose={() => {
          setDebtPayOpen(false)
          setDebtCustomer(null)
        }}
        onPaid={() => {}}
      />

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ReceiptFinderModal open={findReceiptOpen} onClose={() => setFindReceiptOpen(false)} onSelect={handleReprintSale} />
      <SuspendModal open={suspendOpen} onClose={() => setSuspendOpen(false)} onSuspended={() => {
        setSuspendOpen(false)
        refreshSuspendedCount()
      }} />
      <SuspendedListModal open={suspendedOpen} onClose={() => setSuspendedOpen(false)}
        onChanged={refreshSuspendedCount}
        onResume={(sale) => {
          const restoredItems = (sale.sale_items ?? []).map((item) => ({
              productId: item.product_id,
              sku: item.product?.sku ?? '',
              name: item.product?.name ?? '',
              unit: item.product?.unit ?? 'шт',
              qty: item.qty,
              unitPrice: item.unit_price,
              discount: item.discount,
              qtyOnHand: item.product?.qty_on_hand ?? 0,
              requiresCoreReturn: !!item.core_deposit_amount && item.core_deposit_amount > 0,
              coreDepositAmount: item.core_deposit_amount ?? 0,
            }))
          return store.restoreReceipt({
            items: restoredItems,
            notes: sale.notes ?? '',
            customer: sale.customer ? {
              id: sale.customer.id,
              phone: sale.customer.phone,
              name: sale.customer.full_name ?? null,
              debtBalance: 0,
              tierDiscountPct: 0,
              tierName: null,
              vipLevel: 'standard',
              riskProfile: 'low',
            } : null,
          })
        }} />

      {/* Прихований чек для друку */}
      {lastSale && <ReceiptPrint sale={lastSale} />}
      </div>
    </div>
  )
}


