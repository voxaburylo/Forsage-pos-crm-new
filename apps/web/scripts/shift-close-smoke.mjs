// Runs the actual modal with fake APIs in an isolated browser. No store data or network.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const { chromium } = await import('playwright')
const mocks = {
  '@/lib/desktopBridge': 'export const desktopBridge=()=>window.fixture.bridge',
  '@/stores/authStore': "export const useAuthStore=fn=>fn({session:{user:{id:'cashier',app_metadata:{role:window.fixture.role||'cashier'}}}})",
  '@/features/staff/staffApi': "export const staffApi={tireServiceReport:async()=>{if(window.fixture.tireError)throw Error('unavailable');return {data:[]}}}",
  '@/lib/utils': "export const formatMoney=n=>(n/100).toFixed(2)+' грн'",
  '@/lib/businessDate': "export const businessDateKey=()=> '2026-09-11'",
  '@/components/ui/Toast': "export const toast={error:m=>window.fixture.errors.push(m),success:()=>{},warning:()=>{}}",
  './shiftApi': 'export const shiftApi={}',
}
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ShiftCloseModal} from '/src/features/pos/ShiftCloseModal.tsx';
const root=createRoot(document.getElementById('root'));
const f=window.fixture={mode:'ok',id:'A',calls:[],errors:[],pending:[],closed:0,holdClose:false};
function read(){
 const id=f.id;
 const methods={cash:0,card:0,transfer:0,account:0,debt:0};
 const value={
  shift:{id,cashier_id:'cashier',status:'open',opening_cash:10000},
  cash_breakdown:{opening_cash:10000,cash_sales:0,cash_returns:0,cash_in:0,cash_out:0,expected_amount:10000,...f.cash},
  by_method:{...methods},refunds_by_method:{...methods},total_sales:0,gross_revenue:0,refund_total:0,total_revenue:0,
  payment_received_total:0,payment_refunded_total:0,payment_net_total:0,unassigned_refunds_count:0,sales:[],...f.report,
 };
 if(f.mode==='error')return Promise.reject(Error('test failure'));
 if(f.mode==='defer')return new Promise(resolve=>f.pending.push(()=>resolve(value)));
 return Promise.resolve(value);
}
f.bridge={pos:{shiftReport:()=>read(),expectedCash:()=>{throw Error('Closing must use one atomic snapshot')},closeShift:(...args)=>{
 f.calls.push(args);return f.holdClose?new Promise(resolve=>f.finishClose=resolve):Promise.resolve();
}}};
f.render=(id='A',open=true)=>{f.id=id;root.render(React.createElement(ShiftCloseModal,{open,shiftId:id,onClose:()=>f.render(id,false),onClosed:()=>{f.closed++;f.render(id,false)}}))};
f.render();
`
const server = await createServer({cacheDir:createSmokeCache(),
  configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'isolated-audit-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:audit' || Object.hasOwn(mocks, id)) return '\0'+id },
    load(id) {
      if (id === '\0virtual:audit') return entry
      if (id.startsWith('\0')) return mocks[id.slice(1)]
      for (const [name, source] of Object.entries(mocks)) {
        const suffix = name.startsWith('@/') ? name.slice(2) : 'features/pos/shiftApi'
        if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + suffix)) return source
      }
    },
    configureServer(server) {
      server.middlewares.use('/audit', async (_req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end(await server.transformIndexHtml('/audit', '<html><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:audit"></script></body></html>'))
      })
    },
  }],
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(server.resolvedUrls.local[0] + 'audit')
  const input = page.getByRole('textbox', { name: 'Фактична сума в касі', exact: true })
  await input.waitFor()
  await input.press('Enter')
  assert.equal(await page.evaluate(() => fixture.calls.length), 0)
  await input.fill('100')
  await page.evaluate(() => { fixture.holdClose = true })
  await input.press('Enter')
  await page.waitForFunction(() => fixture.calls.length === 1)
  await page.evaluate(() => document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.equal(await page.evaluate(() => fixture.calls.length), 1)
  assert.equal(await page.getByRole('button', { name: 'Скасувати', exact: true }).isDisabled(), true)
  assert.deepEqual(await page.evaluate(() => fixture.calls[0]), ['cashier',10000,null,'A'])
  await page.evaluate(() => fixture.finishClose())
  await page.waitForFunction(() => fixture.closed === 1)
  await page.evaluate(() => { fixture.mode='defer'; fixture.render('B') })
  await page.waitForFunction(() => fixture.pending.length === 1)
  await page.evaluate(() => { fixture.mode='error'; fixture.render('C') })
  await page.getByRole('alert').waitFor()
  await page.evaluate(() => fixture.pending.splice(0).forEach(resolve=>resolve()))
  assert.equal(await input.count(), 0)
  assert.equal(await page.getByRole('button', {name:'Закрити зміну',exact:true}).isDisabled(), true)
  await page.evaluate(() => fixture.render('C',false))
  await page.waitForFunction(() => !document.querySelector('button'))
  await page.evaluate(() => { fixture.mode='ok'; fixture.render('D') })
  await input.waitFor()
  assert.equal(await input.inputValue(), '')
  await input.press('Enter')
  assert.equal(await page.evaluate(() => fixture.calls.length), 1)
  await page.evaluate(() => { fixture.role='owner'; fixture.tireError=true; fixture.render('E') })
  await page.getByText('Не вдалося завантажити нарахування.', {exact:false}).waitFor()
  assert.equal(await page.getByText('Доступно до виплати:',{exact:false}).count(), 0)
  await page.evaluate(() => {
    fixture.report={total_sales:1,gross_revenue:2000,refund_total:2000,total_revenue:0,
      by_method:{cash:1000,card:1000,transfer:0,account:0,debt:0},refunds_by_method:{cash:1000,card:1000,transfer:0,account:0,debt:0},
      payment_received_total:2000,payment_refunded_total:2000,payment_net_total:0,
      sales:[{id:'sale',status:'returned',total:2000}]};
    fixture.cash={opening_cash:10000,cash_sales:1000,cash_returns:1000};
    fixture.render('F');
  })
  await page.getByText('Продажі мінус повернення:',{exact:true}).waitFor()
  assert.match(await page.getByText('Продано: 1 чек(ів)',{exact:true}).locator('..').innerText(), /20.00 грн/)
  assert.match(await page.getByText('Повернення цієї зміни:',{exact:true}).locator('..').innerText(), /20.00 грн/)
  assert.match(await page.getByText('Продажі мінус повернення:',{exact:true}).locator('..').innerText(), /0.00 грн/)
  assert.match(await page.getByText('Очікується в касі:',{exact:true}).locator('..').innerText(), /100.00 грн/)
  await page.getByText('Повернення через термінал:',{exact:true}).waitFor()
  await page.evaluate(() => {fixture.report.unassigned_refunds_count=1;fixture.render('G')})
  await page.getByText('Неповні дані',{exact:true}).waitFor()
  await page.getByText('Для 1 старих повернень',{exact:false}).waitFor()
  await input.fill('100')
  assert.equal(await page.getByRole('button', {name:'Закрити зміну',exact:true}).isDisabled(), false)
  await page.evaluate(() => {fixture.report={cash_breakdown:undefined};fixture.render('H')})
  await page.getByRole('alert').waitFor()
  assert.equal(await input.count(),0)
  assert.equal(await page.getByRole('button', {name:'Закрити зміну',exact:true}).isDisabled(),true)
  assert.equal(await page.evaluate(() => fixture.calls.length),1)
  await page.evaluate(() => {fixture.report={};fixture.cash={};fixture.render('I')})
  await input.waitFor()
  await page.getByText('Продано: 0 чек(ів)',{exact:true}).waitFor()
  assert.equal(await page.getByText('Неповні дані',{exact:true}).count(),0)
  assert.deepEqual(errors, [])
  console.log('PASS: blank Enter, duplicate Enter, explicit shift ID, close lock, single atomic snapshot, stale responses, load failure, clean reopen, salary error not shown as zero, gross/refund/net separation, incomplete legacy refunds, incomplete snapshot blocks close')
} finally { await browser?.close(); await server.close() }
