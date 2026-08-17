const fs = require('node:fs')
const path = require('node:path')

const webEnvPath = path.resolve(__dirname, '../../web/.env')
const webProductionEnvPath = path.resolve(__dirname, '../../web/.env.production')
const desktopDistPath = path.resolve(__dirname, '../dist')
const authConfigPath = path.join(desktopDistPath, 'trusted-auth-config.json')
const webDistIndexPath = path.resolve(__dirname, '../../web/dist/index.html')
const requiredKeys = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_API_URL']

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const result = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    result[key] = value
  }
  return result
}

const fileEnv = { ...parseEnvFile(webEnvPath), ...parseEnvFile(webProductionEnvPath) }
const valueFor = (key) => process.env[key] || fileEnv[key] || ''
const missing = requiredKeys.filter((key) => !valueFor(key))

if (missing.length > 0) {
  console.error(`Desktop build is missing required web env keys: ${missing.join(', ')}`)
  console.error(`Expected them in ${webEnvPath} or process environment.`)
  console.error('Copy production-safe VITE_* values before building the portable EXE.')
  process.exit(1)
}

let supabaseUrl
try {
  supabaseUrl = new URL(valueFor('VITE_SUPABASE_URL'))
} catch {
  console.error('VITE_SUPABASE_URL must be a valid HTTPS URL.')
  process.exit(1)
}
if (supabaseUrl.protocol !== 'https:') {
  console.error('VITE_SUPABASE_URL must use HTTPS.')
  process.exit(1)
}
let apiUrl
try {
  apiUrl = new URL(valueFor('VITE_API_URL'))
} catch {
  console.error('VITE_API_URL must be a valid HTTPS URL for the desktop build.')
  process.exit(1)
}
if (apiUrl.protocol !== 'https:' || apiUrl.hostname.endsWith('.onrender.com')) {
  console.error('Desktop VITE_API_URL must use the active HTTPS API and must not point to the retired Render service.')
  process.exit(1)
}
// A desktop renderer is loaded from file://, so Vite assets must be relative
// (./assets/...). Catch a web-mode build here instead of producing a black EXE.
if (fs.existsSync(webDistIndexPath)) {
  const webIndex = fs.readFileSync(webDistIndexPath, 'utf8')
  if (webIndex.includes('src="/assets/') || webIndex.includes('href="/assets/') || webIndex.includes('href="/favicon')) {
    console.error('Desktop renderer was built with absolute web asset paths.')
    console.error('Rebuild the web app with FORSAGE_DESKTOP_BUILD=1 before packaging the portable EXE.')
    process.exit(1)
  }
}


// The desktop main process uses this pinned public project configuration only
// to bootstrap a missing local password after Supabase has authenticated it.
fs.mkdirSync(desktopDistPath, { recursive: true })
fs.writeFileSync(authConfigPath, JSON.stringify({
  supabaseUrl: supabaseUrl.toString().replace(/\/$/, ''),
  supabaseAnonKey: valueFor('VITE_SUPABASE_ANON_KEY'),
}), { encoding: 'utf8', mode: 0o600 })
