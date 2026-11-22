// Real web order form (phone), isolated fake API. No live documents, accounts or network.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const { chromium } = await import('playwright')
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const mocks = {
  '@/lib/api': 'export const api={get:(url)=>window.fixture.get(url),post:(url,body)=>window.fixture.post(url,body)}',
  '@/stores/authStore': "export const useAuthStore=fn=>fn({session:{user:{id:'u1',user_metadata:{full_name:'Олена'},app_metadata:{role:'manager'}}}})",
  '@/lib/utils': "export const formatMoney=n=>(n/100).toFixed(2)+' грн'",
  '@/components/Layout': "export const Layout=({children,title})=><main><h1>{title}</h1>{children}</main>",
  '@/components/ui/Toast': 'export const toast={success:m=>window.fixture.toasts.push(m),error:m=>window.fixture.toasts.push(m),warning:m=>window.fixture.toasts.push(m)};export const ToastContainer=()=>null',
  '@/features/tillCommands/TillEditModal': 'import {useState,useEffect} from "react";export const useTillOnline=()=>{const [s,set]=useState({online:window.fixture.online,seen_at:null});useEffect(()=>{window.fixture.setOnline=v=>set({online:v,seen_at:null})},[]);return s}',
  '@/lib/processingUploads': "export const dataUrlToBlob=()=>new Blob(['x'],{type:'image/png'});export const uploadProcessingBlob=async()=>({path:'ai/u1/cart-'+(++window.fixture.uploads)+'.png',mimeType:'image/png'});export const removeProcessingUploads=async paths=>{window.fixture.removed.push(...paths)}",
  '@/lib/prepareImage': "export const prepareImageDataUrl=async()=>'data:image/png;base64,eA=='",
  'react-router-dom': 'export const useNavigate=()=>to=>window.fixture.navigated.push(to)',
}
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import WebOrderFormPage, {WaitingOrdersNote} from '/src/features/orders/WebOrderFormPage.tsx';
import '/src/index.css';
const f=window.fixture={online:true,posts:[],toasts:[],navigated:[],state:{status:'done',result:{order_number:57,total_amount:250000},error:null},
  found:[{id:'11111111-2222-4333-8444-555555555555',name:'Фільтр масляний W712',sku:'W712',retail_price:30000,qty_on_hand:4}]};
