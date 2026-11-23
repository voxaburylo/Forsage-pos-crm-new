// 23.11.2026 (план T8): ключові перевірки інтерфейсу — ще й у Microsoft Edge.
// Сканер каси працював у Chrome і не працював в Edge — таке має ловитись до випуску.
//
//   node apps/web/scripts/run-in-edge.mjs apps/web/scripts/pos-dialog-ui-smoke.mjs
//
// Сама перевірка не змінюється: тут лише підміняється запуск браузера — той самий Playwright відкриває
// встановлений Edge (channel "msedge") замість вбудованого Chromium. FORSAGE_SMOKE_CHANNEL=chrome — те саме для Chrome.
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [script, ...rest] = process.argv.slice(2)
if (!script || !/-smoke\.mjs$/.test(script)) {
  console.error('Використання: node apps/web/scripts/run-in-edge.mjs <шлях до *-smoke.mjs>')
  process.exit(2)
}
const channel = process.env.FORSAGE_SMOKE_CHANNEL || 'msedge'
if (!['msedge', 'chrome'].includes(channel)) { console.error('Невідомий браузер: ' + channel); process.exit(2) }

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, '../package.json'))
// Той самий екземпляр модуля, який імпортує перевірка: підміна launch діє й для неї.
const playwright = await import(pathToFileURL(require.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default?.chromium
if (!chromium) { console.error('Playwright не знайдено'); process.exit(2) }
const launch = chromium.launch.bind(chromium)
let launches = 0
chromium.launch = (options = {}) => { launches++; return launch({ ...options, channel }) }

process.argv = [process.argv[0], path.resolve(script), ...rest]
process.once('exit', code => {
  if (code === 0 && launches === 0) { console.error(`${channel}: перевірка не відкрила браузер — нічого не перевірено`); process.exitCode = 1 }
  else if (code === 0) console.log(`Browser channel: ${channel} (launches: ${launches})`)
})
await import(pathToFileURL(path.resolve(script)).href)
