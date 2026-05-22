import { db } from '../db/supabase.js'
import { TaskQueue } from './taskQueue.js'
import { AppError } from '../middleware/errorHandler.js'

export class ReserveService {
  static async releaseExpiredReserves() {
    const { data, error } = await db.rpc('release_expired_reserves')
    if (error) {
      throw new AppError('DB_ERROR', `Failed to release expired reserves: ${error.message}`, 500)
    }
    return data
  }

  static async createManualReserve(input: {
    tenantId: string
    productId: string
    qty: number
    orderId?: string | null
    customerId?: string | null
    expiresAt: string
    userId: string
  }) {
    const { data, error } = await db.rpc('create_manual_reserve', {
      p_tenant_id: input.tenantId,
      p_product_id: input.productId,
      p_qty: input.qty,
      p_order_id: input.orderId || null,
      p_customer_id: input.customerId || null,
      p_expires_at: input.expiresAt,
      p_user_id: input.userId
    })

    if (error) {
      if (error.message.includes('INSUFFICIENT_STOCK')) {
        throw new AppError('INSUFFICIENT_STOCK', error.message, 422)
      }
      if (error.message.includes('PRODUCT_NOT_FOUND')) {
        throw new AppError('PRODUCT_NOT_FOUND', error.message, 404)
      }
      throw new AppError('DB_ERROR', `Failed to create manual reserve: ${error.message}`, 500)
    }

    return data
  }

  static async enqueueCleanupJob(tenantId?: string) {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour from now
    return TaskQueue.enqueue(
      'cleanup_expired_reserves',
      {},
      {
        scheduledAt,
        tenantId: tenantId || '00000000-0000-0000-0000-000000000001'
      }
    )
  }
}
