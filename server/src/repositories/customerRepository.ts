import { db } from '../db/supabase.js'

export interface Customer {
  id: string
  phone: string
  full_name?: string | null
  bonus_balance?: number
  debt_balance?: number
  telegram_chat_id?: string | null
  card_barcode?: string | null
  price_tier_id?: string | null
  deleted_at?: string | null
  tenant_id: string
  discount_pct?: number
  client_status?: string
}

export interface ICustomerRepository {
  findById(id: string, tenantId: string): Promise<Customer | null>
  findByPhone(phone: string, tenantId: string): Promise<Customer | null>
  findByTelegramChatId(chatId: string, tenantId: string): Promise<Customer | null>
  insert(data: Partial<Customer>, tenantId: string): Promise<Customer>
  update(id: string, data: Partial<Customer>, tenantId: string): Promise<Customer>
  getBonusBalance(id: string, tenantId: string): Promise<number>
}

export class CustomerRepository implements ICustomerRepository {
  async findById(id: string, tenantId: string): Promise<Customer | null> {
    const { data, error } = await db
      .from('customers')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async findByPhone(phone: string, tenantId: string): Promise<Customer | null> {
    const { data, error } = await db
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async findByTelegramChatId(chatId: string, tenantId: string): Promise<Customer | null> {
    const { data, error } = await db
      .from('customers')
      .select('*')
      .eq('telegram_chat_id', chatId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async insert(data: Partial<Customer>, tenantId: string): Promise<Customer> {
    const { data: inserted, error } = await db
      .from('customers')
      .insert({ ...data, tenant_id: tenantId })
      .select()
      .single()
    if (error) throw error
    return inserted
  }

  async update(id: string, data: Partial<Customer>, tenantId: string): Promise<Customer> {
    const { data: updated, error } = await db
      .from('customers')
      .update(data)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single()
    if (error) throw error
    return updated
  }

  async getBonusBalance(id: string, tenantId: string): Promise<number> {
    const { data, error } = await db
      .from('customers')
      .select('bonus_balance')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (error) throw error
    return data?.bonus_balance ?? 0
  }
}

export const customerRepository = new CustomerRepository()
