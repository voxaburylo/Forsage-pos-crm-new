import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { TaskQueue } from './taskQueue.js'

export interface StockIntegrityItem {
  product_id: string
  product_name: string
  sku: string | null
  qty_on_hand: number
  storage_bin: string | null
  updated_at: string
}

export class StockValidatorService {
  /**
   * Перевіряє цілісність залишків — шукає товари з від'ємним qty_on_hand
   */
  static async checkIntegrity(tenantId: string): Promise<StockIntegrityItem[]> {
    const { data, error } = await db.rpc('validate_stock_integrity', {
      p_tenant_id: tenantId,
    })

    if (error) {
      logger.error({ error: error.message }, 'Failed to validate stock integrity')
      throw new Error(`Stock integrity check failed: ${error.message}`)
    }

    return (data ?? []) as StockIntegrityItem[]
  }

  /**
   * Запускає перевірку, записує результати в audit_log
   */
  static async runIntegrityCheck(tenantId: string): Promise<{ issues: StockIntegrityItem[], count: number }> {
    const issues = await StockValidatorService.checkIntegrity(tenantId)

    if (issues.length > 0) {
      // Логуємо розходження в audit_log
      await db.from('audit_log').insert({
        tenant_id: tenantId,
        user_id: '00000000-0000-0000-0000-000000000000',
        user_name: 'system:cron',
        action: 'stock_integrity_check',
        entity_type: 'products',
        entity_label: `Знайдено ${issues.length} товарів з від'ємним залишком`,
        new_value: issues.slice(0, 50), // обмежуємо до 50 записів для аудиту
      })
      logger.warn({ count: issues.length }, 'Stock integrity issues found')
    } else {
      logger.info('Stock integrity check passed — no issues found')
    }

    return { issues, count: issues.length }
  }

  /**
   * Ставить в чергу наступну перевірку цілісності через 6 годин
   */
  static async enqueueNextCheck(tenantId: string): Promise<void> {
    const nextRun = new Date(Date.now() + 6 * 3600 * 1000) // через 6 годин
    await TaskQueue.enqueue('validate_stock_integrity', {}, {
      scheduledAt: nextRun,
      tenantId,
    })
  }
}
