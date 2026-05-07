import { create } from 'zustand'

export interface POSItem {
  productId: string
  sku: string
  name: string
  unit: string
  qty: number
  unitPrice: number    // копейки
  discount: number     // копейки
  total: number        // копейки
}

export interface POSCustomer {
  id: string
  phone: string
  name: string | null
  debtBalance: number  // копейки
}

interface POSState {
  items: POSItem[]
  customer: POSCustomer | null
  notes: string
  // Вычисляемые
  subtotal: number
  totalDiscount: number
  total: number
  // Действия
  addItem: (item: Omit<POSItem, 'total'>) => void
  removeItem: (productId: string) => void
  updateQty: (productId: string, qty: number) => void
  setDiscount: (productId: string, discount: number) => void
  setCustomer: (customer: POSCustomer | null) => void
  setNotes: (notes: string) => void
  clearReceipt: () => void
}

function calcTotal(items: POSItem[]) {
  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0)
  const totalDiscount = items.reduce((s, i) => s + i.discount, 0)
  return { subtotal, totalDiscount, total: subtotal - totalDiscount }
}

export const usePOSStore = create<POSState>((set, get) => ({
  items: [],
  customer: null,
  notes: '',
  subtotal: 0,
  totalDiscount: 0,
  total: 0,

  addItem: (item) => {
    const { items } = get()
    const existing = items.find((i) => i.productId === item.productId)
    let updated: POSItem[]
    if (existing) {
      updated = items.map((i) =>
        i.productId === item.productId
          ? { ...i, qty: i.qty + item.qty, total: (i.qty + item.qty) * i.unitPrice - i.discount }
          : i,
      )
    } else {
      const newItem: POSItem = { ...item, total: item.qty * item.unitPrice - item.discount }
      updated = [...items, newItem]
    }
    set({ items: updated, ...calcTotal(updated) })
  },

  removeItem: (productId) => {
    const updated = get().items.filter((i) => i.productId !== productId)
    set({ items: updated, ...calcTotal(updated) })
  },

  updateQty: (productId, qty) => {
    if (qty <= 0) { get().removeItem(productId); return }
    const updated = get().items.map((i) =>
      i.productId === productId
        ? { ...i, qty, total: qty * i.unitPrice - i.discount }
        : i,
    )
    set({ items: updated, ...calcTotal(updated) })
  },

  setDiscount: (productId, discount) => {
    const updated = get().items.map((i) =>
      i.productId === productId
        ? { ...i, discount, total: i.qty * i.unitPrice - discount }
        : i,
    )
    set({ items: updated, ...calcTotal(updated) })
  },

  setCustomer: (customer) => set({ customer }),
  setNotes: (notes) => set({ notes }),

  clearReceipt: () => set({
    items: [], customer: null, notes: '',
    subtotal: 0, totalDiscount: 0, total: 0,
  }),
}))
