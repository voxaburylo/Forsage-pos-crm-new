import pg from 'pg'

if (!process.env.DATABASE_URL) {
  throw new Error('Missing DATABASE_URL in environment')
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
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
