export interface Customer {
  id: string
  phone: string
  full_name: string | null
  email: string | null
  debt_balance: number   // копійки
  notes: string | null
  tags: string[]
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface CustomerSale {
  id: string
  sale_number: string
  total: number          // копійки
  payment_method: string
  status: string
  completed_at: string
}

export interface PaginatedCustomers {
  data: Customer[]
  pagination: {
    page: number
    per_page: number
    total: number
    total_pages: number
  }
}

export const TAGS = ['VIP', 'Оптовик', 'Проблемний', 'СТО'] as const

export function debtColor(debt: number): 'red' | 'orange' | 'green' {
  if (debt > 100000) return 'red'    // > 1000 грн
  if (debt > 0)      return 'orange'
  return 'green'
}
