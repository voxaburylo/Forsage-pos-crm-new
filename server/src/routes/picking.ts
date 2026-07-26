import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { updateOrderStatus } from './customerOrders.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('owner', 'admin', 'manager', 'storekeeper'))

// GET /api/v1/picking/orders — Отримати список замовлень, які потребують збірки на складі
router.get('/orders', async (req, res, next) => {
  try {
    // Беремо всі замовлення зі складськими позиціями, доки їм не призначено
    // місце видачі. Це не дає повністю зібраному замовленню зникнути з черги
    // між останнім скануванням і збереженням комірки.
    const { data: items, error: itemsErr } = await db
      .from('customer_order_items')
      .select('order_id')
      .eq('source_type', 'warehouse')

    if (itemsErr) throw new AppError('DB_ERROR', itemsErr.message, 500)

    const orderIds = [...new Set((items ?? []).map(i => i.order_id))]

    if (orderIds.length === 0) {
      return res.json({ data: [] })
    }

    const { data: orders, error: ordersErr } = await db
      .from('customer_orders')
      .select('*, customer:customers(id, full_name, phone), items:customer_order_items(*)')
      .eq('tenant_id', req.user!.tenant_id)
      // Лише ПІДТВЕРДЖЕНІ замовлення («В замовлення» і далі). Відкриті (lead/new),
      // що ще чекають відповіді клієнта, у чергу збірки не потрапляють.
      .in('status', ['ordered', 'in_progress', 'arrived', 'called', 'no_answer', 'ready'])
      .in('id', orderIds)
      .is('pickup_cell', null)
      .order('created_at', { ascending: false })

    if (ordersErr) throw new AppError('DB_ERROR', ordersErr.message, 500)

    res.json({ data: orders ?? [] })
  } catch (err) { next(err) }
})

// GET /api/v1/picking/orders/:id — Отримати деталі замовлення для збірки (з ячейками та сортуванням)
router.get('/orders/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    const { data: order, error } = await db
      .from('customer_orders')
      .select('*, customer:customers(id, full_name, phone), items:customer_order_items(*)')
      .eq('id', id)
      .eq('tenant_id', req.user!.tenant_id)
      .single()

    if (error || !order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)

    // Отримуємо ячейки зберігання (storage_bin) для продуктів
    const productIds = order.items.map((i: any) => i.product_id).filter(Boolean) as string[]
    const productsMap = new Map<string, string | null>()

    if (productIds.length > 0) {
      const { data: products, error: prodErr } = await db
        .from('products')
        .select('id, storage_bin')
        .in('id', productIds)
        .eq('tenant_id', req.user!.tenant_id) // SECURED
      
      if (prodErr) throw new AppError('DB_ERROR', prodErr.message, 500)

      if (products) {
        products.forEach(p => productsMap.set(p.id, p.storage_bin))
      }
    }

    // Збагачуємо позиції полем storage_bin та сортуємо їх
    const enrichedItems = order.items.map((item: any) => ({
      ...item,
      storage_bin: item.product_id ? productsMap.get(item.product_id) || null : null
    }))

    // Сортуємо: складські товари спочатку, за ячейкою зберігання (storage_bin) за алфавітом, пусті ячейки та товари під замовлення в кінці
    enrichedItems.sort((a: any, b: any) => {
      if (a.source_type !== b.source_type) {
        return a.source_type === 'warehouse' ? -1 : 1
      }
      const binA = a.storage_bin || ''
      const binB = b.storage_bin || ''
      
      if (!binA && binB) return 1
      if (binA && !binB) return -1
      if (!binA && !binB) return 0
      
      return binA.localeCompare(binB, undefined, { numeric: true, sensitivity: 'base' })
    })

    res.json({ data: { ...order, items: enrichedItems } })
  } catch (err) { next(err) }
})

// PATCH /api/v1/picking/items/:itemId — Відмітити позицію як зібрану (item_status -> 'arrived')
router.patch('/items/:itemId', async (req, res, next) => {
  try {
    const { itemId } = req.params
    const schema = z.object({
      item_status: z.enum(['pending', 'arrived'])
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний статус', 422)

    const status = parsed.data.item_status

    // Знаходимо позицію замовлення
    const { data: item, error: findError } = await db
      .from('customer_order_items')
      .select('order_id, name, qty, source_type')
      .eq('id', itemId)
      .single()

    if (findError || !item) throw new AppError('NOT_FOUND', 'Позицію замовлення не знайдено', 404)
    if (item.source_type !== 'warehouse') {
      throw new AppError('VALIDATION_ERROR', 'У збірці можна змінювати лише складські позиції', 422)
    }

    // Перевіряємо що замовлення належить нашому тененту
    const { data: order, error: orderErr } = await db
      .from('customer_orders')
      .select('id')
      .eq('id', item.order_id)
      .eq('tenant_id', req.user!.tenant_id)
      .maybeSingle()

    if (orderErr || !order) throw new AppError('NOT_FOUND', 'Позицію замовлення не знайдено', 404)

    // Оновлюємо статус позиції
    const { error: updateError } = await db
      .from('customer_order_items')
      .update({ item_status: status })
      .eq('id', itemId)

    if (updateError) throw new AppError('DB_ERROR', updateError.message, 500)

    // Записуємо дію у лог активності
    await db.from('order_activity_log').insert({
      order_id: item.order_id,
      user_id: req.user!.id,
      action: status === 'arrived' ? 'item_status:arrived' : 'item_status:pending',
      details: { item_id: itemId, name: item.name, qty: item.qty, method: 'picking' },
    })

    // Оновлюємо статус самого замовлення
    await updateOrderStatus(item.order_id, req.user!.tenant_id, req.user!.id)

    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

// PATCH /api/v1/picking/orders/:id/pickup-cell — Встановити ячейку видачі для замовлення
router.patch('/orders/:id/pickup-cell', async (req, res, next) => {
  try {
    const { id } = req.params
    const schema = z.object({
      pickup_cell: z.string().min(1).max(50)
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна назва ячейки', 422)

    const { data: order, error: orderError } = await db
      .from('customer_orders')
      .select('id, items:customer_order_items(id, source_type, item_status)')
      .eq('id', id)
      .eq('tenant_id', req.user!.tenant_id)
      .maybeSingle()

    if (orderError || !order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)

    const items = (order.items ?? []) as Array<{ id: string; source_type: string; item_status: string }>
    const warehouseItems = items.filter(item => item.source_type === 'warehouse')
    const allItemsReady = items.every(item =>
      item.item_status === 'arrived' || item.item_status === 'handed' || item.item_status === 'canceled'
    )
    if (warehouseItems.length === 0 || !allItemsReady) {
      throw new AppError(
        'ORDER_NOT_READY',
        'Не всі позиції готові. Завершіть збірку складу та дочекайтеся постачальника.',
        409,
      )
    }

    const { error } = await db
      .from('customer_orders')
      .update({ pickup_cell: parsed.data.pickup_cell, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', req.user!.tenant_id)

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // Записуємо у лог
    await db.from('order_activity_log').insert({
      order_id: id,
      user_id: req.user!.id,
      action: 'status_changed', // Або кастомна дія
      details: { pickup_cell: parsed.data.pickup_cell, note: 'Встановлено ячейку видачі' }
    })

    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

export default router
