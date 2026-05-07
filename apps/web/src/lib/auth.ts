import { supabase } from './supabase'

function phoneToEmail(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `${digits}@forsage.internal`
}

export async function signIn(phone: string, password: string) {
  const email = phoneToEmail(phone)
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error('Невірний номер телефону або пароль')
  return data
}

export async function signOut() {
  await supabase.auth.signOut()
}

export async function getSession() {
  const { data } = await supabase.auth.getSession()
  return data.session
}
