/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_API_URL: string
}

/** Час і коміт збірки вебу (vite.config.ts → define). */
declare const __WEB_BUILT_AT__: string
declare const __WEB_COMMIT__: string

interface ImportMeta {
  readonly env: ImportMetaEnv
}
