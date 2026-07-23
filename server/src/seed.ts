import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const OWNER_PHONE = process.env.SEED_OWNER_PHONE?.trim()
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD
const CASHIER_PHONE = process.env.SEED_CASHIER_PHONE?.trim()
const CASHIER_PASSWORD = process.env.SEED_CASHIER_PASSWORD

if (process.env.ALLOW_DESTRUCTIVE_SEED !== 'YES') {
  console.error('Seed заблоковано. Для нової порожньої бази явно задайте ALLOW_DESTRUCTIVE_SEED=YES.')
  process.exit(1)
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Відсутні SUPABASE_URL або SUPABASE_SERVICE_KEY у .env')
  process.exit(1)
}
if (!OWNER_PHONE || !OWNER_PASSWORD) {
  console.error('Обов’язково задайте SEED_OWNER_PHONE і SEED_OWNER_PASSWORD')
  process.exit(1)
}
if (OWNER_PASSWORD.length < 8) {
  console.error('SEED_OWNER_PASSWORD має містити щонайменше 8 символів')
  process.exit(1)
}
if (Boolean(CASHIER_PHONE) !== Boolean(CASHIER_PASSWORD)) {
  console.error('Для тестового касира задайте обидві змінні: SEED_CASHIER_PHONE і SEED_CASHIER_PASSWORD')
  process.exit(1)
}
if (CASHIER_PASSWORD && CASHIER_PASSWORD.length < 8) {
  console.error('SEED_CASHIER_PASSWORD має містити щонайменше 8 символів')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
})

// MVP: один магазин — фіксований tenant_id
const TENANT_ID = '00000000-0000-0000-0000-000000000001'

