import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false } }
)

async function main() {
  const { data, error } = await supabase.auth.admin.listUsers()
  if (error) { console.error('Помилка:', error.message); process.exit(1) }

  const users = data?.users ?? []
  console.log('\nКористувачі в системі:')
  users.forEach((u, i) => {
    const phone = u.user_metadata?.phone ?? u.email
    const role  = u.user_metadata?.role ?? 'unknown'
    console.log(`  ${i + 1}. ${phone} (${role})`)
  })

  if (users.length === 0) {
    console.log('\nНемає жодного користувача. Запусти: npx tsx scripts/setup-owner.ts')
    process.exit(0)
  }

  const NEW_PASSWORD = 'Forsage2026!'

  console.log('\nResetting passwords for all users...')
  for (const user of users) {
    const phone = user.user_metadata?.phone ?? user.email
    const { error: resetErr } = await supabase.auth.admin.updateUserById(user.id, {
      password: NEW_PASSWORD,
    })
    if (resetErr) {
      console.error(`❌ Failed resetting for ${phone}:`, resetErr.message)
    } else {
      console.log(`✅ Password reset for ${phone}`)
    }
  }

  console.log('\n✅ All passwords updated to: ' + NEW_PASSWORD)
}

main().catch(console.error)

