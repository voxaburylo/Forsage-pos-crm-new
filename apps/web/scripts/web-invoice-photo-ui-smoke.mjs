// Real phone invoice screen (web), isolated fake API. No live documents, accounts, AI or network.
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
  '@/lib/processingUploads': "export const dataUrlToBlob=()=>new Blob(['x'],{type:'image/jpeg'});export const uploadProcessingBlob=async()=>({path:'ai/u1/photo-'+(++window.fixture.uploads)+'.jpg',mimeType:'image/jpeg'});export const removeProcessingUploads=async paths=>{window.fixture.removed.push(...paths)}",
  '@/lib/prepareImage': "export const prepareImageDataUrl=async()=>'data:image/jpeg;base64,eA=='",
  'react-router-dom': 'export const useNavigate=()=>to=>window.fixture.navigated.push(to)',
}
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import WebInvoicePhotoPage from '/src/features/suppliers/WebInvoicePhotoPage.tsx';
import '/src/index.css';
const f=window.fixture={online:true,posts:[],toasts:[],navigated:[],uploads:0,removed:[],waiting:[],aiError:'',state:{status:'done',result:{rows:2},error:null},
  recognized:{actions:[{payload:{supplier_name:'Vitol',invoice_number:'36214',products:[
    {name:'Фільтр масляний',sku:'W712/75',brand_name:'MANN',qty:2,purchase_price_uah:120.5,unit:'шт'},
    {name:'Свічка запалювання',sku:'BKR6E',qty:4},
    {sku:'БЕЗ-НАЗВИ',qty:1}]}}]}};
f.post=(url,body)=>{f.posts.push({url,body:structuredClone(body)});
  if(url==='/api/v1/ai/supply-invoice-photo')return f.aiError?Promise.reject(new Error(f.aiError)):Promise.resolve({data:f.recognized});
  return Promise.resolve({data:{operation_id:body.operation_id,status:'pending',till_online:f.online}})};
f.get=url=>url.includes('/waiting')?Promise.resolve({data:f.waiting}):Promise.resolve({data:f.state});
createRoot(document.getElementById('root')).render(React.createElement(WebInvoicePhotoPage));
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false,
  root: path.join(root, 'apps/web'), logLevel: 'error', esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), { name: 'isolated-web-invoice', enforce: 'pre',
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
  const photo = { name: 'invoice.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-photo') }
  const tillPosts = async () => (await page.evaluate(() => fixture.posts)).filter(post => post.url === '/api/v1/till-commands')
  const send = page.getByRole('button', { name: 'Надіслати на касу', exact: true })
  await send.waitFor({ timeout: 15000 }).catch(async error => { console.error('PAGE ERRORS', errors, (await page.content()).slice(0, 600)); throw error })

  // 1. Без рядків відправляти нічого: кнопка вимкнена.
  assert.equal(await send.isDisabled(), true)
  console.log('PASS: nothing can be sent while the invoice has no rows')

  // 2. Помічник недоступний: причину видно, фото з тимчасового сховища прибрано, рядків не з'явилось.
  await page.evaluate(() => { fixture.aiError = 'Помічник АІ вимкнено в Налаштуваннях.' })
  await page.getByLabel('Фото накладної').setInputFiles(photo)
  await page.getByRole('alert').filter({ hasText: 'Помічник АІ вимкнено' }).waitFor()
  assert.deepEqual(await page.evaluate(() => fixture.removed), ['ai/u1/photo-1.jpg'])
  assert.equal(await page.getByLabel('Назва, рядок 1').count(), 0)
  console.log('PASS: a recognition failure is shown with its reason; the uploaded photo is removed')

  // 3. Фото розпізнано: рядки у формі, нечитана ціна лишається порожньою, рядок без назви пораховано.
  await page.evaluate(() => { fixture.aiError = '' })
  await page.getByLabel('Фото накладної').setInputFiles(photo)
  await page.getByText('Розпізнано рядків: 2. Без назви пропущено: 1', { exact: false }).waitFor()
  const ai = (await page.evaluate(() => fixture.posts)).at(-1)
  assert.equal(ai.url, '/api/v1/ai/supply-invoice-photo')
  assert.deepEqual(ai.body, { images: [{ mime_type: 'image/jpeg', storage_path: 'ai/u1/photo-2.jpg' }] })
  assert.equal(await page.getByLabel('Постачальник').inputValue(), 'Vitol')
  assert.equal(await page.getByLabel('Номер накладної').inputValue(), '36214')
  assert.equal(await page.getByLabel('Назва, рядок 1').inputValue(), 'Фільтр масляний')
  assert.equal(await page.getByLabel('Закупка, грн, рядок 1').inputValue(), '120.5')
  assert.equal(await page.getByLabel('Закупка, грн, рядок 2').inputValue(), '')
  await page.getByText('Без кількості або ціни: 1', { exact: false }).waitFor()
  console.log('PASS: recognised rows fill the form; an unreadable price stays empty and is flagged')

  // 4. Помилка в числі не відправляється і називає рядок.
  await page.getByLabel('Кількість, рядок 2').fill('чотири')
  await send.click()
  await page.getByRole('alert').filter({ hasText: 'Рядок 2: перевірте поле «Кількість»' }).waitFor()
  assert.equal((await tillPosts()).length, 0)
  console.log('PASS: a broken number is refused in the browser and names the row')

  // 5. Відправка: одна команда invoice.draft, без грошей і без проведення.
  await page.getByLabel('Кількість, рядок 2').fill('4')
  await page.getByLabel('Закупка, грн, рядок 2').fill('95,40')
  await page.getByText('разом за закупкою:', { exact: false }).filter({ hasText: '622.60 грн' }).waitFor()
  await send.click()
  await page.getByText('Накладна на касі', { exact: true }).waitFor({ timeout: 10000 })
  const commands = await tillPosts()
  assert.equal(commands.length, 1)
  assert.equal(commands[0].body.command, 'invoice.draft')
  assert.match(commands[0].body.operation_id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(commands[0].body.payload, { supplier_name: 'Vitol', invoice_number: '36214', notes: null, author: 'Олена', rows: [
    { name: 'Фільтр масляний', brand_name: 'MANN', unit: 'шт', sku: 'W712/75', qty: 2, purchase_price_uah: 120.5 },
    { name: 'Свічка запалювання', sku: 'BKR6E', qty: 4, purchase_price_uah: 95.4 },
  ] })
  console.log('PASS: exactly one invoice.draft command with the checked rows and no money or posting fields')

  // 6. Каса не в мережі: накладна, вписана вручну, чекає на сервері.
  await page.getByRole('button', { name: 'Ще одна накладна', exact: true }).click()
  await page.evaluate(() => { fixture.online = false; fixture.setOnline(false) })
  const later = page.getByRole('button', { name: 'Надіслати — каса забере пізніше', exact: true })
  await later.waitFor()
  await page.getByRole('button', { name: 'Додати рядок вручну' }).click()
  await page.getByLabel('Назва, рядок 1').fill('Ремінь 6PK1200')
  await page.getByLabel('Кількість, рядок 1').fill('1')
  await page.getByLabel('Закупка, грн, рядок 1').fill('310')
  await later.click()
  await page.getByText('Накладна чекає касу', { exact: true }).waitFor()
  assert.equal((await tillPosts()).length, 2)
  console.log('PASS: with the till offline a hand-typed invoice is queued and the screen says so')

  const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(layout.scroll <= layout.width, 'phone invoice screen must not scroll sideways on a phone')
  assert.deepEqual(errors, [])
  console.log('PASS: fits a 390px phone, no page errors')
} finally { await browser?.close(); await server.close() }