f.uploads=0;f.removed=[];f.cart={actions:[{payload:{products:[{name:'Амортизатор передній',sku:'333114',brand_name:'KYB',qty:2,purchase_price_uah:1450.5},{name:'Пильовик',article:'PK-12'},{sku:'БЕЗ-НАЗВИ'}]}}]};
f.post=(url,body)=>{f.posts.push({url,body:structuredClone(body)});if(url==='/api/v1/ai/supply-invoice-photo')return Promise.resolve({data:f.cart});return Promise.resolve({data:{operation_id:body.operation_id,status:'pending',till_online:f.online}})};
f.waiting=[{operation_id:'77777777-2222-4333-8444-555555555555',created_at:'2026-11-22T05:00:00Z',customer:'Марія',items:2,state:'waiting',error:null},{operation_id:'88888888-2222-4333-8444-555555555555',created_at:'2026-11-22T04:00:00Z',customer:'Олег',items:1,state:'failed',error:'Позиція 1: ціна нижча за закупівельну'}];
f.get=url=>url.includes('/products/search')?Promise.resolve({data:f.found}):url.endsWith('/waiting')?Promise.resolve({data:f.waiting}):Promise.resolve({data:f.state});
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(WaitingOrdersNote),React.createElement(WebOrderFormPage)));
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false,
  root: path.join(root, 'apps/web'), logLevel: 'error', esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), { name: 'isolated-web-order', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:audit' || Object.hasOwn(mocks, id)) return '\0'+id },
    load(id) {
      if (id === '\0virtual:audit') return entry
      if (id.startsWith('\0')) return mocks[id.slice(1)]
      for (const [name, source] of Object.entries(mocks)) {
        if (name.startsWith('@/') && id.replaceAll('\\','/').replace(/\.tsx?$/, '').endsWith('/src/'+name.slice(2))) return source
      }
    },
    configureServer(server) {
      server.middlewares.use('/audit', async (_req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end(await server.transformIndexHtml('/audit', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:audit"></script></body></html>'))
      })
    },
  }],
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(server.resolvedUrls.local[0]+'audit')
  const send = page.getByRole('button', { name: 'Надіслати на касу', exact: true })
  await send.waitFor({ timeout: 15000 }).catch(async error => { console.error('PAGE ERRORS', errors, (await page.content()).slice(0, 600)); throw error })

  // 1. Порожній бланк не відправляється і каже чому.
  await send.click()
  await page.getByRole('alert').filter({ hasText: 'Додайте хоча б одну позицію' }).waitFor()
  assert.equal(await page.evaluate(() => fixture.posts.length), 0)
  console.log('PASS: empty form is refused with a reason, nothing is sent')

  // 2. Ціна нижча за закупку не проходить.
  await page.getByLabel('Ім’я клієнта').fill('Іван')
  await page.getByLabel('Телефон клієнта').fill('067 123 45 67')
  await page.getByLabel('Назва, позиція 1').fill('Колодки передні')
  await page.getByLabel('Артикул, позиція 1').fill('GDB1330')
  await page.getByLabel('Ціна продажу, грн, позиція 1').fill('800')
  await page.getByLabel('Закупка, грн, позиція 1').fill('900')
  await send.click()
  await page.getByRole('alert').filter({ hasText: 'нижча за закупку' }).waitFor()
  assert.equal(await page.evaluate(() => fixture.posts.length), 0)
  console.log('PASS: selling below the purchase price is refused in the browser')

  // 3. Друга позиція — зі складу: закупка ховається, на касу йде лише картка.
  await page.getByLabel('Ціна продажу, грн, позиція 1').fill('1250')
  await page.getByRole('button', { name: 'Додати позицію' }).click()
  await page.getByLabel('Назва, позиція 2').fill('w712')
  await page.getByRole('button', { name: 'Знайти на складі' }).last().click()
  await page.getByRole('button', { name: /Фільтр масляний W712/ }).click()
  await page.getByText('Товар зі складу', { exact: false }).waitFor()
  assert.equal(await page.getByLabel('Закупка, грн, позиція 2').count(), 0)
  assert.equal(await page.getByLabel('Ціна продажу, грн, позиція 2').inputValue(), '300.00')
  await page.getByText('Разом:').filter({ hasText: '1550.00 грн' }).waitFor()
  console.log('PASS: a stock item is picked from the catalogue; total is 1550.00')

  // 4. Відправка: одна команда order.save, без грошей; відповідь каси — номер замовлення.
  await send.click()
  await page.getByText('Замовлення № 57 створено на касі', { exact: true }).waitFor({ timeout: 10000 })
  const posts = await page.evaluate(() => fixture.posts)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, '/api/v1/till-commands')
  assert.equal(posts[0].body.command, 'order.save')
  assert.match(posts[0].body.operation_id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(posts[0].body.payload, { customer_phone: '0671234567', customer_name: 'Іван', car_make: null, car_model: null, car_year: null,
    vin: null, comment: null, author: 'Олена', items: [
      { name: 'Колодки передні', sku: 'GDB1330', qty: 1, sell_price: 125000, buy_price: 90000 },
      { name: 'Фільтр масляний W712', sku: 'W712', qty: 1, sell_price: 30000, buy_price: 0, product_id: '11111111-2222-4333-8444-555555555555' },
    ] })
  console.log('PASS: exactly one order.save command with no money fields; the till answer shows the order number')

  // 5. Каса не в мережі: бланк чекає на сервері, людині це сказано прямо.
  await page.getByRole('button', { name: 'Ще одне', exact: true }).click()
  await page.evaluate(() => { fixture.online = false; fixture.setOnline(false) })
  const later = page.getByRole('button', { name: 'Надіслати — каса забере пізніше', exact: true })
  await later.waitFor()
  await page.getByLabel('Ім’я клієнта').fill('Петро')
  await page.getByLabel('Назва, позиція 1').fill('Свічка')
  await later.click()
  await page.getByText('Замовлення чекає касу', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => fixture.posts.length), 2)
  console.log('PASS: with the till offline the order is queued and the screen says so')

  // 6. Черга: відмову каси видно з причиною; бланк, який ще чекає, можна скасувати однією командою.
  await page.getByRole('alert').filter({ hasText: 'Олег' }).filter({ hasText: 'ціна нижча за закупівельну' }).waitFor()
  await page.evaluate(() => { fixture.waiting = fixture.waiting.slice(1) })
  await page.getByRole('button', { name: 'Скасувати бланк: Марія', exact: true }).click()
  await page.getByRole('button', { name: 'Скасувати бланк: Марія', exact: true }).waitFor({ state: 'detached' })
  const cancel = (await page.evaluate(() => fixture.posts)).at(-1)
  assert.equal(cancel.body.command, 'order.cancel')
  assert.deepEqual(cancel.body.payload, { operation_id: '77777777-2222-4333-8444-555555555555' })
  console.log('PASS: a refusal is shown with its reason; a waiting order is cancelled by one order.cancel')

  // 7. Скриншот кошика: рядки лягають у бланк, ціну продажу не вигадано, фото прибрано з тимчасового сховища.
  await page.getByRole('button', { name: 'Ще одне', exact: true }).click()
  await page.getByLabel('Скриншот кошика постачальника').setInputFiles({ name: 'cart.png', mimeType: 'image/png', buffer: Buffer.from('fake-cart') })
  await page.getByText('Додано позицій: 2. Без назви пропущено: 1.', { exact: false }).waitFor()
  assert.equal(await page.getByLabel('Назва, позиція 1').inputValue(), 'Амортизатор передній KYB')
  assert.equal(await page.getByLabel('Артикул, позиція 1').inputValue(), '333114')
  assert.equal(await page.getByLabel('Кількість, позиція 1').inputValue(), '2')
  assert.equal(await page.getByLabel('Закупка, грн, позиція 1').inputValue(), '1450.5')
  assert.equal(await page.getByLabel('Ціна продажу, грн, позиція 1').inputValue(), '')
  assert.equal(await page.getByLabel('Назва, позиція 2').inputValue(), 'Пильовик')
  assert.equal(await page.getByLabel('Закупка, грн, позиція 2').inputValue(), '')
  assert.equal(await page.getByLabel('Назва, позиція 3').count(), 0)
  assert.deepEqual(await page.evaluate(() => fixture.removed), ['ai/u1/cart-1.png'])
  console.log('PASS: a supplier cart screenshot fills the order rows; the selling price is left for a person')

  const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(layout.scroll <= layout.width, 'web order form must not scroll sideways on a phone')
  assert.deepEqual(errors, [])
  console.log('PASS: fits a 390px phone, no page errors')
} finally { await browser?.close(); await server.close() }
