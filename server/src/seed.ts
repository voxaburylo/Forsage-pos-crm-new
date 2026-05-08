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

async function seed() {
  console.log('?? Seed: ��������� tenant + owner...')

  // 1. ��������� tenant
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .insert({
      name: '������',
      slug: 'forsage',
      settings: {
        shop_name: '������',
        shop_address: '',
        phone: '+380',
        max_discount_pct: 10,
        allow_negative_qty: false,
        return_days: 14,
      },
    })
    .select('id')
    .single()

  if (tenantError) {
    const { data: existing } = await supabase
      .from('tenants')
      .select('id')
      .eq('slug', 'forsage')
      .single()
    if (existing) {
      console.log('  ? Tenant ��� ����:', existing.id)
    } else {
      console.error('  ? �������:', tenantError.message)
      process.exit(1)
    }
  } else {
    console.log('  ? Tenant ��������:', tenant.id)
  }

  // 2. ID tenant
  const { data: tenantData } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', 'forsage')
    .single()
  if (!tenantData) { console.error('  ? Tenant �� ��������'); process.exit(1) }
  const TENANT_ID = tenantData.id

  // 3. Owner
  const ownerPhone = process.env.SEED_OWNER_PHONE ?? '+380671234567'
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? 'admin123'
  const email = ownerPhone.replace(/\D/g, '') + '@forsage.internal'

  const { data: existingUsers } = await supabase.auth.admin.listUsers()
  if (!existingUsers?.users?.find((u) => u.email === email)) {
    const { error: e } = await supabase.auth.admin.createUser({
      email, password: ownerPassword, email_confirm: true,
      user_metadata: { phone: ownerPhone, full_name: '�������', role: 'owner', tenant_id: TENANT_ID, is_active: true },
    })
    if (e) { console.error('  ? Owner:', e.message); process.exit(1) }
    console.log('  ? Owner ��������')
  } else {
    console.log('  ? Owner ��� ����')
  }

  // 4. Cashier
  const cashierPhone = '+380501234567'
  const cashierEmail = cashierPhone.replace(/\D/g, '') + '@forsage.internal'
  if (!existingUsers?.users?.find((u) => u.email === cashierEmail)) {
    const { error: e } = await supabase.auth.admin.createUser({
      email: cashierEmail, password: 'cashier123', email_confirm: true,
      user_metadata: { phone: cashierPhone, full_name: '������ ����', role: 'cashier', tenant_id: TENANT_ID, is_active: true },
    })
    if (e) { console.error('  ? �����:', e.message) }
    else { console.log('  ? ����� ��������') }
  } else {
    console.log('  ? ����� ��� ����')
  }

  // 5. Settings
  const { data: settings } = await supabase.from('shop_settings').select('id').single()
  if (!settings) {
    await supabase.from('shop_settings').insert({
      shop_name: '������', shop_address: '�. ���', phone: '+380',
      max_discount_pct: 10, allow_negative_qty: false, return_days: 14,
    })
    console.log('  ? ������������ ��������')
  } else {
    console.log('  ? ������������ ��� �������')
  }

  console.log('\n? Seed ���������!')
  console.log('  Owner:  +380671234567 / admin123')
  console.log('  �����:  +380501234567 / cashier123')
}

seed().catch((err) => { console.error('Seed failed:', err); process.exit(1) })

