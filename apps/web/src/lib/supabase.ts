import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)
const desktopRuntime = typeof window !== 'undefined' && Boolean(window.forsageDesktop)

if (desktopRuntime && typeof localStorage !== 'undefined') {
  // Remove credentials left by older desktop builds. Local cashiers must always
  // authenticate again after the application is restarted.
  try {
    const obsoleteKeys = new Set([
      'forsage_offline_auth_v1',
      'forsage_local_desktop_session_v1',
    ])
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index)
      if (key && (obsoleteKeys.has(key) || /^sb-.*-auth-token$/.test(key))) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Some locked-down browser profiles may deny storage access. The client is
    // still configured with persistSession=false below.
  }
}

if (!isSupabaseConfigured) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env')
}

export const supabase = createClient(
  supabaseUrl || 'https://missing-supabase-url.supabase.co',
  supabaseAnonKey || 'missing-anon-key',
  {
    auth: {
      // Every cashier must enter their own password after desktop restart.
      persistSession: !desktopRuntime,
      autoRefreshToken: true,
      detectSessionInUrl: !desktopRuntime,
    },
  },
)
