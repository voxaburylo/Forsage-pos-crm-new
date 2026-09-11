// Runs the actual modal with fake APIs in an isolated browser. No store data or network.
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
function read(kind){
 const id=f.id;
 const value=kind==='report'?{shift:{id},by_method:{cash:10000,card:0},total_sales:0,sales:[]}:{expected_amount:10000};
 if(f.mode==='error')return Promise.reject(Error('test failure'));
 if(f.mode==='defer')return new Promise(resolve=>f.pending.push(()=>resolve(value)));
 return Promise.resolve(value);
}
f.bridge={pos:{shiftReport:()=>read('report'),expectedCash:()=>read('cash'),closeShift:(...args)=>{
 f.calls.push(args);return f.holdClose?new Promise(resolve=>f.finishClose=resolve):Promise.resolve();
}}};
f.render=(id='A',open=true)=>{f.id=id;root.render(React.createElement(ShiftCloseModal,{open,shiftId:id,onClose:()=>f.render(id,false),onClosed:()=>{f.closed++;f.render(id,false)}}))};
f.render();
`
const server = await createServer({
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
  const input = page.getByRole('spinbutton')
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
  await page.waitForFunction(() => fixture.pending.length === 2)
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
  assert.deepEqual(errors, [])
  console.log('PASS: blank Enter, duplicate Enter, explicit shift ID, close lock, stale responses, load failure, clean reopen, salary error not shown as zero')
} finally { await browser?.close(); await server.close() }
