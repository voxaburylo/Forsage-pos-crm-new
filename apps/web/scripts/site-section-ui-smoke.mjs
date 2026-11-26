// 24.11.2026 (слово власника: «вкладка Сайт якась мала, зверху повзунок, хоча місця купа; вкладки порожні й незрозумілі»).
// Справжня оболонка й розділ «Сайт» з даними тієї форми, яку віддає шлюз сайту. Перевіряє: вкладки вміщаються без
// прокрутки на ПК, розділ займає ширину робочої області, порожня вкладка пояснює, для чого вона, і що на ній зробити.
// SITE_SHOTS=<тека> — зберегти знімки екрана. Жодних живих даних і мережі.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { chromium } = await import('playwright')
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const shots = process.env.SITE_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const gateway = {
  ping: { site: 'forsage-tires.com', time: '2026-11-24T18:29:19Z', catalog_sync: { last_ok_at: '2026-11-24T18:28:02Z', last_error: null, minutes_since_ok: 1, stale: false } },
  'orders.unseen_count': { count: 1 },
  'orders.list': [{ id: 10, created_at: '2026-11-24T12:14:49Z', status: 'new', customer_name: 'Швидке замовлення', customer_phone: '+380 96 000 00 00', customer_email: null,
    delivery_method: null, city: null, warehouse: null, comment: null, total: 140, tracking_number: null, manager_comment: null,
    items: [{ product_id: 56318, program_product_id: '74bea2cd-26be-4e83-a8aa-000000000001', title: 'Лампа H7 12V 55W', qty: 1, price: 140 }] }],
  'customers.list': [{ id: 'c1', email: 'ivan@example.com', full_name: null, phone: null, created_at: '2026-06-23T18:31:07Z', orders_count: 0 }],
  'categories.list': [{ id: 1, name: 'Шини', slug: 'shyny', parent_id: null, icon: 'tyre', sort_order: 1, is_active: true, kind: 'tyre', program_category_ids: [] },
    { id: 6, name: 'Легкові', slug: 'shyny-legkovi', parent_id: 1, icon: 'car', sort_order: 1, is_active: true, kind: 'tyre', program_category_ids: [] },
    { id: 20, name: 'Фільтри', slug: 'filtry', parent_id: null, icon: 'filter', sort_order: 5, is_active: true, kind: 'goods', program_category_ids: ['p1'] }],
  'banners.list': [], 'promos.list': [], 'reviews.list': [],
  'home.get': { blocks: [{ type: 'banners', enabled: true }, { type: 'size_search', enabled: true }, { type: 'categories', enabled: true }] },
  'pages.list': [{ id: 'delivery', type: 'info', slug: 'delivery', title: null, content: null, image_url: null, created_at: null, customized: false },
    { id: 'about', type: 'info', slug: 'about', title: null, content: null, image_url: null, created_at: null, customized: false }],
  'settings.get': { seo_title: 'Форсаж — інтернет-магазин', contact_phone1: '099 000 00 00', contact_address: 'м. Синельникове' },
}
const modules = {
  '@/stores/authStore': `import{create}from'zustand';export const useAuthStore=create(()=>({loading:false,offlineMode:false,session:{user:{id:'u',app_metadata:{role:'owner',tenant_id:'t'}}}}));`,
  '@/lib/auth': `export async function signOut(){}`,
  '@/lib/api': `const G=${JSON.stringify(gateway)};
    window.__catalogCalls=[];
    const TREE={categories:[{id:'c1',parent_id:null,name:'Оливи',ours:5,supplier:20},{id:'c2',parent_id:'c1',name:'Моторні оливи',ours:3,supplier:10},{id:'c3',parent_id:null,name:'Фільтри',ours:0,supplier:0}],none:{ours:2,supplier:7}};
    export const api={get:async(p)=>(p.includes('/site-admin/catalog')&&!p.includes('/catalog/categories')?window.__catalogCalls.push(p):0,{data:p.includes('/site-admin/catalog/categories')?TREE:p.includes('/site-admin/catalog')?{rows:[],total:0,ours_total:0,page:1,pages:1}:p.includes('/categories')?[{id:'p1',parent_id:null,name:'Фільтри'},{id:'p2',parent_id:null,name:'Оливи-ATF'}]:p.includes('/access')?{user_ids:[],users:[]}:p.includes('/orders')?[]:{enabled:false,settings:{show_prices:true,stock_mode:'flag',only_in_stock:false,hidden_category_ids:[],price_change_pct:0,accept_orders:true,min_order_kopecks:0,title:'',phone:'',address:'',working_hours:'',banner_text:'',about:'',delivery_text:'',payment_text:''},key_hint:null,key_created_at:null,updated_at:null}}),
      post:async(_p,b)=>{if(b&&b.action==='boom')throw new Error('x');return {data:G[b.action]??null}},put:async()=>({data:{}}),delete:async()=>({data:{}})};
    export const isWebReadOnlyRequest=()=>false;`,
  '@/lib/apiBaseUrl': `export const API_BASE_URL='https://example.test'`,
  '@/lib/desktopBridge': `export const isDesktopRuntime=()=>false;export const desktopBridge=()=>null;`,
  '@/features/inventory/pickingApi': `export const PICKING_STATUSES=[];`,
  '@/components/ui/Toast': `export const toast={error(){},success(){},warning(){},info(){}};export function ToastContainer(){return null}`,
  '@/components/DataFreshness': `export function DataFreshness(){return null}`,
  '@/components/BuildBadge': `export function BuildBadge(){return null}`,
  '@/features/products/productApi': `export const productApi={search:async()=>({data:[]})}`,
  '@/features/products/BulkEditModal': `export function BulkEditModal(){return null}`,
}
const entry = `
import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';
import SitePage from'/src/features/site/SitePage.tsx';import'/src/index.css';
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/site']}><SitePage/></MemoryRouter>);
`
const server = await createServer({
  cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } },
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom', 'lucide-react', 'zustand'] },
  server: { host: '127.0.0.1', port: 0 }, plugins: [tailwindcss(), {
    name: 'site-section-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:site-section.tsx' || id in modules) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:site-section.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      const normalized = id.replaceAll('\\', '/')
      for (const [key, source] of Object.entries(modules)) {
        if (id === '\0' + key || normalized.endsWith('/src/' + key.slice(2) + '.ts') || normalized.endsWith('/src/' + key.slice(2) + '.tsx')) return source
      }
    },
    configureServer(vite) { vite.middlewares.use('/site-section-test', async (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(await vite.transformIndexHtml('/site-section-test', '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"></head><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:site-section.tsx"></script></body></html>'))
    }) },
  }],
})
const SIZES = [{ name: 'pc', width: 1366, height: 768 }, { name: 'pc-wide', width: 1920, height: 1080 }, { name: 'phone', width: 375, height: 667 }]
const results = []
try {
  await server.listen()
  const base = server.resolvedUrls.local[0]
  const browser = await chromium.launch({ headless: true })
  try {
    for (const size of SIZES) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, hasTouch: size.name === 'phone', isMobile: size.name === 'phone' })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(base + 'site-section-test')
      await page.locator('[data-site-tab="orders"]').waitFor({ timeout: process.env.CI ? 30000 : 15000 })
      await page.locator('[data-site-orders] button').first().waitFor()
      const top = await page.evaluate(() => {
        const tabs = document.querySelector('[role=tablist]'), main = document.getElementById('app-main-scroll'), body = document.querySelector('[data-site-body]')
        return { tabsScroll: tabs.scrollWidth - tabs.clientWidth, mainWidth: main.clientWidth, bodyWidth: body ? Math.round(body.getBoundingClientRect().width) : 0,
          mainScroll: main.scrollWidth - main.clientWidth, docWidth: document.documentElement.scrollWidth, viewWidth: window.innerWidth }
      })
      const label = `${size.name} ${size.width}x${size.height}`
      if (shots) await page.screenshot({ path: path.join(shots, `site-${size.name}-orders.png`) })
      assert.ok(top.docWidth <= top.viewWidth && top.mainScroll === 0, `${label}: сторінка їде вбік`)
      if (size.width >= 1024) {
        // На ПК усі вкладки видно одразу — жодного повзунка, і розділ не затиснутий у вузьку колонку.
        assert.equal(top.tabsScroll, 0, `${label}: вкладки не вміщаються й прокручуються на ${top.tabsScroll}px`)
        assert.ok(top.bodyWidth >= Math.min(top.mainWidth - 80, 1200), `${label}: розділ вузький (${top.bodyWidth} з ${top.mainWidth})`)
      }
      // Кожна вкладка каже, для чого вона; порожня — що на ній зробити.
      // 26.11.2026: чотири розділи (Товари, Замовлення, Вітрина, Налаштування); вкладка видна лише у своєму розділі.
      assert.deepEqual(await page.locator('[data-site-section]').allInnerTexts(), ['Товари', 'Замовлення1', 'Вітрина', 'Налаштування'], `${label}: розділи`)
      assert.deepEqual(await page.locator('[data-site-tab]').evaluateAll(nodes => nodes.map(node => node.dataset.siteTab)), ['orders', 'customers', 'reviews'], `${label}: вкладки розділу «Замовлення»`)
      // Назви розділів не обрізаються.
      assert.ok(await page.locator('[data-site-section]').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), `${label}: назва розділу обрізана`)
      // 26.11.2026, слово власника: «чотири колонки на всю ширину — некрасиво, багато порожнього місця»: розділи — за шириною слів.
      const bar = await page.locator('[data-site-sections]').boundingBox()
      if (size.width >= 1024) assert.ok(bar && bar.width < 520, `${label}: розділи розтягнуті на ${Math.round(bar?.width ?? 0)}px`)
      assert.ok(bar && bar.height < 48, `${label}: розділи у кілька рядків (${Math.round(bar?.height ?? 0)}px)`)

      // «Товари → категорії → товари в категорії; або “усі товари” — усе підряд».
      await page.locator('[data-site-section="goods"]').click()
      await page.locator('[data-site-tab="all"]').click()
      if (size.name === 'phone') await page.locator('[data-site-category-toggle]').click()
      // «Усі» і «Без відбору» — в одному ряду (власник: «навіщо одне під одним, коли праворуч купа місця»).
      const filterTops = await page.locator('[data-site-filters] select').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)))
      assert.equal(new Set(filterTops).size, 1, `${label}: фільтри одне під одним`)
      const list = page.locator('[data-site-category-list]').locator('visible=true')
      await list.locator('[data-site-category=""]').waitFor()
      // Усього 5+20+3+10+2+7 = 47; «Оливи» разом із вкладеними 38; порожніх «Фільтрів» не видно.
      assert.match(await list.locator('[data-site-category=""]').innerText(), /Усі товари\s*47/, `${label}: «Усі товари» без кількості`)
      assert.match(await list.locator('[data-site-category="c1"]').innerText(), /Оливи\s*38/, `${label}: категорія без вкладених`)
      assert.equal(await list.locator('[data-site-category="c3"]').count(), 0, `${label}: порожня категорія видна`)
      await list.locator('[data-site-category="c1"]').click()
      await page.waitForFunction(() => window.__catalogCalls.some(call => call.includes('category=c1')))
      assert.match(await page.locator('[data-site-breadcrumb]').innerText(), /Усі товари\s*›\s*Оливи/, `${label}: не видно, в якій категорії`)
      await page.locator('[data-site-breadcrumb] button', { hasText: 'Усі товари' }).click()
      await page.waitForFunction(() => /category=(&|$)/.test(window.__catalogCalls.at(-1)))
      if (shots) await page.screenshot({ path: path.join(shots, `site-${size.name}-goods.png`) })

      const SECTION = { customers: 'sales', reviews: 'sales', photos: 'goods', categories: 'showcase', promos: 'goods', home: 'showcase', banners: 'showcase', pages: 'showcase', settings: 'setup', catalog: 'setup', access: 'setup' }
      assert.equal(await page.locator('[data-site-tab="products"]').count(), 0, `${label}: окремої вкладки «Товари на сайті» немає`)
      for (const tab of ['customers', 'photos', 'categories', 'banners', 'promos', 'home', 'pages', 'reviews', 'settings', 'catalog', 'access']) {
        await page.locator(`[data-site-section="${SECTION[tab]}"]`).click()
        await page.locator(`[data-site-tab="${tab}"]`).click()
        const intro = page.locator('[data-site-intro]')
        await intro.waitFor()
        assert.ok((await intro.innerText()).trim().length > 30, `${label}: вкладка ${tab} без пояснення`)
        if (['banners', 'promos', 'reviews'].includes(tab)) {
          await page.locator('[data-site-empty]').waitFor()
          assert.ok((await page.locator('[data-site-empty]').innerText()).trim().length > 25, `${label}: порожня вкладка ${tab} нічого не пояснює`)
        }
        if (tab === 'pages') assert.ok((await page.locator('[data-site-list="pages"]').innerText()).includes('Доставка'), `${label}: інфо-сторінка без назви`)
        if (shots && size.name !== 'pc-wide') await page.screenshot({ path: path.join(shots, `site-${size.name}-${tab}.png`) })
      }
      assert.deepEqual(errors, [], label)
      results.push(label)
      await context.close()
    }
  } finally { await browser.close() }
  console.log(JSON.stringify({ passed: true, checked: results.length, cases: results }))
} finally { await server.close() }
