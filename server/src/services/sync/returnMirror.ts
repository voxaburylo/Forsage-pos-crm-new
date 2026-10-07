import { z } from 'zod'
import type { PoolClient } from 'pg'
import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid, type SyncOutboxOperation } from './syncCore.js'

const id = z.string().refine(isUuid).transform(value => value.toLowerCase())
const money = z.number().int().nonnegative().max(2_147_483_647)
const quantity = z.number().finite().positive().max(999_999_999.999)
  .refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)))
  .transform(value => new Date(value).toISOString())
const copySchema = z.object({
  id, sale_id: id, approved_by: id, created_at: timestamp,
  reason: z.enum(['defective', 'wrong_part', 'changed_mind', 'customer_changed_mind', 'warranty', 'duplicate', 'other']).default('other'),
  reason_note: z.string().nullable().optional().transform(value => value ?? null),
  refund_method: z.enum(['cash', 'terminal', 'debt_reduction', 'credit']),
  stock_action: z.enum(['return_to_stock', 'write_off', 'send_to_supplier']),
  refund_kopecks: money,
  shift_id: id.nullable().optional().transform(value => value ?? null),
  shift_link_recorded: z.boolean().optional(),
  fiscal_number: z.string().max(128).nullable().optional().transform(value => value ?? null),
  deposit_transaction: z.object({ id, balance_after: money }).optional(),
  items: z.array(z.object({
    id, sale_item_id: id, product_id: id, quantity, unit_price: money, total: money,
    condition: z.enum(['good', 'defective', 'damaged', 'opened_packaging']).default('good'),
  })).min(1).max(10000),
})
type Copy = z.infer<typeof copySchema> & { shift_link_recorded: boolean }
function invalid(message: string): never { throw new AppError('SYNC_RETURN_COPY_INVALID', message, 422) }
function conflict(): never {
  throw new AppError('SYNC_RETURN_COPY_CONFLICT', 'Серверна копія повернення відрізняється від локальної. Потрібна звірка; повторну виплату не створено.', 409)
}
function required(message: string): never { throw new AppError('SYNC_RETURN_COPY_REQUIRED', message, 409) }
const iso = (value: unknown) => value == null ? null : new Date(value as string).toISOString()
const units = (value: number | string) => Math.round(Number(value) * 1000)

