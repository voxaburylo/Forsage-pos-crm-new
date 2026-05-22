import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import {
  createProductSchema,
  updateProductSchema,
  productListSchema,
  posSearchSchema,
  stockCorrectionSchema,
  addAnalogSchema,
} from '../validators/productValidator.js'
import * as productService from '../services/productService.js'

const router = Router()

// Все маршруты требуют авторизации
router.use(requireAuth)

// GET /api/v1/products/export — експорт товарів у CSV
router.get('/export', requireRole('owner', 'admin', 'manager'), async (_req, res, next) => {
  try {
    const { data, error } = await db
      .from('products')
      .select('id, sku, name, barcode, retail_price, purchase_price, qty_on_hand, unit, storage_bin, brand:brands(name), category:categories(name)')
      .is('deleted_at', null)
      .order('name')

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    const header = 'ID,Артикул,Назва,ШтрихКод,РоздрібнаЦіна,Собівартість,Залишок,Одиниця,Ячейка,Бренд,Категорія'
    const rows = (data ?? []).map((p: any) =>
      `"${p.id}","${p.sku}","${(p.name ?? '').replace(/"/g, '""')}","${p.barcode ?? ''}",${p.retail_price ?? 0},${p.purchase_price ?? 0},${p.qty_on_hand ?? 0},"${p.unit ?? ''}","${p.storage_bin ?? ''}","${p.brand?.name ?? ''}","${p.category?.name ?? ''}"`
    ).join('\n')

    const bom = '﻿'
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename=products.csv')
    res.send(bom + header + '\n' + rows)
  } catch (err) { next(err) }
})

// POST /api/v1/products/import — імпорт товарів (upsert по sku або barcode)
router.post('/import', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { z } = await import('zod')
    const importRowSchema = z.object({
      sku: z.string().min(1).max(50),
      name: z.string().min(1).max(500),
      barcode: z.string().max(100).optional().nullable(),
      retail_price: z.number().int().min(0).default(0),
      purchase_price: z.number().int().min(0).default(0),
      qty_on_hand: z.number().min(0).default(0),
      unit: z.string().max(20).default('шт'),
      storage_bin: z.string().max(50).optional().nullable(),
    })
    const bodySchema = z.object({
      products: z.array(importRowSchema).min(1),
      mode: z.enum(['replace', 'add']).default('replace'),
    })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    let created = 0; let updated = 0; let errors = 0

    for (const item of parsed.data.products) {
      try {
        const { data, error } = await db.rpc('upsert_product_import', {
          p_tenant_id:      req.user!.tenant_id,
          p_sku:            item.sku,
          p_barcode:        item.barcode ?? null,
          p_name:           item.name,
          p_retail_price:   item.retail_price,
          p_purchase_price: item.purchase_price,
          p_qty_on_hand:    item.qty_on_hand,
          p_unit:           item.unit,
          p_storage_bin:    item.storage_bin ?? null,
          p_mode:           parsed.data.mode,
        })

        if (error || !data) {
          errors++
          continue
        }

        const resObj = data as { id: string; is_new: boolean; old_qty: number; new_qty: number }

        if (resObj.is_new) {
          created++
        } else {
          updated++
          // Авто-сповіщення waitlist при появі товару
          if (resObj.old_qty <= 0 && resObj.new_qty > 0) {
            const { notifyWaitlistCustomers } = await import('./waitlist.js').catch(() => ({ notifyWaitlistCustomers: null }))
            if (notifyWaitlistCustomers) void notifyWaitlistCustomers(resObj.id)
          }
        }
      } catch {
        errors++
      }
    }

    res.json({ data: { created, updated, errors } })
  } catch (err) { next(err) }
})

