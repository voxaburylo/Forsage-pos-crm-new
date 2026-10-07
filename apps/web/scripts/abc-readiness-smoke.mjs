// Actual ABC page and report hook, with isolated data; no live API or documents.
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
  '@/lib/api': 'export const api={get:url=>window.fixture.read({url})}',
  '@/lib/desktopBridge': 'export const isDesktopRuntime=()=>Boolean(window.fixture.desktop);export const desktopBridge=()=>window.fixture.desktop==="old"?{catalog:{}}:{catalog:{analytics:input=>window.fixture.read({input}).then(r=>r.data)}}',
  '@/features/analytics/AnalyticsLayout': "export const AnalyticsLayout=({children,title})=><main className='analytics-content'><h1>{title}</h1>{children}</main>",
  '@/components/ui': 'import React from "react";export {Table} from "/src/components/ui/Table.tsx";export const Card=({children,className})=>React.createElement("div",{className},children);export const Badge=({children})=>React.createElement("span",null,children)',
  '@/components/ui/Toast': 'export const toast={error:()=>{},success:()=>{}}',
  'xlsx': 'export const utils={json_to_sheet:rows=>({rows}),book_new:()=>({}),book_append_sheet:(book,sheet)=>{book.rows=sheet.rows}};export const writeFile=book=>{window.fixture.exported=book.rows}',
}
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import ABCAnalysis from '/src/features/analytics/ABCAnalysis.tsx';
import '/src/index.css';
import '/src/features/analytics/analyticsLayout.css';
const root=createRoot(document.getElementById('root'));
const f=window.fixture={mode:'error',desktop:false,pending:[],key:0,requests:[],
 data:[{id:'p',sku:'W 811/80',name:'Фільтр A',currentStock:2,soldQty:1,profit:12345,abc_class:'A',cumulative_pct:100},
 {id:'loss',sku:'SKU 2',name:'Повернення товару',currentStock:0,soldQty:-.5,profit:-500,abc_class:'Z',cumulative_pct:100}]};
