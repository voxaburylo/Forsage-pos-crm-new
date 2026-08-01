import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { db } from '../db/supabase.js'
import { pool, runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import type { CreateUserInput, UpdateUserInput, CategoryInput, BrandInput, SettingsInput } from '../validators/adminSchema.js'
import { nextSettingsRowUpdatedAt, prepareLabelSettingsUpdate } from './labelSettingsConflict.js'
import { clearProductSearchCache } from './productService.js'
import { beginTenantReset, clearTenantResetMarker } from './syncGeneration.js'

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const brandsCache = new Map<string, CacheEntry<any[]>>();
const categoriesCache = new Map<string, CacheEntry<any[]>>();
const CACHE_TTL_MS = 60000; // 1 minute

export function clearCatalogReferenceCaches(tenantId: string): void {
  categoriesCache.delete(tenantId)
  brandsCache.delete(tenantId)
}

const PRODUCT_PHOTO_PUBLIC_MARKER = '/storage/v1/object/public/product-photos/'

function productPhotoObjectPath(value: unknown): string | null {
  const rawUrl = String(value ?? '').trim()
  if (!rawUrl) return null
  try {
    const url = new URL(rawUrl)
    const storageOrigin = new URL(String(process.env.SUPABASE_URL ?? '')).origin
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.origin !== storageOrigin || !url.pathname.startsWith(PRODUCT_PHOTO_PUBLIC_MARKER)) return null
    const encodedPath = url.pathname.slice(PRODUCT_PHOTO_PUBLIC_MARKER.length)
    if (!encodedPath) return null
    const objectPath = decodeURIComponent(encodedPath).replace(/^\/+/, '')
    if (!objectPath || objectPath.split('/').some((part) => part === '..' || part === '.')) return null
    return objectPath
  } catch {
    return null
  }
}

async function removeProductPhotoObjects(urls: string[]): Promise<number> {
  const objectPaths = [...new Set(urls.map(productPhotoObjectPath).filter((path): path is string => Boolean(path)))]
  let failed = 0
  for (let start = 0; start < objectPaths.length; start += 100) {
    const chunk = objectPaths.slice(start, start + 100)
    try {
      const { error } = await supabaseAdmin.storage.from('product-photos').remove(chunk)
      if (error) failed += chunk.length
    } catch {
      failed += chunk.length
    }
  }
  return failed
}


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

const AUTH_LIST_PAGE_SIZE = 1000

async function listAllAuthUsers(): Promise<any[]> {
  const users: any[] = []
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: AUTH_LIST_PAGE_SIZE,
    })
    if (error) throw new AppError('AUTH_ERROR', error.message, 500)

    const batch = data?.users ?? []
    users.push(...batch)
    const total = Number((data as { total?: number } | null)?.total ?? 0)
    if (batch.length < AUTH_LIST_PAGE_SIZE || (total > 0 && users.length >= total)) return users
  }
}

export async function listUsers(tenantId: string) {
  const users = await listAllAuthUsers()
  return users
    .filter((user) => user.app_metadata?.tenant_id === tenantId)
    .map(mapSupabaseUser)
}

export async function createUser(input: CreateUserInput, tenantId: string) {
  const email = phoneToEmail(input.phone)

  const existing = await listAllAuthUsers()
  const dup = existing.find((u) => u.email === email)
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
    const allUsers = await listAllAuthUsers()
    const dup = allUsers.find((u) => u.email === email && u.id !== id)
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

  // 2. Delete user from Supabase Auth. If deletion fails, revoke the old JWT
  // immediately through trusted app_metadata before reporting the error.
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
  if (error) {
    await supabaseAdmin.auth.admin.updateUserById(id, {
      app_metadata: { ...existing.user.app_metadata, is_active: false },
    })
    throw new AppError('DB_ERROR', error.message, 500)
  }
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
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  const result = data ?? []
  categoriesCache.set(tenantId, { data: result, timestamp: Date.now() });
  return result
}