async function seed() {
  console.log('🌱 Seed: Початок...')

  // 1. Owner
  const ownerPhone = OWNER_PHONE!
  const ownerPassword = OWNER_PASSWORD!
  const email = ownerPhone.replace(/\D/g, '') + '@forsage.internal'

  const { data: existingUsers } = await supabase.auth.admin.listUsers()
  if (!existingUsers?.users?.find((u) => u.email === email)) {
    const { error: e } = await supabase.auth.admin.createUser({
      email, password: ownerPassword, email_confirm: true,
      user_metadata: { phone: ownerPhone, full_name: 'Власник' },
      app_metadata: { role: 'owner', tenant_id: TENANT_ID, is_active: true, base_rate: 0, rate_period: 'month' },
    })
    if (e) { console.error('  ❌ Owner:', e.message); process.exit(1) }
    console.log('  ✅ Owner створено')
  } else {
    // Власник вже існує — пароль НЕ змінюємо щоб не перезаписати
    console.log('  ✅ Owner вже існує (пароль збережено без змін)')
  }

  // 2. Необов’язковий тестовий касир — лише з явно переданими обліковими даними.
  if (CASHIER_PHONE && CASHIER_PASSWORD) {
    const cashierEmail = CASHIER_PHONE.replace(/\D/g, '') + '@forsage.internal'
    if (!existingUsers?.users?.find((user) => user.email === cashierEmail)) {
      const { error } = await supabase.auth.admin.createUser({
        email: cashierEmail,
        password: CASHIER_PASSWORD,
        email_confirm: true,
        user_metadata: {
          phone: CASHIER_PHONE,
          full_name: process.env.SEED_CASHIER_NAME?.trim() || 'Касир',
        },
        app_metadata: {
          role: 'cashier', tenant_id: TENANT_ID, is_active: true,
          base_rate: 0, rate_period: 'month',
        },
      })
      if (error) console.error('  ❌ Касир:', error.message)
      else console.log('  ✅ Касира створено')
    } else {
      console.log('  ✅ Касир вже існує')
    }
  } else {
    console.log('  ℹ️ Тестового касира пропущено')
  }

  // 3. Settings
  const { data: settings } = await supabase.from('shop_settings').select('id')
    .eq('tenant_id', TENANT_ID).maybeSingle()
  if (!settings) {
    const { error } = await supabase.from('shop_settings').insert({
      tenant_id: TENANT_ID,
      shop_name: 'Форсаж', shop_address: 'м. Київ', phone: '+380',
      max_discount_pct: 10, allow_negative_qty: false, return_days: 14,
    })
    if (error) console.error('  ❌ Settings:', error.message)
    else console.log('  ✅ Налаштування створено')
  } else {
    console.log('  ✅ Налаштування вже існують')
  }

  // 4. Клієнти
  console.log('🌱 Seed: Клієнти...')
  const mockCustomers = [
    { tenant_id: TENANT_ID, phone: '+380500000001', full_name: 'Петро Іваненко', debt_balance: 0 },
    { tenant_id: TENANT_ID, phone: '+380500000002', full_name: 'Анна Коваленко', debt_balance: 150000 },
    { tenant_id: TENANT_ID, phone: '+380500000003', full_name: 'Микола Оптовик', debt_balance: 0 },
    { tenant_id: TENANT_ID, phone: '+380500000004', full_name: 'Сергій Мельник', debt_balance: 0 },
    { tenant_id: TENANT_ID, phone: '+380500000005', full_name: 'Олена Шевченко', debt_balance: 5000 },
  ]
  for (const c of mockCustomers) {
    const { error } = await supabase.from('customers').upsert(c, { onConflict: 'tenant_id, phone' })
    if (error) console.error('  ❌ Customer:', c.full_name, error.message)
  }
  console.log('  ✅ Клієнти створені/оновлені')

  // 5. Бренди (через seed.sql — але продублюємо тут для автономності)
  console.log('🌱 Seed: Бренди та категорії...')
  const brands = [
    { tenant_id: TENANT_ID, name: 'Mann-Filter', country: 'Germany' },
    { tenant_id: TENANT_ID, name: 'Bosch', country: 'Germany' },
    { tenant_id: TENANT_ID, name: 'NGK', country: 'Japan' },
    { tenant_id: TENANT_ID, name: 'Gates', country: 'USA' },
    { tenant_id: TENANT_ID, name: 'Brembo', country: 'Italy' },
    { tenant_id: TENANT_ID, name: 'Kayaba', country: 'Japan' },
  ]
  for (const b of brands) {
    await supabase.from('brands').upsert(b, { onConflict: 'tenant_id, name' })
  }
  console.log('  ✅ Бренди створені')

  const categories = [
    { tenant_id: TENANT_ID, name: 'Фільтри', sort_order: 1 },
    { tenant_id: TENANT_ID, name: 'Гальма', sort_order: 2 },
    { tenant_id: TENANT_ID, name: 'Свічки', sort_order: 3 },
    { tenant_id: TENANT_ID, name: 'Мастила та рідини', sort_order: 4 },
    { tenant_id: TENANT_ID, name: 'Підвіска', sort_order: 5 },
  ]
  for (const cat of categories) {
    await supabase.from('categories').insert(cat).select().maybeSingle()
  }
  console.log('  ✅ Категорії створені')

  // 6. Товари
  console.log('🌱 Seed: Товари...')
  const products = [
    { tenant_id: TENANT_ID, sku: 'W712',    name: 'Фільтр оливний Mann W712',       barcode: '4011558737604', unit: 'шт', purchase_price: 22000, retail_price: 38000,  qty_on_hand: 15, reorder_point: 5, is_active: true },
    { tenant_id: TENANT_ID, sku: 'C30130',  name: 'Фільтр повітряний Mann C30130',   barcode: '4011558014803', unit: 'шт', purchase_price: 18000, retail_price: 32000,  qty_on_hand: 8,  reorder_point: 3, is_active: true },
    { tenant_id: TENANT_ID, sku: 'CU2842',  name: 'Фільтр салону Mann CU2842',       barcode: '4011558314805', unit: 'шт', purchase_price: 16000, retail_price: 28000,  qty_on_hand: 6,  reorder_point: 3, is_active: true },
    { tenant_id: TENANT_ID, sku: 'WK8152',  name: 'Фільтр паливний Mann WK815/2',    barcode: '4011558349504', unit: 'шт', purchase_price: 25000, retail_price: 42000,  qty_on_hand: 4,  reorder_point: 3, is_active: true },
    { tenant_id: TENANT_ID, sku: 'NG2756',  name: 'Свічка NGK BKR6EGP',              barcode: '5891600080105', unit: 'шт', purchase_price: 8000,  retail_price: 15000,  qty_on_hand: 30, reorder_point: 10, is_active: true },
    { tenant_id: TENANT_ID, sku: 'GK3558',  name: 'Комплект ременя ГРМ Gates',       barcode: '5420007210619', unit: 'компл', purchase_price: 85000, retail_price: 145000, qty_on_hand: 3, reorder_point: 2, is_active: true },
    { tenant_id: TENANT_ID, sku: 'BP456',   name: 'Гальмівні колодки Brembo P85020',  barcode: '8020584040236', unit: 'компл', purchase_price: 95000, retail_price: 165000, qty_on_hand: 5, reorder_point: 2, is_active: true },
    { tenant_id: TENANT_ID, sku: 'OIL5W30', name: 'Моторна олива Bosch 5W-30 4L',    barcode: '4047024367612', unit: 'л',    purchase_price: 42000, retail_price: 72000,  qty_on_hand: 12, reorder_point: 4, is_active: true },
    { tenant_id: TENANT_ID, sku: 'SKF6205', name: 'Підшипник SKF 6205 2RS',          barcode: '7316573520407', unit: 'шт',  purchase_price: 12000, retail_price: 22000,  qty_on_hand: 20, reorder_point: 5, is_active: true },
    { tenant_id: TENANT_ID, sku: 'KYB341',  name: 'Амортизатор Kayaba 341829',        barcode: '4957664534219', unit: 'шт',  purchase_price: 120000, retail_price: 195000, qty_on_hand: 2, reorder_point: 2, is_active: true },
  ]
  for (const p of products) {
    const { error } = await supabase.from('products').upsert(p, { onConflict: 'tenant_id, sku' })
    if (error) console.error('  ❌ Product:', p.sku, error.message)
  }
  console.log('  ✅ Товари створені')

  // 7. Постачальники
  console.log('🌱 Seed: Постачальники...')
  const suppliers = [
    { tenant_id: TENANT_ID, name: 'ТОВ Авто-Запчастини Плюс', phone: '+380671234567', contact_name: 'Іванов Іван', is_active: true },
    { tenant_id: TENANT_ID, name: 'ФОП Петренко А.В.', phone: '+380931112233', contact_name: 'Петренко Андрій', is_active: true },
  ]
  for (const s of suppliers) {
    await supabase.from('suppliers').insert(s).select().maybeSingle()
  }
  console.log('  ✅ Постачальники створені')

  console.log('\n✅ Seed завершено успішно!')
  console.log(`  Власник: ${ownerPhone}`)
  if (CASHIER_PHONE) console.log(`  Касир: ${CASHIER_PHONE}`)
  console.log('  Паролі не виводяться. Збережіть їх у менеджері паролів.')
}

seed().catch((err) => { console.error('Seed failed:', err); process.exit(1) })
