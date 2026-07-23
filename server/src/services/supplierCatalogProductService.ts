import { randomUUID } from 'node:crypto'
import { db } from '../db/supabase.js'
import { applyMarkup, roundingFromSettings, type MarkupRule } from '../lib/markup.js'
import { normalizeExactBarcode, normalizeExactProductName } from '../lib/productIdentity.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizeArticle, normalizeOemValue } from '../validators/productValidator.js'
import { createProduct } from './productService.js'

type CatalogImportInput = {
  sku: string
  barcode?: string | null
  brandName: string
  name: string
  supplierId: string | null
  purchasePrice: number
  retailPrice?: number
}

type ProductIdentityRow = {
  id: string
  sku: string
  name: string
  barcode: string | null
}

const PRODUCT_SELECT = '*, brand:brands(id,name), category:categories(id,name)'

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function conflict(message: string, details?: unknown): never {
  throw new AppError('CATALOG_PRODUCT_CONFLICT', message, 409, details)
}

async function getProduct(productId: string, tenantId: string): Promise<any> {
  const { data, error } = await db
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('id', productId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? null
}

async function productIdsByBarcode(barcode: string, tenantId: string): Promise<string[]> {
  const [{ data: products, error: productsError }, { data: extra, error: extraError }] = await Promise.all([
    db.from('products')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('barcode', barcode)
      .is('deleted_at', null)
      .limit(3),
    db.from('product_barcodes')
      .select('product_id')
      .eq('tenant_id', tenantId)
      .eq('barcode', barcode)
      .is('deleted_at', null)
      .limit(3),
  ])
  if (productsError) throw new AppError('DB_ERROR', productsError.message, 500)
  if (extraError) throw new AppError('DB_ERROR', extraError.message, 500)
  return uniqueIds([
    ...(products ?? []).map((row: any) => row.id),
    ...(extra ?? []).map((row: any) => row.product_id),
  ])
}

async function productIdsBySku(sku: string, tenantId: string): Promise<string[]> {
  if (!sku) return []
  const { data, error } = await db
    .from('products')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('sku', sku)
    .is('deleted_at', null)
    .limit(3)
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return uniqueIds((data ?? []).map((row: any) => row.id))
}

async function productIdsByFullName(name: string, tenantId: string): Promise<string[]> {
  const normalizedName = normalizeExactProductName(name)
  if (!normalizedName) return []

  const matches: string[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from('products')
      .select('id,sku,name,barcode')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    const rows = (data ?? []) as ProductIdentityRow[]
    for (const row of rows) {
      if (normalizeExactProductName(row.name) === normalizedName) matches.push(row.id)
      if (matches.length > 1) return uniqueIds(matches)
    }
    if (rows.length < pageSize) break
  }
  return uniqueIds(matches)
}

async function findExactProduct(input: CatalogImportInput, tenantId: string): Promise<any | null> {
  const barcode = normalizeExactBarcode(input.barcode)
  const sku = input.sku.trim() ? normalizeArticle(input.sku) : ''
  const [barcodeIds, skuIds] = await Promise.all([
    barcode ? productIdsByBarcode(barcode, tenantId) : Promise.resolve([]),
    productIdsBySku(sku, tenantId),
  ])

  if (barcodeIds.length > 1) {
    conflict(`Штрихкод «${barcode}» належить кільком товарам. Виправте дублікати перед імпортом.`, { barcode, product_ids: barcodeIds })
  }
  if (skuIds.length > 1) {
    conflict(`Артикул «${sku}» належить кільком товарам. Виправте дублікати перед імпортом.`, { sku, product_ids: skuIds })
  }
  if (barcodeIds[0] && skuIds[0] && barcodeIds[0] !== skuIds[0]) {
    conflict('Штрихкод і артикул вказують на різні товари. Оберіть правильний товар вручну.', {
      barcode_product_id: barcodeIds[0], sku_product_id: skuIds[0],
    })
  }

  const identifierId = barcodeIds[0] ?? skuIds[0]
  if (identifierId) return getProduct(identifierId, tenantId)

  const nameIds = await productIdsByFullName(input.name, tenantId)
  if (nameIds.length > 1) {
    conflict(`Назва «${input.name.trim()}» точно збігається з кількома товарами. Оберіть товар вручну.`, {
      product_ids: nameIds,
    })
  }
  return nameIds[0] ? getProduct(nameIds[0], tenantId) : null
}

async function findOrCreateBrand(name: string, tenantId: string): Promise<string | null> {
  const normalizedName = name.trim()
  if (!normalizedName) return null
  const { data: existing, error: lookupError } = await db
    .from('brands')
    .select('id')
    .eq('tenant_id', tenantId)
    .ilike('name', normalizedName)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()
  if (lookupError) throw new AppError('DB_ERROR', lookupError.message, 500)
  if (existing) return existing.id

  const { data: created, error } = await db
    .from('brands')
    .insert({ tenant_id: tenantId, name: normalizedName, tier: 'standard' })
    .select('id')
    .single()
  if (!error && created) return created.id

  const { data: raced } = await db
    .from('brands')
    .select('id')
    .eq('tenant_id', tenantId)
    .ilike('name', normalizedName)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()
  if (raced) return raced.id
  throw new AppError('DB_ERROR', `Не вдалося створити бренд: ${error?.message ?? 'невідома помилка'}`, 500)
}

async function linkSupplierCode(
  productId: string,
  supplierId: string | null,
  supplierCode: string,
  supplierPrice: number,
  tenantId: string,
): Promise<void> {
  if (!supplierId || !supplierCode.trim()) return
  const normalizedCode = normalizeOemValue(supplierCode)
  const { data: existing, error: lookupError } = await db
    .from('product_supplier_codes')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('product_id', productId)
    .eq('supplier_id', supplierId)
    .eq('normalized_supplier_article', normalizedCode)
    .limit(1)
    .maybeSingle()
  if (lookupError) throw new AppError('DB_ERROR', lookupError.message, 500)
  if (existing) {
    const { error } = await db.from('product_supplier_codes')
      .update({ supplier_price: supplierPrice })
      .eq('id', existing.id)
      .eq('tenant_id', tenantId)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    return
  }
  const { error } = await db.from('product_supplier_codes').insert({
    tenant_id: tenantId,
    product_id: productId,
    supplier_id: supplierId,
    supplier_code: supplierCode.trim(),
    supplier_price: supplierPrice,
    normalized_supplier_article: normalizedCode,
  })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

export async function importSupplierCatalogProduct(
  input: CatalogImportInput,
  tenantId: string,
  userId: string,
): Promise<{ product: any; reused: boolean }> {
  const normalizedInput: CatalogImportInput = {
    ...input,
    sku: input.sku.trim(),
    barcode: normalizeExactBarcode(input.barcode),
    name: input.name.trim(),
    purchasePrice: Math.max(0, Math.round(Number(input.purchasePrice) || 0)),
    retailPrice: input.retailPrice == null ? undefined : Math.max(0, Math.round(Number(input.retailPrice) || 0)),
  }
  if (!normalizedInput.name) throw new AppError('VALIDATION_ERROR', "Назва товару є обов'язковою", 400)

  const exact = await findExactProduct(normalizedInput, tenantId)
  if (exact) {
    await linkSupplierCode(exact.id, normalizedInput.supplierId, normalizedInput.sku, normalizedInput.purchasePrice, tenantId)
    return { product: exact, reused: true }
  }

  const { data: settings, error: settingsError } = await db
    .from('shop_settings')
    .select('markup_rules, price_rounding_enabled, price_rounding_step, price_rounding_dir')
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (settingsError) throw new AppError('DB_ERROR', settingsError.message, 500)
  const retailPrice = normalizedInput.retailPrice ?? applyMarkup(
    normalizedInput.purchasePrice,
    (settings as any)?.markup_rules as MarkupRule[] | undefined,
    30,
    roundingFromSettings(settings),
  )
  const sku = normalizedInput.sku
    ? normalizeArticle(normalizedInput.sku)
    : `IMP-${randomUUID().replace(/-/g, '').toUpperCase()}`
  const brandId = await findOrCreateBrand(normalizedInput.brandName, tenantId)

  try {
    const created = await createProduct({
      sku,
      name: normalizedInput.name,
      barcode: normalizedInput.barcode,
      brand_id: brandId,
      category_id: null,
      unit: 'шт',
      purchase_price: normalizedInput.purchasePrice,
      retail_price: retailPrice,
      wholesale_price: 0,
      min_price: 0,
      qty_on_hand: 0,
      reorder_point: 0,
      notes: normalizedInput.supplierId ? 'Імпортовано з прайсу постачальника' : null,
      is_active: true,
      is_service: false,
      status: 'active',
      storage_bin: null,
      specs: {},
      requires_core_return: false,
      core_deposit_amount: 0,
    }, userId, tenantId)
    await linkSupplierCode(created.id, normalizedInput.supplierId, normalizedInput.sku, normalizedInput.purchasePrice, tenantId)
    return { product: created, reused: false }
  } catch (error) {
    if (error instanceof AppError && ['SKU_DUPLICATE', 'BARCODE_TAKEN'].includes(error.code)) {
      const raced = await findExactProduct(normalizedInput, tenantId)
      if (raced) {
        await linkSupplierCode(raced.id, normalizedInput.supplierId, normalizedInput.sku, normalizedInput.purchasePrice, tenantId)
        return { product: raced, reused: true }
      }
    }
    throw error
  }
}
