// 26.11.2026, слово власника: «у вкладці “Сайт” — усі товари, наші й від постачальників, у купі; міні-фото; усі основні
// дані в один рядок; решта — у картці; масова робота з цінами; видаляти теж можна».
// Справжня вкладка «Усі товари» зі штучними даними на телефоні й ПК. Перевіряє: рядок товару — один рядок (висота не
// розпливається), видно міні-фото/заглушку, назву, ціну й кількість; вибір дає масові дії для наших і для постачальників;
// картка товару постачальника відкривається зі складами. Жодних живих даних і мережі.
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
const shot = process.argv.find(arg => arg.startsWith('--screenshot='))?.slice('--screenshot='.length)

const KEY = '0b6f4c1e-1111-4222-8333-944455556666:'
const rows = [
  ...Array.from({ length: 6 }, (_, i) => ({ kind: 'ours', id: 'p' + i, sku: 'W712/7' + i, name: i === 0 ? 'Фільтр масляний MANN W712/75 для VW Golf IV, Passat B5, Audi A4, Skoda Octavia дуже довга назва' : 'Свічка запалювання NGK BKR6E-' + i,
    brand: i === 0 ? 'MANN' : 'NGK', barcode: i % 2 ? '482000012345' + i : null, price: 35000 + i * 100, purchase: 20000, qty: i, photo: null, category: 'Фільтри', supplier: null, hidden: false, linked: false, custom: false })),
  ...Array.from({ length: 6 }, (_, i) => ({ kind: 'supplier', id: KEY + 'EXT' + i, sku: 'OC 9' + i, name: 'Фільтр масляний KNECHT OC 9' + i, brand: 'KNECHT', barcode: null,
    price: 41000, purchase: 30000, qty: 12, photo: null, category: 'Фільтри', supplier: 'Омега', hidden: i === 5, linked: i === 0, custom: i === 1 })),
]
const offer = { key: KEY + 'EXT0', supplier: 'Омега', number: 'OC 90', brand: 'KNECHT', name: 'Фільтр масляний KNECHT OC 90', custom_name: null, barcode: '4009026000001', custom_barcode: null,
  retail_price: 41000, custom_price: null, purchase_price: 30000, hidden: false, image_url: null, description: 'Висота 79 мм', category_name: 'Фільтри', total_qty: 12,
  stock: [{ warehouse: 'Київ 1', qty: 8, days_to_ship: 1, active: true }, { warehouse: 'Львів 1', qty: 4, days_to_ship: 2, active: true }], product_id: 'p0' }
