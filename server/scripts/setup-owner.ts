/**
 * Форсаж CRM — Скрипт первинного налаштування
 *
 * Запуск: cd server && npx tsx scripts/setup-owner.ts
 *
 * Що робить:
 * 1. Створює першого власника (owner) у Supabase Auth
 * 2. Встановлює роль owner в user_metadata
 *
 * Потребує: server/.env з SUPABASE_URL і SUPABASE_SERVICE_KEY
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import * as readline from 'readline'

const SUPABASE_URL       = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Відсутні SUPABASE_URL або SUPABASE_SERVICE_KEY у server/.env')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
})

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()) })
  })
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('380')) return `+${digits}`
  if (digits.startsWith('80'))  return `+3${digits}`
  if (digits.startsWith('0'))   return `+38${digits}`
  return raw
}

function phoneToEmail(phone: string): string {
  return `${phone.replace(/\D/g, '')}@forsage.internal`
}

async function main() {
  console.log('\n🔧 Форсаж CRM — Налаштування першого власника\n')

  // Перевіряємо чи вже є власник
  const { data: existingUsers } = await supabase.auth.admin.listUsers()
  const owners = existingUsers?.users?.filter(
    (u) => u.user_metadata?.role === 'owner'
  ) ?? []

  if (owners.length > 0) {
    console.log(`⚠️  Власник вже існує: ${owners[0].user_metadata?.phone ?? owners[0].email}`)
    const cont = await ask('Створити ще одного власника? (y/N): ')
    if (cont.toLowerCase() !== 'y') {
      console.log('Вихід.')
      process.exit(0)
    }
  }

  // Отримуємо дані від користувача
  const phoneRaw = await ask("Телефон власника (напр. +380671234567): ")
  const phone    = normalizePhone(phoneRaw)

  if (!/^\+?380\d{9}$/.test(phone)) {
    console.error('❌ Невірний формат телефону. Приклад: +380671234567')
    process.exit(1)
  }

  const fullName = await ask("Повне ім'я: ")
  if (!fullName) {
    console.error("❌ Ім'я обов'язкове")
    process.exit(1)
  }

  const password = await ask('Пароль (мінімум 6 символів): ')
  if (password.length < 6) {
    console.error('❌ Пароль мінімум 6 символів')
    process.exit(1)
  }

  const email = phoneToEmail(phone)

  // Перевіряємо чи телефон не зайнятий
  const duplicate = existingUsers?.users?.find((u) => u.email === email)
  if (duplicate) {
    console.error(`❌ Користувач з телефоном ${phone} вже існує`)
    process.exit(1)
  }

  console.log(`\nСтворення власника: ${fullName} (${phone})...`)

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      phone,
      full_name: fullName,
      role:      'owner',
      is_active: true,
      tenant_id: '00000000-0000-0000-0000-000000000001',
    },
  })

  if (error) {
    console.error('❌ Помилка створення:', error.message)
    process.exit(1)
  }

  console.log('\n✅ Власника створено успішно!')
  console.log(`   ID:       ${data.user?.id}`)
  console.log(`   Телефон:  ${phone}`)
  console.log(`   Пароль:   ${password}`)
  console.log(`   Роль:     owner`)
  console.log('\n🚀 Тепер можна входити в систему.')
}

main().catch((err) => {
  console.error('❌ Критична помилка:', err)
  process.exit(1)
})