f.read=request=>{
 f.requests.push(request);const result={data:structuredClone(f.data)};
 if(f.mode==='error')return Promise.reject(Error('offline'));
 if(f.mode==='pending')return new Promise(resolve=>f.pending.push(()=>resolve(result)));
 return Promise.resolve(result);
};
f.render=()=>root.render(React.createElement(ABCAnalysis,{key:++f.key}));
f.render();
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false,
  root: path.join(root, 'apps/web'), logLevel: 'error', esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), { name: 'isolated-abc', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:audit' || Object.hasOwn(mocks, id)) return '\0'+id },
    load(id) {
      if (id === '\0virtual:audit') return entry
      if (id.startsWith('\0')) return mocks[id.slice(1)]
      for (const [name, source] of Object.entries(mocks)) {
        if (name.startsWith('@/') && id.replaceAll('\\','/').replace(/\.tsx?$/, '').replace(/\/index$/, '').endsWith('/src/'+name.slice(2))) return source
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
  const page = await browser.newPage()
  await page.clock.setFixedTime(new Date('2026-10-03T10:00:00Z'))
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:',error.message) })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(server.resolvedUrls.local[0]+'audit')
  const exportButton=page.getByRole('button',{name:'Експорт в Excel'})
  await page.getByRole('alert').waitFor()
  assert.equal(await exportButton.isDisabled(),true)
  assert.equal(await page.getByText('0 товарів · 0 показано',{exact:true}).count(),0)
  console.log('PASS: an unavailable report is not displayed/exported as zero sales')

  await page.evaluate(()=>{fixture.mode='ok';fixture.good=structuredClone(fixture.data);delete fixture.data[0].profit;fixture.render()})
  await page.getByText('Товарний звіт містить неповні або некоректні дані',{exact:true}).waitFor()
  assert.equal(await exportButton.isDisabled(),true)
  assert.equal(await page.getByText('NaN',{exact:true}).count(),0)
  console.log('PASS: incomplete ABC rows are rejected before display and export')

  await page.evaluate(()=>{fixture.data=structuredClone(fixture.good);fixture.render()})
  await page.getByText('Фільтр A',{exact:true}).waitFor()
  const lossCell=page.getByRole('row').filter({hasText:'Повернення товару'}).locator('td').last()
  assert.match(await lossCell.innerText(),/-5/)
  assert.equal(await lossCell.locator('span').getAttribute('class'),'font-semibold text-red-700')
  await page.getByRole('button',{name:'A (80%)',exact:true}).click()
  assert.equal(await page.getByRole('row').count(),2)
  await exportButton.click()
  const exported=await page.evaluate(()=>fixture.exported)
  assert.equal(exported.length,1);assert.equal(exported[0]['Товар'],'Фільтр A');assert.equal(exported[0]['Прибуток, грн'],123.45)
  console.log('PASS: refunds/losses remain negative; export respects the existing class filter')

  await page.evaluate(()=>{fixture.requests=[];fixture.desktop=true;fixture.render()})
  await page.getByText('Фільтр A',{exact:true}).waitFor()
  await page.waitForFunction(()=>fixture.requests.length>0)
  const requests=await page.evaluate(()=>fixture.requests)
  assert.deepEqual(requests,[{input:{kind:'abc',startDate:'2026-07-06',endDate:'2026-10-03',from:'2026-07-05T21:00:00.000Z',to:'2026-10-03T20:59:59.999Z'}}])
  console.log('PASS: desktop uses exactly 90 Kyiv days and does not access the server')

  await page.evaluate(()=>{fixture.requests=[];fixture.desktop='old';fixture.render()})
  await page.getByText('Для локальної аналітики запустіть оновлену програму',{exact:true}).waitFor()
  assert.equal((await page.evaluate(()=>fixture.requests)).length,0)
  assert.equal(await exportButton.isDisabled(),true)
  console.log('PASS: an old desktop bridge cannot silently read the web copy')

  await page.evaluate(()=>{fixture.desktop=false;fixture.mode='pending';fixture.data=[{...fixture.good[0],name:'Старий звіт'}];fixture.render()})
  await page.waitForFunction(()=>fixture.pending.length===1)
  await page.evaluate(()=>{fixture.mode='ok';fixture.data=structuredClone(fixture.good);fixture.render()})
  await page.getByText('Фільтр A',{exact:true}).waitFor()
  await page.evaluate(()=>fixture.pending.shift()())
  await page.waitForTimeout(100)
  assert.equal(await page.getByText('Старий звіт',{exact:true}).count(),0)
  console.log('PASS: a late stale response cannot replace current rows')

  await page.evaluate(()=>{fixture.data=[];fixture.render()})
  await page.getByText('0 товарів · 0 показано',{exact:true}).waitFor()
  assert.equal(await page.getByRole('alert').count(),0)
  assert.equal(await exportButton.isDisabled(),true)
  console.log('PASS: a genuinely empty report remains distinct from an error')

  await page.setViewportSize({width:390,height:844})
  await page.evaluate(()=>{fixture.data=Array.from({length:35},(_,i)=>({...fixture.good[0],id:'p'+i,sku:'AUTO-'+String(i).padStart(40,'0'),name:'Довга назва товару з артикулом для перевірки вузького екрана '+i}));fixture.render()})
  await page.getByText('35 товарів · 35 показано',{exact:true}).waitFor()
  const last=page.getByText('Довга назва товару з артикулом для перевірки вузького екрана 34',{exact:true})
  await last.scrollIntoViewIfNeeded()
  assert.equal(await last.isVisible(),true)
  const layout=await page.evaluate(()=>({w:document.documentElement.scrollWidth,v:innerWidth,y:scrollY}))
  assert.ok(layout.w<=layout.v+1,JSON.stringify(layout));assert.ok(layout.y>0)
  assert.deepEqual(errors,[])
  console.log('PASS: 390px mobile layout has no horizontal overflow and reaches the last product')
} finally {
  if(browser)await browser.close()
  await server.close()
}
