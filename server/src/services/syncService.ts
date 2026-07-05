import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'

const PAGE_SIZE = 1000
const CURSOR_OVERLAP_MS = 5_000

async function fetchAll(buildQuery: (from: number, to: number) => any): Promise<any[]> {
  const rows: any[] = []
  let from = 0

  while (true) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
    from += PAGE_SIZE
  }
}

function withChangedSince(query: any, since?: string): any {
  if (!since) return query
  return query.or(`updated_at.gt.${since},deleted_at.gt.${since}`)
}

async function loadAvailability(productIds: string[]): Promise<Map<string, { qty_reserved: number; qty_available: number }>> {
  const result = new Map<string, { qty_reserved: number; qty_available: number }>()
  for (let start = 0; start < productIds.length; start += PAGE_SIZE) {
    const ids = productIds.slice(start, start + PAGE_SIZE)
    if (ids.length === 0) continue
    const { data, error } = await db
      .from('products_available')
      .select('product_id,qty_reserved,qty_available')
      .in('product_id', ids)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    for (const row of data ?? []) {
      result.set(row.product_id, {
        qty_reserved: Number(row.qty_reserved ?? 0),
        qty_available: Number(row.qty_available ?? 0),
      })
    }
  }
  return result
}

export interface SyncChangesInput {
  since?: string
  tenantId: string
  role: string
}

/**
 * One consistent local-first pull endpoint.
 *
 * The cursor intentionally trails the request by five seconds. Duplicate rows
 * are harmless IndexedDB upserts, while a gap during concurrent writes could
 * permanently lose a stock/customer update.
 */
export async function getSyncChanges({ since, tenantId, role }: SyncChangesInput) {
  const nextCursor = new Date(Date.now() - CURSOR_OVERLAP_MS).toISOString()

  const [productRows, customerRows, sales, categories, brands] = await Promise.all([
    fetchAll((from, to) => {
      let query = db
        .from('products')
        .select('*,brand:brands(id,name),category:categories(id,name)')
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: true })
      query = withChangedSince(query, since)
      if (!since) query = query.is('deleted_at', null)
      return query.range(from, to)
    }),
    fetchAll((from, to) => {
      let query = db
        .from('customers')
        .select('*,price_tier:price_tiers(id,name,discount_pct),customer_cars(vin)')
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: true })
      query = withChangedSince(query, since)
      if (!since) query = query.is('deleted_at', null)
      return query.range(from, to)
    }),
    fetchAll((from, to) => {
      let query = db
        .from('sales')
        .select('*,sale_items(*,product:products(id,sku,name,unit)),customer:customers(id,phone,full_name)')
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: true })
      if (since) query = query.gt('updated_at', since)
      return query.range(from, to)
    }),
    fetchAll((from, to) => db
      .from('categories')
      .select('id,parent_id,name,sort_order,created_at')
      .eq('tenant_id', tenantId)
      .order('sort_order', { ascending: true })
      .range(from, to)),
    fetchAll((from, to) => db
      .from('brands')
      .select('id,name,country,created_at')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true })
      .range(from, to)),
  ])

  const deletedProductIds = productRows.filter((row) => row.deleted_at).map((row) => row.id)
  const activeProducts = productRows.filter((row) => !row.deleted_at)
  const availability = await loadAvailability(activeProducts.map((row) => row.id))
  const products = activeProducts.map((product) => {
    const available = availability.get(product.id)
    const result = {
      ...product,
      qty_reserved: available?.qty_reserved ?? 0,
      qty_available: available?.qty_available ?? Number(product.qty_on_hand ?? 0),
    }
    if (role === 'cashier' || role === 'manager') {
      delete result.purchase_price
      delete result.cost_price
    }
    return result
  })

  const deletedCustomerIds = customerRows.filter((row) => row.deleted_at).map((row) => row.id)
  const customers = customerRows
    .filter((row) => !row.deleted_at)
    .map((customer) => ({
      ...customer,
      primary_vin: customer.customer_cars?.find((car: any) => car.vin)?.vin ?? null,
      car_count: Array.isArray(customer.customer_cars) ? customer.customer_cars.length : 0,
      customer_cars: undefined,
    }))

  return {
    cursor: nextCursor,
    products,
    deleted_product_ids: deletedProductIds,
    customers,
    deleted_customer_ids: deletedCustomerIds,
    sales,
    categories,
    brands,
  }
}
