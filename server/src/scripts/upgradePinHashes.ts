import 'dotenv/config'
import { db } from '../db/supabase.js'
import { hashSecret } from '../lib/secretHash.js'

async function main(): Promise<void> {
  const { data, error } = await db.from('staff_pins').select('user_id,pin_code')
  if (error) throw error

  let upgraded = 0
  for (const row of data ?? []) {
    const pin = String(row.pin_code ?? '')
    if (!/^\d{4}$/.test(pin)) continue
    const { error: updateError } = await db
      .from('staff_pins')
      .update({ pin_code: hashSecret(pin), updated_at: new Date().toISOString() })
      .eq('user_id', row.user_id)
    if (updateError) throw updateError
    upgraded += 1
  }
  console.log(`Upgraded legacy PIN rows: ${upgraded}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})