export async function createCategory(input: CategoryInput, tenantId: string) {
  categoriesCache.delete(tenantId);
  const updatedAt = new Date().toISOString()
  const { data, error } = await db
    .from('categories')
    .insert({ ...input, tenant_id: tenantId, updated_at: updatedAt, deleted_at: null })
    .select('*')
    .single()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function updateCategory(id: string, input: Partial<CategoryInput>, tenantId: string) {
  categoriesCache.delete(tenantId);
  const { data, error } = await db
    .from('categories')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .select('*')
    .single()
  if (error || !data) throw new AppError('NOT_FOUND', 'Категорію не знайдено', 404)
  return data
}

export async function deleteCategory(id: string, tenantId: string) {
  await runTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    await client.query(`
      LOCK TABLE brands, categories, products, category_markups,
        commission_rules, volume_discounts IN SHARE ROW EXCLUSIVE MODE
    `)

    const category = await client.query<{ id: string }>(`
      SELECT id FROM categories
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
      FOR UPDATE
    `, [id, tenantId])
    if (category.rowCount === 0) throw new AppError('NOT_FOUND', 'Категорію не знайдено', 404)

    const stampResult = await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')
    const updatedAt = stampResult.rows[0].at
    await client.query(`UPDATE products SET category_id = NULL, updated_at = $3 WHERE tenant_id = $2 AND category_id = $1`, [id, tenantId, updatedAt])
    await client.query(`UPDATE categories SET parent_id = NULL, updated_at = $3 WHERE tenant_id = $2 AND parent_id = $1`, [id, tenantId, updatedAt])
    await client.query(`UPDATE volume_discounts SET category_id = NULL WHERE tenant_id = $2 AND category_id = $1`, [id, tenantId])
    await client.query(`DELETE FROM category_markups WHERE tenant_id = $2 AND category_id = $1`, [id, tenantId])
    await client.query(`UPDATE commission_rules SET category_id = NULL, updated_at = $3 WHERE tenant_id = $2 AND category_id = $1`, [id, tenantId, updatedAt])
    await client.query(`
      UPDATE categories SET parent_id = NULL, deleted_at = $3, updated_at = $3
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
    `, [id, tenantId, updatedAt])
  })

  clearCatalogReferenceCaches(tenantId)
  await clearProductSearchCache()
}
// Повне очищення каталогу залишає sync-visible tombstone товарів і категорій.
// Продажі, повернення та рухи складу залишаються цілими, бо каталог не
// видаляється фізично.
export async function resetCatalog(tenantId: string) {
  const result = await runTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    await client.query(`
      LOCK TABLE brands, categories, products, category_markups,
        commission_rules, volume_discounts IN SHARE ROW EXCLUSIVE MODE
    `)
    const stampResult = await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')
    const updatedAt = stampResult.rows[0].at

    const deletedProducts = await client.query(`
      UPDATE products SET deleted_at = $2, updated_at = $2, category_id = NULL
      WHERE tenant_id = $1 AND deleted_at IS NULL
    `, [tenantId, updatedAt])
    await client.query(`UPDATE categories SET parent_id = NULL, updated_at = $2 WHERE tenant_id = $1 AND parent_id IS NOT NULL`, [tenantId, updatedAt])
    await client.query(`UPDATE volume_discounts SET category_id = NULL WHERE tenant_id = $1 AND category_id IS NOT NULL`, [tenantId])
    await client.query('DELETE FROM category_markups WHERE tenant_id = $1', [tenantId])
    await client.query(`UPDATE commission_rules SET category_id = NULL, updated_at = $2 WHERE tenant_id = $1 AND category_id IS NOT NULL`, [tenantId, updatedAt])
    const deletedCategories = await client.query(`
      UPDATE categories SET deleted_at = $2, updated_at = $2
      WHERE tenant_id = $1 AND deleted_at IS NULL
    `, [tenantId, updatedAt])

    return {
      products_deleted: deletedProducts.rowCount ?? 0,
      categories_deleted: deletedCategories.rowCount ?? 0,
    }
  })

  clearCatalogReferenceCaches(tenantId)
  await clearProductSearchCache()
  return result
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
    .is('deleted_at', null)
    .order('name', { ascending: true })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  const result = data ?? []
  brandsCache.set(tenantId, { data: result, timestamp: Date.now() });
  return result
}

