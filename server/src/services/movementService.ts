import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'

export interface MovementResult {
  movement_id: string
  product_name: string
  from_bin: string | null
  to_bin: string
  qty: number
}

export interface MovementRecord {
  id: string
  tenant_id: string
  product_id: string
  from_bin: string | null
  to_bin: string
  qty: number
  moved_by: string | null
  note: string | null
  created_at: string
  product_name?: string
  product_sku?: string
}

export class MovementService {
  /**
   * Створює переміщення товару між комірками через атомарний RPC
   */
  static async createMovement(params: {
    tenantId: string
    productId: string
    qty: number
    fromBin?: string | null
    toBin: string
    movedBy: string
    note?: string | null
  }): Promise<MovementResult> {
    const { data, error } = await db.rpc('process_warehouse_movement', {
      p_tenant_id: params.tenantId,
      p_product_id: params.productId,
      p_qty: params.qty,
      p_from_bin: params.fromBin ?? null,
      p_to_bin: params.toBin,
      p_moved_by: params.movedBy,
      p_note: params.note ?? null,
    })

    if (error) {
      logger.error({ error: error.message }, 'Failed to create warehouse movement')
      throw new Error(error.message)
    }

    return data as MovementResult
  }

  /**
   * Отримує список переміщень з інформацією про товар
   */
  static async listMovements(params: {
    tenantId: string
    page?: number
    perPage?: number
    productId?: string
  }): Promise<{ data: MovementRecord[], total: number }> {
    const page = params.page ?? 1
    const perPage = params.perPage ?? 50
    const offset = (page - 1) * perPage

    let query = db
      .from('warehouse_movements')
      .select(`
        *,
        products:product_id (name, sku)
      `, { count: 'exact' })
      .eq('tenant_id', params.tenantId)
      .order('created_at', { ascending: false })
      .range(offset, offset + perPage - 1)

    if (params.productId) {
      query = query.eq('product_id', params.productId)
    }

    const { data, error, count } = await query

    if (error) {
      logger.error({ error: error.message }, 'Failed to list warehouse movements')
      throw new Error(error.message)
    }

    const records: MovementRecord[] = (data ?? []).map((row: any) => ({
      ...row,
      product_name: row.products?.name ?? '',
      product_sku: row.products?.sku ?? '',
    }))

    return { data: records, total: count ?? 0 }
  }
}
