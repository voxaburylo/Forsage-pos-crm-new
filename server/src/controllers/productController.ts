import type { Request, Response, NextFunction } from 'express'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { applyMarkup, roundingFromSettings, type MarkupRule } from '../lib/markup.js'
import {
  createProductSchema,
  updateProductSchema,
  productListSchema,
  posSearchSchema,
  stockCorrectionSchema,
  addAnalogSchema,
  bulkCrossNumbersSchema,
  importCrossNumbersSchema,
} from '../validators/productValidator.js'
import * as productService from '../services/productService.js'

export async function exportCsv(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await db
      .from('products')
      .select('id, sku, name, barcode, retail_price, purchase_price, qty_on_hand, unit, storage_bin, brand:brands(name), category:categories(name)')
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)
      .order('name')

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    const header = 'ID,Артикул,Назва,ШтрихКод,РоздрібнаЦіна,Собівартість,Залишок,Одиниця,Ячейка,Бренд,Категорія'
    const rows = (data ?? []).map((p: any) =>
      `"${p.id}","${p.sku}","${(p.name ?? '').replace(/"/g, '""')}","${p.barcode ?? ''}",${p.retail_price ?? 0},${p.purchase_price ?? 0},${p.qty_on_hand ?? 0},"${p.unit ?? ''}","${p.storage_bin ?? ''}","${p.brand?.name ?? ''}","${p.category?.name ?? ''}"`
    ).join('\n')

    const bom = '\uFEFF'
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename=products.csv')
    res.send(bom + header + '\n' + rows)
  } catch (err) { next(err) }
}

export async function generateBarcodeOnly(req: Request, res: Response, next: NextFunction) {
  try {
    const barcode = await productService.generateBarcode(req.user!.tenant_id)
    res.json({ data: { barcode } })
  } catch (err) { next(err) }
}

export async function importBulk(req: Request, res: Response, next: NextFunction) {
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
          if (resObj.old_qty <= 0 && resObj.new_qty > 0) {
            const { notifyWaitlistCustomers } = await import('../routes/waitlist.js').catch(() => ({ notifyWaitlistCustomers: null }))
            if (notifyWaitlistCustomers) void notifyWaitlistCustomers(resObj.id, req.user!.tenant_id)
          }
        }
      } catch {
        errors++
      }
    }

    res.json({ data: { created, updated, errors } })
  } catch (err) { next(err) }
}

export async function search(req: Request, res: Response, next: NextFunction) {
  try {
    const query = posSearchSchema.safeParse(req.query)
    if (!query.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри пошуку', 400, query.error.flatten())
    const results = await productService.searchForPOS(query.data.q, query.data.limit, req.user!.tenant_id)
    res.json({ data: results })
  } catch (err) { next(err) }
}

export async function getSupplierPrices(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await productService.getSupplierPrices(String(req.params.id), req.user!.tenant_id)
    res.json({ data })
  } catch (err) { next(err) }
}

export async function getFavorites(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await db
      .from('products')
      .select('id, sku, name, retail_price, unit, qty_on_hand, storage_bin, requires_core_return, core_deposit_amount, brand:brands(name)')
      .eq('tenant_id', req.user!.tenant_id)
      .eq('is_favorite', true)
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('name')
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
}

