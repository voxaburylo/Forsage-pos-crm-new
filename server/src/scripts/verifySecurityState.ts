import 'dotenv/config'
import pg from 'pg'

interface SecurityState {
  background_jobs_rls: boolean
  background_job_rows: string
  public_table_grants: string
  public_function_grants: string
  plaintext_pin_rows: string
  current_pin_rows: string
  total_pin_rows: string
  anon_claim_job_functions: string
  mutable_application_functions: string
  pg_trgm_schema: string | null
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    const { rows } = await client.query<SecurityState>(`
      SELECT
        (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sys_background_jobs'::regclass) AS background_jobs_rls,
        (SELECT count(*) FROM public.sys_background_jobs)::text AS background_job_rows,
        (SELECT count(*) FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee IN ('anon','authenticated','PUBLIC'))::text AS public_table_grants,
        (SELECT count(*) FROM information_schema.role_routine_grants
          WHERE routine_schema = 'public' AND grantee IN ('anon','authenticated','PUBLIC'))::text AS public_function_grants,
        (SELECT count(*) FROM public.staff_pins WHERE pin_code ~ '^\\d{4}$')::text AS plaintext_pin_rows,
        (SELECT count(*) FROM public.staff_pins WHERE pin_code LIKE 'pbkdf2-sha512$210000$%')::text AS current_pin_rows,
        (SELECT count(*) FROM public.staff_pins)::text AS total_pin_rows,
        (SELECT count(*) FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = 'public'
            AND procedure.proname = 'claim_next_job'
            AND has_function_privilege('anon', procedure.oid, 'EXECUTE'))::text AS anon_claim_job_functions,
        (SELECT count(*) FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname IN ('public', 'app')
            AND NOT EXISTS (
              SELECT 1 FROM unnest(COALESCE(procedure.proconfig, ARRAY[]::text[])) AS config
              WHERE config LIKE 'search_path=%'
            )
            AND NOT EXISTS (
              SELECT 1 FROM pg_depend AS dependency
              WHERE dependency.classid = 'pg_proc'::regclass
                AND dependency.objid = procedure.oid
                AND dependency.deptype = 'e'
            ))::text AS mutable_application_functions,
        (SELECT namespace.nspname FROM pg_extension AS extension
          JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
          WHERE extension.extname = 'pg_trgm') AS pg_trgm_schema
    `)
    const state = rows[0]
    const failures: string[] = []
    if (!state.background_jobs_rls) failures.push('background job queue has no RLS')
    if (state.public_table_grants !== '0') failures.push('browser roles still have public table grants')
    if (state.public_function_grants !== '0') failures.push('browser roles still have public function grants')
    if (state.plaintext_pin_rows !== '0') failures.push('plaintext PIN rows remain')
    if (state.anon_claim_job_functions !== '0') failures.push('anonymous role can claim jobs')
    if (state.mutable_application_functions !== '0') failures.push('application functions have mutable search_path')
    if (state.pg_trgm_schema !== 'extensions') failures.push('pg_trgm remains in public schema')
    if (failures.length > 0) throw new Error(failures.join('; '))
    console.log(JSON.stringify({ ok: true, ...state }))
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})