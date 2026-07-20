import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import type { PaginatedWriteoffs, Writeoff, WriteoffReason } from '@/types/writeoff'

export interface WarehouseMovementInput {
  product_id: string
  qty: number
  from_bin?: string | null
  to_bin: string
  note?: string | null
  user_id?: string | null
}

export interface ReserveInput {
  product_id: string
  qty: number
  customer_id?: string | null
  order_id?: string | null
  expires_at?: string | null
  user_id?: string | null
}

function requiredDesktopWarehouse() {
  const warehouse = desktopBridge()?.warehouse
  if (!warehouse) throw new Error('Локальне складське сховище ще не готове')
  return warehouse
}

export const warehouseApi = {
  async listMovements(filters: { page?: number; per_page?: number } = {}): Promise<any> {
    if (desktopBridge()) return requiredDesktopWarehouse().listMovements(filters)
    const params = new URLSearchParams()
    if (filters.page) params.set('page', String(filters.page))
    if (filters.per_page) params.set('per_page', String(filters.per_page))
    return api.get<any>('/api/v1/warehouse/movements' + (params.size ? '?' + params.toString() : ''))
  },

  async createMovement(body: WarehouseMovementInput): Promise<any> {
    if (desktopBridge()) return requiredDesktopWarehouse().createMovement(body)
    return api.post<any>('/api/v1/warehouse/movements', body)
  },

  async listReserves(): Promise<{ data: any[] }> {
    if (desktopBridge()) return { data: await requiredDesktopWarehouse().listReserves() }
    return api.get<{ data: any[] }>('/api/v1/reserves')
  },

  async createReserve(body: ReserveInput): Promise<any> {
    if (desktopBridge()) return requiredDesktopWarehouse().createReserve(body)
    return api.post<any>('/api/v1/reserves', body)
  },

  async releaseReserve(id: string): Promise<any> {
    if (desktopBridge()) return requiredDesktopWarehouse().releaseReserve(id)
    return api.delete<any>('/api/v1/reserves/' + id)
  },

  async listWriteoffs(filters: { reason?: WriteoffReason; page?: number; per_page?: number } = {}): Promise<PaginatedWriteoffs> {
    if (desktopBridge()) return requiredDesktopWarehouse().listWriteoffs(filters)
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value))
    })
    return api.get<PaginatedWriteoffs>('/api/v1/writeoffs' + (params.size ? '?' + params.toString() : ''))
  },

  async getWriteoff(id: string): Promise<{ data: Writeoff }> {
    if (desktopBridge()) return { data: await requiredDesktopWarehouse().getWriteoff(id) as Writeoff }
    return api.get<{ data: Writeoff }>('/api/v1/writeoffs/' + id)
  },

  async createWriteoff(body: {
    reason: WriteoffReason
    notes?: string | null
    items: Array<{ product_id: string; qty: number }>
  }): Promise<{ data: Writeoff }> {
    if (desktopBridge()) return { data: await requiredDesktopWarehouse().createWriteoff(body) as Writeoff }
    return api.post<{ data: Writeoff }>('/api/v1/writeoffs', body)
  },
}
