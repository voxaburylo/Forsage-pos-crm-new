import { runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'

export interface ArrivedOrderItem {
  id: string
  order_id: string
  product_id: string | null
}

/**
 * Marks order items as arrived only after every requested id has been proved to
 * belong to the same tenant. The lock, validation and update are one database
 * transaction, so a mixed-tenant request can never be partially applied.
 */
export async function markOrderItemsArrived(input: {
  tenant_id: string
  item_ids: string[]
}): Promise<ArrivedOrderItem[]> {
  const itemIds = [...new Set(input.item_ids)]
  if (itemIds.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Оберіть хоча б одну позицію', 422)
  }

  return runTransaction(async (client) => {
    const found = await client.query<ArrivedOrderItem>(
      `SELECT i.id, i.order_id, i.product_id
       FROM customer_order_items i
       JOIN customer_orders o
         ON o.id = i.order_id
        AND o.tenant_id = i.tenant_id
       WHERE i.id = ANY($1::uuid[])
         AND i.deleted_at IS NULL
         AND o.tenant_id = $2
         AND o.deleted_at IS NULL
       FOR UPDATE OF i`,
      [itemIds, input.tenant_id],
    )

    if (found.rowCount !== itemIds.length) {
      throw new AppError(
        'ORDER_ITEMS_NOT_FOUND',
        'Одна або кілька позицій не знайдені у вашому магазині',
        404,
      )
    }

    const updated = await client.query<ArrivedOrderItem>(
      `UPDATE customer_order_items i
       SET item_status = 'arrived', updated_at = NOW()
       FROM customer_orders o
       WHERE i.id = ANY($1::uuid[])
         AND i.order_id = o.id
         AND i.tenant_id = o.tenant_id
         AND i.deleted_at IS NULL
         AND o.tenant_id = $2
         AND o.deleted_at IS NULL
       RETURNING i.id, i.order_id, i.product_id`,
      [itemIds, input.tenant_id],
    )

    if (updated.rowCount !== itemIds.length) {
      throw new AppError('DB_ERROR', 'Не вдалося прийняти всі вибрані позиції', 500)
    }
    return updated.rows
  })
}
