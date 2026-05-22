import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env')
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
  const ownerPhone = process.env.SEED_OWNER_PHONE ?? '+380671234567'
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? 'admin123'
  const email = ownerPhone.replace(/\D/g, '') + '@forsage.internal'

  const { data: existingUsers } = await supabase.auth.admin.listUsers()
  if (!existingUsers?.users?.find((u) => u.email === email)) {
    const { error: e } = await supabase.auth.admin.createUser({
      email, password: ownerPassword, email_confirm: true,
      user_metadata: { phone: ownerPhone, full_name: 'Власник', role: 'owner', tenant_id: TENANT_ID, is_active: true },
    })
    if (e) { console.error('  ❌ Owner:', e.message); process.exit(1) }
    console.log('  ✅ Owner створено')
  } else {
    // Ensure password is set correctly
    const owner = existingUsers.users.find((u) => u.email === email)!
    await supabase.auth.admin.updateUserById(owner.id, { password: ownerPassword })
    console.log('  ✅ Owner вже існує (пароль оновлено)')
  }

  // 2. Cashier
  const cashierPhone = '+380501234567'
  const cashierEmail = cashierPhone.replace(/\D/g, '') + '@forsage.internal'
  if (!existingUsers?.users?.find((u) => u.email === cashierEmail)) {
    const { error: e } = await supabase.auth.admin.createUser({
      email: cashierEmail, password: 'cashier123', email_confirm: true,
      user_metadata: { phone: cashierPhone, full_name: 'Касир Іван', role: 'cashier', tenant_id: TENANT_ID, is_active: true },
    })
    if (e) { console.error('  ❌ Касир:', e.message) }
    else { console.log('  ✅ Касір створено') }
  } else {
    console.log('  ✅ Касір вже існує')
  }

  // 3. Settings
  const { data: settings } = await supabase.from('shop_settings').select('id').maybeSingle()
  if (!settings) {
    const { error } = await supabase.from('shop_settings').insert({
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
  console.log('  Owner:  +380671234567 / admin123')
  console.log('  Касір:  +380501234567 / cashier123')
}

seed().catch((err) => { console.error('Seed failed:', err); process.exit(1) })
