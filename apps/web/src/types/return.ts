export type ReturnReason =
  | 'defective'
  | 'wrong_part'
  | 'changed_mind'
  | 'warranty'
  | 'duplicate'
  | 'other'

export type RefundMethod =
  | 'cash'
  | 'terminal'
  | 'debt_reduction'
  | 'credit'

export type StockAction =
  | 'return_to_stock'
  | 'write_off'
  | 'send_to_supplier'

export type ItemCondition =
  | 'good'
  | 'damaged'
  | 'opened_packaging'
  | 'defective'

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  defective: 'Brakovana detal',
  wrong_part: 'Ne ta detal',
  changed_mind: 'Kliient peredumav',
  warranty: 'Garanriia',
  duplicate: 'Dublikat',
  other: 'Inshe',
}

export const REFUND_METHOD_LABELS: Record<RefundMethod, string> = {
  cash: 'Povernennia gotivkoiu',
  terminal: 'Povernennia na terminal',
  debt_reduction: 'Zmenshennia borhu',
  credit: 'Kredyt',
}

export const STOCK_ACTION_LABELS: Record<StockAction, string> = {
  return_to_stock: 'Povernuty na sklad',
  write_off: 'Spysaty',
  send_to_supplier: 'Vidpravyty postachalnyku',
}

export const ITEM_CONDITION_LABELS: Record<ItemCondition, string> = {
  good: 'Spravnyi',
  damaged: 'Poshkodzhenyi',
  opened_packaging: 'Rozkryta upakovka',
  defective: 'Shliub',
}

// Який stock_action дозволений для кожного condition
export const CONDITION_ALLOWED_ACTIONS: Record<ItemCondition, StockAction[]> = {
  good: ['return_to_stock', 'write_off', 'send_to_supplier'],
  damaged: ['return_to_stock', 'write_off', 'send_to_supplier'],
  opened_packaging: ['return_to_stock', 'write_off', 'send_to_supplier'],
  defective: ['write_off', 'send_to_supplier'],
}

// Stock_action за замовчуванням для кожного condition
export const DEFAULT_STOCK_ACTION_FOR_CONDITION: Record<ItemCondition, StockAction> = {
  good: 'return_to_stock',
  damaged: 'return_to_stock',
  opened_packaging: 'return_to_stock',
  defective: 'write_off',
}

// Опис умови для підказки
export const CONDITION_DESCRIPTIONS: Record<ItemCondition, string> = {
  good: 'Tovar u tovarnomu vygliadi, mozhna prodavaty',
  damaged: 'Tovar poshkodzheno, ale mozhna prodaty zi znyshkoiu',
  opened_packaging: 'Upakovku rozkryto, ale tovar spravnyi',
  defective: 'Brak, ne pidliahaie prodazhu',
}

/** Позиція чека з інформацією для повернення */
export interface SaleItemForReturn {
  id: string
  product_id: string
  product_name: string
  sku: string
  unit: string
  qty: number
  unit_price: number
  total: number
  already_returned_qty: number
  available_qty: number
}

/** Дані з GET /api/v1/returns/sale/:id/items */
export interface SaleForReturn {
  sale: {
    id: string
    sale_number: string
    status: string
    customer_id: string | null
    total: number
    completed_at: string
  }
  items: SaleItemForReturn[]
}

/** Одна позиція в запиті на створення повернення */
export interface ReturnItemBody {
  sale_item_id: string
  product_id: string
  quantity: number
  condition: ItemCondition
}

/** Тіло POST /api/v1/returns */
export interface CreateReturnBody {
  sale_id: string
  reason: ReturnReason
  reason_note?: string | null
  refund_method: RefundMethod
  stock_action: StockAction
  items: ReturnItemBody[]
}

/** Повернення з БД */
export interface CustomerReturn {
  id: string
  sale_id: string
  customer_id: string | null
  return_type: string
  reason: ReturnReason
  reason_note: string | null
  refund_method: RefundMethod
  refund_kopecks: number
  stock_action: string
  status: string
  approved_by: string
  created_at: string
  sale?: { id: string; sale_number: string; total: number }
  customer?: { id: string; phone: string; full_name: string | null } | null
  return_items?: Array<{
    id: string
    product_id: string
    quantity: number
    unit_price_kopecks: number
    total_kopecks: number
    condition: string
  }>
}

export interface PaginatedReturns {
  data: CustomerReturn[]
  pagination: {
    page: number
    per_page: number
    total: number
    total_pages: number
  }
}