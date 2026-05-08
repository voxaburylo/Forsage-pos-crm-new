import { createClient } from '@supabase/supabase-js'

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
}

// Єдиний admin клієнт із service role key — використовується для:
// 1. Перевірки JWT токенів (auth middleware)
// 2. Операцій Supabase Auth Admin API (adminService)
// НЕ використовується для звичайних запитів до БД (для цього є db/supabase.ts)
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } },
)