export async function createBrand(input: BrandInput, tenantId: string) {
  brandsCache.delete(tenantId);
  const updatedAt = new Date().toISOString()
  const { data, error } = await db
    .from('brands')
    .insert({ ...input, tenant_id: tenantId, updated_at: updatedAt, deleted_at: null })
    .select('*')
    .single()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function updateBrand(id: string, input: Partial<BrandInput>, tenantId: string) {
  brandsCache.delete(tenantId);
  const { data, error } = await db
    .from('brands')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .select('*')
    .single()
  if (error || !data) throw new AppError('NOT_FOUND', 'Бренд не знайдено', 404)
  return data
}

export async function deleteBrand(id: string, tenantId: string) {
  await runTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    await client.query(`
      LOCK TABLE brands, categories, products, category_markups,
        commission_rules, volume_discounts IN SHARE ROW EXCLUSIVE MODE
    `)

    const brand = await client.query<{ id: string }>(`
      SELECT id FROM brands
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
      FOR UPDATE
    `, [id, tenantId])
    if (brand.rowCount === 0) throw new AppError('NOT_FOUND', 'Бренд не знайдено', 404)

    const stampResult = await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')
    const updatedAt = stampResult.rows[0].at
    await client.query(`UPDATE products SET brand_id = NULL, updated_at = $3 WHERE tenant_id = $2 AND brand_id = $1`, [id, tenantId, updatedAt])
    await client.query(`UPDATE commission_rules SET brand_id = NULL, updated_at = $3 WHERE tenant_id = $2 AND brand_id = $1`, [id, tenantId, updatedAt])
    await client.query(`
      UPDATE brands SET deleted_at = $3, updated_at = $3
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
    `, [id, tenantId, updatedAt])
  })

  clearCatalogReferenceCaches(tenantId)
  await clearProductSearchCache()
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

  const hasLabelSettings = input.label_settings !== undefined
  const maxAttempts = hasLabelSettings ? 3 : 1
  const serverReceivedAt = new Date().toISOString()

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const updates: SettingsInput = { ...input }
    let expectedUpdatedAt: string | null | undefined

    if (hasLabelSettings) {
      const { data: current, error: currentError } = await db
        .from('shop_settings')
        .select('label_settings,updated_at')
        .eq('tenant_id', tenantId)
        .single()
      if (currentError || !current) {
        throw new AppError('DB_ERROR', currentError?.message ?? 'Налаштування не знайдено', 500)
      }

      expectedUpdatedAt = current.updated_at
      const prepared = prepareLabelSettingsUpdate({
        // Онлайн PUT упорядковуємо за часом надходження на сервер, а не за
        // годинником браузера. Offline desktop зберігає окрему edit-time логіку.
        incoming: input.label_settings
          ? { ...input.label_settings, sync_updated_at: serverReceivedAt }
          : input.label_settings,
        incomingFallbackUpdatedAt: serverReceivedAt,
        current: current.label_settings,
        currentRowUpdatedAt: current.updated_at,
        serverReceivedAt,
      })
      if (prepared.shouldApply && prepared.normalizedIncoming) {
        updates.label_settings = prepared.normalizedIncoming as SettingsInput['label_settings']
      } else {
        delete updates.label_settings
      }
    }

    // Якщо прийшов лише застарілий макет, нічого не перезаписуємо та повертаємо
    // чинну серверну версію, щоб дизайнер одразу її підхопив.
    if (Object.keys(updates).length === 0) return getSettings(tenantId)

    let query = db
      .from('shop_settings')
      .update({
        ...updates,
        updated_at: nextSettingsRowUpdatedAt(expectedUpdatedAt, new Date(serverReceivedAt)),
      })
      .eq('tenant_id', tenantId)
    if (hasLabelSettings) {
      query = expectedUpdatedAt == null
        ? query.is('updated_at', null)
        : query.eq('updated_at', expectedUpdatedAt)
    }
    const { data, error } = await query.select('*').maybeSingle()

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
    if (data) return data
    // updated_at змінився між SELECT та UPDATE: перечитуємо і вирішуємо конфлікт знову.
  }

  throw new AppError(
    'SETTINGS_CONFLICT',
    'Макет етикетки одночасно змінено на іншому пристрої. Повторіть збереження.',
    409,
  )
}

