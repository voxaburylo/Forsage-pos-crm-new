import { create } from 'zustand'
import type { Shift } from '@/types/shift'
import { useAuthStore } from './authStore'

export interface POSItem {
  productId: string
  sku: string
  name: string
  unit: string
  qty: number
  unitPrice: number    // копійки
  discount: number     // копійки
  discountPct?: number // автоматична знижка, що масштабується разом із кількістю
  total: number        // копійки
  qtyOnHand: number    // поточний залишок на складі
  requiresCoreReturn?: boolean
  coreDepositAmount?: number
}

export interface POSCustomer {
  id:              string
  phone:           string
  name:            string | null
  debtBalance:     number   // копійки
  tierDiscountPct: number   // % знижки рівня (0 = немає)
  tierName:        string | null
  vipLevel:        'standard' | 'bronze' | 'silver' | 'gold'
  riskProfile:     'low' | 'medium' | 'high'
}

export interface ReceiptTab {
  id: string
  idempotencyKey: string
  items: POSItem[]
  customer: POSCustomer | null
  notes: string
  subtotal: number
  totalDiscount: number
  totalCoreDeposit: number
  total: number
  selectedProductId: string | null
  bonusToRedeem: number
  customerOrderId: string | null
  automaticDiscountPct: number
}

const MAX_TABS = 5

let tabCounter = 0
function generateTabId(): string {
  tabCounter++
  return 'tab_' + tabCounter + '_' + Date.now().toString(36)
}

function createEmptyTab(): ReceiptTab {
  return {
    id: generateTabId(),
    idempotencyKey: crypto.randomUUID(),
    items: [], customer: null, notes: '',
    subtotal: 0, totalDiscount: 0, totalCoreDeposit: 0, total: 0,
    selectedProductId: null,
    bonusToRedeem: 0,
    customerOrderId: null,
    automaticDiscountPct: 0,
  }
}

function calcTotals(items: POSItem[]) {
  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0)
  const totalDiscount = items.reduce((s, i) => s + i.discount, 0)
  const totalCoreDeposit = items.reduce((s, i) => s + (i.requiresCoreReturn ? (i.coreDepositAmount ?? 0) * i.qty : 0), 0)
  return { subtotal, totalDiscount, totalCoreDeposit, total: subtotal - totalDiscount + totalCoreDeposit }
}

function automaticDiscount(unitPrice: number, qty: number, pct: number) {
  return Math.round(unitPrice * qty * Math.max(0, Math.min(100, pct)) / 100)
}

interface POSState {
  // Зміна (глобальна)
  currentShift: Shift | null
  setCurrentShift: (shift: Shift | null) => void
  isInitializing: boolean
  setInitializing: (val: boolean) => void
  initError: string | null
  setInitError: (err: string | null) => void

  // Вкладки
  tabs: ReceiptTab[]
  activeTabId: string | null

  // Доступ до активної вкладки (комфортні гетери)
  items: POSItem[]
  customer: POSCustomer | null
  notes: string
  subtotal: number
  totalDiscount: number
  totalCoreDeposit: number
  total: number
  selectedProductId: string | null
  bonusToRedeem: number
  customerOrderId: string | null
  automaticDiscountPct: number

  // Менеджер для комісійних (глобальний на всю зміну)
  managerId: string | null
  setManagerId: (id: string | null) => void

  // Управління вкладками
  addTab: () => string
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  getActiveTab: () => ReceiptTab | null

  // Дії (на активній вкладці)
  addItem: (item: Omit<POSItem, 'total'>) => void
  removeItem: (productId: string) => void
  updateQty: (productId: string, qty: number) => void
  setDiscount: (productId: string, discount: number) => void
  setAutomaticDiscountPct: (pct: number) => void
  setCustomer: (customer: POSCustomer | null) => void
  setNotes: (notes: string) => void
  setBonusToRedeem: (amount: number) => void
  setSelectedProductId: (id: string | null) => void
  setCustomerOrderId: (id: string | null) => void
  clearReceipt: () => void
}

