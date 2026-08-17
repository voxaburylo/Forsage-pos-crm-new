import pg from 'pg'

if (!process.env.DATABASE_URL) {
  throw new Error('Missing DATABASE_URL in environment')
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Для Vercel використовуємо малий пул: багато великих пулів швидко
  // вичерпають ліміт підключень Supabase. DATABASE_URL у Vercel має вести
  // на transaction pooler Supabase (порт 6543).
  max: Number.parseInt(process.env.PG_POOL_MAX ?? (process.env.VERCEL ? '3' : '10'), 10),
  idleTimeoutMillis: process.env.VERCEL ? 5_000 : 30_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: Boolean(process.env.VERCEL),
})

export async function runTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
