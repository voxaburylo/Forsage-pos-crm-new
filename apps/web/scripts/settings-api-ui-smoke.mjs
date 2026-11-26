// 25.11.2026, фото власника з iPhone (Налаштування → «API-ключі»): верхня панель вкладок частково перекривала
// сторінку при прокручуванні; склади займали багато місця; не видно, чи йде завантаження складу.
// Справжня оболонка (Layout), справжні вкладки налаштувань і картка постачальників зі штучними даними.
// Перевіряє: над панеллю немає щілини, крізь яку видно сторінку; підключення й склади згорнуті; кружечки є.
// Жодних живих даних і мережі.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { chromium, webkit } = await import('playwright')
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const shot = process.argv.find(arg => arg.startsWith('--screenshot='))?.slice('--screenshot='.length)

const warehouses = Array.from({ length: 14 }, (_, i) => ({ id: 'w' + i, code: 'W' + i, name: ['Житомир 1', 'Запоріжжя 1', 'Київ 1', 'Київ 2', 'Львів 1', 'Одеса 1', 'Дніпро 1'][i % 7] + (i >= 7 ? ' (2)' : ''), city: null, days_to_ship: i === 0 ? 1 : null, is_active: i !== 3 }))
const connections = [
  { id: 'c1', provider: 'omega', name: 'Омега', key_hint: '…ab12', enabled: true, syncing: true, sync_page: 21, last_full_sync_at: null, last_error: null, total_offers: 80000, offers: 79075, linked: 370,
    crosses_done: 1200, crosses_total: 30000, details_done: 900, warehouses,
    progress: { overall: { fraction: 0.09, eta_ms: 16 * 86400000, loading: true, next_at: null }, photos: { fraction: 0.05, eta_ms: null, loading: true, next_at: null, note: 'разом із кросами, повільніше' }, price: { fraction: 0.25, eta_ms: 3 * 3600000 + 20 * 60000, loading: true, next_at: null },
      crosses: { fraction: 0.015, eta_ms: 16 * 86400000, loading: true, next_at: null }, details: { fraction: 0.011, eta_ms: 13 * 86400000, loading: true, next_at: null } } },
]
const modules = {
  '@/stores/authStore': `import{create}from'zustand';export const useAuthStore=create(()=>({loading:false,offlineMode:false,session:{user:{id:'u',app_metadata:{role:'owner',tenant_id:'t'}}}}));`,
  '@/lib/auth': `export async function signOut(){}`,
  '@/lib/api': `const rows=${JSON.stringify(connections)};export const api={get:async(url)=>({data:url.includes('supplier-api')?rows:{}}),post:async()=>({data:rows}),put:async()=>({data:rows}),delete:async()=>({data:rows})};export const isWebReadOnlyRequest=()=>false;`,
  '@/lib/desktopBridge': `export const isDesktopRuntime=()=>false;export const desktopBridge=()=>null;`,
  '@/features/inventory/pickingApi': `export const PICKING_STATUSES=[];`,
  '@/components/ui/Toast': `export const toast={error(){},success(){},warning(){}};export function ToastContainer(){return null}`,
  '@/components/DataFreshness': `export function DataFreshness(){return null}`,
  '@/components/BuildBadge': `export function BuildBadge(){return null}`,
  '@/features/site/siteGateway': `export function useSiteUnseenCount(){return 0}`,
  '@/features/site/siteAccess': `export function useSiteSection(){return{allowed:false,owner:false}}`,
}
const entry = `
import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';
import{Layout}from'/src/components/Layout.tsx';import'/src/index.css';
import{SettingsTabsProvider,SettingsTabBar,SettingsSection}from'/src/features/settings/SettingsTabs.tsx';
import{SupplierApiCard}from'/src/features/settings/SupplierApiCard.tsx';
localStorage.setItem('forsage.settings.tab','api');
function Page(){return <Layout title="Налаштування магазину"><SettingsTabsProvider><SettingsTabBar/>
  <SettingsSection tab="api" title="API-ключі постачальників"><div className="rounded-xl bg-white p-4"><p className="mb-3 font-semibold">Постачальники за API</p><SupplierApiCard/></div></SettingsSection>
  <div style={{height:1500}} data-filler/></SettingsTabsProvider></Layout>}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/settings']}><Page/></MemoryRouter>);
`
const server = await createServer({
  cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } },
  server: { host: '127.0.0.1', port: 0 }, plugins: [tailwindcss(), {
    name: 'settings-api-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:settings-api.tsx' || id in modules) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:settings-api.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      const normalized = id.replaceAll('\\', '/')
      for (const [key, source] of Object.entries(modules)) {
        if (id === '\0' + key || normalized.endsWith('/src/' + key.slice(2) + '.ts') || normalized.endsWith('/src/' + key.slice(2) + '.tsx')) return source
      }
    },
    configureServer(vite) { vite.middlewares.use('/settings-api-test', async (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(await vite.transformIndexHtml('/settings-api-test', '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"></head><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:settings-api.tsx"></script></body></html>'))
    }) },
  }],
})
const SIZES = [{ name: 'iphone', width: 390, height: 844 }, { name: 'pc', width: 1366, height: 768 }]
const results = []
try {
  await server.listen()
  const base = server.resolvedUrls.local[0]
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    let browser
    try { browser = await launcher.launch({ headless: true }) } catch { results.push(`${engine}: не встановлено, пропущено`); continue }
    try {
      for (const size of SIZES) {
        const label = `${engine} ${size.name}`
        const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, hasTouch: size.name === 'iphone', isMobile: engine === 'chromium' && size.name === 'iphone' })
        const errors = []; page.on('pageerror', error => errors.push(String(error))); page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
        await page.goto(base + 'settings-api-test')
        await page.locator('[data-supplier-warehouses]').waitFor({ state: 'attached', timeout: 20_000 }).catch(async error => { throw new Error(label + ': ' + errors.join(' | ') + ' :: ' + (await page.locator('body').innerText()).slice(0, 400), { cause: error }) })
        // Підключення й склади згорнуті; кружечок видно в заголовку.
        // 26.11.2026 (фото власника): один блок на постачальника; склади — усередині нього.
        assert.equal(await page.locator('details[data-supplier-fold]').count(), 2, label + ': Омега, GPL')
        assert.equal(await page.locator('details[data-supplier-fold="Омега"]').evaluate(node => node.open), false, label + ': налаштована Омега згорнута')
        assert.equal(await page.locator('details[data-supplier-fold="gpl"]').evaluate(node => node.open), true, label + ': GPL без доступу — відкритий')
        // У заголовку — загальний стан усіх завантажень (кроси ще вантажаться — отже, не «завантажено»).
        assert.match(await page.locator('details[data-supplier-fold="Омега"] summary').innerText(), /9 %.*лишилось ≈ 16 дн/s, label)
        await page.locator('details[data-supplier-fold="Омега"] summary').click()
        const details = await page.locator('details[data-supplier-fold="Омега"] [data-supplier-progress]').innerText()
        for (const text of ['Прайс і склади', 'Кроси', 'Опис', 'Фото', 'разом із кросами, повільніше']) assert.ok(details.includes(text), `${label}: у розкритому блоці немає «${text}»`)
        assert.ok(await page.locator('details[data-supplier-fold="Омега"] [data-supplier-warehouses]').isVisible(), label + ': склади — усередині блоку Омеги')
        assert.equal(await page.locator('[data-supplier-warehouses] li [data-load-ring]').count(), 13, label + ': кружечок біля кожного ввімкненого складу')
        // Прокручуємо: панель вкладок прилягає до верху робочої області, над нею сторінку не видно.
        const main = page.locator('#app-main-scroll')
        await main.evaluate(node => { node.scrollTop = 600 })
        await page.waitForTimeout(100)
        const gap = await page.evaluate(() => {
          const mainBox = document.querySelector('#app-main-scroll').getBoundingClientRect()
          const bar = document.querySelector('[data-settings-tabbar]')
          const barBox = bar.getBoundingClientRect()
          const hits = []
          for (const dy of [0.5, 2, 6, 10, 14]) {
            const hit = document.elementFromPoint(mainBox.left + mainBox.width / 2, mainBox.top + dy)
            hits.push(Boolean(hit && (bar === hit || bar.contains(hit))))
          }
          const tabs = bar.querySelector('[role="tablist"]').getBoundingClientRect()
          return { barTop: barBox.top - mainBox.top, tabsTop: tabs.top - mainBox.top, hits, background: getComputedStyle(bar).backgroundColor }
        })
        assert.ok(gap.hits.every(Boolean), `${label}: над вкладками видно сторінку ${JSON.stringify(gap)}`)
        assert.ok(gap.tabsTop >= 0 && gap.tabsTop <= 26, `${label}: вкладки біля верху ${JSON.stringify(gap)}`)
        assert.doesNotMatch(gap.background, /rgba\(.*, 0\.\d+\)/, `${label}: фон панелі суцільний`)
        if (shot && size.name === 'iphone' && engine === 'chromium') {
          await main.evaluate(node => { node.scrollTop = 0 })
          await page.screenshot({ path: shot + '-top.png' })
          await main.evaluate(node => { node.scrollTop = 600 })
          await page.screenshot({ path: shot + '-scrolled.png' })
        }
        results.push(`${label}: OK (${JSON.stringify(gap)})`)
        await page.close()
      }
    } finally { await browser.close() }
  }
  console.log(results.join('\n'))
  console.log('PASS settings API tab: flush tab bar, folded suppliers and warehouses, load circles')
} finally {
  await server.close()
}
