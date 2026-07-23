import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { db } from '../db/supabase.js'
import { pool } from '../db/pg.js'
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

function mapSupabaseUser(u: any) {
  const userMeta = u.user_metadata ?? {}
  const appMeta = u.app_metadata ?? {}
  return {
    id:        u.id,
    email:     u.email ?? '',
    phone:     userMeta.phone ?? u.email?.replace('@forsage.internal', '+') ?? '',
    full_name: userMeta.full_name ?? '',
    role:      appMeta.role ?? 'cashier',
    is_active: appMeta.is_active !== false,
    base_rate: appMeta.base_rate ?? 0,
    rate_period: appMeta.rate_period ?? 'month',
    created_at: u.created_at,
    updated_at: u.updated_at ?? u.created_at,
  }
}

export async function listUsers(tenantId: string) {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers()
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return (data.users ?? [])
    .filter((user) => user.app_metadata?.tenant_id === tenantId)
    .map(mapSupabaseUser)
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
    },
    app_metadata: {
      role:      input.role,
      tenant_id: tenantId,
      is_active: true,
      base_rate: input.base_rate ?? 0,
      rate_period: input.rate_period ?? 'month',
    },
  })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return mapSupabaseUser(data.user)
}

export async function updateUser(id: string, input: UpdateUserInput, tenantId: string) {
  const { data: existing } = await supabaseAdmin.auth.admin.getUserById(id)
  if (!existing.user) throw new AppError('USER_NOT_FOUND', 'Користувача не знайдено', 404)
  if (existing.user.app_metadata?.tenant_id !== tenantId) {
    throw new AppError('USER_NOT_FOUND', 'Користувача не знайдено', 404)
  }

  const currentUserMeta = existing.user.user_metadata ?? {}
  const currentAppMeta = existing.user.app_metadata ?? {}
  
  if (input.phone !== undefined && input.phone !== currentUserMeta.phone) {
    const email = phoneToEmail(input.phone)
    const { data: allUsers } = await supabaseAdmin.auth.admin.listUsers()
    const dup = allUsers?.users?.find((u) => u.email === email && u.id !== id)
    if (dup) throw new AppError('PHONE_DUPLICATE', `Користувач з телефоном ${input.phone} вже існує`, 409)
  }

  const updatePayload: any = {
    user_metadata: {
      ...currentUserMeta,
      ...(input.full_name !== undefined ? { full_name: input.full_name } : {}),
      ...(input.phone     !== undefined ? { phone: input.phone }         : {}),
    },
    app_metadata: {
      ...currentAppMeta,
      ...(input.role      !== undefined ? { role: input.role }           : {}),
      ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
      ...(input.base_rate !== undefined ? { base_rate: input.base_rate } : {}),
      ...(input.rate_period !== undefined ? { rate_period: input.rate_period } : {}),
    }
  }

  if (input.phone !== undefined) {
    updatePayload.email = phoneToEmail(input.phone)
  }

  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(id, updatePayload)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data.user
}

export async function resetPassword(id: string, newPassword: string, tenantId: string) {
  const { data: existing } = await supabaseAdmin.auth.admin.getUserById(id)
  if (!existing.user || existing.user.app_metadata?.tenant_id !== tenantId) {
    throw new AppError('USER_NOT_FOUND', 'Користувача не знайдено', 404)
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password: newPassword })
  if (error) throw new AppError('AUTH_ERROR', error.message, 500)
}

export async function deactivateUser(id: string, tenantId: string) {
  const { data: existing } = await supabaseAdmin.auth.admin.getUserById(id)
  if (!existing.user) throw new AppError('USER_NOT_FOUND', 'Користувача не знайдено', 404)
  if (existing.user.app_metadata?.tenant_id !== tenantId) {
    throw new AppError('USER_NOT_FOUND', 'Користувача не знайдено', 404)
  }

  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(id, {
    app_metadata: { ...existing.user.app_metadata, is_active: false },
  })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data.user
}

