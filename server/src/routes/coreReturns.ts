import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { runTransaction } from '../db/pg.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('owner', 'admin', 'manager'))

// GET /api/v1/core-returns — список повернень та боргів
router.get('/', async (req, res, next) => {
  try {
    const tenantId = req.user!.tenant_id

    // 1. Повернення від клієнтів (sale_items)
    const { data: sales, error: salesErr } = await db
      .from('sale_items')
      .select('*, product:products(id, name, sku, brand:brands(name)), sale:sales(completed_at, sale_number, customer:customers(id, full_name, phone))')
      .eq('tenant_id', tenantId)
      .in('core_return_status', ['pending', 'returned'])

    if (salesErr) throw new AppError('DB_ERROR', salesErr.message, 500)

    // 2. Повернення від клієнтів (customer_order_items)
    const { data: orders, error: ordersErr } = await db
      .from('customer_order_items')
      .select('*, product:products(id, name, sku, brand:brands(name)), order:customer_orders!inner(created_at, order_number, tenant_id, customer:customers(id, full_name, phone))')
      .eq('order.tenant_id', tenantId)
      .in('core_return_status', ['pending', 'returned'])

    if (ordersErr) throw new AppError('DB_ERROR', ordersErr.message, 500)

    // Об'єднуємо клієнтські повернення в один список
    const clientReturns = [
      ...(sales ?? []).map(item => ({
        id: item.id,
        type: 'sale',
        created_at: item.created_at,
        core_deposit_amount: item.core_deposit_amount,
        core_return_status: item.core_return_status,
        product: item.product,
        customer: (item.sale as any)?.customer,
        doc_number: (item.sale as any)?.sale_number ? `чеком #${(item.sale as any).sale_number}` : 'чеком',
        doc_date: (item.sale as any)?.completed_at,
      })),
      ...(orders ?? []).map(item => ({
        id: item.id,
        type: 'order',
        created_at: item.created_at,
        core_deposit_amount: item.core_deposit_amount,
        core_return_status: item.core_return_status,
        product: item.product,
        customer: (item.order as any)?.customer,
        doc_number: (item.order as any)?.order_number ? `замовленням #${(item.order as any).order_number}` : 'замовленням',
        doc_date: (item.order as any)?.created_at,
      }))
    ]

    // 3. Борги перед постачальниками (supply_invoice_items з проведених накладних)
    const { data: supplierItems, error: supplierErr } = await db
      .from('supply_invoice_items')
      .select('*, product:products!inner(id, name, sku, requires_core_return, core_deposit_amount, brand:brands(name)), invoice:supply_invoices!inner(id, invoice_number, posted_at, status, supplier:suppliers(id, name))')
      .eq('invoice.tenant_id', tenantId)
      .eq('invoice.status', 'posted')
      .eq('product.requires_core_return', true)

    if (supplierErr) throw new AppError('DB_ERROR', supplierErr.message, 500)

    const supplierDebts = (supplierItems ?? []).map(item => ({
      id: item.id,
      product: item.product,
      supplier: (item.invoice as any)?.supplier,
      invoice_number: (item.invoice as any)?.invoice_number,
      posted_at: (item.invoice as any)?.posted_at,
      qty: item.qty,
      core_deposit_amount: (item.product as any)?.core_deposit_amount || 0
    }))

    res.json({
      clientReturns,
      supplierDebts
    })
  } catch (err) { next(err) }
})

// POST /api/v1/core-returns/:type/:itemId/status — змінити статус повернення серцевини
router.post('/:type/:itemId/status', async (req, res, next) => {
  try {
    const { type, itemId } = req.params
    const tenantId = req.user!.tenant_id

    const schema = z.object({
      status: z.enum(['pending', 'returned', 'refunded']),
      refund_method: z.enum(['cash', 'balance']).optional().nullable()
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const { status, refund_method } = parsed.data

    if (type !== 'sale' && type !== 'order') {
      throw new AppError('VALIDATION_ERROR', 'Невідомий тип документа', 400)
    }

    const table = type === 'sale' ? 'sale_items' : 'customer_order_items'

    // 1. Отримуємо деталь
    let itemQuery = db.from(table).select('*').eq('id', itemId)
    if (type === 'sale') {
      itemQuery = itemQuery.eq('tenant_id', tenantId)
    } else {
      itemQuery = itemQuery.select('*, order:customer_orders!inner(tenant_id, customer_id)')
    }

    const { data: item, error: itemErr } = await itemQuery.single()
    if (itemErr || !item) throw new AppError('NOT_FOUND', 'Позицію не знайдено', 404)

    // Перевірка прав tenant_id для замовлень
    if (type === 'order' && (item.order as any)?.tenant_id !== tenantId) {
      throw new AppError('FORBIDDEN', 'Немає доступу до цього документа', 403)
    }

    const coreDepositAmount = item.core_deposit_amount || 0

    // Отримуємо customer_id
    let customerId: string | null = null
    if (type === 'sale') {
      const { data: sale } = await db.from('sales').select('customer_id').eq('id', item.sale_id).single()
      customerId = sale?.customer_id || null
    } else {
      customerId = (item.order as any)?.customer_id || null
    }

    // 2. Якщо статус 'refunded' та обрано повернення на баланс
    if (status === 'refunded' && refund_method === 'balance' && coreDepositAmount > 0 && customerId) {
      await runTransaction(async (pgClient) => {
        // Оновлюємо бонусний баланс клієнта
        await pgClient.query(
          `UPDATE customers SET bonus_balance = bonus_balance + $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
          [coreDepositAmount, customerId, tenantId]
        )

        // Додаємо запис про нарахування бонусів
        await pgClient.query(
          `INSERT INTO bonus_transactions (tenant_id, customer_id, amount, transaction_type, description)
           VALUES ($1, $2, $3, 'manual', $4)`,
          [
            tenantId,
            customerId,
            coreDepositAmount,
            `Повернення застави за стару деталь (позиція: ${item.name || 'Запчастина'})`
          ]
        )
      })
    }

    // 3. Оновлюємо статус у БД
    const { data: updatedItem, error: updateErr } = await db
      .from(table)
      .update({ core_return_status: status })
      .eq('id', itemId)
      .select('*')
      .single()

    if (updateErr) throw new AppError('DB_ERROR', updateErr.message, 500)

    res.json({ data: updatedItem })
  } catch (err) { next(err) }
})

export default router