const modules = {
  '@/stores/authStore': `import{create}from'zustand';export const useAuthStore=create(()=>({loading:false,offlineMode:false,session:{user:{id:'u',app_metadata:{role:'owner',tenant_id:'t'}}}}));`,
  '@/lib/api': `const page=${JSON.stringify({ rows, total: 12, ours_total: 6, page: 1, pages: 1 })};const offer=${JSON.stringify(offer)};
    window.calls=[];export const api={get:async(url)=>{window.calls.push(['GET',url]);return{data:url.includes('/offers/')?offer:page}},post:async(url,body)=>{window.calls.push(['POST',url,body]);return{data:{changed:1,below_purchase:0}}},patch:async(url,body)=>{window.calls.push(['PATCH',url,body]);return{data:offer}},put:async()=>({data:{}})};`,
  '@/features/products/productApi': `export const productApi={generateBarcode:async()=>({}),delete:async()=>undefined}`,
  '@/features/products/BulkEditModal': `export function BulkEditModal(){return <div data-bulk-modal/>}`,
  '@/components/ui/Toast': `export const toast={error(){},success(){},warning(){}};export function ToastContainer(){return null}`,
}
const entry = `
import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import'/src/index.css';
import{SiteAllProductsTab}from'/src/features/site/SiteAllProductsTab.tsx';
createRoot(document.getElementById('root')).render(<MemoryRouter><div className="p-3"><SiteAllProductsTab/></div></MemoryRouter>);
`
const server = await createServer({
  cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } },
  server: { host: '127.0.0.1', port: 0 }, plugins: [tailwindcss(), {
    name: 'site-all-products-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:site-all.tsx' || id in modules) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:site-all.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      const normalized = id.replaceAll('\\', '/')
      for (const [key, source] of Object.entries(modules)) {
        if (id === '\0' + key || normalized.endsWith('/src/' + key.slice(2) + '.ts') || normalized.endsWith('/src/' + key.slice(2) + '.tsx'))
          return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' }).then(result => result.code)
      }
    },
    configureServer(vite) { vite.middlewares.use('/site-all-test', async (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(await vite.transformIndexHtml('/site-all-test', '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:site-all.tsx"></script></body></html>'))
    }) },
  }],
})
const results = []
try {
  await server.listen()
  const base = server.resolvedUrls.local[0]
  const browser = await chromium.launch({ headless: true })
  try {
    for (const size of [{ name: 'iphone', width: 390, height: 844 }, { name: 'pc', width: 1366, height: 768 }]) {
      const label = size.name
      const page = await browser.newPage({ viewport: { width: size.width, height: size.height } })
      const errors = []; page.on('pageerror', error => errors.push(String(error)))
      await page.goto(base + 'site-all-test')
      await page.locator('[data-catalog-row]').first().waitFor({ timeout: 20_000 }).catch(error => { throw new Error(label + ': ' + errors.join(' | '), { cause: error }) })
      assert.equal(await page.locator('[data-catalog-row="ours"]').count(), 6, label)
      assert.equal(await page.locator('[data-catalog-row="supplier"]').count(), 6, label)
      // Один рядок на товар: навіть дуже довга назва обрізається, рядок не росте.
      const heights = await page.locator('[data-catalog-row]').evaluateAll(items => items.map(item => item.getBoundingClientRect().height))
      assert.ok(Math.max(...heights) <= (size.name === "iphone" ? 72 : 56), `${label}: рядок товару не вміщається в один рядок ${JSON.stringify(heights)}`)
      const width = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
      assert.ok(width, `${label}: сторінка їде вбік`)
      // Масові дії: наші й постачальників — свої кнопки.
      await page.locator('[data-catalog-row="ours"] input[type=checkbox]').first().check()
      await page.locator('[data-catalog-row="supplier"] input[type=checkbox]').first().check()
      const bulk = await page.locator('[data-site-bulk]').innerText()
      for (const text of ['Ціни, категорія', 'Штрихкоди, де немає', 'Видалити', 'Ціна ±%', 'Прибрати']) assert.ok(bulk.includes(text), `${label}: немає «${text}»`)
      await page.locator('[data-site-bulk] button', { hasText: 'Прибрати' }).click()
      await page.waitForFunction(() => window.calls.some(call => call[0] === 'POST' && call[1].endsWith('/offers/bulk')))
      const sent = await page.evaluate(() => window.calls.find(call => call[0] === 'POST')[2])
      assert.deepEqual(sent, { keys: [KEY + 'EXT0'], hidden: true }, label)
      // Картка товару постачальника: склади й поля «наша назва», штрихкод, ціна.
      await page.locator('[data-catalog-row="supplier"] button').first().click()
      await page.locator('[data-offer-card]').waitFor()
      const card = await page.locator('[data-offer-card]').innerText()
      assert.ok(card.includes('Київ 1') && card.includes('Львів 1'), label + ': склади в картці')
      if (shot && size.name === 'iphone') await page.screenshot({ path: shot + '-card.png' })
      await page.keyboard.press('Escape')
      if (shot && size.name === 'iphone') { await page.locator('[data-offer-card]').waitFor({ state: 'detached' }).catch(() => undefined); await page.screenshot({ path: shot + '-list.png', fullPage: true }) }
      results.push(`${label}: OK (висота рядка ≤ ${Math.max(...heights)} px)`)
      await page.close()
    }
  } finally { await browser.close() }
  console.log(results.join('\n'))
  console.log('PASS site all products: one row per item, bulk actions for ours and supplier goods, supplier card with warehouses')
} finally { await server.close() }