export async function deleteUser(id: string, tenantId: string) {
  const { data: existing } = await supabaseAdmin.auth.admin.getUserById(id)
  if (!existing.user || existing.user.app_metadata?.tenant_id !== tenantId) {
    throw new AppError('USER_NOT_FOUND', 'Користувача не знайдено', 404)
  }
  // 1. Clean up references
  await db.from('warehouse_movements').update({ moved_by: null }).eq('moved_by', id).eq('tenant_id', tenantId)
  await db.from('staff_kpi_targets').delete().eq('user_id', id).eq('tenant_id', tenantId)

  // 2. Delete user from supabase auth
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
  if (error) throw new AppError('DB_ERROR', error.message, 500)
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

  // categories не мають soft-delete колонок. Спочатку перевіряємо, що категорія
  // справді належить поточному магазину, а потім відв'язуємо всі залежності.
  const { data: category, error: findError } = await db
    .from('categories')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (findError) throw new AppError('DB_ERROR', findError.message, 500)
  if (!category) throw new AppError('NOT_FOUND', 'Категорію не знайдено', 404)

  const { error: productError } = await db
    .from('products')
    .update({ category_id: null, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('category_id', id)
  if (productError) throw new AppError('DB_ERROR', productError.message, 500)

  const { error: childError } = await db
    .from('categories')
    .update({ parent_id: null })
    .eq('tenant_id', tenantId)
    .eq('parent_id', id)
  if (childError) throw new AppError('DB_ERROR', childError.message, 500)

  // Ці таблиці також можуть посилатися на категорію і блокувати hard-delete.
  const { error: discountError } = await db
    .from('volume_discounts')
    .update({ category_id: null })
    .eq('tenant_id', tenantId)
    .eq('category_id', id)
  if (discountError) throw new AppError('DB_ERROR', discountError.message, 500)

  const { error: markupError } = await db
    .from('category_markups')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('category_id', id)
  if (markupError) throw new AppError('DB_ERROR', markupError.message, 500)

  const { error: commissionError } = await db
    .from('commission_rules')
    .update({ category_id: null })
    .eq('tenant_id', tenantId)
    .eq('category_id', id)
  if (commissionError) throw new AppError('DB_ERROR', commissionError.message, 500)

  const { data: deleted, error } = await db
    .from('categories')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('id')
    .maybeSingle()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  if (!deleted) throw new AppError('NOT_FOUND', 'Категорію не знайдено', 404)
}

// Повне очищення каталогу: soft-delete усіх товарів + hard-delete усіх категорій.
// Продажі, повернення, рухи складу залишаються цілими (FK на products зберігається,
// бо товари не видаляються фізично, а лише позначаються deleted_at).
export async function resetCatalog(tenantId: string) {
  // 1. Soft-delete усіх активних товарів + обнуляємо category_id (щоб FK не блокував
  //    видалення категорій). product_id у sale_items залишається.
  const { data: deletedProducts, error: prodErr } = await db
    .from('products')
    .update({ deleted_at: new Date().toISOString(), category_id: null })
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .select('id')
  if (prodErr) throw new AppError('DB_ERROR', prodErr.message, 500)

  // 2. Відв'язуємо всі залежності категорій. Без цього FK може обірвати
  //    очищення посеред операції й залишити каталог у змішаному стані.
  const { error: childCategoryErr } = await db
    .from('categories')
    .update({ parent_id: null })
    .eq('tenant_id', tenantId)
    .not('parent_id', 'is', null)
  if (childCategoryErr) throw new AppError('DB_ERROR', childCategoryErr.message, 500)

  const { error: volumeDiscountErr } = await db
    .from('volume_discounts')
    .update({ category_id: null })
    .eq('tenant_id', tenantId)
    .not('category_id', 'is', null)
  if (volumeDiscountErr) throw new AppError('DB_ERROR', volumeDiscountErr.message, 500)

  const { error: categoryMarkupErr } = await db
    .from('category_markups')
    .delete()
    .eq('tenant_id', tenantId)
  if (categoryMarkupErr) throw new AppError('DB_ERROR', categoryMarkupErr.message, 500)

  const { error: commissionRuleErr } = await db
    .from('commission_rules')
    .update({ category_id: null })
    .eq('tenant_id', tenantId)
    .not('category_id', 'is', null)
  if (commissionRuleErr) throw new AppError('DB_ERROR', commissionRuleErr.message, 500)

  // 3. Тепер hard-delete категорій не порушує зовнішні ключі.
  const { data: deletedCats, error: catErr } = await db
    .from('categories')
    .delete()
    .eq('tenant_id', tenantId)
    .select('id')
  if (catErr) throw new AppError('DB_ERROR', catErr.message, 500)

  categoriesCache.delete(tenantId)
  brandsCache.delete(tenantId)

  return {
    products_deleted:   deletedProducts?.length ?? 0,
    categories_deleted: deletedCats?.length ?? 0,
  }
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

export async function deleteBrand(id: string, tenantId: string) {
  brandsCache.delete(tenantId);

  // brands не мають soft-delete колонок, тому видалення фізичне й обов'язково
  // обмежене tenant_id.
  const { data: brand, error: findError } = await db
    .from('brands')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (findError) throw new AppError('DB_ERROR', findError.message, 500)
  if (!brand) throw new AppError('NOT_FOUND', 'Бренд не знайдено', 404)

  const { error: productError } = await db
    .from('products')
    .update({ brand_id: null, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('brand_id', id)
  if (productError) throw new AppError('DB_ERROR', productError.message, 500)

  const { error: commissionError } = await db
    .from('commission_rules')
    .update({ brand_id: null })
    .eq('tenant_id', tenantId)
    .eq('brand_id', id)
  if (commissionError) throw new AppError('DB_ERROR', commissionError.message, 500)

  const { data: deleted, error } = await db
    .from('brands')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('id')
    .maybeSingle()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  if (!deleted) throw new AppError('NOT_FOUND', 'Бренд не знайдено', 404)
}

// ===================== SETTINGS =====================

export async function getSettings(tenantId: string) {
  const { data, error } = await db
    .from('shop_settings')
    .select('*')
    .eq('tenant_id', tenantId)
    .single()
  if (error || !data) throw new AppError('DB_ERROR', 'Налаштування не знайдено', 500)
  // Зашифрований ключ AI ніколи не віддаємо клієнту — статус ключа є в /api/v1/ai/status
  const { ai_api_key_encrypted: _omit, ...safe } = data as Record<string, any>
  return safe
}

export async function updateSettings(input: SettingsInput, tenantId: string) {
  // Гарантований WHERE через .eq(tenant_id). ВАЖЛИВО: використовуємо Supabase REST
  // клієнт (db), а НЕ прямий pool.query — пряме PG-з'єднання (DATABASE_URL) на
  // продакшні (Render) не працює/висне, тоді як REST-клієнт працює всюди.
  if (!tenantId) throw new AppError('VALIDATION_ERROR', 'Не визначено магазин (tenant)', 400)

  const { data, error } = await db
    .from('shop_settings')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .select('*')
    .single()

  if (error) {
    const isMissingColumn = error.code === 'PGRST204'
      || /could not find .* column|column .* does not exist/i.test(error.message)
    if (isMissingColumn) {
      throw new AppError(
        'SETTINGS_SCHEMA_DRIFT',
        `Не вдалося зберегти: у БД бракує колонки. ${error.message}. Застосуйте міграції shop_settings.`,
        500,
      )
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }
  return data
}

export async function resetAllData(tenantId: string, currentUserId: string) {
  // Спочатку лише читаємо список користувачів. Видаляти Auth-користувачів до
  // успішного COMMIT не можна: при помилці БД акаунти вже зникнуть, а дані
  // залишаться.
  const { data: allUsers, error: listErr } = await supabaseAdmin.auth.admin.listUsers()
  if (listErr) throw new AppError('AUTH_ERROR', listErr.message, 500)

  const usersToDelete = (allUsers?.users ?? []).filter(
    (u) => u.app_metadata?.tenant_id === tenantId && u.id !== currentUserId
  )
  const userIdsToDelete = usersToDelete.map((user) => user.id)

  // Порядок — від дочірніх таблиць до батьківських згідно з реальними FK.
  // Таблиці без tenant_id очищаються через їх батьківську таблицю.
  const tablesToDelete = [
    { name: 'in_app_notifications', query: 'DELETE FROM in_app_notifications WHERE tenant_id = $1' },
    { name: 'sys_background_jobs', query: 'DELETE FROM sys_background_jobs WHERE tenant_id = $1' },
    { name: 'idempotency_keys', query: 'DELETE FROM idempotency_keys WHERE tenant_id = $1' },
    { name: 'ai_usage', query: 'DELETE FROM ai_usage WHERE tenant_id = $1' },
    { name: 'audit_log', query: 'DELETE FROM audit_log WHERE tenant_id = $1' },
    { name: 'telegram_messages', query: 'DELETE FROM telegram_messages WHERE tenant_id = $1' },
    { name: 'bonus_transactions', query: 'DELETE FROM bonus_transactions WHERE tenant_id = $1' },
    { name: 'loyalty_transactions', query: 'DELETE FROM loyalty_transactions WHERE tenant_id = $1' },

    { name: 'return_items', query: 'DELETE FROM return_items WHERE tenant_id = $1' },
    { name: 'customer_return_items', query: 'DELETE FROM customer_return_items WHERE tenant_id = $1' },
    { name: 'supplier_warranty_claims', query: 'DELETE FROM supplier_warranty_claims WHERE tenant_id = $1' },
    { name: 'supplier_returns', query: 'DELETE FROM supplier_returns WHERE tenant_id = $1' },
    { name: 'returns', query: 'DELETE FROM returns WHERE tenant_id = $1' },
    { name: 'customer_returns', query: 'DELETE FROM customer_returns WHERE tenant_id = $1' },

    { name: 'supplier_purchase_order_items', query: 'DELETE FROM supplier_purchase_order_items WHERE tenant_id = $1' },
    { name: 'supplier_purchase_orders', query: 'DELETE FROM supplier_purchase_orders WHERE tenant_id = $1' },
    { name: 'order_payments', query: 'DELETE FROM order_payments WHERE tenant_id = $1' },
    { name: 'order_activity_log', query: 'DELETE FROM order_activity_log WHERE order_id IN (SELECT id FROM customer_orders WHERE tenant_id = $1)' },
    { name: 'customer_order_items', query: 'DELETE FROM customer_order_items WHERE order_id IN (SELECT id FROM customer_orders WHERE tenant_id = $1)' },
    { name: 'customer_orders', query: 'DELETE FROM customer_orders WHERE tenant_id = $1' },

    { name: 'messenger_messages', query: 'DELETE FROM messenger_messages WHERE chat_id IN (SELECT id FROM messenger_chats WHERE tenant_id = $1)' },
    { name: 'messenger_chats', query: 'DELETE FROM messenger_chats WHERE tenant_id = $1' },
    { name: 'messenger_channels', query: 'DELETE FROM messenger_channels WHERE tenant_id = $1' },

    { name: 'sale_items', query: 'DELETE FROM sale_items WHERE tenant_id = $1' },
    { name: 'sales', query: 'DELETE FROM sales WHERE tenant_id = $1' },

    { name: 'inventory_session_items', query: 'DELETE FROM inventory_session_items WHERE tenant_id = $1' },
    { name: 'inventory_items', query: 'DELETE FROM inventory_items WHERE session_id IN (SELECT id FROM inventory_sessions WHERE tenant_id = $1)' },
    { name: 'inventory_sessions', query: 'DELETE FROM inventory_sessions WHERE tenant_id = $1' },
    { name: 'inventory_writeoff_items', query: 'DELETE FROM inventory_writeoff_items WHERE writeoff_id IN (SELECT id FROM inventory_writeoffs WHERE tenant_id = $1)' },
    { name: 'inventory_writeoffs', query: 'DELETE FROM inventory_writeoffs WHERE tenant_id = $1' },

    { name: 'supplier_purchase_items', query: 'DELETE FROM supplier_purchase_items WHERE tenant_id = $1' },
    { name: 'supplier_purchases', query: 'DELETE FROM supplier_purchases WHERE tenant_id = $1' },
    { name: 'inventory_receipt_items', query: 'DELETE FROM inventory_receipt_items WHERE tenant_id = $1' },
    { name: 'inventory_receipts', query: 'DELETE FROM inventory_receipts WHERE tenant_id = $1' },

    { name: 'supplier_payments', query: 'DELETE FROM supplier_payments WHERE tenant_id = $1' },
    { name: 'supply_invoice_items', query: 'DELETE FROM supply_invoice_items WHERE tenant_id = $1' },
    { name: 'supply_invoices', query: 'DELETE FROM supply_invoices WHERE tenant_id = $1' },
    { name: 'supplier_price_items', query: 'DELETE FROM supplier_price_items WHERE tenant_id = $1' },
    { name: 'supplier_price_imports', query: 'DELETE FROM supplier_price_imports WHERE tenant_id = $1' },

    { name: 'warehouse_movements', query: 'DELETE FROM warehouse_movements WHERE tenant_id = $1' },
    { name: 'inventory_reserves', query: 'DELETE FROM inventory_reserves WHERE tenant_id = $1' },
    { name: 'auto_purchase_rules', query: 'DELETE FROM auto_purchase_rules WHERE tenant_id = $1' },

    { name: 'product_photos', query: 'DELETE FROM product_photos WHERE product_id IN (SELECT id FROM products WHERE tenant_id = $1)' },
    { name: 'product_analogs', query: 'DELETE FROM product_analogs WHERE tenant_id = $1' },
    { name: 'product_cobuy', query: 'DELETE FROM product_cobuy WHERE product_id IN (SELECT id FROM products WHERE tenant_id = $1) OR recommended_product_id IN (SELECT id FROM products WHERE tenant_id = $1)' },
    { name: 'product_barcodes', query: 'DELETE FROM product_barcodes WHERE tenant_id = $1' },
    { name: 'product_aliases', query: 'DELETE FROM product_aliases WHERE tenant_id = $1' },
    { name: 'product_cross_numbers', query: 'DELETE FROM product_cross_numbers WHERE tenant_id = $1' },
    { name: 'product_supplier_codes', query: 'DELETE FROM product_supplier_codes WHERE tenant_id = $1' },
    { name: 'product_price_history', query: 'DELETE FROM product_price_history WHERE tenant_id = $1' },
    { name: 'product_fitment', query: 'DELETE FROM product_fitment WHERE tenant_id = $1' },
    { name: 'product_waitlist', query: 'DELETE FROM product_waitlist WHERE tenant_id = $1' },

    { name: 'customer_cars', query: 'DELETE FROM customer_cars WHERE tenant_id = $1' },
    { name: 'customer_vehicles', query: 'DELETE FROM customer_vehicles WHERE tenant_id = $1' },
    { name: 'customer_notes', query: 'DELETE FROM customer_notes WHERE tenant_id = $1' },
    { name: 'customer_group_members', query: 'DELETE FROM customer_group_members WHERE group_id IN (SELECT id FROM customer_groups WHERE tenant_id = $1)' },
    { name: 'customer_groups', query: 'DELETE FROM customer_groups WHERE tenant_id = $1' },
    { name: 'customer_notification_preferences', query: 'DELETE FROM customer_notification_preferences WHERE tenant_id = $1' },
    { name: 'customers', query: 'DELETE FROM customers WHERE tenant_id = $1' },

    { name: 'salary_payments', query: 'DELETE FROM salary_payments WHERE tenant_id = $1' },
    { name: 'internal_consumptions', query: 'DELETE FROM internal_consumptions WHERE tenant_id = $1' },
    { name: 'cash_reconciliations', query: 'DELETE FROM cash_reconciliations WHERE tenant_id = $1' },
    { name: 'cash_operations', query: 'DELETE FROM cash_operations WHERE tenant_id = $1' },
    { name: 'expense_categories', query: 'DELETE FROM expense_categories WHERE tenant_id = $1' },
    { name: 'shifts', query: 'DELETE FROM shifts WHERE tenant_id = $1' },

    { name: 'category_markups', query: 'DELETE FROM category_markups WHERE tenant_id = $1' },
    { name: 'volume_discounts', query: 'DELETE FROM volume_discounts WHERE tenant_id = $1' },
    { name: 'commission_rules', query: 'DELETE FROM commission_rules WHERE tenant_id = $1' },
    { name: 'price_tiers', query: 'DELETE FROM price_tiers WHERE tenant_id = $1' },
    { name: 'products', query: 'DELETE FROM products WHERE tenant_id = $1' },
    { name: 'categories', query: 'DELETE FROM categories WHERE tenant_id = $1' },
    { name: 'brands', query: 'DELETE FROM brands WHERE tenant_id = $1' },
    { name: 'suppliers', query: 'DELETE FROM suppliers WHERE tenant_id = $1' },
    { name: 'staff_kpi_targets', query: 'DELETE FROM staff_kpi_targets WHERE tenant_id = $1' },
  ]

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    for (const table of tablesToDelete) {
      try {
        await client.query(table.query, [tenantId])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new AppError('RESET_TABLE_FAILED', `Не вдалося очистити ${table.name}: ${message}`, 500)
      }
    }
    if (userIdsToDelete.length > 0) {
      await client.query('DELETE FROM staff_pins WHERE user_id = ANY($1::uuid[])', [userIdsToDelete])
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  // БД уже успішно очищена — тепер безпечно видаляємо інші Auth-акаунти.
  const authDeleteErrors: string[] = []
  for (const user of usersToDelete) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id)
    if (error) authDeleteErrors.push(user.id)
  }

  categoriesCache.delete(tenantId)
  brandsCache.delete(tenantId)

  return {
    success: true,
    users_deleted: usersToDelete.length - authDeleteErrors.length,
    users_failed: authDeleteErrors.length,
  }
}
