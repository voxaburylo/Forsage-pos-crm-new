/** Owner-approved, narrowly scoped schema installation. Does not seed balances. */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { pool } from '../db/pg.js'

async function main() {
  const client = await pool.connect()
  try {
    const state = await client.query("SELECT to_regclass('public.local_mirror_authorities') authorities, to_regclass('public.local_balance_mirror') mirror")
    console.log('Schema before:', state.rows[0])
    if (process.argv.includes('--apply')) {
      if (state.rows[0].authorities || state.rows[0].mirror) throw new Error('Already/partly installed: inspect instead of replaying DDL')
      await client.query("SET lock_timeout='5s'; SET statement_timeout='30s'")
      // Simple-query protocol supports the migration's explicit BEGIN/COMMIT.
      // CLI v2.98.2 db query uses a prepared statement and rejects multi-command files.
      await client.query(readFileSync(new URL('../../../supabase/migrations/20260911183427_local_balance_mirror.sql', import.meta.url), 'utf8'))
    }
    console.log('Schema after:', (await client.query(`SELECT c.relname,c.relrowsecurity,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon_access,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') authenticated_access
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('local_mirror_authorities','local_balance_mirror')`)).rows)
    console.log('Triggers:', (await client.query(`SELECT tgname,tgrelid::regclass::text relation,tgenabled
      FROM pg_trigger WHERE tgname='aa_local_balance_mirror'`)).rows)
  } finally { client.release(); await pool.end() }
}
main().catch(error => { console.error(error.message); process.exitCode=1 })