export async function getList(req: Request, res: Response, next: NextFunction) {
  try {
    const query = productListSchema.safeParse(req.query)
    if (!query.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметры', 400, query.error.flatten())
    const result = await productService.listProducts(query.data, req.user!.tenant_id)
    res.json(result)
  } catch (err) { next(err) }
}

export async function bulkUpdate(req: Request, res: Response, next: NextFunction) {
  try {
    const { z } = await import('zod')
    const bulkUpdateSchema = z.object({
      product_ids: z.array(z.string().uuid()).min(1),
      updates: z.object({
        category_id: z.string().uuid().optional().nullable(),
        brand_id: z.string().uuid().optional().nullable(),
        storage_bin: z.string().max(50).optional().nullable(),
        retail_price_action: z.object({
          type: z.enum(['percent', 'amount', 'markup', 'markup_table']),
          value: z.number(),
        }).optional(),
      }),
    })
    const parsed = bulkUpdateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const { product_ids, updates } = parsed.data
    const { retail_price_action, ...standardUpdates } = updates

    if (retail_price_action) {
      const { data: prods, error: fetchErr } = await db
        .from('products')
        .select('id, retail_price, purchase_price')
        .in('id', product_ids)
        .eq('tenant_id', req.user!.tenant_id)
      if (fetchErr) throw new AppError('DB_ERROR', fetchErr.message, 500)

      // Для «націнки по таблиці» тягнемо матрицю націнок + округлення один раз.
      let tableRules: MarkupRule[] | undefined
      let tableRounding = null as ReturnType<typeof roundingFromSettings>
      if (retail_price_action.type === 'markup_table') {
        const { data: settings } = await db
          .from('shop_settings')
          .select('markup_rules, price_rounding_enabled, price_rounding_step, price_rounding_dir')
          .eq('tenant_id', req.user!.tenant_id)
          .single()
        tableRules = (settings as any)?.markup_rules as MarkupRule[] | undefined
        tableRounding = roundingFromSettings(settings)
      }

      await Promise.all((prods ?? []).map(async (prod: any) => {
        const prodUpdates: any = {
          ...standardUpdates,
          updated_at: new Date().toISOString(),
        }

        const newPurchasePrice = prod.purchase_price
        if (prod.retail_price !== null && prod.retail_price !== undefined) {
          let newRetailPrice = prod.retail_price
          if (retail_price_action.type === 'percent') {
            newRetailPrice = Math.round(prod.retail_price * (1 + retail_price_action.value / 100))
          } else if (retail_price_action.type === 'amount') {
            newRetailPrice = prod.retail_price + retail_price_action.value
          } else if (retail_price_action.type === 'markup') {
            newRetailPrice = Math.round(newPurchasePrice * (1 + retail_price_action.value / 100))
          } else if (retail_price_action.type === 'markup_table') {
            // Кожному товару — націнка за його діапазоном закупівельної ціни (з округленням).
            newRetailPrice = applyMarkup(newPurchasePrice ?? 0, tableRules, retail_price_action.value || 30, tableRounding)
          }
          prodUpdates.retail_price = Math.max(0, newRetailPrice)
        }

        const { error: updateError } = await db
          .from('products')
          .update(prodUpdates)
          .eq('id', prod.id)
          .eq('tenant_id', req.user!.tenant_id)

        if (updateError) throw new AppError('DB_ERROR', updateError.message, 500)
      }))
    } else {
      const updateData: Record<string, unknown> = { ...standardUpdates, updated_at: new Date().toISOString() }
      const { error } = await db
        .from('products')
        .update(updateData)
        .in('id', product_ids)
        .eq('tenant_id', req.user!.tenant_id)
        .is('deleted_at', null)

      if (error) throw new AppError('DB_ERROR', error.message, 500)
    }

    const { logAction } = await import('../services/auditService.js')
    void logAction({
      tenantId: req.user!.tenant_id,
      userId: req.user!.id, userRole: req.user!.role,
      action: 'bulk_update', entityType: 'product',
      entityId: product_ids[0],
    })

    res.json({ data: { updated: product_ids.length, product_ids, updates } })
  } catch (err) { next(err) }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const product = await productService.getProduct(String(req.params.id), req.user!.tenant_id)
    res.json({ data: product })
  } catch (err) { next(err) }
}

export async function getPriceHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const history = await productService.getPriceHistory(String(req.params.id), req.user!.tenant_id)
    res.json({ data: history })
  } catch (err) { next(err) }
}

export async function getAnalogs(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await productService.getProductAnalogs(String(req.params.id), req.user!.tenant_id)
    res.json(result)
  } catch (err) { next(err) }
}

export async function addAnalog(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = addAnalogSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await productService.addProductAnalog(String(req.params.id), parsed.data, req.user!.id, req.user!.tenant_id)
    res.status(201).json({ data: result })
  } catch (err) { next(err) }
}

export async function removeAnalog(req: Request, res: Response, next: NextFunction) {
  try {
    const { db } = await import('../db/supabase.js')
    const { error } = await db
      .from('product_analogs')
      .delete()
      .eq('product_id', req.params.id)
      .eq('analog_product_id', req.params.analogId)
      .eq('tenant_id', req.user!.tenant_id)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (err) { next(err) }
}

export async function getCrossNumbers(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await productService.getProductCrossNumbers(String(req.params.id), req.user!.tenant_id)
    res.json({ data: result })
  } catch (err) { next(err) }
}

export async function addCrossNumbers(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = bulkCrossNumbersSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Перевірте список номерів', 422, parsed.error.flatten())
    }
    const result = await productService.addProductCrossNumbers(
      String(req.params.id),
      parsed.data,
      req.user!.id,
      req.user!.role,
      req.user!.tenant_id,
    )
    res.status(201).json({ data: result })
  } catch (err) { next(err) }
}

