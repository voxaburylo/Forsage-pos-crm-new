import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/search/barcode/:code — пошук за штрих-кодом (товар або клієнт)
router.get('/barcode/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code).trim()
    if (!code) throw new AppError('VALIDATION_ERROR', 'Штрих-код обов\'язковий', 400)

    // 1. Шукаємо товар
    const { data: product } = await db
      .from('products')
      .select('id, sku, name, retail_price, qty_on_hand, unit, barcode, storage_bin, brand:brands(name)')
      .is('deleted_at', null)
      .eq('is_active', true)
      .or(`barcode.eq.${code},additional_barcodes.cs.${code}`)
      .maybeSingle()

    if (product) {
      return res.json({ data: { type: 'product', data: product } })
    }

    // 2. Шукаємо клієнта
    const { data: customer } = await db
      .from('customers')
      .select('id, phone, full_name, card_barcode, bonus_balance, vip_level, risk_profile, price_tier:price_tiers!left(id, name, discount_pct)')
      .is('deleted_at', null)
      .eq('card_barcode', code)
      .maybeSingle()

    if (customer) {
      return res.json({ data: { type: 'customer', data: customer } })
    }

    // 3. Не знайдено
    throw new AppError('NOT_FOUND', 'Нічого не знайдено за цим штрих-кодом', 404)
  } catch (err) { next(err) }
})

export default router
