// 23.11.2026 (план B1a): справжня оболонка застосунку (Layout) зі штучним широким і довгим вмістом на розмірах
// телефона, планшета й ПК. Перевіряє саме те, на що скаржився власник: сторінка не їде вбік, шапка з вкладками
// лишається на місці, оболонка не вища за видимий екран. Жодних живих даних і мережі.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { chromium } = await import('playwright')
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)

const modules = {
  '@/stores/authStore': `import{create}from'zustand';export const useAuthStore=create(()=>({loading:false,offlineMode:false,session:{user:{id:'u',app_metadata:{role:'owner',tenant_id:'t'}}}}));`,
  '@/lib/auth': `export async function signOut(){}`,
  '@/lib/api': `export const api={get:async()=>({data:{}}),post:async()=>({data:{}})};export const isWebReadOnlyRequest=()=>false;`,
  '@/lib/desktopBridge': `export const isDesktopRuntime=()=>false;export const desktopBridge=()=>null;`,
  '@/features/inventory/pickingApi': `export const PICKING_STATUSES=[];`,
  '@/components/ui/Toast': `export const toast={error(){},success(){},warning(){}};`,
  '@/components/DataFreshness': `export function DataFreshness(){return null}`,
  '@/components/BuildBadge': `export function BuildBadge(){return null}`,
}
const entry = `
import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';
import{Layout}from'/src/components/Layout.tsx';import'/src/index.css';
const wide='ДУЖЕДОВГЕСЛОВОБЕЗПРОБІЛІВ'.repeat(12);
function Page(){return <Layout title="Статистика дуже довга назва сторінки для перевірки" actions={<button>Дія</button>}>
  <div className="grid grid-cols-2 gap-3"><div className="rounded bg-white p-3"><p>{wide}</p></div><div className="rounded bg-white p-3"><input defaultValue="поле" className="text-xs" data-field /></div></div>
  <div className="mt-3 rounded bg-white" data-table-frame><table style={{minWidth:1400}}><thead><tr>{Array.from({length:14},(_,i)=><th key={i} className="px-4 py-2">Колонка {i}</th>)}</tr></thead>
    <tbody>{Array.from({length:60},(_,r)=><tr key={r}>{Array.from({length:14},(_,i)=><td key={i} className="px-4 py-2 whitespace-nowrap">значення {r}-{i}</td>)}</tr>)}</tbody></table></div>
  <p data-bottom>кінець</p>
</Layout>}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/analytics/statistics']}><Page/></MemoryRouter>);
`
const server = await createServer({
  cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } },
  server: { host: '127.0.0.1', port: 0 }, plugins: [tailwindcss(), {
    name: 'responsive-shell-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:responsive-shell.tsx' || id in modules) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:responsive-shell.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      const normalized = id.replaceAll('\\', '/')
      for (const [key, source] of Object.entries(modules)) {
        if (id === '\0' + key || normalized.endsWith('/src/' + key.slice(2) + '.ts') || normalized.endsWith('/src/' + key.slice(2) + '.tsx')) return source
      }
    },
    configureServer(vite) { vite.middlewares.use('/responsive-shell-test', async (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(await vite.transformIndexHtml('/responsive-shell-test', '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"></head><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:responsive-shell.tsx"></script></body></html>'))
    }) },
  }],
})
const SIZES = [
  { name: 'phone', width: 375, height: 667, touch: true }, { name: 'phone-landscape', width: 667, height: 375, touch: true },
  { name: 'tablet', width: 768, height: 1024, touch: true }, { name: 'tablet-landscape', width: 1024, height: 768, touch: true },
  { name: 'pc', width: 1366, height: 768, touch: false },
]
const results = []
try {
  await server.listen()
  const base = server.resolvedUrls.local[0]
  // Edge і Chrome — якщо встановлені; вбудований Chromium — завжди. WebKit (iPhone/iPad) — у CI, якщо встановлено.
  for (const channel of [undefined, 'msedge', 'chrome']) {
    let browser
    try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }) } catch { continue }
    try {
      for (const size of SIZES) {
        const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch && !channel })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(base + 'responsive-shell-test')
        await page.locator('[data-bottom]').waitFor({ state: 'attached', timeout: process.env.CI ? 30000 : 15000 })
        const measure = () => page.evaluate(() => {
          const main = document.getElementById('app-main-scroll'), header = document.querySelector('[data-app-header]'), shell = document.querySelector('.app-shell')
          const frame = document.querySelector('[data-table-frame]'), field = document.querySelector('[data-field]')
          return {
            docWidth: document.documentElement.scrollWidth, docHeight: document.documentElement.scrollHeight, viewWidth: window.innerWidth, viewHeight: window.innerHeight,
            shellHeight: Math.round(shell.getBoundingClientRect().height), headerTop: Math.round(header.getBoundingClientRect().top), headerBottom: Math.round(header.getBoundingClientRect().bottom),
            mainScrollLeftMax: main.scrollWidth - main.clientWidth, mainOverflowX: getComputedStyle(main).overflowX,
            frameScrolls: frame.scrollWidth > frame.clientWidth, frameWidth: Math.round(frame.getBoundingClientRect().width), mainWidth: main.clientWidth,
            fieldFont: parseFloat(getComputedStyle(field).fontSize), overscroll: getComputedStyle(document.body).overscrollBehaviorY,
          }
        })
        const label = `${channel ?? 'chromium'} ${size.name} ${size.width}x${size.height}`
        const top = await measure()
        // Сторінка не ширша й не вища за екран: документ не прокручується ні вбік, ні вниз (прокручується лише робоча область).
        assert.ok(top.docWidth <= top.viewWidth, `${label}: документ ширший за екран (${top.docWidth} > ${top.viewWidth})`)
        assert.ok(top.docHeight <= top.viewHeight, `${label}: документ вищий за екран (${top.docHeight} > ${top.viewHeight})`)
        assert.equal(top.shellHeight, top.viewHeight, `${label}: оболонка не дорівнює видимому екрану`)
        assert.equal(top.mainOverflowX, 'hidden', `${label}: робоча область їздить убік`)
        assert.equal(top.mainScrollLeftMax, 0, `${label}: вміст ширший за робочу область на ${top.mainScrollLeftMax}px`)
        // Широка таблиця прокручується у власній рамці, рамка не ширша за робочу область.
        assert.ok(top.frameScrolls, `${label}: широка таблиця не має власної прокрутки`)
        assert.ok(top.frameWidth <= top.mainWidth, `${label}: рамка таблиці ширша за робочу область`)
        assert.equal(top.overscroll, 'none', `${label}: «потягнути вниз» не вимкнено`)
        if (size.width < 1024) assert.ok(top.fieldFont >= 16, `${label}: поле з шрифтом ${top.fieldFont}px — iPhone збільшить сторінку`)
        // Прокрутили робочу область униз і вбік-пальцем: шапка з вкладками там само, сторінка не зсунулась.
        await page.evaluate(() => { const main = document.getElementById('app-main-scroll'); main.scrollTop = main.scrollHeight; window.scrollTo(300, 300) })
        const bottom = await measure()
        assert.equal(bottom.headerTop, top.headerTop, `${label}: шапка поїхала після прокрутки`)
        assert.ok(bottom.headerTop >= 0 && bottom.headerBottom > 0, `${label}: шапки не видно`)
        assert.deepEqual(await page.evaluate(() => [window.scrollX, window.scrollY]), [0, 0], `${label}: документ зсунувся`)
        assert.deepEqual(errors, [], label)
        results.push(label)
        await context.close()
      }
    } finally { await browser.close() }
  }
  assert.ok(results.length >= SIZES.length, 'жоден браузер не запустився')
  console.log(JSON.stringify({ passed: true, checked: results.length, cases: results }))
} finally { await server.close() }
