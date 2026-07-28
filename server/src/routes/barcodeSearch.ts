import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/search/barcode/:code — пошук за штрих-кодом (товар або клієнт)
router.get('/barcode/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code).replace(/[\u0000-\u001f\u007f\s]/g, '').trim()
    if (!code) throw new AppError('VALIDATION_ERROR', 'Штрих-код обов\'язковий', 400)

    const productSelect = 'id, sku, name, retail_price, qty_on_hand, unit, barcode, additional_barcodes, storage_bin, is_service, requires_core_return, core_deposit_amount, brand:brands(name)'

    // 1. Основний штрихкод. Не об'єднуємо scalar і JSONB в один PostgREST
    // .or(): помилка JSON-фільтра раніше робила непрацездатним увесь пошук.
    const { data: primaryProducts, error: primaryError } = await db
      .from('products')
      .select(productSelect)
      .is('deleted_at', null)
      .eq('is_active', true)
      .eq('tenant_id', req.user!.tenant_id)
      .eq('barcode', code)
      .order('qty_on_hand', { ascending: false })
      .order('name', { ascending: true })
      .limit(1)

    if (primaryError) throw new AppError('DB_ERROR', primaryError.message, 500)
    let product: any = primaryProducts?.[0] ?? null

    // 2. Окрема таблиця додаткових штрихкодів.
    if (!product) {
      const { data: barcodeRows, error: barcodeError } = await db
        .from('product_barcodes')
        .select('product_id')
        .eq('tenant_id', req.user!.tenant_id)
        .eq('barcode', code)
        .limit(1)
      if (barcodeError) throw new AppError('DB_ERROR', barcodeError.message, 500)

      const barcodeRow = barcodeRows?.[0]
      if (barcodeRow?.product_id) {
        const { data, error } = await db
          .from('products')
          .select(productSelect)
          .eq('id', barcodeRow.product_id)
          .eq('tenant_id', req.user!.tenant_id)
          .is('deleted_at', null)
          .eq('is_active', true)
          .maybeSingle()
        if (error) throw new AppError('DB_ERROR', error.message, 500)
        product = data
      }
    }

    // 3. JSONB-масив additional_barcodes. Для jsonb значення contains має бути
    // JSON-рядком: масив JS постміт формує як {a} (синтаксис text[]), і PostgREST
    // падав з «invalid input syntax for type json» — це ламало ВЕСЬ пошук далі,
    // включно з картками клієнтів. Помилку тут більше не фатальимо.
    if (!product) {
      const { data, error } = await db
        .from('products')
        .select(productSelect)
        .eq('tenant_id', req.user!.tenant_id)
        .is('deleted_at', null)
        .eq('is_active', true)
        .contains('additional_barcodes', JSON.stringify([code]))
        .limit(1)
        .maybeSingle()
      if (error) {
        const { logger } = await import('../lib/logger.js')
        logger.warn({ err: error.message, code }, '[barcode] additional_barcodes lookup failed')
      } else {
        product = data
      }
    }

    if (product) {
      const qtyOnHand = Number(product.qty_on_hand ?? 0)
      return res.json({
        data: {
          type: 'product',
          data: { ...product, qty_available: qtyOnHand },
        },
      })
    }

    // 4. Шукаємо клієнта
    const { data: customers, error: customerError } = await db
      .from('customers')
      .select('id, phone, full_name, card_barcode, debt_balance, bonus_balance, deposit_balance, loyalty_mode, vip_level, risk_profile, price_tier:price_tiers!left(id, name, discount_pct)')
      .is('deleted_at', null)
      .eq('card_barcode', code)
      .eq('tenant_id', req.user!.tenant_id)
      .limit(1)
    if (customerError) throw new AppError('DB_ERROR', customerError.message, 500)

    const customer = customers?.[0]
    if (customer) {
      return res.json({ data: { type: 'customer', data: customer } })
    }

    // 5. Не знайдено
    throw new AppError('NOT_FOUND', 'Нічого не знайдено за цим штрих-кодом', 404)
  } catch (err) { next(err) }
})

export default router
