import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('owner', 'admin', 'manager'))

// GET /api/v1/auto-purchase/suggestions — пропозиції закупки
router.get('/suggestions', async (req, res, next) => {
  try {
    const { data, error } = await db.rpc('generate_purchase_suggestions', {
      p_tenant_id: req.user!.tenant_id,
    })
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

const ruleSchema = z.object({
  product_id:  z.string().uuid(),
  supplier_id: z.string().uuid().optional().nullable(),
  min_qty:     z.number().positive().default(1),
  max_qty:     z.number().positive().default(100),
  is_active:   z.boolean().default(true),
})

// GET /api/v1/auto-purchase/rules — список правил
router.get('/rules', async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('auto_purchase_rules')
      .select('*, product:products(id, sku, name, qty_on_hand, reorder_point), supplier:suppliers(id, name)')
      .eq('tenant_id', req.user!.tenant_id)
      .order('created_at', { ascending: false })

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// POST /api/v1/auto-purchase/rules — створити правило
router.post('/rules', async (req, res, next) => {
  try {
    const parsed = ruleSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 400, parsed.error.flatten())

    const { data, error } = await db
      .from('auto_purchase_rules')
      .upsert({
        tenant_id:   req.user!.tenant_id,
        product_id:  parsed.data.product_id,
        supplier_id: parsed.data.supplier_id ?? null,
        min_qty:     parsed.data.min_qty,
        max_qty:     parsed.data.max_qty,
        is_active:   parsed.data.is_active,
      }, { onConflict: 'tenant_id,product_id' })
      .select()
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// POST /api/v1/auto-purchase/generate-invoices — створити чернетки накладних на основі пропозицій
router.post('/generate-invoices', async (req, res, next) => {
  try {
    const { data: suggestions, error: sugError } = await db.rpc('generate_purchase_suggestions', {
      p_tenant_id: req.user!.tenant_id,
    })
    if (sugError) throw new AppError('DB_ERROR', sugError.message, 500)
    if (!suggestions || suggestions.length === 0) {
      return res.json({ data: { count: 0, invoices: [] } })
    }

    const productIds = suggestions.map((s: any) => s.product_id)
    const { data: products, error: prodError } = await db
      .from('products')
      .select('id, purchase_price')
      .in('id', productIds)
    
    if (prodError) throw new AppError('DB_ERROR', prodError.message, 500)
    const priceMap = new Map(products?.map((p) => [p.id, p.purchase_price ?? 0]))

    const groups: Record<string, any[]> = {}
    suggestions.forEach((s: any) => {
      const key = s.supplier_id || 'none'
      if (!groups[key]) groups[key] = []
      groups[key].push(s)
    })

    const createdInvoices = []
    const { createSupplyInvoice } = await import('../services/supplierService.js')

    for (const [supplierKey, items] of Object.entries(groups)) {
      const supplierId = supplierKey === 'none' ? null : supplierKey
      const invoiceNumber = `АВТО-${new Date().toISOString().slice(0, 10)}-${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`

      const invoiceItems = items.map((item: any) => {
        const price = priceMap.get(item.product_id) ?? 0
        return {
          product_id: item.product_id,
          qty: item.suggest_qty,
          purchase_price: price,
          total: price * item.suggest_qty,
        }
      })

      const invoice = await createSupplyInvoice(req.user!.id, {
        supplier_id: supplierId,
        invoice_number: invoiceNumber,
        notes: 'Автоматично створено на основі пропозицій закупки',
        items: invoiceItems,
      })

      createdInvoices.push(invoice)
    }

    res.json({ data: { count: createdInvoices.length, invoices: createdInvoices } })
  } catch (err) { next(err) }
})

// DELETE /api/v1/auto-purchase/rules/:id — видалити правило
router.delete('/rules/:id', async (req, res, next) => {
  try {
    const { error } = await db
      .from('auto_purchase_rules')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