function updateTabInStore(set: any, get: any, tabId: string, updates: Partial<ReceiptTab>) {
  const tabs = get().tabs.map((t: ReceiptTab) => t.id === tabId ? { ...t, ...updates } : t)
  set({ tabs, ...getActiveTabGetters(tabs, get().activeTabId) })
}

function getActiveTabGetters(tabs: ReceiptTab[], activeTabId: string | null) {
  const active = tabs.find((t) => t.id === activeTabId)
  if (!active) return {
    items: [], customer: null, notes: '',
    subtotal: 0, totalDiscount: 0, totalCoreDeposit: 0, total: 0,
    selectedProductId: null, bonusToRedeem: 0,
    customerOrderId: null,
    automaticDiscountPct: 0,
  }
  return {
    items: active.items,
    customer: active.customer,
    notes: active.notes,
    subtotal: active.subtotal,
    totalDiscount: active.totalDiscount,
    totalCoreDeposit: active.totalCoreDeposit ?? 0,
    total: active.total,
    selectedProductId: active.selectedProductId,
    bonusToRedeem: active.bonusToRedeem,
    customerOrderId: active.customerOrderId ?? null,
    automaticDiscountPct: active.automaticDiscountPct ?? 0,
  }
}

export const usePOSStore = create<POSState>((set, get) => {
  const initialTab = createEmptyTab()

  return {
    currentShift: null,
    setCurrentShift: (shift) => set({ currentShift: shift, isInitializing: false }),
    isInitializing: true,
    setInitializing: (val) => set({ isInitializing: val }),
    initError: null,
    setInitError: (err) => set({ initError: err }),

    tabs: [initialTab],
    activeTabId: initialTab.id,
    managerId: null,
    setManagerId: (id) => set({ managerId: id }),

    // Гетери — підтягуються з активної вкладки
    ...getActiveTabGetters([initialTab], initialTab.id),

    // Управління вкладками
    addTab: () => {
      const { tabs } = get()
      if (tabs.length >= MAX_TABS) return tabs[0].id
      const newTab = createEmptyTab()
      const updated = [...tabs, newTab]
      set({
        tabs: updated,
        activeTabId: newTab.id,
        ...getActiveTabGetters(updated, newTab.id),
      })
      return newTab.id
    },

    closeTab: (tabId: string) => {
      const { tabs, activeTabId } = get()
      if (tabs.length <= 1) {
        // Закриваємо останню — створюємо нову порожню
        const newTab = createEmptyTab()
        set({
          tabs: [newTab],
          activeTabId: newTab.id,
          ...getActiveTabGetters([newTab], newTab.id),
        })
        return
      }
      const filtered = tabs.filter((t) => t.id !== tabId)
      let nextActive = activeTabId
      if (tabId === activeTabId || activeTabId === null) {
        // Активуємо сусідню
        const idx = tabs.findIndex((t) => t.id === tabId)
        const nextIdx = Math.min(idx, filtered.length - 1)
        nextActive = filtered[nextIdx]?.id ?? filtered[0]?.id ?? null
      }
      set({
        tabs: filtered,
        activeTabId: nextActive,
        ...getActiveTabGetters(filtered, nextActive),
      })
    },

    setActiveTab: (tabId) => {
      const { tabs } = get()
      if (tabs.some((t) => t.id === tabId)) {
        set({
          activeTabId: tabId,
          ...getActiveTabGetters(tabs, tabId),
        })
      }
    },

    getActiveTab: () => {
      const { tabs, activeTabId } = get()
      return tabs.find((t) => t.id === activeTabId) ?? null
    },

    // Дії на активній вкладці
    addItem: (item) => {
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      if (!tab) return
      const existing = tab.items.find((i) => i.productId === item.productId)
      const updatedItems = existing
        ? tab.items.map((i) => {
            if (i.productId !== item.productId) return i
            const qty = i.qty + item.qty
            const discount = i.discountPct !== undefined
              ? automaticDiscount(i.unitPrice, qty, i.discountPct)
              : Math.min(i.discount, i.unitPrice * qty)
            return { ...i, qty, discount, total: qty * i.unitPrice - discount }
          })
        : (() => {
            const discount = item.discountPct !== undefined
              ? automaticDiscount(item.unitPrice, item.qty, item.discountPct)
              : Math.min(item.discount, item.qty * item.unitPrice)
            return [...tab.items, { ...item, discount, total: item.qty * item.unitPrice - discount }]
          })()
      const totals = calcTotals(updatedItems)
      updateTabInStore(set, get, activeTabId!, { items: updatedItems, ...totals })
    },

    removeItem: (productId) => {
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      if (!tab) return
      const updated = tab.items.filter((i) => i.productId !== productId)
      const totals = calcTotals(updated)
      updateTabInStore(set, get, activeTabId!, { items: updated, ...totals })
    },

    updateQty: (productId, qty) => {
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      if (!tab) return
      if (qty <= 0) { get().removeItem(productId); return }
      const updated = tab.items.map((i) =>
        i.productId === productId
          ? (() => {
              const discount = i.discountPct !== undefined
                ? automaticDiscount(i.unitPrice, qty, i.discountPct)
                : Math.min(i.discount, qty * i.unitPrice)
              return { ...i, qty, discount, total: qty * i.unitPrice - discount }
            })()
          : i)
      const totals = calcTotals(updated)
      updateTabInStore(set, get, activeTabId!, { items: updated, ...totals })
    },

    setDiscount: (productId, discount) => {
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      if (!tab) return
      if (discount > 0) {
        const session = useAuthStore.getState().session
        const role = session?.user?.user_metadata?.role as string | undefined
        if (role && !['owner', 'admin', 'manager'].includes(role)) return
      }
      const updated = tab.items.map((i) => {
        if (i.productId !== productId) return i
        const safeDiscount = Math.max(0, Math.min(discount, i.qty * i.unitPrice))
        return { ...i, discount: safeDiscount, discountPct: undefined, total: i.qty * i.unitPrice - safeDiscount }
      })
      const totals = calcTotals(updated)
      updateTabInStore(set, get, activeTabId!, { items: updated, ...totals })
    },

    setAutomaticDiscountPct: (pct) => {
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      if (!tab || !activeTabId) return
      const safePct = Math.max(0, Math.min(100, pct))
      const updated = tab.items.map((item) => {
        // Ручну знижку менеджера не перезаписуємо автоматичною.
        if (item.discount > 0 && item.discountPct === undefined) return item
        const discount = automaticDiscount(item.unitPrice, item.qty, safePct)
        return {
          ...item,
          discount,
          discountPct: safePct > 0 ? safePct : undefined,
          total: item.qty * item.unitPrice - discount,
        }
      })
      const totals = calcTotals(updated)
      updateTabInStore(set, get, activeTabId, {
        items: updated,
        automaticDiscountPct: safePct,
        ...totals,
      })
    },

    setCustomer: (customer) => {
      const { activeTabId } = get()
      if (!activeTabId) return
      updateTabInStore(set, get, activeTabId, { customer } as any)
    },

    setNotes: (notes) => {
      const { activeTabId } = get()
      if (!activeTabId) return
      updateTabInStore(set, get, activeTabId, { notes } as any)
    },

    setBonusToRedeem: (amount) => {
      const { activeTabId } = get()
      if (!activeTabId) return
      updateTabInStore(set, get, activeTabId, { bonusToRedeem: amount } as any)
    },

    setSelectedProductId: (id) => {
      const { activeTabId } = get()
      if (!activeTabId) return
      updateTabInStore(set, get, activeTabId, { selectedProductId: id } as any)
    },

    setCustomerOrderId: (id) => {
      const { activeTabId } = get()
      if (!activeTabId) return
      updateTabInStore(set, get, activeTabId, { customerOrderId: id } as any)
    },

    clearReceipt: () => {
      // Після успішної оплати — закриваємо активну вкладку
      const { activeTabId } = get()
      if (activeTabId) get().closeTab(activeTabId)
    },
  }
})
