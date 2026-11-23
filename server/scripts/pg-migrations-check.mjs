// 23.11.2026 (план T4): справжній Postgres (PGlite) без Docker — проганяє всі міграції Supabase,
// щоб запити сервера можна було перевіряти на справжній базі, а не на заглушках.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'

const here = path.dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS = path.resolve(here, '../../supabase/migrations')

// Те, що в Supabase є до наших міграцій: ролі, схема auth з auth.uid()/jwt(), storage, cron.
export const SUPABASE_BASE = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text, phone text, raw_user_meta_data jsonb, raw_app_meta_data jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), deleted_at timestamptz);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $f$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $f$ SELECT string_to_array(name, '/') $f$;
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text, command text);
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $f$ INSERT INTO cron.job(jobname, schedule, command) VALUES (job_name, schedule, command) RETURNING jobid $f$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS $f$ DELETE FROM cron.job WHERE jobname = job_name RETURNING true $f$;
`

// Розширення, яких у PGlite немає (працюють лише в хмарі Supabase), — пропускаємо рядок створення.
const CLOUD_ONLY = /^\s*create\s+extension\s+(if\s+not\s+exists\s+)?"?(pg_cron|pg_net|pg_stat_statements|pgsodium|supabase_vault|pg_graphql|pgjwt|http)"?[^;]*;/gim

export async function migratedDatabase({ log = () => {} } = {}) {
  const db = await PGlite.create({ extensions: { pg_trgm, uuid_ossp } })
  await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;').catch(() => db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;'))
  await db.exec(SUPABASE_BASE)
  // У Supabase розширення живуть у схемі extensions, і вона є в шляху пошуку.
  await db.exec('SET search_path TO public, extensions')
  // Історично частину файлів застосовано не в порядку назв (напр. 020 після 050) — повторюємо невдалі, поки є поступ.
  let pending = readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort()
  let failures = []
  for (let pass = 0; pass < 5 && pending.length; pass++) {
    failures = []
    for (const file of pending) {
      const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8').replace(/^﻿/, '').replace(CLOUD_ONLY, '-- cloud-only extension skipped\n')
      try { await db.exec(sql); log('ok', file) } catch (error) { await db.exec('ROLLBACK').catch(() => {}); failures.push({ file, error: String(error?.message ?? error).slice(0, 300) }) }
    }
    if (failures.length === pending.length) break
    pending = failures.map(item => item.file)
  }
  return { db, failures: failures.filter(item => !LEGACY_ON_EMPTY_DATABASE.has(item.file)), legacy: failures.filter(item => LEGACY_ON_EMPTY_DATABASE.has(item.file)) }
}

// Ранні файли без дати, які на порожній базі не проходять і не можуть пройти: 021 ставить лічильник чеків за кількістю
// чеків (на порожній базі 0 — заборонено), 022 і 025 писались під стару схему (колонки tenant_id / таблиця users).
// Справжня база будувалась із них інакше; чинну схему дають решта файлів. Нові провали поза цим списком — помилка.
export const LEGACY_ON_EMPTY_DATABASE = new Set(['021_fix_sale_number_sequence.sql', '022_security_hardening.sql', '025_extended_business_logic.sql'])

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { db, failures } = await migratedDatabase()
  for (const item of failures) console.log('FAIL', item.file, '—', item.error)
  console.log(`migrations: ${readdirSync(MIGRATIONS).filter(n => n.endsWith('.sql')).length}, failed: ${failures.length}`)
  await db.close()
  process.exit(failures.length ? 1 : 0)
}
