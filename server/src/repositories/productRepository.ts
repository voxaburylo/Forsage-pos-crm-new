import { db } from '../db/supabase.js'

export interface Product {
  id: string
  sku: string
  name: string
  barcode?: string | null
  retail_price: number
  qty_on_hand: number
  reorder_point?: number | null
  unit?: string | null
  is_active: boolean
  is_service?: boolean
  deleted_at?: string | null
  brand_id?: string | null
  category_id?: string | null
  tenant_id: string
}

export interface IProductRepository {
  findByIds(ids: string[], tenantId: string): Promise<Product[]>
  findBySku(sku: string, tenantId: string): Promise<Product | null>
  findByName(name: string, tenantId: string): Promise<Product | null>
  findByBarcodes(barcodes: string[], tenantId: string): Promise<Product[]>
  findBySkus(skus: string[], tenantId: string): Promise<Product[]>
  searchByName(name: string, limit: number, tenantId: string): Promise<Product[]>
  insert(data: Partial<Product>, tenantId: string): Promise<Product>
  update(id: string, data: Partial<Product>, tenantId: string): Promise<Product>
}

export class ProductRepository implements IProductRepository {
  async findByIds(ids: string[], tenantId: string): Promise<Product[]> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .eq('tenant_id', tenantId)
      .in('id', ids)
      .is('deleted_at', null)
    if (error) throw error
    return data || []
  }

  async findBySku(sku: string, tenantId: string): Promise<Product | null> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('sku', sku)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async findByName(name: string, tenantId: string): Promise<Product | null> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('name', name.trim())
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async findByBarcodes(barcodes: string[], tenantId: string): Promise<Product[]> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .eq('tenant_id', tenantId)
      .in('barcode', barcodes)
      .is('deleted_at', null)
    if (error) throw error
    return data || []
  }

  async findBySkus(skus: string[], tenantId: string): Promise<Product[]> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .eq('tenant_id', tenantId)
      .in('sku', skus)
      .is('deleted_at', null)
    if (error) throw error
    return data || []
  }

  async searchByName(name: string, limit: number, tenantId: string): Promise<Product[]> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .eq('tenant_id', tenantId)
      .ilike('name', `%${name.trim().slice(0, 60)}%`)
      .is('deleted_at', null)
      .limit(limit)
    if (error) throw error
    return data || []
  }

  async insert(data: Partial<Product>, tenantId: string): Promise<Product> {
    const { data: inserted, error } = await db
      .from('products')
      .insert({ ...data, tenant_id: tenantId })
      .select()
      .single()
    if (error) throw error
    return inserted
  }

  async update(id: string, data: Partial<Product>, tenantId: string): Promise<Product> {
    const { data: updated, error } = await db
      .from('products')
      .update(data)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single()
    if (error) throw error
    return updated
  }
}

export const productRepository = new ProductRepository()
