import type { Session } from '@supabase/supabase-js'
import { createDesktopSession } from '@/lib/auth'
import { useAuthStore } from '@/stores/authStore'
import { phoneLanLogin, phoneLanUser, setPhoneWorksViaWifi, type PhoneLanUser } from './phoneLan'

/**
 * Вхід телефона через Wi-Fi головного ПК (27.11.2026). Пароль (або сеанс, виданий головним ПК, поки був інтернет)
 * перевіряє головний ПК; телефон отримує той самий «перевірений на місці» сеанс, що й програма каси без інтернету.
 */
const sessionFor = (user: PhoneLanUser): Session => createDesktopSession({ id: user.id, email: '', phone: user.phone, full_name: user.full_name, role: user.role, tenant_id: user.tenant_id })

export async function signInViaPhoneLan(password: string): Promise<Session> {
  const session = sessionFor(await phoneLanLogin(password))
  setPhoneWorksViaWifi(true)
  useAuthStore.getState().setOfflineSession(session)
  return session
}

/** Без інтернету: сеанс Wi-Fi ще дійсний — входимо без пароля й без сканування. */
export function restorePhoneLanSession(): Session | null {
  const user = phoneLanUser()
  if (!user) return null
  const session = sessionFor(user)
  setPhoneWorksViaWifi(true)
  useAuthStore.getState().setOfflineSession(session)
  return session
}