// Масовий імпорт крос-номерів: рядки "наш артикул; крос1; крос2 ..."
export async function importCrossNumbers(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = importCrossNumbersSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Перевірте дані імпорту', 422, parsed.error.flatten())
    }
    const result = await productService.importCrossNumbersBulk(
      parsed.data.text,
      parsed.data.source ?? 'Масовий імпорт',
      req.user!.id,
      req.user!.tenant_id,
    )
    res.json({ data: result })
  } catch (err) { next(err) }
}

export async function removeCrossNumber(req: Request, res: Response, next: NextFunction) {
  try {
    await productService.removeProductCrossNumber(
      String(req.params.id),
      String(req.params.crossNumberId),
      req.user!.id,
      req.user!.role,
      req.user!.tenant_id,
    )
    res.status(204).send()
  } catch (err) { next(err) }
}

export async function getCobuy(req: Request, res: Response, next: NextFunction) {
  try {
    await productService.getProduct(String(req.params.id), req.user!.tenant_id)
    const { data, error } = await db
      .from('product_cobuy')
      .select('recommended_product_id, recommended:recommended_product_id!inner(id, sku, name, retail_price, qty_on_hand, unit)')
      .eq('product_id', req.params.id)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    const items = (data ?? []).map((r: any) => r.recommended)
    res.json({ data: items })
  } catch (err) { next(err) }
}

export async function addCobuy(req: Request, res: Response, next: NextFunction) {
  try {
    const { z } = await import('zod')
    const parsed = z.object({ product_ids: z.array(z.string().uuid()).min(1) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Масив product_ids обов\'язковий', 422)
    await productService.getProduct(String(req.params.id), req.user!.tenant_id)
    for (const productId of parsed.data.product_ids) {
      await productService.getProduct(productId, req.user!.tenant_id)
    }
    const rows = parsed.data.product_ids.map((pid: string) => ({
      product_id: req.params.id,
      recommended_product_id: pid,
    }))
    const { error } = await db.from('product_cobuy').insert(rows)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data: { added: rows.length } })
  } catch (err) { next(err) }
}

export async function removeCobuy(req: Request, res: Response, next: NextFunction) {
  try {
    await productService.getProduct(String(req.params.id), req.user!.tenant_id)
    await productService.getProduct(String(req.params.recommendedId), req.user!.tenant_id)
    const { error } = await db.from('product_cobuy').delete()
      .eq('product_id', req.params.id)
      .eq('recommended_product_id', req.params.recommendedId)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (err) { next(err) }
}

export async function createOne(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createProductSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані товару', 422, parsed.error.flatten())
    const product = await productService.createProduct(parsed.data, req.user!.id, req.user!.tenant_id)
    res.status(201).json({ data: product })
  } catch (err) { next(err) }
}

export async function updateOne(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = updateProductSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані товару', 422, parsed.error.flatten())
    const product = await productService.updateProduct(String(req.params.id), parsed.data, req.user!.id, req.user!.tenant_id)
    res.json({ data: product })
  } catch (err) { next(err) }
}

export async function deleteOne(req: Request, res: Response, next: NextFunction) {
  try {
    await productService.deleteProduct(String(req.params.id), req.user!.tenant_id)
    res.status(204).send()
  } catch (err) { next(err) }
}

export async function getStock(req: Request, res: Response, next: NextFunction) {
  try {
    const breakdown = await productService.getStockBreakdown(String(req.params.id), req.user!.tenant_id)
    res.json({ data: breakdown })
  } catch (err) { next(err) }
}

export async function updateStock(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = stockCorrectionSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const product = await productService.updateStock(String(req.params.id), parsed.data, req.user!.id, req.user!.tenant_id)
    res.json({ data: product })
  } catch (err) { next(err) }
}

export async function getFitment(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await productService.getProductFitment(String(req.params.id), req.user!.tenant_id)
    res.json(result)
  } catch (err) { next(err) }
}

export async function getHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const history = await productService.getProductHistory(String(req.params.id), req.user!.tenant_id)
    res.json({ data: history })
  } catch (err) { next(err) }
}

export async function generateBarcode(req: Request, res: Response, next: NextFunction) {
  try {
    const barcode = await productService.generateBarcode(req.user!.tenant_id)
    const updated = await productService.updateProduct(String(req.params.id), { barcode }, req.user!.id, req.user!.tenant_id)
    res.json({ data: updated })
  } catch (err) { next(err) }
}

export async function merge(req: Request, res: Response, next: NextFunction) {
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
    await productService.getProduct(parsed.data.primary_product_id, req.user!.tenant_id)
    await productService.getProduct(parsed.data.duplicate_product_id, req.user!.tenant_id)
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
}
