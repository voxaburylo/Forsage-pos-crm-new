// Real product editor/reference selectors with synthetic in-memory APIs only.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { default: tailwind } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const mocks = {
  '@/features/products/productApi': 'export const productApi=fixture.api',
  '@/features/admin/adminApi': 'export const adminApi=fixture.admin',
  '@/features/admin/pricingApi': 'export const pricingApi={}',
  '@/features/products/ProductPhotoUpload': 'export function ProductPhotoUpload(){return null}',
  '@/stores/authStore': 'export const useAuthStore=select=>select({session:{user:{id:"fixture-owner",app_metadata:{role:"owner"}}}})',
  '@/components/ui/Toast': 'export const toast={success:m=>fixture.success.push(m),error:m=>fixture.errors.push(m),warning:m=>fixture.errors.push(m)};export function ToastContainer(){return null}',
  '@/components/Layout': 'export function Layout({children}){return <main>{children}</main>}',
}
const bootstrap = `window.fixture={writes:[],success:[],errors:[],creates:[]};
fixture.product={id:'a',name:'Фільтр тестовий',sku:'A1',barcode:'1234567890123',unit:'шт',retail_price:12000,purchase_price:6000,qty_on_hand:3,reorder_point:0,is_active:true,brand_id:'mann',category_id:'filters'};
fixture.admin={listCategories:async()=>({data:[{id:'filters',name:'Фільтри'},{id:'oil',name:'Оливи'}]}),listBrands:async()=>({data:[{id:'mann',name:'Mann'},{id:'bosch',name:'Bosch'}]}),getSettings:async()=>({data:{}}),createCategory:async name=>{fixture.creates.push(name);return {data:{id:'created',name}}}};
fixture.api={get:async()=>({data:structuredClone(fixture.product)}),update:async(id,patch)=>{fixture.writes.push({id,patch});return {data:{...fixture.product,...patch}}}};`
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route} from 'react-router-dom';import {ProductEditor} from '/src/features/products/ProductFormPage.tsx';import '/src/index.css';
createRoot(document.getElementById('root')).render(<div className="flex h-screen overflow-hidden"><aside className="w-60 shrink-0"/><main id="test-scroll" className="min-w-0 flex-1 overflow-auto p-6"><MemoryRouter initialEntries={['/products/a']}><Routes><Route path='/products/:id' element={<ProductEditor embedded/>}/></Routes></MemoryRouter></main></div>);`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error', esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }, plugins: [tailwind(), {
  name: 'product-reference-fixture', enforce: 'pre',
  resolveId(id) { if (id === 'virtual:reference.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
  async load(id) {
    if (id === '\0virtual:reference.tsx') return transformWithEsbuild(entry, 'reference.tsx', { loader: 'tsx', jsx: 'automatic' })
    let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
    for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
    if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
  },
  configureServer(server) { server.middlewares.use('/reference-test', async (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(await server.transformIndexHtml('/reference-test', '<html><head><meta charset="utf-8"><style>.relative{position:relative}[role=listbox]{position:absolute;z-index:20;background:white}</style></head><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:reference.tsx"></script></body></html>'))
  }) },
}] })
let browser
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const page = await browser.newPage(), errors = [], blocked = [], dialogs = []
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.accept() })
  const base = server.resolvedUrls.local[0]
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(base).origin) return route.continue()
    blocked.push(route.request().url()); return route.abort()
  })
  await page.goto(base + 'reference-test')
  const brand = page.getByRole('combobox', { name: 'Бренд', exact: true })
  const category = page.getByRole('combobox', { name: 'Категорія', exact: true })
  const save = page.getByRole('button', { name: 'Зберегти зміни', exact: true })
  await page.waitForFunction(() => document.querySelector('input[role=combobox]')?.value === 'Фільтри')
  assert.equal(await brand.inputValue(), 'Mann')
  for (const zoom of [1, 1.25, 1.5]) {
    await page.setViewportSize({ width: Math.floor(1366 / zoom), height: Math.floor(768 / zoom) })
    for (const fraction of [0, 0.5, 1]) {
      await page.evaluate(f => { const pane = document.getElementById('test-scroll'); pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * f }, fraction)
      const box = await save.boundingBox()
      assert.ok(box && box.y >= 0 && box.y + box.height <= 768 / zoom, `Existing product action stays visible at ${zoom * 100}% and scroll ${fraction}`)
      assert.equal(await save.evaluate(button => { const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }), true)
    }
  }
  await page.setViewportSize({ width: 1366, height: 900 })
  console.log('PASS: existing product footer stays reachable at 1366×768 and 125/150% with a long scrolled editor')

  await brand.fill('Bos'); await brand.press('Tab'); await save.click()
  assert.equal(await page.evaluate(() => fixture.writes.length), 0)
  assert.match((await page.evaluate(() => fixture.errors)).at(-1), /Бренд/)
  assert.equal(await brand.inputValue(), 'Bos')
  await brand.focus(); await brand.press('Escape')
  assert.equal(await brand.inputValue(), 'Mann')
  console.log('PASS: unresolved reference text does not erase an ID or save a misleading label; Escape restores selection')

  await brand.fill('  bosch  '); await brand.press('Tab')
  assert.equal(await brand.inputValue(), 'Bosch')
  await save.click(); await page.waitForFunction(() => fixture.writes.length === 1)
  assert.equal(await page.evaluate(() => fixture.writes[0].patch.brand_id), 'bosch')
  assert.equal(await page.evaluate(() => fixture.writes[0].patch.category_id), 'filters')

  await brand.fill('Ma'); await brand.press('ArrowDown'); await brand.press('Enter')
  assert.equal(await brand.inputValue(), 'Mann')
  assert.equal(await page.evaluate(() => fixture.writes.length), 1)
  await save.click(); await page.waitForFunction(() => fixture.writes.length === 2)
  assert.equal(await page.evaluate(() => fixture.writes[1].patch.brand_id), 'mann')
  console.log('PASS: exact Tab and explicit Arrow/Enter select existing references without unintended form submission')

  await category.fill(''); await category.press('Enter'); await save.click()
  assert.equal(await page.evaluate(() => fixture.writes.length), 2)
  await category.focus(); await category.press('Escape')
  assert.equal(await category.inputValue(), 'Фільтри')
  await category.click(); await page.getByRole('option', { name: 'Без категорії', exact: true }).click()
  await save.click(); await page.waitForFunction(() => fixture.writes.length === 3)
  assert.equal(await page.evaluate(() => fixture.writes[2].patch.category_id), '')
  assert.equal(await page.evaluate(() => fixture.writes[2].patch.brand_id), 'mann')
  console.log('PASS: clearing search is not deletion; explicit empty choice clears only the intended reference')

  await category.fill('Нова категорія'); await page.getByRole('option', { name: '+ Створити "Нова категорія"', exact: true }).click()
  await page.waitForFunction(() => fixture.creates.length === 1 && document.querySelector('input[role=combobox]')?.value === 'Нова категорія')
  await save.click(); await page.waitForFunction(() => fixture.writes.length === 4)
  assert.equal(await page.evaluate(() => fixture.writes[3].patch.category_id), 'created')
  await category.fill('Незавершений пошук')
  await page.getByRole('button', { name: 'Скасувати', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('input[role=combobox]')?.value === 'Нова категорія')
  assert.deepEqual(dialogs, ['Скасувати незбережені зміни?'])
  assert.equal(await category.inputValue(), 'Нова категорія')
  assert.equal(await brand.inputValue(), 'Mann')
  assert.equal(await page.evaluate(() => fixture.writes.length), 4)
  console.log('PASS: existing create-reference action remains usable; cancelling pending input restores the saved baseline')
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
} finally { await browser?.close(); await server.close() }
