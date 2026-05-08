import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import type { CreateUserInput, UpdateUserInput, CategoryInput, BrandInput, SettingsInput } from '../validators/adminSchema.js'

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

export async function createUser(input: CreateUserInput) {
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

export async function listCategories() {
  const { data, error } = await db
    .from('categories')
    .select('*')
    .order('sort_order', { ascending: true })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function createCategory(input: CategoryInput) {
  const { data, error } = await db
    .from('categories')
    .insert(input)
    .select('*')
    .single()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function updateCategory(id: string, input: Partial<CategoryInput>) {
  const { data, error } = await db
    .from('categories')
    .update(input)
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) throw new AppError('NOT_FOUND', 'Категорію не знайдено', 404)
  return data
}

export async function deleteCategory(id: string) {
  const { count } = await db
    .from('products')
    .select('*', { count: 'exact', head: true })
    .eq('category_id', id)
    .is('deleted_at', null)

  if ((count ?? 0) > 0) {
    throw new AppError('CATEGORY_IN_USE', 'Категорія використовується в товарах', 409)
  }
  const { error } = await db.from('categories').delete().eq('id', id)
  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

// ===================== BRANDS =====================

export async function listBrands() {
  const { data, error } = await db
    .from('brands')
    .select('*')
    .order('name', { ascending: true })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function createBrand(input: BrandInput) {
  const { data, error } = await db
    .from('brands')
    .insert(input)
    .select('*')
    .single()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function updateBrand(id: string, input: Partial<BrandInput>) {
  const { data, error } = await db
    .from('brands')
    .update(input)
    .eq('id', id)
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
