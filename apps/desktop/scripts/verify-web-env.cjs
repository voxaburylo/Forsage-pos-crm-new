const fs = require('node:fs')
const path = require('node:path')

const webEnvPath = path.resolve(__dirname, '../../web/.env')
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

const fileEnv = parseEnvFile(webEnvPath)
const missing = requiredKeys.filter((key) => !(process.env[key] || fileEnv[key]))

if (missing.length > 0) {
  console.error(`Desktop build is missing required web env keys: ${missing.join(', ')}`)
  console.error(`Expected them in ${webEnvPath} or process environment.`)
  console.error('Copy production-safe VITE_* values before building the portable EXE.')
  process.exit(1)
}
