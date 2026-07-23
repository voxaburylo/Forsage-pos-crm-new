import { Router } from 'express'
import { db } from '../db/supabase.js'
import { requireAuth } from '../middleware/auth.js'
import { buildProductSearchTerms, searchProductsForPOS } from '../services/searchService.js'
import { normalizeArticle } from '../validators/productValidator.js'
import { AppError } from '../middleware/errorHandler.js'
import { importSupplierCatalogProduct } from '../services/supplierCatalogProductService.js'
import { normalizeExactBarcode } from '../lib/productIdentity.js'

const router = Router()
router.use(requireAuth)

router.get('/hybrid', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    const limit = Math.min(Number(req.query.limit) || 10, 50)
    const tenantId = req.user!.tenant_id
    if (!q) return res.json({ data: { warehouse: [], supplier_catalog: [] } })

    const warehouseResults = await searchProductsForPOS(q, limit, tenantId)
    const catalogTerms = buildProductSearchTerms(q)
    const wordTerms = catalogTerms.flatMap((term) => term.split(/\s+/)).filter((term) => term.length >= 2)
    const conditions = [...new Set([...catalogTerms, ...wordTerms])]
      .sort((left, right) => right.length - left.length)
      .slice(0, 16)
      .flatMap((term) => {
        const safe = term.replace(/[,()*%]/g, ' ').replace(/\s+/g, ' ').trim()
        return safe
          ? [`sku.ilike.*${safe}*`, `sku.ilike.*${normalizeArticle(safe)}*`, `barcode.ilike.*${safe}*`, `name.ilike.*${safe}*`]
          : []
      })
      .join(',')
    const { data: catalogResults, error } = await db
      .from('supplier_price_items')
      .select('id, sku, barcode, brand, name, price_kopecks, qty, warehouse_name, supplier_id, supplier:suppliers(id, name)')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .or(conditions || 'name.ilike.*__no_match__*')
      .limit(limit)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: { warehouse: warehouseResults || [], supplier_catalog: catalogResults || [] } })
  } catch (error) { next(error) }
})

router.get('/vehicles', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    const limit = Math.min(Number(req.query.limit) || 10, 50)
    const tenantId = req.user!.tenant_id
    if (!q) return res.json({ data: [] })
    const { data, error } = await db
      .from('customer_vehicles')
      .select('id, vin, brand, model, year, customer:customers(id, full_name, phone)')
      .eq('tenant_id', tenantId)
      .or(`vin.ilike.%${q}%,brand.ilike.%${q}%,model.ilike.%${q}%`)
      .limit(limit)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data || [] })
  } catch (error) { next(error) }
})

router.get('/catalog', async (req, res, next) => {
  try {
    const supplierId = req.query.supplier_id as string || null
    const q = String(req.query.q || '').trim()
    const page = Math.max(Number(req.query.page) || 1, 1)
    const limit = Math.min(Number(req.query.limit) || 25, 100)
    const offset = (page - 1) * limit
    const tenantId = req.user!.tenant_id
    let query = db
      .from('supplier_price_items')
      .select('id, sku, barcode, brand, name, price_kopecks, qty, warehouse_name, supplier_id, supplier:suppliers(id, name)', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
    if (supplierId) query = query.eq('supplier_id', supplierId)
    if (q) {
      const normalized = normalizeArticle(q)
      const safe = q.replace(/[,()*%]/g, ' ').replace(/\s+/g, ' ').trim()
      query = query.or(`sku.ilike.%${normalized}%,barcode.ilike.%${safe}%,name.ilike.%${safe}%`)
    }
    const { data, error, count } = await query
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data || [], pagination: { page, limit, total: count || 0 } })
  } catch (error) { next(error) }
})

router.post('/import-on-demand', async (req, res, next) => {
  try {
    const { sku, barcode, brand, name, supplier_id, purchase_price, retail_price } = req.body
    if (!String(name || '').trim()) {
      throw new AppError('VALIDATION_ERROR', "Назва товару є обов'язковою", 400)
    }
    const result = await importSupplierCatalogProduct({
      sku: String(sku || ''),
      barcode: normalizeExactBarcode(barcode),
      brandName: String(brand || ''),
      name: String(name).trim(),
      supplierId: supplier_id || null,
      purchasePrice: Number(purchase_price) || 0,
      retailPrice: retail_price !== undefined && retail_price !== null ? Number(retail_price) : undefined,
    }, req.user!.tenant_id, req.user!.id)
    res.status(result.reused ? 200 : 201).json({ data: result.product, reused: result.reused })
  } catch (error) { next(error) }
})

router.post('/catalog', async (req, res, next) => {
  try {
    const { sku, barcode, brand, name, price_kopecks, qty, warehouse_name, supplier_id } = req.body
    if (!String(sku || '').trim() || !String(name || '').trim()) {
      throw new AppError('VALIDATION_ERROR', "Артикул та назва є обов'язковими", 400)
    }
    const { data, error } = await db
      .from('supplier_price_items')
      .insert({
        tenant_id: req.user!.tenant_id,
        sku: normalizeArticle(String(sku)),
        barcode: normalizeExactBarcode(barcode),
        brand: String(brand || '').trim() || null,
        name: String(name).trim(),
        price_kopecks: Math.max(0, Math.round(Number(price_kopecks) || 0)),
        qty: String(qty || '0'),
        warehouse_name: String(warehouse_name || '').trim() || null,
        supplier_id: supplier_id || null,
        deleted_at: null,
      })
      .select('id, sku, barcode, brand, name, price_kopecks, qty, warehouse_name, supplier_id, supplier:suppliers(id, name)')
      .single()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
  } catch (error) { next(error) }
})

router.put('/catalog/:id', async (req, res, next) => {
  try {
    const { sku, barcode, brand, name, price_kopecks, qty, warehouse_name, supplier_id } = req.body
    const { data, error } = await db
      .from('supplier_price_items')
      .update({
        sku: sku ? normalizeArticle(String(sku)) : undefined,
        barcode: barcode !== undefined ? normalizeExactBarcode(barcode) : undefined,
        brand: brand !== undefined ? String(brand || '').trim() || null : undefined,
        name: name ? String(name).trim() : undefined,
        price_kopecks: price_kopecks !== undefined ? Math.max(0, Math.round(Number(price_kopecks) || 0)) : undefined,
        qty: qty !== undefined ? String(qty || '0') : undefined,
        warehouse_name: warehouse_name !== undefined ? String(warehouse_name || '').trim() || null : undefined,
        supplier_id: supplier_id !== undefined ? supplier_id || null : undefined,
        deleted_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)
      .select('id, sku, barcode, brand, name, price_kopecks, qty, warehouse_name, supplier_id, supplier:suppliers(id, name)')
      .maybeSingle()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    if (!data) throw new AppError('NOT_FOUND', 'Чернову позицію не знайдено', 404)
    res.json({ data })
  } catch (error) { next(error) }
})

router.delete('/catalog/:id', async (req, res, next) => {
  try {
    const timestamp = new Date().toISOString()
    const { error } = await db
      .from('supplier_price_items')
      .update({ deleted_at: timestamp, updated_at: timestamp })
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (error) { next(error) }
})

export default router
