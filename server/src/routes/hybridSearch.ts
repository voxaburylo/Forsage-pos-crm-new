import { Router } from 'express'
import { db } from '../db/supabase.js'
import { requireAuth } from '../middleware/auth.js'
import { searchProductsForPOS } from '../services/searchService.js'
import { normalizeArticle } from '../validators/productValidator.js'
import { AppError } from '../middleware/errorHandler.js'
import { importFromCatalog } from '../services/productService.js'
import { fixKeyboardLayout } from '../services/keyboardService.js'
import { isLatinText, transliterateToCyrillic } from '../services/translitService.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/search/hybrid?q=...&limit=...
router.get('/hybrid', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    const limit = Math.min(Number(req.query.limit) || 10, 50)
    const tenantId = req.user!.tenant_id

    if (!q) {
      return res.json({ data: { warehouse: [], supplier_catalog: [] } })
    }

    // 1. Пошук по основному складу
    const warehouseResults = await searchProductsForPOS(q, limit, tenantId)

    // 2. Пошук по прайсах постачальників
    const catalogTerms = [q]
    if (isLatinText(q)) {
      catalogTerms.push(...fixKeyboardLayout(q))
      const translit = transliterateToCyrillic(q)
      catalogTerms.push(translit, translit.replace(/і/g, 'и').replace(/ї/g, 'й').replace(/є/g, 'е').replace(/ґ/g, 'г'))
    }
    const catalogConditions = [...new Set(catalogTerms)]
      .flatMap((term) => {
        const safe = term.replace(/[,()]/g, ' ').replace(/\s+/g, ' ').trim()
        return safe ? [`sku.ilike.*${normalizeArticle(safe)}*`, `name.ilike.*${safe}*`] : []
      })
      .join(',')
    const { data: catalogResults, error: catalogError } = await db
      .from('supplier_price_items')
      .select('id, sku, brand, name, price_kopecks, qty, warehouse_name, supplier:suppliers(id, name)')
      .eq('tenant_id', tenantId)
      .or(catalogConditions || 'name.ilike.*__no_match__*')
      .limit(limit)

    if (catalogError) throw new AppError('DB_ERROR', catalogError.message, 500)

    res.json({
      data: {
        warehouse: warehouseResults || [],
        supplier_catalog: catalogResults || []
      }
    })
  } catch (err) { next(err) }
})

// GET /api/v1/search/vehicles?q=...&limit=...
router.get('/vehicles', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    const limit = Math.min(Number(req.query.limit) || 10, 50)
    const tenantId = req.user!.tenant_id

    if (!q) {
      return res.json({ data: [] })
    }

    const { data, error } = await db
      .from('customer_vehicles')
      .select('id, vin, brand, model, year, customer:customers(id, full_name, phone)')
      .eq('tenant_id', tenantId)
      .or(`vin.ilike.%${q}%,brand.ilike.%${q}%,model.ilike.%${q}%`)
      .limit(limit)

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    res.json({ data: data || [] })
  } catch (err) { next(err) }
})

// GET /api/v1/search/catalog?supplier_id=...&q=...&page=...&limit=...
router.get('/catalog', async (req, res, next) => {
  try {
    const supplierId = req.query.supplier_id as string || null
    const q = String(req.query.q || '').trim()
    const page = Math.max(Number(req.query.page) || 1, 1)
    const limit = Math.min(Number(req.query.limit) || 25, 100)
    const offset = (page - 1) * limit
    const tenantId = req.user!.tenant_id

    let queryBuilder = db
      .from('supplier_price_items')
      .select('id, sku, brand, name, price_kopecks, qty, warehouse_name, supplier:suppliers(id, name)', { count: 'exact' })
      .eq('tenant_id', tenantId)

    if (supplierId) {
      queryBuilder = queryBuilder.eq('supplier_id', supplierId)
    }

    if (q) {
      const normalized = normalizeArticle(q)
      queryBuilder = queryBuilder.or(`sku.ilike.%${normalized}%,name.ilike.%${q}%`)
    }

    const { data, error, count } = await queryBuilder
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    res.json({
      data: data || [],
      pagination: {
        page,
        limit,
        total: count || 0
      }
    })
  } catch (err) { next(err) }
})

// POST /api/v1/search/import-on-demand
router.post('/import-on-demand', async (req, res, next) => {
  try {
    const { sku, brand, name, supplier_id, purchase_price, retail_price } = req.body
    const tenantId = req.user!.tenant_id

    if (!sku || !name) {
      throw new AppError('VALIDATION_ERROR', "Артикул та назва є обов'язковими", 400)
    }

    const product = await importFromCatalog({
      sku,
      brandName: brand || '',
      name,
      supplierId: supplier_id || null,
      purchasePrice: Number(purchase_price) || 0,
      retailPrice: retail_price !== undefined && retail_price !== null ? Number(retail_price) : undefined
    }, tenantId)

    res.status(201).json({ data: product })
  } catch (err) { next(err) }
})


// POST /api/v1/search/catalog — додати вручну
router.post('/catalog', async (req, res, next) => {
  try {
    const { sku, brand, name, price_kopecks, qty, warehouse_name, supplier_id } = req.body
    const tenantId = req.user!.tenant_id

    if (!sku || !name) {
      throw new AppError('VALIDATION_ERROR', "Артикул та назва є обов'язковими", 400)
    }

    const { data, error } = await db
      .from('supplier_price_items')
      .insert({
        tenant_id: tenantId,
        sku: normalizeArticle(sku),
        brand: brand || null,
        name,
        price_kopecks: Number(price_kopecks) || 0,
        qty: qty || '0',
        warehouse_name: warehouse_name || null,
        supplier_id: supplier_id || null,
      })
      .select('id, sku, brand, name, price_kopecks, qty, warehouse_name, supplier:suppliers(id, name)')
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// PUT /api/v1/search/catalog/:id — редагувати
router.put('/catalog/:id', async (req, res, next) => {
  try {
    const { sku, brand, name, price_kopecks, qty, warehouse_name, supplier_id } = req.body
    const tenantId = req.user!.tenant_id

    const { data, error } = await db
      .from('supplier_price_items')
      .update({
        sku: sku ? normalizeArticle(sku) : undefined,
        brand: brand !== undefined ? (brand || null) : undefined,
        name: name || undefined,
        price_kopecks: price_kopecks !== undefined ? (Number(price_kopecks) || 0) : undefined,
        qty: qty !== undefined ? (qty || '0') : undefined,
        warehouse_name: warehouse_name !== undefined ? (warehouse_name || null) : undefined,
        supplier_id: supplier_id !== undefined ? (supplier_id || null) : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .select('id, sku, brand, name, price_kopecks, qty, warehouse_name, supplier:suppliers(id, name)')
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data })
  } catch (err) { next(err) }
})

// DELETE /api/v1/search/catalog/:id — видалити
router.delete('/catalog/:id', async (req, res, next) => {
  try {
    const tenantId = req.user!.tenant_id
    const { error } = await db
      .from('supplier_price_items')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
