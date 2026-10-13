// Real order pages with synthetic services, isolated browser storage and no external traffic.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const mocks = {
  '@/features/orders/orderApi': 'export const orderApi=fixture.orders',
  '@/features/products/productApi': 'export const productApi={search:async()=>({data:[]})};export function requestDesktopSync(){throw Error("Unexpected sync")}',
  '@/features/customers/customerApi': 'export const customerApi=fixture.customers',
  '@/features/customers/customerVehiclesApi': 'export const customerVehiclesApi={list:async()=>{if(fixture.vehicleFail)throw Error("Garage unavailable");return{data:[]}}}',
  '@/features/suppliers/supplierApi': 'export const supplierApi={list:async()=>({data:[]})}',
  '@/features/admin/adminApi': 'export const adminApi={getSettings:async()=>({data:{quick_percents:[]}})}',
  '@/features/admin/pricingApi': 'export const pricingApi={}',
  '@/lib/api': 'export const api=fixture.api',
  '@/lib/vehicleOcr': 'export const recognizeVehicleImage=()=>{throw Error("Unexpected paid OCR")}',
  '@/stores/authStore': 'export const useAuthStore=Object.assign(select=>select(fixture.auth),{getState:()=>fixture.auth})',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.warnings.push(m),success:m=>fixture.messages.push(m)};export function ToastContainer(){return null}',
  '@/components/Layout': 'export function Layout({children,title}){return <main><h1>{title}</h1>{children}</main>}',
  '@/components/Sidebar': 'export function Sidebar(){return null}',
}
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{MemoryRouter,Routes,Route}from'react-router-dom';import Form from'/src/features/orders/OrderFormPage.tsx';import Orders from'/src/features/orders/OrdersPage.tsx';import'/src/index.css';createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={[fixture.start]}><Routes><Route path='/orders/new' element={<Form/>}/><Route path='/orders' element={<Orders/>}/><Route path='/chats' element={<Orders/>}/></Routes></MemoryRouter>);`
const bootstrap = `
window.forsageDesktop={};window.fixture={start:window.testStart,largeHistory:window.testLargeHistory??false,reads:[],pending:[],writes:[],errors:[],warnings:[],messages:[],historyFail:!window.testLargeHistory,defaultFail:window.testDefaultFail??false,auth:{offlineMode:false,session:{user:{id:'synthetic-staff',app_metadata:{role:'owner',tenant_id:'synthetic'}}}}};
fixture.customer=(id,name)=>({id,full_name:name,phone:'+380671234567',debt_balance:0});
fixture.customers={list:params=>{fixture.reads.push({kind:'customer',...params});if(!params.search){if(fixture.defaultFail)return Promise.reject(Error('Default list failed'));return Promise.resolve({data:[]})}return new Promise((resolve,reject)=>fixture.pending.push({query:params.search,resolve,reject}))},quickCreate:async(phone,name)=>{fixture.writes.push({phone,name});return{data:fixture.customer('created',name)}},get:async()=>({data:fixture.customer('existing','Існуючий клієнт')})};
fixture.order={id:'synthetic-order',order_number:123,status:'new',source:'walk_in',total_amount:10000,total_paid:0,prepayment:0,created_at:'2026-10-13T08:00:00Z',updated_at:'r1',customer:fixture.customer('existing','Існуючий клієнт'),items:Array.from({length:30},(_,index)=>({id:'item-'+index,name:'Фільтр '+index,sku:'SKU-'+index,qty:1,sell_price:1000,buy_price:500,item_status:index===29?'canceled':'pending',source_type:'supplier',is_draft_note:index===28}))};
fixture.historyRows=[...Array.from({length:230},(_,i)=>({...fixture.order,id:'unrelated-'+i,order_number:1000+i,customer_id:'other',chat_id:'other-chat',customer:fixture.customer('other','Other customer')})),...Array.from({length:14},(_,i)=>({...fixture.order,id:'chat-old-'+i,order_number:2000+i,customer_id:'existing',chat_id:'chat-a',items:[{...fixture.order.items[0],name:'Давнє замовлення чату '+i}]})),...Array.from({length:8},(_,i)=>({...fixture.order,id:'customer-old-'+i,order_number:3000+i,customer_id:'existing',chat_id:'another-chat',items:[{...fixture.order.items[0],name:'Давнє замовлення клієнта '+i}]}))];
fixture.orders={list:async(offset=0,opts={},limit=200,filters={})=>{fixture.reads.push({kind:'orders',offset,limit,...filters});if(fixture.start.startsWith('/chats')&&fixture.historyFail&&(filters.customer_id||filters.chat_id||limit===200))throw Error('History unavailable');let data=fixture.start.startsWith('/chats')?(fixture.largeHistory?fixture.historyRows:[]):[fixture.order];if(filters.customer_id)data=data.filter(o=>o.customer_id===filters.customer_id);if(filters.chat_id)data=data.filter(o=>o.chat_id===filters.chat_id);return{data:data.slice(offset,offset+limit),meta:{has_more:data.length>offset+limit,offset,per_page:limit}}}};
fixture.chat={id:'chat-a',channel_id:'channel',platform_chat_id:'test',first_name:'Історія тест',phone:null,unread_count:0,channel:{id:'channel',name:'Synthetic',platform:'telegram'},customer:fixture.customer('existing','Історія клієнта')};
fixture.api={get:async url=>{if(url==='/api/v1/chats')return{data:[fixture.chat]};if(url.endsWith('/messages'))return{data:[]};throw Error('Unexpected API read '+url)},post:()=>{throw Error('Unexpected API write')},patch:()=>{throw Error('Unexpected API write')}};
`
// Keep one prebundled React instance. Dependency rediscovery during navigation
// must not reload this synthetic fixture or reset its evidence counters.
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error', optimizeDeps: { entries: [], noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-router-dom', 'lucide-react', 'zustand', 'zustand/middleware', 'zustand/shallow'] }, esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'], alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [tailwindcss(), {
  name: 'order-usability-fixtures', enforce: 'pre',
  resolveId(id) { if (id === 'virtual:order-usability.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
  async load(id) {
    if (id === '\0virtual:order-usability.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
    let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
    for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
    if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
  },
  configureServer(vite) { vite.middlewares.use('/order-usability-test', async (_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml('/order-usability-test', '<html><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:order-usability.tsx"></script></body></html>')) }) },
}] })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0], errors = [], blocked = []
  async function setup(start = '/orders/new', defaultFail = false, width = 1440, largeHistory = false) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } })
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : (blocked.push(route.request().url()), route.abort()))
    await page.addInitScript(({ start, defaultFail, largeHistory }) => { window.testStart = start; window.testDefaultFail = defaultFail; window.testLargeHistory = largeHistory }, { start, defaultFail, largeHistory })
    await page.goto(base + 'order-usability-test', { timeout: 30000 })
    return page
  }
  const search = page => page.getByPlaceholder("Пошук: Ім'я, Телефон або VIN...")
  const waitQuery = (page, query, count = 1) => page.waitForFunction(({ query, count }) => fixture.pending.filter(row => row.query === query).length >= count, { query, count })

  const retry = await setup()
  await search(retry).fill('+380 (67) 123-45-67')
  await waitQuery(retry, '+380 (67) 123-45-67')
  await retry.evaluate(() => fixture.pending[0].reject(Error('Temporary outage')))
  await retry.getByRole('alert').filter({ hasText: 'Не вдалося перевірити клієнта' }).waitFor()
  assert.equal(await retry.getByText('Клієнтів не знайдено', { exact: true }).count(), 0)
  assert.equal(await retry.getByRole('button', { name: 'Створити нового клієнта', exact: true }).count(), 0)
  await retry.getByRole('button', { name: 'Повторити завантаження', exact: true }).click()
  await waitQuery(retry, '+380 (67) 123-45-67', 2)
  await retry.evaluate(() => fixture.pending[1].resolve({ data: [] }))
  await retry.getByText('Клієнтів не знайдено', { exact: true }).waitFor()
  assert.equal(await search(retry).inputValue(), '+380 (67) 123-45-67')
  await retry.getByRole('button', { name: 'Створити нового клієнта', exact: true }).click()
  assert.equal(await retry.getByLabel('Телефон клієнта', { exact: true }).inputValue(), '+380671234567')
  await retry.getByLabel('Телефон клієнта', { exact: true }).fill('+380931111111')
  await retry.getByRole('button', { name: 'Скасувати', exact: true }).click()
  await retry.getByRole('button', { name: 'Створити нового клієнта', exact: true }).click()
  assert.equal(await retry.getByLabel('Телефон клієнта', { exact: true }).inputValue(), '+380931111111', 'manual phone survives reopening')
  assert.equal(await retry.evaluate(() => fixture.writes.length), 0)
  await retry.close()

  const race = await setup()
  await search(race).fill('Старий запит')
  await waitQuery(race, 'Старий запит')
  await search(race).fill('Новий запит')
  await waitQuery(race, 'Новий запит')
  await race.evaluate(() => fixture.pending[1].resolve({ data: [fixture.customer('new', 'Новий результат')] }))
  await race.getByRole('button', { name: /Новий результат/ }).waitFor()
  await race.evaluate(() => fixture.pending[0].resolve({ data: [fixture.customer('old', 'Старий результат')] }))
  await race.waitForTimeout(100)
  assert.equal(await race.getByRole('button', { name: /Старий результат/ }).count(), 0)
  assert.equal(await search(race).inputValue(), 'Новий запит')
  await search(race).fill('Наступний запит')
  await waitQuery(race, 'Наступний запит')
  assert.equal(await race.getByRole('button', { name: 'Створити нового клієнта', exact: true }).isDisabled(), true)
  await search(race).fill('Останній запит')
  await waitQuery(race, 'Останній запит')
  await race.evaluate(() => { fixture.pending[3].resolve({ data: [] }); fixture.pending[2].reject(Error('Obsolete failed request')) })
  await race.getByText('Клієнтів не знайдено', { exact: true }).waitFor()
  assert.equal(await race.getByRole('alert').count(), 0)
  assert.equal(await search(race).inputValue(), 'Останній запит')
  await race.getByRole('button', { name: 'Створити нового клієнта', exact: true }).click()
  assert.equal(await race.getByLabel('Телефон клієнта', { exact: true }).inputValue(), '', 'name must not become phone')
  await race.close()

  const defaults = await setup('/orders/new', true)
  await defaults.getByRole('alert').waitFor()
  assert.equal(await defaults.getByText('Клієнтів не знайдено', { exact: true }).count(), 0)
  await defaults.evaluate(() => fixture.defaultFail = false)
  await defaults.getByRole('button', { name: 'Повторити завантаження', exact: true }).click()
  await defaults.getByText('Клієнтів не знайдено', { exact: true }).waitFor()
  await defaults.close()

  const garage = await setup()
  await garage.evaluate(() => fixture.vehicleFail = true)
  await search(garage).fill('Клієнт з авто')
  await waitQuery(garage, 'Клієнт з авто')
  await garage.evaluate(() => fixture.pending[0].resolve({ data: [fixture.customer('car-client', 'Клієнт з авто')] }))
  await garage.getByRole('button', { name: /Клієнт з авто/ }).click()
  await garage.getByRole('alert').filter({ hasText: 'автомобілі клієнта' }).waitFor()
  assert.equal(await garage.getByText("Немає прив'язаних автомобілів", { exact: true }).count(), 0)
  assert.equal(await garage.getByRole('button', { name: 'Додати новий автомобіль', exact: true }).isDisabled(), true)
  await garage.evaluate(() => fixture.vehicleFail = false)
  await garage.getByRole('button', { name: 'Повторити завантаження', exact: true }).click()
  await garage.getByText("Немає прив'язаних автомобілів", { exact: true }).waitFor()
  assert.equal(await garage.getByRole('button', { name: 'Додати новий автомобіль', exact: true }).isEnabled(), true)
  await garage.close()

  for (const width of [1440, 390]) {
    const preview = await setup('/orders?search=SKU-29', false, width)
    await preview.locator('p:visible').filter({ hasText: /^Позицій: 29 · ще 26$/ }).waitFor()
    const content = width > 500 ? preview.locator('table tbody tr').first() : preview.locator('div.md\\:hidden.space-y-3 > div').first()
    const text = await content.innerText()
    assert.match(text, /Фільтр 29.*SKU-29/)
    assert.match(text, /Скасовано/)
    assert.match(text, /Позицій: 29 · ще 26/)
    assert.ok(text.indexOf('Фільтр 29') < text.indexOf('Фільтр 0'), 'matching final item is first')
    assert.doesNotMatch(text, /Фільтр 28/, 'draft note is not a product position')
    assert.equal(await preview.evaluate(() => fixture.writes.length), 0)
    await preview.close()
  }

  const history = await setup('/chats?chat_id=chat-a')
  await history.getByRole('alert').filter({ hasText: 'історію замовлень' }).waitFor()
  assert.equal(await history.getByText(/Замовлень до цього чату ще немає/).count(), 0)
  await history.evaluate(() => fixture.historyFail = false)
  await history.getByRole('alert').filter({ hasText: 'історію замовлень' }).getByRole('button', { name: 'Повторити завантаження' }).click()
  await history.getByText(/Замовлень до цього чату ще немає/).waitFor()
  assert.equal(await history.evaluate(() => fixture.writes.length), 0)
  await history.close()
  const oldHistory = await setup('/chats?chat_id=chat-a', false, 1440, true)
  await oldHistory.getByText('Давнє замовлення чату 0', { exact: true }).first().waitFor()
  await oldHistory.getByText('Давнє замовлення клієнта 0', { exact: true }).waitFor()
  const historyReads = await oldHistory.evaluate(() => fixture.reads.filter(read => read.kind === 'orders'))
  assert.ok(historyReads.some(read => read.chat_id === 'chat-a'), 'chat history must be scoped before paging')
  assert.ok(historyReads.some(read => read.customer_id === 'existing'), 'customer history must be scoped before paging')
  assert.equal(await oldHistory.getByText('Other customer', { exact: true }).count(), 0)
  assert.equal(await oldHistory.evaluate(() => fixture.writes.length), 0)
  await oldHistory.close()
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.log('PASS: real order form failure/retry/current query; valid phone prefill/manual preservation/name exclusion; stale success and stale failure suppressed; create disabled during lookup; default-list failure; garage failure/retry; desktop/mobile long order preview and canceled/draft distinction; chat history failure/retry. Synthetic only, zero writes, no live services or DB.')
} finally { await browser?.close(); await server.close() }
