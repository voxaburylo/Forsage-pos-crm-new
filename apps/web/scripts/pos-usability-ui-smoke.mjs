// Real payment and receipt-search components, synthetic reads only. No printers or shop data.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const mocks = {
  '@/stores/authStore': 'export const useAuthStore={getState:()=>({session:{user:{id:"fixture",app_metadata:{role:"cashier"}}}})}',
  '@/features/customers/customerApi': 'export const customerApi={get:async id=>fixture.readCustomer(id)}',
  '@/features/admin/adminApi': 'export const adminApi={getSettings:async()=>({data:{bank_terminal_enabled:false}})}',
  '@/lib/api': 'export const api={get:async url=>fixture.readBonusLimit(url)}',
  '@/lib/desktopBridge': 'export const desktopBridge=()=>fixture.serverMode?null:({fiscal:{getConfig:async()=>({enabled:false})}})',
  '@/components/ui/Toast': 'export const toast={error:message=>fixture.errors.push(message)};export function ToastContainer(){return null}',
  '@/features/pos/saleApi': 'export const saleApi={list:params=>fixture.readReceipts(params)}',
}
const entry = `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{usePOSStore}from'/src/stores/posStore.ts';import{PaymentModal}from'/src/features/pos/PaymentModal.tsx';
import{ReceiptFinderModal}from'/src/features/pos/ReceiptFinderModal.tsx';import'/src/index.css';
const store=usePOSStore.getState();store.replaceOpenReceipts([]);store.setCustomer({id:'client',name:'Fixture',phone:'0670000000',debtBalance:0,tierDiscountPct:0,tierName:null,vipLevel:'standard',riskProfile:'low'});
store.addItem({productId:'part',sku:'TEST',name:'Fixture',unit:'шт',qty:1,unitPrice:fixture.price??10000,discount:fixture.discount??0,qtyOnHand:1,requiresCoreReturn:!!fixture.coreDeposit,coreDepositAmount:fixture.coreDeposit??0});fixture.store=usePOSStore;
function App(){const[open,setOpen]=useState(true);fixture.setOpen=setOpen;return fixture.screen==='finder'
 ?<ReceiptFinderModal open={open} onClose={()=>setOpen(false)} onSelect={id=>fixture.prints.push(id)}/>
 :<PaymentModal open={open} offline={fixture.offline} onClose={()=>{fixture.closes++;setOpen(false)}} onConfirm={async(...args)=>{fixture.payments.push(args);await new Promise(resolve=>fixture.complete=resolve);return false}}/>}
createRoot(document.getElementById('root')).render(<App/>);
`
const bootstrap = `
window.fixture={...window.testBonus,screen:window.testScreen??'finder',mode:window.testMode??'ready',offline:window.testOffline??false,errors:[],prints:[],payments:[],closes:0,reads:[],customerReads:0,bonusReads:[],pending:{}};
fixture.readReceipts=params=>{const key=params.search??params.product_barcode??'recent';fixture.reads.push(key);return new Promise((resolve,reject)=>fixture.pending[key]={resolve:()=>resolve({data:[{id:key,sale_number:key,status:'completed',completed_at:'2026-10-13T08:00:00Z',total:10000,payment_method:'cash',sale_items:[]}]}),reject:()=>reject(Error('Synthetic search failure'))})};
fixture.readCustomer=async()=>{fixture.customerReads++;if(fixture.mode==='hold')await new Promise(resolve=>fixture.finishRead=resolve);if(fixture.mode==='error')throw Error('Synthetic balance failure');return{data:{bonus_balance:fixture.mode==='zero'?0:fixture.balance??5000}}};
fixture.readBonusLimit=async url=>{if(!url.startsWith('/api/v1/loyalty/customer/'))throw Error('Unexpected remote API');const total=Number(new URL(url,location.origin).searchParams.get('total'));fixture.bonusReads.push(total);const balance=fixture.balance??5000;return{data:{balance,max_redeem:Math.min(balance,Math.floor(total*(fixture.percent??30)/100))}}};
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [tailwindcss(), {
    name: 'pos-usability-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:pos-ux.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:pos-ux.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
      for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
      if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
    },
    configureServer(instance) { instance.middlewares.use('/pos-ux', async (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(await instance.transformIndexHtml('/pos-ux', '<html><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:pos-ux.tsx"></script></body></html>'))
    }) },
  }] })
let browser
const errors = [], blocked = [], passed = []
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0]
  async function setup(screen = 'finder', mode = 'ready', offline = false, bonus = {}) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : (blocked.push(route.request().url()), route.abort()))
    await page.addInitScript(({ screen, mode, offline, bonus }) => { window.testScreen = screen; window.testMode = mode; window.testOffline = offline; window.testBonus = bonus }, { screen, mode, offline, bonus })
    await page.goto(base + 'pos-ux')
    await page.waitForFunction(() => typeof fixture.setOpen === 'function')
    return page
  }
  if (!process.env.FORSAGE_UX_CASE || process.env.FORSAGE_UX_CASE === 'finder') {
    const page = await setup()
    const search = page.getByPlaceholder(/Номер чека/)
    await page.waitForFunction(() => fixture.pending.recent)
    await search.fill('Alpha')
    await page.waitForFunction(() => fixture.pending.Alpha)
    await search.fill('Beta')
    await page.waitForFunction(() => fixture.pending.Beta)
    await page.evaluate(() => fixture.pending.Beta.resolve())
    await page.getByText('#Beta', { exact: true }).waitFor()
    await page.evaluate(() => { fixture.pending.Alpha.resolve(); fixture.pending.recent.reject() })
    await page.waitForTimeout(100)
    assert.equal(await page.getByText('#Beta', { exact: true }).count(), 1, 'late Alpha must not replace Beta')
    assert.deepEqual(await page.evaluate(() => fixture.errors), [], 'stale rejected query must not toast')
    await search.fill('Closing')
    await page.waitForFunction(() => fixture.pending.Closing)
    await page.getByRole('button', { name: 'Закрити', exact: true }).click()
    await page.evaluate(() => fixture.pending.Closing.resolve())
    await page.evaluate(() => fixture.setOpen(true))
    await page.waitForFunction(() => fixture.reads.filter(q => q === 'recent').length === 2)
    assert.equal(await search.inputValue(), '')
    assert.equal(await page.getByText('#Closing', { exact: true }).count(), 0)
    await page.evaluate(() => fixture.pending.recent.reject())
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByText('Останні чеки за 14 днів', { exact: true }).count(), 0, 'read failure is not an empty history')
    await search.press('Enter')
    await page.waitForFunction(() => fixture.reads.filter(q => q === 'recent').length === 3)
    await page.evaluate(() => fixture.pending.recent.resolve())
    await page.getByText('#recent', { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => fixture.prints), [])
    passed.push('receipt response ordering, stale errors, close/reopen, retry without printing')
    await page.close()
  }
  if (!process.env.FORSAGE_UX_CASE || process.env.FORSAGE_UX_CASE === 'bonus') {
    for (const mode of ['zero', 'hold', 'error']) {
      const page = await setup('payment', mode)
      const messages = { zero: 'Бонусів для списання немає.', hold: 'Перевіряємо бонусний баланс…', error: 'Не вдалося перевірити бонуси.' }
      await page.getByText(messages[mode], { exact: true }).waitFor()
      assert.equal(await page.locator('input[type=number][max]').count(), 0)
      if (mode === 'error') {
        await page.evaluate(() => fixture.mode = 'ready')
        await page.getByRole('button', { name: 'Повторити перевірку бонусів', exact: true }).click()
      } else if (mode === 'hold') await page.evaluate(() => fixture.finishRead())
      if (mode !== 'zero') await page.locator('input[type=number][max]').waitFor()
      await page.close()
    }
    const noCustomer = await setup('payment')
    await noCustomer.evaluate(() => fixture.store.getState().setCustomer(null))
    await noCustomer.getByText('Для оплати бонусами виберіть клієнта в чеку.', { exact: true }).waitFor()
    await noCustomer.close()
    const offline = await setup('payment', 'ready', true)
    await offline.getByText('Бонуси недоступні у вебкасі без зв’язку.', { exact: true }).waitFor()
    assert.equal(await offline.evaluate(() => fixture.customerReads), 0)
    await offline.close()
    passed.push('bonus zero/loading/error/retry/no-customer/offline')
  }
  if (!process.env.FORSAGE_UX_CASE || process.env.FORSAGE_UX_CASE === 'bonus-limit') {
    for (const scenario of [
      { serverMode: false, price: 10000, discount: 1000, coreDeposit: 20000, maximum: 2700 },
      { serverMode: false, price: 103, maximum: 30 },
      { serverMode: false, price: 10000, balance: 700, maximum: 700 },
      { serverMode: true, percent: 10, price: 10000, discount: 1000, coreDeposit: 20000, maximum: 900 },
      { serverMode: true, percent: 100, price: 10000, balance: 20000, maximum: 10000 },
    ]) {
      const page = await setup('payment', 'ready', false, scenario)
      const bonus = page.locator('input[type=number][max]')
      await bonus.waitFor()
      assert.equal(await bonus.getAttribute('max'), (scenario.maximum / 100).toFixed(2))
      assert.match(await page.getByText(/Списати бонусів \(макс/).innerText(), new RegExp((scenario.maximum / 100).toFixed(2).replace('.', '[,.]')))
      if (scenario.serverMode) assert.deepEqual(await page.evaluate(() => fixture.bonusReads), [scenario.price - (scenario.discount ?? 0)])
      await bonus.fill('9999')
      await page.getByRole('button', { name: 'Без решти', exact: true }).click()
      await page.getByRole('button', { name: 'ОПЛАТИТИ', exact: true }).click()
      await page.waitForFunction(() => fixture.payments.length === 1)
      const payload = await page.evaluate(() => fixture.payments[0])
      assert.equal(payload[2], scenario.maximum, 'actual callback amount must not exceed displayed maximum')
      assert.equal(payload[1], scenario.price - (scenario.discount ?? 0) + (scenario.coreDeposit ?? 0) - scenario.maximum)
      await page.evaluate(() => fixture.complete())
      await page.close()
    }
    const disabled = await setup('payment', 'ready', false, { serverMode: true, percent: 0 })
    await disabled.getByText(/Для цього чека списання бонусів недоступне/).waitFor()
    assert.equal(await disabled.locator('input[type=number][max]').count(), 0)
    await disabled.close()
    passed.push('bonus maximum: desktop30%, configuredserver10/100/0%, core exclusion, discounts, rounding, low balance and actual payload clamp')
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log(JSON.stringify({ passed: true, cases: passed, liveWrites: 0, printing: 0 }))
} finally { await browser?.close(); await server.close() }