// GET /api/v1/products/search — быстрый поиск для POS (до CRUD чтобы не конфликтовало с /:id)
router.get('/search', async (req, res, next) => {
  try {
    const query = posSearchSchema.safeParse(req.query)
    if (!query.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри пошуку', 400, query.error.flatten())
    const results = await productService.searchForPOS(query.data.q, query.data.limit)
    res.json({ data: results })
  } catch (err) { next(err) }
})

// GET /api/v1/products/favorites — швидкі товари для POS
router.get('/favorites', async (_req, res, next) => {
  try {
    const { data, error } = await db
      .from('products')
      .select('id, sku, name, retail_price, unit, qty_on_hand, storage_bin, brand:brands(name)')
      .eq('is_favorite', true)
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('name')
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// GET /api/v1/products — список с поиском и фильтрами
router.get('/', async (req, res, next) => {
  try {
    const query = productListSchema.safeParse(req.query)
    if (!query.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, query.error.flatten())
    const result = await productService.listProducts(query.data)
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/v1/products/bulk-update — масове оновлення товарів
router.post('/bulk-update', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { z } = await import('zod')
    const schema = z.object({
      product_ids: z.array(z.string().uuid()).min(1).max(1000),
      updates: z.object({
        retail_price: z.number().int().min(0).optional(),
        purchase_price: z.number().int().min(0).optional(),
        category_id: z.string().uuid().optional().nullable(),
        brand_id: z.string().uuid().optional().nullable(),
        is_active: z.boolean().optional(),
      }).refine(obj => Object.keys(obj).length > 0, 'Хоча б одне поле для оновлення'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const { product_ids, updates } = parsed.data
    const updateData: Record<string, unknown> = { ...updates, updated_at: new Date().toISOString() }

    const { error } = await db
      .from('products')
      .update(updateData)
      .in('id', product_ids)
      .is('deleted_at', null)

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // Audit log
    const { logAction } = await import('../services/auditService.js')
    void logAction({
      userId: req.user!.id, userRole: req.user!.role,
      action: 'bulk_update', entityType: 'product',
      entityId: product_ids[0],
    })

    res.json({ data: { updated: product_ids.length, product_ids, updates } })
  } catch (err) { next(err) }
})

// GET /api/v1/products/:id — карточка товара
router.get('/:id', async (req, res, next) => {
  try {
    const product = await productService.getProduct(String(req.params.id))
    res.json({ data: product })
  } catch (err) { next(err) }
})

// GET /api/v1/products/:id/price-history — история цен
router.get('/:id/price-history', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const history = await productService.getPriceHistory(String(req.params.id))
    res.json({ data: history })
  } catch (err) { next(err) }
})

// GET /api/v1/products/:id/analogs — аналоги товара (ТЗ Analog Display Logic)
router.get('/:id/analogs', async (req, res, next) => {
  try {
    const result = await productService.getProductAnalogs(String(req.params.id))
    res.json(result)
  } catch (err) { next(err) }
})


// POST /api/v1/products/:id/analogs — додати аналог (ТЗ Product CRUD API)
router.post('/:id/analogs', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = addAnalogSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await productService.addProductAnalog(String(req.params.id), parsed.data, req.user!.id, req.user!.tenant_id)
    res.status(201).json({ data: result })
  } catch (err) { next(err) }
})

// DELETE /api/v1/products/:id/analogs/:analogId — видалити аналог
router.delete('/:id/analogs/:analogId', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const { db } = await import('../db/supabase.js')
    const { error } = await db
      .from('product_analogs')
      .delete()
      .eq('product_id', req.params.id)
      .eq('analog_product_id', req.params.analogId)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (err) { next(err) }
})

// GET /api/v1/products/:id/cobuy — супутні товари
router.get('/:id/cobuy', async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('product_cobuy')
      .select('recommended_product_id, recommended:recommended_product_id!inner(id, sku, name, retail_price, qty_on_hand, unit)')
      .eq('product_id', req.params.id)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    const items = (data ?? []).map((r: any) => r.recommended)
    res.json({ data: items })
  } catch (err) { next(err) }
})

// POST /api/v1/products/:id/cobuy — додати супутні товари
router.post('/:id/cobuy', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const { z } = await import('zod')
    const parsed = z.object({ product_ids: z.array(z.string().uuid()).min(1) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Масив product_ids обов\'язковий', 422)
    const rows = parsed.data.product_ids.map((pid: string) => ({
      product_id: req.params.id,
      recommended_product_id: pid,
    }))
    const { error } = await db.from('product_cobuy').insert(rows)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data: { added: rows.length } })
  } catch (err) { next(err) }
})

