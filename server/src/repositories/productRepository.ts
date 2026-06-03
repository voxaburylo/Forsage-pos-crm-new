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
}

export interface IProductRepository {
  findByIds(ids: string[]): Promise<Product[]>
  findBySku(sku: string): Promise<Product | null>
  findByName(name: string): Promise<Product | null>
  findByBarcodes(barcodes: string[]): Promise<Product[]>
  findBySkus(skus: string[]): Promise<Product[]>
  searchByName(name: string, limit: number): Promise<Product[]>
  insert(data: Partial<Product>): Promise<Product>
  update(id: string, data: Partial<Product>): Promise<Product>
}

export class ProductRepository implements IProductRepository {
  async findByIds(ids: string[]): Promise<Product[]> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .in('id', ids)
      .is('deleted_at', null)
    if (error) throw error
    return data || []
  }

  async findBySku(sku: string): Promise<Product | null> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .eq('sku', sku)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async findByName(name: string): Promise<Product | null> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .eq('name', name.trim())
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async findByBarcodes(barcodes: string[]): Promise<Product[]> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .in('barcode', barcodes)
      .is('deleted_at', null)
    if (error) throw error
    return data || []
  }

  async findBySkus(skus: string[]): Promise<Product[]> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .in('sku', skus)
      .is('deleted_at', null)
    if (error) throw error
    return data || []
  }

  async searchByName(name: string, limit: number): Promise<Product[]> {
    const { data, error } = await db
      .from('products')
      .select('*')
      .ilike('name', `%${name.trim().slice(0, 60)}%`)
      .is('deleted_at', null)
      .limit(limit)
    if (error) throw error
    return data || []
  }

  async insert(data: Partial<Product>): Promise<Product> {
    const { data: inserted, error } = await db
      .from('products')
      .insert(data)
      .select()
      .single()
    if (error) throw error
    return inserted
  }

  async update(id: string, data: Partial<Product>): Promise<Product> {
    const { data: updated, error } = await db
      .from('products')
      .update(data)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return updated
  }
}

export const productRepository = new ProductRepository()
