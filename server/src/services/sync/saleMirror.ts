import { z } from 'zod'
import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid, type SyncOutboxOperation } from './syncCore.js'
import { ensureFreeAmountProduct } from './syncGuards.js'

const id = z.string().refine(isUuid).transform(value => value.toLowerCase())
const optionalId = id.nullable().optional().transform(value => value ?? null)
const money = z.number().int().nonnegative().max(2_147_483_647)
const optionalMoney = money.optional().default(0)
const stamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString())
const method = z.enum(['cash', 'card', 'transfer', 'debt'])
const text = (limit: number) => z.string().max(limit).nullable().optional().transform(value => value ?? null)
const schema = z.object({
  sale_id: id, sale_number: z.string().trim().min(1).max(100), shift_id: id, customer_id: optionalId,
  cashier_id: id, manager_id: optionalId, completed_at: stamp, created_at: stamp,
  subtotal: money, discount: optionalMoney, total: money, bonuses_spent: optionalMoney,
  payment_method: z.enum(['cash', 'card', 'transfer', 'debt', 'mixed']),
  notes: text(10000), is_fiscal: z.boolean().optional().default(false),
  fiscal_number: text(128), fiscal_qr_url: text(4000),
  payments: z.array(z.object({ method, amount: money, fiscal_number: text(128) })).min(1).max(1000),
  items: z.array(z.object({
    id, product_id: optionalId,
    qty: z.number().finite().min(0.001).max(999_999_999.999)
      .refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001),
    unit_price: money, discount: optionalMoney, total: money,
    purchase_price: money.optional(), cost_price: money.optional(), core_deposit_amount: optionalMoney,
    core_return_status: z.enum(['none', 'pending', 'returned', 'refunded']).optional(),
  })).min(1).max(10000),
})
type Copy = z.infer<typeof schema>
function invalid(message = 'Неповні або некоректні дані локального чека: потрібні точні позиції, кількість, дата та оплати'): never {
  throw new AppError('SYNC_SALE_INVALID', message, 422)
}
function conflict(): never {
  throw new AppError('SYNC_SALE_COPY_CONFLICT',
    'Серверна копія чека має іншу суму, склад або реквізити; потрібна звірка. Повторного продажу не виконано.', 409)
}
const iso = (value: unknown) => value == null ? null : new Date(value as string).toISOString()
const units = (value: unknown) => Math.round(Number(value) * 1000)
const split = (copy: Copy) => Object.fromEntries(['cash', 'card', 'transfer', 'debt']
  .map(kind => [kind, copy.payments.filter(payment => payment.method === kind).reduce((sum, payment) => sum + payment.amount, 0)])) as
  Record<'cash' | 'card' | 'transfer' | 'debt', number>

function parseCopy(tenantId: string, userId: string, operation: SyncOutboxOperation): Copy {
  if (operation.tenant_id !== tenantId || !isUuid(operation.aggregate_id)) invalid()
  const payload = operation.payload ?? {}
  const parsed = schema.safeParse({ ...payload, sale_id: payload.sale_id ?? operation.aggregate_id,
    cashier_id: payload.cashier_id === undefined ? userId : payload.cashier_id,
    completed_at: payload.completed_at ?? payload.created_at,
    created_at: payload.created_at ?? payload.completed_at })
  if (!parsed.success) invalid()
  const copy = parsed.data
  if (copy.sale_id !== operation.aggregate_id.toLowerCase()
    || new Set(copy.items.map(item => item.id)).size !== copy.items.length) invalid()
  let gross = 0, lineDiscounts = 0
  for (const item of copy.items) {
    const itemGross = Math.round(item.qty * item.unit_price)
    const core = Math.round(item.qty * item.core_deposit_amount)
    if (!Number.isSafeInteger(itemGross + core) || item.discount > itemGross
      || item.total !== itemGross - item.discount + core
      || (item.purchase_price !== undefined && item.cost_price !== undefined && item.purchase_price !== item.cost_price)) invalid()
    gross += itemGross + core
    lineDiscounts += item.discount
  }
  const paid = split(copy)
  const methods = new Set(copy.payments.map(payment => payment.method))
  const expectedMethod = methods.size === 1 ? [...methods][0] : 'mixed'
  if (gross !== copy.subtotal || copy.discount < lineDiscounts
    || copy.total !== Math.max(0, copy.subtotal - copy.discount)
    || Object.values(paid).reduce((sum, value) => sum + value, 0) !== copy.total
    || copy.payment_method !== expectedMethod || (paid.debt > 0 && !copy.customer_id)) invalid()
  return copy
}
function expectedHeader(copy: Copy, tenantId: string): unknown[] {
  const paid = split(copy)
  const fiscal = copy.fiscal_number ?? copy.payments.find(payment => payment.fiscal_number)?.fiscal_number ?? null
  return [copy.sale_id, tenantId, copy.sale_number, copy.customer_id, copy.cashier_id, copy.shift_id,
    copy.subtotal, copy.discount, copy.total, copy.payment_method, paid.debt > 0, copy.notes,
    copy.manager_id, paid.cash, paid.card, paid.transfer, paid.debt, copy.bonuses_spent,
    copy.is_fiscal || fiscal !== null, fiscal, copy.fiscal_qr_url, copy.completed_at, copy.created_at]
}
function savedHeader(row: Record<string, any>): unknown[] {
  // NULL debt is an old schema/writer, not zero. Derive only its recorded unpaid
  // portion, never infer a debt for an ordinary cash/card/transfer receipt.
  const debt = row.debt_amount ?? ((row.is_debt || row.payment_method === 'debt')
    ? Number(row.total) - Number(row.cash_amount) - Number(row.card_amount) - Number(row.transfer_amount) : 0)
  return [row.id, row.tenant_id, row.sale_number, row.customer_id, row.cashier_id, row.shift_id,
    Number(row.subtotal), Number(row.discount), Number(row.total), row.payment_method, row.is_debt, row.notes,
    row.manager_id, Number(row.cash_amount), Number(row.card_amount), Number(row.transfer_amount), Number(debt),
    Number(row.bonuses_spent ?? 0), row.is_fiscal, row.fiscal_number, row.fiscal_qr_url,
    iso(row.completed_at), iso(row.created_at)]
}
function lineValues(item: Record<string, any>): unknown[] {
  return [item.id, item.product_id, units(item.qty), Number(item.unit_price), Number(item.discount),
    Number(item.total), Number(item.purchase_price ?? item.cost_price ?? 0), Number(item.core_deposit_amount ?? 0)]
}