function expectedHeader(copy: Copy, tenantId: string, customerId: string | null) {
  return [copy.id, tenantId, copy.sale_id, customerId, 'customer_return', copy.reason,
    copy.reason_note, copy.reason_note, copy.refund_kopecks, copy.refund_kopecks,
    copy.refund_method, copy.stock_action, 'completed', copy.approved_by, copy.approved_by,
    copy.fiscal_number, copy.created_at]
}
function headerValues(row: Record<string, any>) {
  return [row.id, row.tenant_id, row.sale_id, row.customer_id, row.return_type, row.reason,
    row.reason_text, row.reason_note, Number(row.refund_amount), Number(row.refund_kopecks),
    row.refund_method, row.stock_action, row.status, row.created_by, row.approved_by,
    row.fiscal_number, iso(row.created_at)]
}
function lineValues(copy: Copy) {
  return copy.items.map(item => [item.id, item.sale_item_id, item.product_id, units(item.quantity),
    item.unit_price, item.total, item.condition]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
}

/** A desktop return has already changed stock, money and salary locally.
 * Copy the immutable document and its original money movement atomically.
 * Current signed balances are applied separately; never replay their deltas here.
 */
export async function applyReturnCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  if (operation.tenant_id !== tenantId) invalid('Повернення належить іншому магазину')
  const payload = operation.payload ?? {}
  const parsed = copySchema.safeParse({ ...payload, id: payload.id ?? operation.aggregate_id,
    approved_by: payload.approved_by ?? userId, created_at: payload.created_at ?? operation.created_at,
    refund_method: payload.refund_method === 'card' ? 'terminal' : payload.refund_method })
  if (!parsed.success) invalid('Неповні або некоректні дані копії повернення: потрібні точні рядки, кількість і суми з локальної бази')
  const copy: Copy = { ...parsed.data, shift_link_recorded: parsed.data.shift_link_recorded ?? parsed.data.shift_id !== null }
  if (copy.shift_link_recorded && !Object.prototype.hasOwnProperty.call(payload, 'shift_id')) {
    invalid('Підтверджений зв’язок зі зміною потребує явного номера зміни або null для повернення поза зміною')
  }
  if (copy.shift_id !== null && !copy.shift_link_recorded) invalid('Номер зміни суперечить ознаці його збереження')
  if (copy.id !== operation.aggregate_id.toLowerCase()
    || new Set(copy.items.map(item => item.id)).size !== copy.items.length
    || new Set(copy.items.map(item => item.sale_item_id)).size !== copy.items.length
    || copy.items.reduce((sum, item) => sum + item.total, 0) !== copy.refund_kopecks) {
    invalid('Рядки повернення дублюються або їх сума не відповідає локальному документу')
  }
  if (copy.refund_method === 'cash' && copy.refund_kopecks > 0 && !copy.shift_id) {
    required('Для копії повернення потрібна початкова локальна касова зміна')
  }
  if (copy.refund_method === 'credit' && (!copy.deposit_transaction
    || copy.deposit_transaction.balance_after < copy.refund_kopecks)) {
    required('Для копії повернення на рахунок потрібен збережений локальний запис зарахування. Оновіть локальну програму та повторіть передачу.')
  }
  const appliedAt = operation.applied_at ?? new Date().toISOString()
  await runTransaction(async client => {
    await client.query("SELECT set_config('app.sync_mode','true',true)")
    // A receipt lock serialises different returns; the ID lock also covers retries
    // that try to reuse a return ID with a different receipt or tenant.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['return-copy:' + copy.id])
    const sale = (await client.query(
      `SELECT id,sale_number,customer_id,total FROM sales WHERE id=$1 AND tenant_id=$2
       AND status IN ('completed','returned') FOR UPDATE`, [copy.sale_id, tenantId])).rows[0]
    if (!sale) required('Спочатку потрібно передати локальний чек для повернення')
    const customerId = sale.customer_id ?? null
    if (customerId) {
      const customer = await client.query('SELECT id FROM customers WHERE id=$1 AND tenant_id=$2', [customerId, tenantId])
      if (!customer.rowCount) required('Не передано картку клієнта цього магазину')
    } else if (['credit', 'debt_reduction'].includes(copy.refund_method)) {
      invalid('Повернення на рахунок або зменшення боргу потребує клієнта в початковому чеку')
    }
    if (copy.shift_id) {
      const shift = await client.query("SELECT id FROM shifts s WHERE id=$1 AND tenant_id=$2 AND to_jsonb(s)->>'deleted_at' IS NULL FOR KEY SHARE", [copy.shift_id, tenantId])
      if (!shift.rowCount) required('Спочатку потрібно передати початкову локальну касову зміну')
    }
    const existing = (await client.query('SELECT * FROM returns WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [copy.id, tenantId])).rows[0]
    if (existing) {
      if (JSON.stringify(headerValues(existing)) !== JSON.stringify(expectedHeader(copy, tenantId, customerId))) conflict()
      const rows = (await client.query(
        'SELECT * FROM return_items WHERE return_id=$1 AND tenant_id=$2 ORDER BY id', [copy.id, tenantId])).rows
      const saved = rows.map(row => [row.id, row.sale_item_id, row.product_id, units(row.quantity),
        Number(row.unit_price_kopecks), Number(row.total_kopecks), row.condition])
      if (JSON.stringify(saved) !== JSON.stringify(lineValues(copy))
        || rows.some(row => iso(row.created_at) !== copy.created_at)) conflict()
      if (existing.shift_link_recorded) {
        if (!copy.shift_link_recorded) required('Повтор не містить збереженого зв’язку зі зміною. Оновіть локальну програму; відому зміну не змінено.')
        if ((existing.shift_id ?? null) !== copy.shift_id) conflict()
      }
      await copyMoneyMovement(client, tenantId, copy, customerId, sale.sale_number, appliedAt, true)
      if (!existing.shift_link_recorded && copy.shift_link_recorded) {
        // Metadata only, after the complete return and its financial history match.
        // Never pay again, replay stock deltas or move the original receipt.
        await client.query(
          'UPDATE returns SET shift_id=$3,shift_link_recorded=true,updated_at=$4 WHERE id=$1 AND tenant_id=$2 AND shift_link_recorded=false',
          [copy.id,tenantId,copy.shift_id,appliedAt])
      }
      return
    }
    // Global primary keys must not silently acknowledge another tenant's row.
    if ((await client.query('SELECT 1 FROM returns WHERE id=$1', [copy.id])).rowCount) conflict()
    const lines = (await client.query(
      `SELECT si.id,si.product_id,si.qty,si.unit_price,si.total,
        COALESCE(SUM(ri.quantity) FILTER (WHERE r.id IS NOT NULL),0) returned_qty,
        COALESCE(SUM(ri.total_kopecks) FILTER (WHERE r.id IS NOT NULL),0) refunded
       FROM sale_items si
       JOIN products p ON p.id=si.product_id AND p.tenant_id=si.tenant_id
       LEFT JOIN return_items ri ON ri.sale_item_id=si.id AND ri.tenant_id=si.tenant_id AND ri.product_id=si.product_id
       LEFT JOIN returns r ON r.id=ri.return_id AND r.tenant_id=si.tenant_id AND r.sale_id=si.sale_id AND r.status='completed'
       WHERE si.sale_id=$1 AND si.tenant_id=$2 GROUP BY si.id`, [copy.sale_id, tenantId])).rows
    const byId = new Map(lines.map(row => [row.id, row]))
    for (const item of copy.items) {
      const source = byId.get(item.sale_item_id)
      if (!source || source.product_id !== item.product_id) {
        required('Не передано точну позицію початкового чека; підміну іншим рядком товару заборонено')
      }
      if (Number(source.unit_price) !== item.unit_price
        || units(source.returned_qty) + units(item.quantity) > units(source.qty)
        || Number(source.refunded) + item.total > Number(source.total)) {
        invalid('Сума або кількість повернення перевищує початкову позицію чека')
      }
    }
    const previous = (await client.query(
      `SELECT COALESCE(SUM(refund_kopecks),0) amount FROM returns
       WHERE sale_id=$1 AND tenant_id=$2 AND status='completed'`, [copy.sale_id, tenantId])).rows[0]
    if (Number(previous.amount) + copy.refund_kopecks > Number(sale.total)) invalid('Повернення перевищує суму початкового чека')
    await client.query(
      `INSERT INTO returns(id,tenant_id,sale_id,customer_id,return_type,reason,reason_text,reason_note,
        refund_amount,refund_kopecks,refund_method,stock_action,status,created_by,approved_by,fiscal_number,created_at,
        shift_id,shift_link_recorded,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [...expectedHeader(copy, tenantId, customerId), copy.shift_id, copy.shift_link_recorded, appliedAt])
    for (const item of copy.items) {
      await client.query(
        `INSERT INTO return_items(id,tenant_id,return_id,product_id,sale_item_id,quantity,unit_price_kopecks,total_kopecks,condition,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [item.id, tenantId, copy.id, item.product_id, item.sale_item_id, item.quantity, item.unit_price, item.total, item.condition, copy.created_at])
    }
    await copyMoneyMovement(client, tenantId, copy, customerId, sale.sale_number, appliedAt, false)
    // These are document statuses, not a new sale, stock movement or salary award.
    await client.query(
      `UPDATE sales s SET status='returned',updated_at=$3 WHERE s.id=$1 AND s.tenant_id=$2
       AND NOT EXISTS(SELECT 1 FROM sale_items si WHERE si.sale_id=s.id AND si.tenant_id=s.tenant_id
         AND si.qty > COALESCE((SELECT SUM(ri.quantity) FROM return_items ri JOIN returns r
           ON r.id=ri.return_id AND r.tenant_id=ri.tenant_id
           WHERE ri.sale_item_id=si.id AND ri.product_id=si.product_id AND ri.tenant_id=s.tenant_id
             AND r.sale_id=s.id AND r.status='completed'),0))`, [copy.sale_id, tenantId, appliedAt])
    const returnedOrderItems = await client.query(
      `UPDATE customer_order_items coi SET item_status='returned'
       FROM customer_orders o WHERE coi.order_id=o.id AND o.tenant_id=$2 AND o.sale_id=$1 AND o.deleted_at IS NULL
         AND coi.item_status IS DISTINCT FROM 'returned'
         AND coi.product_id IN (SELECT si.product_id FROM sale_items si
           LEFT JOIN (SELECT ri.sale_item_id,SUM(ri.quantity) qty FROM return_items ri JOIN returns r
             ON r.id=ri.return_id AND r.tenant_id=ri.tenant_id
             WHERE r.sale_id=$1 AND r.tenant_id=$2 AND r.status='completed' GROUP BY ri.sale_item_id) returned ON returned.sale_item_id=si.id
           WHERE si.sale_id=$1 AND si.tenant_id=$2 GROUP BY si.product_id
           HAVING SUM(si.qty)<=COALESCE(SUM(returned.qty),0))
       RETURNING coi.order_id`, [copy.sale_id, tenantId])
    if (returnedOrderItems.rowCount) {
      const orderIds = [...new Set(returnedOrderItems.rows.map(row => row.order_id))]
      // Child rows have no delta timestamp; the parent exposes their change to pull.
      await client.query('UPDATE customer_orders SET updated_at = $3 WHERE id=ANY($1::uuid[]) AND tenant_id=$2',
        [orderIds, tenantId, appliedAt])
      for (const orderId of orderIds) await client.query(
        "INSERT INTO order_activity_log(order_id,user_id,action,details) VALUES($1,$2,'items_returned',$3::jsonb)",
        [orderId, copy.approved_by, JSON.stringify({ return_id: copy.id, product_ids: copy.items.map(item => item.product_id) })])
    }
  })
}

async function copyMoneyMovement(client: PoolClient, tenantId: string, copy: Copy, customerId: string | null,
  saleNumber: string, appliedAt: string, existingReturn: boolean): Promise<void> {
  const note = `Повернення за чеком ${saleNumber}`
  if (copy.refund_method === 'cash' && copy.refund_kopecks > 0) {
    const expected = [tenantId, copy.shift_id, 'out', copy.refund_kopecks, 'cashbox', copy.approved_by, copy.created_at]
    const existing = (await client.query('SELECT * FROM cash_operations WHERE id=$1', [copy.id])).rows[0]
    if (existing) {
      const actual = [existing.tenant_id, existing.shift_id, existing.type, Number(existing.amount),
        existing.source, existing.created_by, iso(existing.created_at)]
      if (JSON.stringify(actual) !== JSON.stringify(expected)) conflict()
    } else {
      if (existingReturn) conflict()
      await client.query(
        `INSERT INTO cash_operations(id,tenant_id,shift_id,type,amount,note,source,created_by,created_at,updated_at)
         VALUES($1,$2,$3,'out',$4,$5,'cashbox',$6,$7,$8)`,
        [copy.id, tenantId, copy.shift_id, copy.refund_kopecks, note, copy.approved_by, copy.created_at, appliedAt])
    }
  }
  if (copy.refund_method === 'credit' && copy.deposit_transaction) {
    const transaction = copy.deposit_transaction
    const expected = [tenantId, customerId, copy.refund_kopecks, transaction.balance_after, 'return_credit',
      copy.sale_id, copy.shift_id, copy.approved_by, copy.created_at]
    const existing = (await client.query('SELECT * FROM customer_deposit_transactions WHERE id=$1', [transaction.id])).rows[0]
    if (existing) {
      const actual = [existing.tenant_id, existing.customer_id, Number(existing.amount), Number(existing.balance_after),
        existing.method, existing.sale_id, existing.shift_id, existing.created_by, iso(existing.created_at)]
      if (JSON.stringify(actual) !== JSON.stringify(expected)) conflict()
    } else {
      if (existingReturn) conflict()
      await client.query(
        `INSERT INTO customer_deposit_transactions(id,tenant_id,customer_id,amount,balance_after,method,sale_id,shift_id,notes,created_by,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,'return_credit',$6,$7,$8,$9,$10,$11)`,
        [transaction.id, tenantId, customerId, copy.refund_kopecks, transaction.balance_after, copy.sale_id,
          copy.shift_id, note, copy.approved_by, copy.created_at, appliedAt])
    }
  }
}
