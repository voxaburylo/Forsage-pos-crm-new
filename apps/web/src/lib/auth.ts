import { supabase } from './supabase'

function phoneToEmail(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `${digits}@forsage.internal`
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('380')) return `+${digits}`
  if (digits.startsWith('80'))  return `+3${digits}`
  if (digits.startsWith('0'))   return `+38${digits}`
  return raw
}

// Вхід напряму через Supabase Auth (без посередника Express)
export async function signIn(phone: string, password: string) {
  const normalized = normalizePhone(phone)
  const email = phoneToEmail(normalized)

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error || !data.session) {
    // Перетворюємо помилку Supabase в зрозуміле повідомлення
    const msg = error?.message ?? ''
    if (msg.includes('Invalid login credentials') || msg.includes('Email not confirmed')) {
      throw new Error('Невірний номер телефону або пароль')
    }
    throw new Error(msg || 'Помилка входу')
  }

  return data.session
}

export async function signOut() {
  await supabase.auth.signOut()
}

export async function getSession() {
  const { data } = await supabase.auth.getSession()
  return data.session
}