export async function resetAllData(tenantId: string, currentUserId: string) {
  await beginTenantReset(tenantId)
  try {
    let productPhotoUrls: string[] = []
    // Auth Admin повертає сторінки. Збираємо їх усі до фільтра tenant, інакше
    // працівник з наступної сторінки переживе повне очищення.
    const allUsers = await listAllAuthUsers()
    const usersToDelete = allUsers.filter(
      (user) => user.app_metadata?.tenant_id === tenantId && user.id !== currentUserId,
    )
    const userIdsToDelete = usersToDelete.map((user) => user.id)

  // Порядок — від дочірніх таблиць до батьківських згідно з реальними FK.
  // Таблиці без tenant_id очищаються через їх батьківську таблицю.
  const tablesToDelete = [
    { name: 'in_app_notifications', query: 'DELETE FROM in_app_notifications WHERE tenant_id = $1' },
    { name: 'sys_background_jobs', query: 'DELETE FROM sys_background_jobs WHERE tenant_id = $1' },
    { name: 'idempotency_keys', query: 'DELETE FROM idempotency_keys WHERE tenant_id = $1' },
    { name: 'payment_reconciliation', query: 'DELETE FROM payment_reconciliation WHERE tenant_id = $1' },
    { name: 'sync_deletions', query: 'DELETE FROM sync_deletions WHERE tenant_id = $1' },
    { name: 'ai_usage', query: 'DELETE FROM ai_usage WHERE tenant_id = $1' },
    { name: 'audit_log', query: 'DELETE FROM audit_log WHERE tenant_id = $1' },
    { name: 'telegram_messages', query: 'DELETE FROM telegram_messages WHERE tenant_id = $1' },
    { name: 'bonus_transactions', query: 'DELETE FROM bonus_transactions WHERE tenant_id = $1' },
    { name: 'customer_deposit_transactions', query: 'DELETE FROM customer_deposit_transactions WHERE tenant_id = $1' },
    { name: 'loyalty_transactions', query: 'DELETE FROM loyalty_transactions WHERE tenant_id = $1' },

    { name: 'salary_payments', query: 'DELETE FROM salary_payments WHERE tenant_id = $1' },

    { name: 'return_items', query: 'DELETE FROM return_items WHERE tenant_id = $1' },
    { name: 'customer_return_items', query: 'DELETE FROM customer_return_items WHERE tenant_id = $1' },
    { name: 'supplier_warranty_claims', query: 'DELETE FROM supplier_warranty_claims WHERE tenant_id = $1' },
    { name: 'supplier_returns', query: 'DELETE FROM supplier_returns WHERE tenant_id = $1' },
    { name: 'returns', query: 'DELETE FROM returns WHERE tenant_id = $1' },
    { name: 'customer_returns', query: 'DELETE FROM customer_returns WHERE tenant_id = $1' },




    { name: 'supplier_purchase_order_items', query: 'DELETE FROM supplier_purchase_order_items WHERE tenant_id = $1' },
    { name: 'supplier_purchase_orders', query: 'DELETE FROM supplier_purchase_orders WHERE tenant_id = $1' },
    { name: 'order_payments', query: 'DELETE FROM order_payments WHERE tenant_id = $1' },
    { name: 'customer_orders.exchange_source_order_id', query: 'UPDATE customer_orders SET exchange_source_order_id = NULL WHERE tenant_id = $1 AND exchange_source_order_id IS NOT NULL' },
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
    { name: 'inventory_movements', query: 'DELETE FROM inventory_movements WHERE tenant_id = $1' },
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
    { name: 'customers.balance_reset', query: 'UPDATE customers SET debt_balance = 0, deposit_balance = 0, bonus_balance = 0 WHERE tenant_id = $1' },
    { name: 'customers', query: 'DELETE FROM customers WHERE tenant_id = $1' },


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

    const photoRows = await client.query<{ url: string | null }>(
      `SELECT photo_url AS url
       FROM products
       WHERE tenant_id = $1 AND photo_url IS NOT NULL
       UNION
       SELECT photo.url
       FROM product_photos AS photo
       JOIN products AS product ON product.id = photo.product_id
       WHERE product.tenant_id = $1`,
      [tenantId],
    )
    productPhotoUrls = photoRows.rows
      .map((row) => row.url)
      .filter((url): url is string => typeof url === 'string' && url.length > 0)

    // The marker is committed atomically with the destructive reset and is
    // deliberately not present in tablesToDelete. Other devices must clear
    // their previous generation instead of trying to infer every hard delete.
    await client.query(
      `INSERT INTO sync_tenant_generations (tenant_id, generation, reset_at, updated_at)
       SELECT $1, 1, stamp.at, stamp.at
       FROM (SELECT clock_timestamp() AS at) AS stamp
       ON CONFLICT (tenant_id) DO UPDATE SET
         generation = sync_tenant_generations.generation + 1,
         reset_at = EXCLUDED.reset_at,
         updated_at = EXCLUDED.updated_at`,
      [tenantId],
    )

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

    // БД уже успішно очищена — тепер безпечно видаляємо точні Storage-об'єкти
    // і Auth-акаунти. Скидання лишається в maintenance-режимі до завершення
    // цього повторного, також пагінованого, читання.
    const photo_cleanup_failed = await removeProductPhotoObjects(productPhotoUrls)
    let authRelistFailed = false
    let usersAfterReset: any[]
    try {
      usersAfterReset = await listAllAuthUsers()
    } catch {
      authRelistFailed = true
      usersAfterReset = usersToDelete
    }
    const finalUsersToDelete = usersAfterReset.filter(
      (user) => user.app_metadata?.tenant_id === tenantId && user.id !== currentUserId,
    )
    const authDeleteErrors: string[] = []
    const authRevocationErrors: string[] = []
    for (const user of finalUsersToDelete) {
      const { error: deactivateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
        app_metadata: { ...user.app_metadata, is_active: false },
      })
      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(user.id)
      if (deleteError) {
        authDeleteErrors.push(user.id)
        if (deactivateError) authRevocationErrors.push(user.id)
      }
    }

    clearCatalogReferenceCaches(tenantId)
    await clearProductSearchCache()

    return {
      success: authDeleteErrors.length === 0 && !authRelistFailed && photo_cleanup_failed === 0,
      users_deleted: finalUsersToDelete.length - authDeleteErrors.length,
      users_failed: authDeleteErrors.length,
      users_revocation_failed: authRevocationErrors.length,
      auth_relist_failed: authRelistFailed,
      photo_cleanup_failed,
    }
  } finally {
    await clearTenantResetMarker(tenantId)
  }
}
