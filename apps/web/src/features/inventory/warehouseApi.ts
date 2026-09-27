import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { durableLocalRequest, pendingLocalRequests, clearPendingLocalRequest } from '@/lib/durableLocalRequest'
import { useAuthStore } from '@/stores/authStore'
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
  duration_days?: number
  user_id?: string | null
}

function requiredDesktopWarehouse() {
  const warehouse = desktopBridge()?.warehouse
  if (!warehouse) throw new Error('Локальне складське сховище ще не готове. Операція доступна лише в локальній програмі.')
  return warehouse
}

export type WarehouseOperationKind = 'movement' | 'reserve' | 'consumption'
const recoveryEvent = 'forsage:warehouse-recovery'
function notifyRecovery() { if (typeof window !== 'undefined') window.dispatchEvent(new Event(recoveryEvent)) }
function operationScope(kind: WarehouseOperationKind) {
  const userId = useAuthStore.getState().session?.user?.id
  if (!userId) throw new Error('Увійдіть у програму для перевірки складської операції')
  return kind + ':' + userId
}
function requireResolver() {
  const resolve = requiredDesktopWarehouse().resolveOperation
  if (!resolve) throw new Error('Для безпечної перевірки операцій потрібна оновлена локальна програма')
  return resolve
}
function validResolution(value: unknown): { status: 'committed'; result: any } | { status: 'not_committed' } {
  const result = value as { status?: string; result?: { id?: string } } | null
  if (result?.status === 'committed' && typeof result.result?.id === 'string' && result.result.id)
    return { status: 'committed', result: result.result }
  if (result?.status === 'not_committed') return { status: 'not_committed' }
  throw new Error('Не вдалося підтвердити результат складської операції')
}
async function warehouseWrite(kind: WarehouseOperationKind, body: unknown, send: (id: string) => Promise<any>) {
  const resolve = requireResolver()
  const scope = operationScope(kind)
  try {
    return await durableLocalRequest(scope, body, async id => {
      const sameUser = () => kind + ':' + useAuthStore.getState().session?.user?.id === scope
      if (!sameUser()) throw new Error('Користувач змінився. Перевірте незавершену спробу під попереднім обліковим записом.')
      try { return await send(id) }
      catch (writeError) {
        // Never resolve/fence the previous user's attempt with a new session.
        if (!sameUser()) throw writeError
        // On uncertainty, the main PC atomically confirms the receipt or fences a late write.
        let resolution
        try { resolution = validResolution(await resolve(kind, id)) }
        catch { throw writeError } // Keep the original error and durable pending marker.
        if (resolution.status === 'committed') return resolution.result
        clearPendingLocalRequest(scope, id)
        throw writeError
      }
    }, localStorage, { exclusive: true })
  } finally { notifyRecovery() }
}

export const warehouseApi = {
  pendingOperations(kind: WarehouseOperationKind) { return pendingLocalRequests(operationScope(kind)) },
  async resolveOperation(kind: WarehouseOperationKind, id: string) {
    const scope = operationScope(kind)
    if (!pendingLocalRequests(scope).some(item => item.operationId === id)) throw new Error('Незавершену спробу не знайдено у цьому сеансі')
    const result = validResolution(await requireResolver()(kind, id))
    clearPendingLocalRequest(scope, id)
    notifyRecovery()
    return result
  },
  async listConsumptions(month: string): Promise<any> {
    return requiredDesktopWarehouse().listConsumptions({ month })
  },
  async createConsumption(body: { employee_id: string; items: Array<{ product_id: string; qty: number }>; note?: string | null }): Promise<any> {
    const warehouse = requiredDesktopWarehouse()
    return warehouseWrite('consumption', body, operation_id => warehouse.createConsumption({ ...body, operation_id }))
  },
  async listMovements(filters: { page?: number; per_page?: number } = {}): Promise<any> {
    if (desktopBridge()) return requiredDesktopWarehouse().listMovements(filters)
    const params = new URLSearchParams()
    if (filters.page) params.set('page', String(filters.page))
    if (filters.per_page) params.set('per_page', String(filters.per_page))
    return api.get<any>('/api/v1/warehouse/movements' + (params.size ? '?' + params.toString() : ''))
  },

  async createMovement(body: WarehouseMovementInput): Promise<any> {
    const warehouse = requiredDesktopWarehouse()
    return warehouseWrite('movement', body, operation_id => warehouse.createMovement({ ...body, operation_id }))
  },

  async listReserves(): Promise<{ data: any[] }> {
    if (desktopBridge()) return { data: await requiredDesktopWarehouse().listReserves() }
    return api.get<{ data: any[] }>('/api/v1/reserves')
  },

  async createReserve(body: ReserveInput): Promise<any> {
    const warehouse = requiredDesktopWarehouse()
    return warehouseWrite('reserve', body, operation_id => warehouse.createReserve({ ...body, operation_id }))
  },

  async releaseReserve(id: string): Promise<any> {
    return requiredDesktopWarehouse().releaseReserve(id)
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
    operation_id?: string
    reason: WriteoffReason
    notes?: string | null
    items: Array<{ product_id: string; qty: number }>
  }): Promise<{ data: Writeoff }> {
    const warehouse = requiredDesktopWarehouse()
    if (body.operation_id) return { data: await warehouse.createWriteoff(body) as Writeoff }
    return { data: await durableLocalRequest('writeoff:' + useAuthStore.getState().session?.user?.id, body, operation_id => warehouse.createWriteoff({ ...body, operation_id })) as Writeoff }
  },
}
