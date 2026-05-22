import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import type { CreateUserInput, UpdateUserInput, CategoryInput, BrandInput, SettingsInput } from '../validators/adminSchema.js'

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const brandsCache = new Map<string, CacheEntry<any[]>>();
const categoriesCache = new Map<string, CacheEntry<any[]>>();
const CACHE_TTL_MS = 60000; // 1 minute


function phoneToEmail(phone: string): string {
  return `${phone.replace(/\D/g, '')}@forsage.internal`
}

// ===================== USERS =====================

export async function listUsers() {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers()
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return (data.users ?? []).map((u) => ({
    id:        u.id,
    email:     u.email ?? '',
    phone:     u.user_metadata?.phone ?? u.email?.replace('@forsage.internal', '+') ?? '',
    full_name: u.user_metadata?.full_name ?? '',
    role:      u.user_metadata?.role ?? 'cashier',
    is_active: u.user_metadata?.is_active !== false,
    created_at: u.created_at,
  }))
}

export async function createUser(input: CreateUserInput, tenantId: string) {
  const email = phoneToEmail(input.phone)

  const { data: existing } = await supabaseAdmin.auth.admin.listUsers()
  const dup = existing?.users?.find((u) => u.email === email)
  if (dup) throw new AppError('PHONE_DUPLICATE', `Користувач з телефоном ${input.phone} вже існує`, 409)

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password:      input.password,
    email_confirm: true,
    user_metadata: {
      phone:     input.phone,
      full_name: input.full_name,
      role:      input.role,
      tenant_id: tenantId,
      is_active: true,
    },
  })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data.user
}

export async function updateUser(id: string, input: UpdateUserInput) {
  const { data: existing } = await supabaseAdmin.auth.admin.getUserById(id)
  if (!existing.user) throw new AppError('USER_NOT_FOUND', 'Користувача не знайдено', 404)

  const currentMeta = existing.user.user_metadata ?? {}
  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(id, {
    user_metadata: {
      ...currentMeta,
      ...(input.role      !== undefined ? { role: input.role }           : {}),
      ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
      ...(input.full_name !== undefined ? { full_name: input.full_name } : {}),
    },
  })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data.user
}

export async function resetPassword(id: string, newPassword: string) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password: newPassword })
  if (error) throw new AppError('AUTH_ERROR', error.message, 500)
}

export async function deactivateUser(id: string) {
  const { data: existing } = await supabaseAdmin.auth.admin.getUserById(id)
  if (!existing.user) throw new AppError('USER_NOT_FOUND', 'Користувача не знайдено', 404)

  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(id, {
    user_metadata: { ...existing.user.user_metadata, is_active: false },
  })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data.user
}

// ===================== CATEGORIES =====================

export async function listCategories(tenantId: string) {
  const cached = categoriesCache.get(tenantId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  const { data, error } = await db
    .from('categories')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('sort_order', { ascending: true })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  const result = data ?? []
  categoriesCache.set(tenantId, { data: result, timestamp: Date.now() });
  return result
}

export async function createCategory(input: CategoryInput, tenantId: string) {
  categoriesCache.delete(tenantId);
  const { data, error } = await db
    .from('categories')
    .insert({ ...input, tenant_id: tenantId })
    .select('*')
    .single()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function updateCategory(id: string, input: Partial<CategoryInput>, tenantId: string) {
  categoriesCache.delete(tenantId);
  const { data, error } = await db
    .from('categories')
    .update(input)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('*')
    .single()
  if (error || !data) throw new AppError('NOT_FOUND', 'Категорію не знайдено', 404)
  return data
}

export async function deleteCategory(id: string, tenantId: string) {
  categoriesCache.delete(tenantId);
  const { count } = await db
    .from('products')
    .select('*', { count: 'exact', head: true })
    .eq('category_id', id)
    .is('deleted_at', null)

  if ((count ?? 0) > 0) {
    throw new AppError('CATEGORY_IN_USE', 'Категорія використовується в товарах', 409)
  }
  const { error } = await db.from('categories').delete().eq('id', id).eq('tenant_id', tenantId)
  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

// ===================== BRANDS =====================

export async function listBrands(tenantId: string) {
  const cached = brandsCache.get(tenantId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  const { data, error } = await db
    .from('brands')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  const result = data ?? []
  brandsCache.set(tenantId, { data: result, timestamp: Date.now() });
  return result
}

export async function createBrand(input: BrandInput, tenantId: string) {
  brandsCache.delete(tenantId);
  const { data, error } = await db
    .from('brands')
    .insert({ ...input, tenant_id: tenantId })
    .select('*')
    .single()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function updateBrand(id: string, input: Partial<BrandInput>, tenantId: string) {
  brandsCache.delete(tenantId);
  const { data, error } = await db
    .from('brands')
    .update(input)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('*')
    .single()
  if (error || !data) throw new AppError('NOT_FOUND', 'Бренд не знайдено', 404)
  return data
}

// ===================== SETTINGS =====================

export async function getSettings() {
  const { data, error } = await db
    .from('shop_settings')
    .select('*')
    .single()
  if (error || !data) throw new AppError('DB_ERROR', 'Налаштування не знайдено', 500)
  return data
}

export async function updateSettings(input: SettingsInput) {
  const { data, error } = await db
    .from('shop_settings')
    .update({ ...input, updated_at: new Date().toISOString() })
    .select('*')
    .single()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}