// DELETE /api/v1/products/:id/cobuy/:recommendedId — видалити супутній зв'язок
router.delete('/:id/cobuy/:recommendedId', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const { error } = await db.from('product_cobuy').delete()
      .eq('product_id', req.params.id)
      .eq('recommended_product_id', req.params.recommendedId)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (err) { next(err) }
})

// POST /api/v1/products — создать товар
router.post('/', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = createProductSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані товару', 422, parsed.error.flatten())
    const product = await productService.createProduct(parsed.data, req.user!.id, req.user!.tenant_id)
    res.status(201).json({ data: product })
  } catch (err) { next(err) }
})

// PUT /api/v1/products/:id — обновить товар
router.put('/:id', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = updateProductSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані товару', 422, parsed.error.flatten())
    const product = await productService.updateProduct(String(req.params.id), parsed.data, req.user!.id)
    res.json({ data: product })
  } catch (err) { next(err) }
})

// DELETE /api/v1/products/:id — soft delete
router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await productService.deleteProduct(String(req.params.id))
    res.status(204).send()
  } catch (err) { next(err) }
})

// GET /api/v1/products/:id/stock — доступний залишок (E-0: qty_on_hand / reserved / available)
router.get('/:id/stock', async (req, res, next) => {
  try {
    const breakdown = await productService.getStockBreakdown(String(req.params.id))
    res.json({ data: breakdown })
  } catch (err) { next(err) }
})

// PUT /api/v1/products/:id/stock — коррекция остатка (ТЗ Product CRUD API)
router.put('/:id/stock', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = stockCorrectionSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const product = await productService.updateStock(String(req.params.id), parsed.data, req.user!.id)
    res.json({ data: product })
  } catch (err) { next(err) }
})

// GET /api/v1/products/:id/fitment — сумісність з авто (ТЗ Product CRUD API)
router.get('/:id/fitment', async (req, res, next) => {
  try {
    const result = await productService.getProductFitment(String(req.params.id))
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/v1/products/:id/history — історія товару (ціни + рух) (ТЗ Product CRUD API)
router.get('/:id/history', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const history = await productService.getProductHistory(String(req.params.id), req.user!.tenant_id)
    res.json({ data: history })
  } catch (err) { next(err) }
})

// POST /api/v1/products/:id/generate-barcode — генерувати внутрішній штрих-код
router.post('/:id/generate-barcode', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const barcode = await productService.generateBarcode()
    const updated = await productService.updateProduct(String(req.params.id), { barcode }, req.user!.id)
    res.json({ data: updated })
  } catch (err) { next(err) }
})

// POST /api/v1/products/merge — злиття дублікатів (перед /:id щоб не конфліктувати)
router.post('/merge', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { z } = await import('zod')
    const schema = z.object({
      primary_product_id: z.string().uuid('ID основного товару обов\'язковий'),
      duplicate_product_id: z.string().uuid('ID дубліката обов\'язковий'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    if (parsed.data.primary_product_id === parsed.data.duplicate_product_id) {
      throw new AppError('SAME_PRODUCT', 'Не можна злити товар з самим собою', 400)
    }
    const { data, error } = await db.rpc('merge_products', {
      p_primary_id: parsed.data.primary_product_id,
      p_duplicate_id: parsed.data.duplicate_product_id,
    })
    if (error) {
      const msg = error.message ?? ''
      if (msg.includes('PRODUCT_NOT_FOUND')) throw new AppError('NOT_FOUND', 'Товар не знайдено', 404)
      throw new AppError('DB_ERROR', msg, 500)
    }
    res.json({ data })
  } catch (err) { next(err) }
})

export default router