/** Copy an immutable committed receipt, not a second sale. No stock, balance,
 * commission or cash delta is replayed; a retry must match ALL original rows. */
export async function applySaleCompleted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const copy = parseCopy(tenantId, userId, operation)
  const appliedAt = operation.applied_at ?? new Date().toISOString()
  await runTransaction(async client => {
    await client.query("SELECT set_config('app.sync_mode','true',true)")
    // Same global ID must also serialize across tenants. Row lock coordinates
    // with returns/core updates, including a retry after a full return.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['sale-copy:' + copy.sale_id])
    const existing = (await client.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE', [copy.sale_id])).rows[0]
    if (existing && (existing.tenant_id !== tenantId || !['completed', 'returned'].includes(existing.status)
      || existing.deleted_at != null)) conflict()
    if (!existing) {
      const shift = await client.query('SELECT id FROM shifts WHERE id=$1 AND tenant_id=$2', [copy.shift_id, tenantId])
      if (!shift.rowCount) throw new AppError('SYNC_SALE_SHIFT_REQUIRED', 'Спочатку потрібно передати копію касової зміни', 409)
      if (copy.customer_id) {
        const customer = await client.query('SELECT id FROM customers WHERE id=$1 AND tenant_id=$2', [copy.customer_id, tenantId])
        if (!customer.rowCount) throw new AppError('SYNC_SALE_CUSTOMER_REQUIRED', 'Спочатку потрібна картка клієнта цього магазину', 409)
      }
      for (const actor of new Set([copy.cashier_id, copy.manager_id].filter(Boolean))) {
        const staff = await client.query("SELECT id FROM auth.users WHERE id=$1 AND raw_app_meta_data->>'tenant_id'=$2", [actor, tenantId])
        if (!staff.rowCount) throw new AppError('SYNC_SALE_STAFF_REQUIRED', 'Працівник чека відсутній у копії цього магазину', 409)
      }
    }
    let freeProduct: string | undefined
    for (const item of copy.items) if (!item.product_id) {
      freeProduct ??= await ensureFreeAmountProduct(client, tenantId)
      item.product_id = freeProduct
    }
    if (existing) {
      const saved = savedHeader(existing), expected = expectedHeader(copy, tenantId)
      // Older copies filled a missing manager with the original cashier. Both
      // mean the same seller for a regular POS receipt; never use today's user.
      if (!copy.manager_id && existing.manager_id === copy.cashier_id) saved[12] = null
      if (JSON.stringify(saved) !== JSON.stringify(expected)) conflict()
      const rows = (await client.query('SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY id', [copy.sale_id])).rows
      const originals = [...copy.items].sort((a,b) => a.id.localeCompare(b.id))
      if (rows.length !== originals.length || rows.some((row, index) => row.tenant_id !== tenantId
        || row.deleted_at != null || iso(row.created_at) !== copy.completed_at
        || JSON.stringify(lineValues(row)) !== JSON.stringify(lineValues(originals[index]))
        || !validCoreProgress(originals[index], row))) conflict()
      return
    }
    const products = await client.query('SELECT id FROM products WHERE id=ANY($1::uuid[]) AND tenant_id=$2',
      [copy.items.map(item => item.product_id), tenantId])
    const known = new Set(products.rows.map(row => row.id))
    if (copy.items.some(item => !known.has(item.product_id))) {
      throw new AppError('SYNC_PRODUCT_NOT_FOUND', 'Не передано картку товару цього чека', 409)
    }
    if ((await client.query('SELECT 1 FROM sale_items WHERE id=ANY($1::uuid[])',
      [copy.items.map(item => item.id)])).rowCount) conflict()
    await client.query(`INSERT INTO sales(id,tenant_id,sale_number,customer_id,cashier_id,shift_id,
      subtotal,discount,total,payment_method,is_debt,notes,manager_id,cash_amount,card_amount,transfer_amount,debt_amount,
      bonuses_spent,is_fiscal,fiscal_number,fiscal_qr_url,completed_at,created_at,updated_at,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'completed')`,
      [...expectedHeader(copy, tenantId), appliedAt])
    for (const item of copy.items) {
      await client.query(`INSERT INTO sale_items(id,tenant_id,sale_id,product_id,qty,unit_price,discount,total,
        cost_price,core_deposit_amount,core_return_status,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [item.id, tenantId, copy.sale_id, item.product_id, item.qty, item.unit_price, item.discount, item.total,
        item.purchase_price ?? item.cost_price ?? 0, item.core_deposit_amount,
        item.core_return_status ?? (item.core_deposit_amount > 0 ? 'pending' : 'none'), copy.completed_at])
    }
  })
}
function validCoreProgress(original: Copy['items'][number], saved: Record<string, any>): boolean {
  const initial = original.core_return_status ?? (original.core_deposit_amount > 0 ? 'pending' : 'none')
  return saved.core_return_status === initial
    || (initial === 'pending' && ['returned', 'refunded'].includes(saved.core_return_status))
}
