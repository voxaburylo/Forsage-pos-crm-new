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
  findById(id: string): Promise<Customer | null>
  findByPhone(phone: string): Promise<Customer | null>
  findByTelegramChatId(chatId: string): Promise<Customer | null>
  insert(data: Partial<Customer>): Promise<Customer>
  update(id: string, data: Partial<Customer>): Promise<Customer>
  getBonusBalance(id: string): Promise<number>
}

export class CustomerRepository implements ICustomerRepository {
  async findById(id: string): Promise<Customer | null> {
    const { data, error } = await db
      .from('customers')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async findByPhone(phone: string): Promise<Customer | null> {
    const { data, error } = await db
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async findByTelegramChatId(chatId: string): Promise<Customer | null> {
    const { data, error } = await db
      .from('customers')
      .select('*')
      .eq('telegram_chat_id', chatId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async insert(data: Partial<Customer>): Promise<Customer> {
    const { data: inserted, error } = await db
      .from('customers')
      .insert(data)
      .select()
      .single()
    if (error) throw error
    return inserted
  }

  async update(id: string, data: Partial<Customer>): Promise<Customer> {
    const { data: updated, error } = await db
      .from('customers')
      .update(data)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return updated
  }

  async getBonusBalance(id: string): Promise<number> {
    const { data, error } = await db
      .from('customers')
      .select('bonus_balance')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    return data?.bonus_balance ?? 0
  }
}

export const customerRepository = new CustomerRepository()
