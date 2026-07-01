import { db } from '../db/supabase.js'

export interface Sale {
  id: string
  sale_number?: string
  tenant_id: string
  cashier_id: string
  shift_id: string
  customer_id?: string | null
  manager_id?: string | null
  total: number
  payment_method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'
  discount: number
  notes?: string | null
  cash_amount?: number
  card_amount?: number
  pickup_cell?: string | null
  status: 'draft' | 'suspended' | 'completed' | 'cancelled' | 'ready_for_pickup'
  is_fiscal?: boolean
  fiscal_number?: string | null
  fiscal_qr_url?: string | null
  bank_auth_code?: string | null
  terminal_rrn?: string | null
  bonuses_spent?: number
  bonuses_earned?: number
  completed_at?: string | null
  created_at?: string
  updated_at?: string
}

export interface SaleItem {
  id: string
  sale_id: string
  product_id: string
  qty: number
  unit_price: number
  discount: number
  total: number
  created_at?: string
}

export interface ISaleRepository {
  findById(id: string, tenantId: string): Promise<any | null>
  findItemsBySaleId(saleId: string, tenantId: string): Promise<any[]>
  insertSale(data: Partial<Sale>, tenantId: string): Promise<Sale>
  insertSaleItems(items: Partial<SaleItem>[]): Promise<SaleItem[]>
  updateSale(id: string, data: Partial<Sale>, tenantId: string): Promise<Sale>
  resumeSale(saleId: string, tenantId: string): Promise<any>
  markReadyForPickup(saleId: string, tenantId: string): Promise<any>
}

export class SaleRepository implements ISaleRepository {
  async findById(id: string, tenantId: string): Promise<any | null> {
    const { data, error } = await db
      .from('sales')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async findItemsBySaleId(saleId: string, tenantId: string): Promise<any[]> {
    const sale = await this.findById(saleId, tenantId)
    if (!sale) return []
    const { data, error } = await db
      .from('sale_items')
      .select('*, product:products(id,sku,name,unit)')
      .eq('sale_id', saleId)
    if (error) throw error
    return data || []
  }

  async insertSale(data: Partial<Sale>, tenantId: string): Promise<Sale> {
    const { data: inserted, error } = await db
      .from('sales')
      .insert({ ...data, tenant_id: tenantId })
      .select()
      .single()
    if (error) throw error
    return inserted
  }

  async insertSaleItems(items: Partial<SaleItem>[]): Promise<SaleItem[]> {
    const { data, error } = await db
      .from('sale_items')
      .insert(items)
      .select()
    if (error) throw error
    return data || []
  }

  async updateSale(id: string, data: Partial<Sale>, tenantId: string): Promise<Sale> {
    const { data: updated, error } = await db
      .from('sales')
      .update(data)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single()
    if (error) throw error
    return updated
  }

  async resumeSale(saleId: string, tenantId: string): Promise<any> {
    const { data, error } = await db
      .from('sales')
      .update({ status: 'draft', updated_at: new Date().toISOString() })
      .eq('id', saleId)
      .eq('tenant_id', tenantId)
      .eq('status', 'suspended')
      .select('*, sale_items(*, product:products(id,sku,name,unit)), customer:customers(id,phone,full_name)')
      .single()
    if (error) throw error
    return data
  }

  async markReadyForPickup(saleId: string, tenantId: string): Promise<any> {
    const { data, error } = await db
      .from('sales')
      .update({ status: 'ready_for_pickup', updated_at: new Date().toISOString() })
      .eq('id', saleId)
      .eq('tenant_id', tenantId)
      .select('*, customer:customers(id, full_name, phone)')
      .single()
    if (error) throw error
    return data
  }
}

export const saleRepository = new SaleRepository()
