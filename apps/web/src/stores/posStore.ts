import { create } from 'zustand'
import type { Shift } from '@/types/shift'

export interface POSItem {
  productId: string
  sku: string
  name: string
  unit: string
  qty: number
  unitPrice: number    // копійки
  discount: number     // копійки
  total: number        // копійки
}

export interface POSCustomer {
  id: string
  phone: string
  name: string | null
  debtBalance: number  // копійки
}

interface POSState {
  // Зміна
  currentShift: Shift | null
  setCurrentShift: (shift: Shift | null) => void

  // Чек
  items: POSItem[]
  customer: POSCustomer | null
  notes: string
  subtotal: number
  totalDiscount: number
  total: number

  // Дії
  addItem: (item: Omit<POSItem, 'total'>) => void
  removeItem: (productId: string) => void
  updateQty: (productId: string, qty: number) => void
  setDiscount: (productId: string, discount: number) => void
  setCustomer: (customer: POSCustomer | null) => void
  setNotes: (notes: string) => void
  clearReceipt: () => void
}

function calcTotals(items: POSItem[]) {
  const subtotal      = items.reduce((s, i) => s + i.unitPrice * i.qty, 0)
  const totalDiscount = items.reduce((s, i) => s + i.discount, 0)
  return { subtotal, totalDiscount, total: subtotal - totalDiscount }
}

export const usePOSStore = create<POSState>((set, get) => ({
  currentShift:  null,
  setCurrentShift: (shift) => set({ currentShift: shift }),

  items: [], customer: null, notes: '',
  subtotal: 0, totalDiscount: 0, total: 0,

  addItem: (item) => {
    const { items } = get()
    const existing = items.find((i) => i.productId === item.productId)
    const updated = existing
      ? items.map((i) => i.productId === item.productId
          ? { ...i, qty: i.qty + item.qty, total: (i.qty + item.qty) * i.unitPrice - i.discount }
          : i)
      : [...items, { ...item, total: item.qty * item.unitPrice - item.discount }]
    set({ items: updated, ...calcTotals(updated) })
  },

  removeItem: (productId) => {
    const updated = get().items.filter((i) => i.productId !== productId)
    set({ items: updated, ...calcTotals(updated) })
  },

  updateQty: (productId, qty) => {
    if (qty <= 0) { get().removeItem(productId); return }
    const updated = get().items.map((i) =>
      i.productId === productId ? { ...i, qty, total: qty * i.unitPrice - i.discount } : i)
    set({ items: updated, ...calcTotals(updated) })
  },

  setDiscount: (productId, discount) => {
    const updated = get().items.map((i) =>
      i.productId === productId ? { ...i, discount, total: i.qty * i.unitPrice - discount } : i)
    set({ items: updated, ...calcTotals(updated) })
  },

  setCustomer: (customer) => set({ customer }),
  setNotes:    (notes)    => set({ notes }),

  clearReceipt: () => set({
    items: [], customer: null, notes: '',
    subtotal: 0, totalDiscount: 0, total: 0,
  }),
}))
