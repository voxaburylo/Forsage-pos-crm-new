// Real payment UI with synthetic data only: no live database, bank, fiscal service or printers.
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
  '@/stores/authStore': 'export const useAuthStore={getState:()=>({session:{user:{id:"cashier",app_metadata:{role:"cashier"}}}})}',
  '@/features/customers/customerApi': 'export const customerApi={get:async id=>({data:{id,bonus_balance:100000}})}',
  '@/features/admin/adminApi': 'export const adminApi={getSettings:async()=>({data:{bank_terminal_enabled:false}})}',
  '@/lib/api': 'export const api={get:async()=>{throw Error("Unexpected network API")}}',
  '@/lib/desktopBridge': 'export const desktopBridge=()=>({fiscal:{getConfig:async()=>({enabled:false})}})',
}
const entry = `
import React from 'react';import{createRoot}from'react-dom/client';
import{usePOSStore}from'/src/stores/posStore.ts';import{PaymentModal}from'/src/features/pos/PaymentModal.tsx';import'/src/index.css';
const s=usePOSStore.getState();s.replaceOpenReceipts([]);s.setCustomer({id:'client-1',name:'Тест',phone:'0670000000',debtBalance:0,tierDiscountPct:10,tierName:null,vipLevel:'standard',riskProfile:'low'});s.setAutomaticDiscountPct(10);
s.addItem({productId:'part',sku:'TEST-1',name:'Тестовий товар',unit:'м',qty:1,unitPrice:10000,discount:0,qtyOnHand:10,requiresCoreReturn:true,coreDepositAmount:20000});
fixture.store=usePOSStore;
createRoot(document.getElementById('root')).render(<PaymentModal open onClose={()=>fixture.closes++} onConfirm={async(...args)=>{fixture.calls.push(args);await new Promise(resolve=>fixture.resolve=resolve);return true}}/>);
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0 }, plugins: [tailwindcss(), {
    name: 'pos-discount-payment-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:pos-money.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:pos-money.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
      for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
      if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
    },
    configureServer(server) { server.middlewares.use('/pos-money-test', async (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(await server.transformIndexHtml('/pos-money-test', '<html><body><div id="root"></div><script>window.fixture={calls:[],closes:0}</script><script type="module" src="/@id/__x00__virtual:pos-money.tsx"></script></body></html>'))
    }) },
  }] })
let browser
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0], errors = [], blocked = []
  async function setup() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue() : (blocked.push(route.request().url()), route.abort()))
    await page.goto(base + 'pos-money-test')
    await page.locator('input[type=number][max]').waitFor()
    return page
  }
  for (const method of ['cash', 'card', 'mixed', 'transfer']) {
    const page = await setup()
    const bonus = page.locator('input[type=number][max]')
    assert.equal(await bonus.getAttribute('max'), '27.00', 'bonus cap excludes the core deposit')
    await bonus.fill('1000')
    if (method === 'cash') await page.getByRole('button', { name: 'Без решти', exact: true }).click()
    if (method === 'card') await page.getByRole('button', { name: 'Термінал', exact: true }).click()
    if (method === 'transfer') await page.getByRole('button', { name: 'Переказ на карту', exact: true }).click()
    if (method === 'mixed') {
      await page.getByRole('button', { name: 'Змішана оплата', exact: true }).click()
      await page.getByPlaceholder('0.00').last().fill('100')
    }
    await page.getByRole('button', { name: 'ОПЛАТИТИ', exact: true }).click()
    if (method === 'card' || method === 'mixed') {
      await page.getByPlaceholder('наприклад: 123456').fill('TEST-ONLY')
      await page.getByRole('button', { name: /Підтвердити/ }).evaluate(button => { button.click(); button.click() })
    }
    await page.waitForFunction(() => fixture.calls.length === 1, null, { timeout: 7000 })
    const [actual, cash, redeemed, split, fiscal, auth, print] = await page.evaluate(() => fixture.calls[0])
    assert.equal(actual, method); assert.equal(redeemed, 2700)
    assert.equal(fiscal, false); assert.equal(print, false)
    if (method === 'cash') assert.equal(cash, 26300)
    if (method === 'card' || method === 'mixed') assert.equal(auth, 'TEST-ONLY')
    if (method === 'mixed') assert.deepEqual(split, { cash_amount: 10000, card_amount: 16300 })
    await page.evaluate(() => fixture.resolve()); await page.close()
  }
  const switched = await setup()
  await switched.locator('input[type=number][max]').fill('10')
  await switched.evaluate(() => {
    const s = fixture.store.getState(); s.setCustomer({ ...s.customer, id: 'client-2' })
  })
  await switched.waitForFunction(() => document.querySelector('input[type=number]')?.value === '')
  await switched.close()
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log(JSON.stringify({ passed: true, cases: ['customer-discount', 'bonus-excludes-deposit', 'cash', 'card-confirmation', 'mixed-confirmation', 'transfer', 'double-click', 'switch-customer'], liveWrites: 0 }))
} finally { await browser?.close(); await server.close() }
