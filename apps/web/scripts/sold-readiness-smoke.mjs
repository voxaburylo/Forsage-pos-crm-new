// Actual DailyReport and API adapter in an isolated browser. No live server/DB.
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
  '@/lib/desktopBridge': 'export const desktopProductToProduct=p=>p;export const desktopCheckoutToSale=p=>p;export const isDesktopRuntime=()=>Boolean(window.fixture.desktop);export const desktopBridge=()=>window.fixture.desktop?(window.fixture.desktop==="old"?{pos:{}}:{pos:{soldItemsReport:input=>window.fixture.read({input}).then(r=>r.data)}}):null',
  '@/stores/authStore': 'export const useAuthStore=selector=>selector({session:{user:{app_metadata:{role:window.fixture.role}}}})',
  '@/features/analytics/AnalyticsLayout': "export const AnalyticsLayout=({children,title})=><main className='analytics-content'><h1>{title}</h1>{children}</main>",
  '@/components/ui': 'import React from "react";export {Table} from "/src/components/ui/Table.tsx";export const Card=({children,className})=>React.createElement("div",{className},children);export const Badge=({children})=>React.createElement("span",null,children)',
  '@/components/ui/Toast': 'export const toast={error:m=>window.fixture.toast=m,success:()=>{}}',
  'xlsx': 'export const utils={json_to_sheet:rows=>({rows}),book_new:()=>({}),book_append_sheet:(book,sheet)=>{book.rows=sheet.rows}};export const writeFile=book=>{window.fixture.exported=book.rows}',
}
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import DailyReport from '/src/features/reports/DailyReport.tsx';
import '/src/index.css';
import '/src/features/analytics/analyticsLayout.css';
const root=createRoot(document.getElementById('root'));
const totals={qty_sold:3,qty_returned:1,qty_net:2,revenue:30000,refund_total:10000,net_revenue:20000};
const f=window.fixture={mode:'error',role:'cashier',desktop:false,pending:[],key:0,requests:[],
 data:[{product_id:'p',name:'Фільтр WIX WA9428',sku:'WA9428',barcode:'0200000000001',unit:'шт',
 qty_on_hand:3,storage_bin:null,...totals,suppliers:[{id:'a',name:'Автокомфорт'},{id:'b',name:'Інший'}],
 sellers:[{id:'one',name:'Перший',...totals,qty_sold:1,qty_returned:0,qty_net:1,revenue:10000,refund_total:0,net_revenue:10000},
 {id:'two',name:'Другий',...totals,qty_sold:2,qty_net:1,revenue:20000,net_revenue:10000}]}]};
f.read=request=>{
 if(request.url?.startsWith('/api/v1/reports/sales/period?')){
  const date=new URL(request.url,'http://synthetic.invalid').searchParams.get('from');
  return Promise.resolve({data:{total_sales:1,total_revenue:30000,returns_count:1,returns_total:10000,
   net_revenue:20000,payment_received_total:35000,profit:9000,by_method:{cash:30000,card:5000,transfer:0,account:0,debt:0},
   sales:[{id:'sale',sale_number:'SYNTHETIC',total:30000,payment_method:'cash',status:'completed',completed_at:date+'T10:00:00Z',customer:null}],
   daily:[{date,sales:1,gross_revenue:30000,returns_total:10000,revenue:20000}]}});
 }
 f.requests.push(request);const result={data:structuredClone(f.data)};
 if(f.mode==='error')return Promise.reject(Error('offline'));
 if(f.mode==='pending')return new Promise(resolve=>f.pending.push(()=>resolve(result)));
 return Promise.resolve(result);
};
f.render=()=>root.render(React.createElement(MemoryRouter,null,React.createElement(DailyReport,{key:++f.key})));
f.render();
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false,
  root: path.join(root, 'apps/web'), logLevel: 'error', esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  plugins: [tailwindcss(), { name: 'isolated-sold-items', enforce: 'pre',
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
  browser = await chromium.launch({headless:true})
  const page=await browser.newPage({viewport:{width:1200,height:900}})
  await page.clock.setFixedTime(new Date('2026-10-04T10:00:00Z'))
  const errors=[]
  page.on('pageerror',error=>{errors.push(error.message);console.error('BROWSER ERROR:',error.message)})
  page.on('console',message=>{if(message.type()==='error')console.error('CONSOLE:',message.text())})
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort())
  await page.goto(server.resolvedUrls.local[0]+'audit')
  const exportButton=page.getByRole('button',{name:'Експорт в Excel'})
  await page.getByRole('alert').waitFor()
  assert.equal(await exportButton.isDisabled(),true)
  await page.evaluate(()=>{fixture.mode='ok';fixture.good=structuredClone(fixture.data);fixture.render()})
  await page.locator('tbody tr').filter({hasText:'Фільтр WIX WA9428'}).first().waitFor()
  await page.getByLabel('Продавець',{exact:true}).selectOption('two')
  await page.getByLabel('Знайти проданий товар',{exact:true}).fill('WX WA9428')
  await page.getByLabel('Постачальник для дозамовлення').selectOption('a')
  await exportButton.click()
  const exported=await page.evaluate(()=>fixture.exported)
  assert.equal(exported.length,1)
  assert.equal(exported[0]['Чиста сума (грн)'],100)
  assert.equal(exported[0]['Продано'],2)
  assert.equal(exported[0]['Штрихкод'],'0200000000001')
  assert.equal(exported[0]['Від'],'2026-10-04')
  assert.equal(exported[0]['Продавець у звіті'],'Другий')
  assert.equal(exported[0]['Пошук'],'WX WA9428')
  await page.evaluate(()=>{
    window.open=()=>({document:{write:html=>fixture.printHtml=html,close:()=>{}},focus:()=>{},print:()=>fixture.printed=true})
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{fixture.copied=text}}})
  })
  await page.getByRole('button',{name:/Друк/}).click()
  assert.equal(await page.evaluate(()=>fixture.printed),true)
  assert.match(await page.evaluate(()=>fixture.printHtml),/Разом: 100,00/)
  await page.getByRole('button',{name:'Копіювати список',exact:true}).click()
  assert.match(await page.evaluate(()=>fixture.copied),/Разом: 100.00 грн/)
  console.log('PASS: one seller, supplier and catalog-prefix search share screen, export, clipboard and print data')
  await page.getByLabel('Знайти проданий товар').fill('WX WA9429')
  assert.equal(await exportButton.isDisabled(),true)
  await page.getByLabel('Знайти проданий товар').fill('')
  await page.evaluate(()=>{fixture.mode='pending';fixture.data[0].name='Застарілий результат'})
  await page.getByRole('button',{name:'7 днів',exact:true}).click()
  await page.waitForFunction(()=>fixture.pending.length===1)
  assert.equal(await exportButton.isDisabled(),true)
  await page.evaluate(()=>{fixture.mode='ok';fixture.data=structuredClone(fixture.good)})
  await page.getByRole('button',{name:'30 днів',exact:true}).click()
  await page.locator('tbody tr').filter({hasText:'Фільтр WIX WA9428'}).first().waitFor()
  await page.evaluate(()=>fixture.pending.shift()())
  assert.equal(await page.getByText('Застарілий результат',{exact:true}).count(),0)
  await page.getByLabel('Від',{exact:true}).fill('')
  await page.getByRole('alert').waitFor()
  assert.equal(await exportButton.isDisabled(),true)
  assert.equal(await page.locator('tbody tr').count(),0)
  console.log('PASS: date edits and late replies cannot export stale rows under new dates')

  await page.evaluate(()=>{fixture.data[0].net_revenue=1;fixture.requests=[];fixture.render()})
  await page.getByRole('alert').filter({hasText:'Виберіть правильну дату початку й завершення'}).waitFor()
  assert.equal(await page.getByLabel('Від',{exact:true}).inputValue(),'','remount preserves an unfinished date rather than silently resetting the report')
  assert.equal(await page.getByLabel('Продавець',{exact:true}).inputValue(),'two')
  assert.equal(await page.getByLabel('Постачальник для дозамовлення').inputValue(),'a')
  assert.equal(await page.evaluate(()=>fixture.requests.length),0,'invalid saved dates must not query a different period')
  await page.getByRole('button',{name:'Сьогодні',exact:true}).click()
  await page.getByRole('alert').filter({hasText:'Звіт проданих товарів неповний або застарілий'}).waitFor()
  assert.deepEqual(await page.evaluate(()=>fixture.requests),[{url:'/api/v1/reports/sold-items?from=2026-10-04&to=2026-10-04'}],'corrupt-data assertion reaches the adapter, not the invalid-date guard')
  assert.equal(await exportButton.isDisabled(),true)
  await page.evaluate(()=>{fixture.desktop=true;fixture.requests=[];fixture.data=structuredClone(fixture.good);fixture.render()})
  await page.locator('tbody tr').filter({hasText:'Фільтр WIX WA9428'}).first().waitFor()
  assert.deepEqual(await page.evaluate(()=>fixture.requests),[{input:{date_from:'2026-10-03T21:00:00.000Z',date_to:'2026-10-04T20:59:59.999Z'}}])
  await page.evaluate(()=>{fixture.desktop='old';fixture.requests=[];fixture.render()})
  await page.getByRole('alert').waitFor()
  assert.equal(await exportButton.isDisabled(),true)
  assert.equal(await page.evaluate(()=>fixture.requests.length),0)
  console.log('PASS: corrupt reports fail closed; local reports never silently fall back to the cloud')

  await page.evaluate(()=>{fixture.role='owner';fixture.desktop=false;fixture.data=structuredClone(fixture.good);fixture.render()})
  const summaryLink=page.getByRole('button',{name:'Продані товари за сьогодні →',exact:true})
  await summaryLink.waitFor()
  assert.equal(await page.locator('tbody tr').count(),0,'Today is a summary, not a second sold-items table')
  assert.equal(await page.getByTestId('sold-items-mobile').count(),0,'There is no hidden mobile duplicate list')
  assert.match(await page.getByText('Прийнято оплат до повернень',{exact:true}).locator('..').innerText(),/350,00/)
  assert.match(await page.getByText('Сума товарів після повернень',{exact:true}).locator('..').innerText(),/200,00/)
  await summaryLink.click()
  await page.getByLabel('Від',{exact:true}).fill('2026-10-01')
  await page.getByLabel('Продавець',{exact:true}).selectOption('two')
  await page.getByLabel('Постачальник для дозамовлення').selectOption('a')
  await page.getByLabel('Знайти проданий товар',{exact:true}).fill('WX WA9428')
  await page.getByRole('button',{name:'Підсумки',exact:true}).click()
  await summaryLink.waitFor()
  assert.equal(await page.locator('tbody tr').count(),0)
  await exportButton.click()
  const todayExport=await page.evaluate(()=>fixture.exported)
  assert.equal(todayExport.length,1,'Summary export still includes all today items regardless of previous sold filters')
  assert.equal(todayExport[0]['Чиста сума (грн)'],200)
  assert.equal(todayExport[0]['Дата'],'2026-10-04')
  await summaryLink.click()
  await page.locator('tbody tr').filter({hasText:'Фільтр WIX WA9428'}).first().waitFor()
  assert.equal(await page.getByLabel('Від',{exact:true}).inputValue(),'2026-10-04')
  assert.equal(await page.getByLabel('До',{exact:true}).inputValue(),'2026-10-04')
  assert.equal(await page.getByLabel('Продавець',{exact:true}).inputValue(),'')
  assert.equal(await page.getByLabel('Постачальник для дозамовлення').inputValue(),'')
  assert.equal(await page.getByLabel('Знайти проданий товар',{exact:true}).inputValue(),'')
  await exportButton.click()
  assert.equal((await page.evaluate(()=>fixture.exported))[0]['Чиста сума (грн)'],200)
  console.log('PASS: today has no duplicate list; the sole sold view opens today with cleared filters, keeping payment metrics and export separate')

  await page.evaluate(()=>{fixture.role='cashier';fixture.desktop=false;fixture.data=[];fixture.render()})
  await page.getByText('За вибраним періодом, пошуком і фільтрами операцій із товарами немає',{exact:true}).waitFor()
  assert.equal(await page.getByRole('alert').count(),0)
  assert.equal(await exportButton.isDisabled(),true)
  await page.setViewportSize({width:390,height:844})
  await page.evaluate(()=>{fixture.data=Array.from({length:30},(_,i)=>({...fixture.good[0],product_id:'p'+i,
    name:'Довга назва проданого товару для мобільного звіту '+i,sku:'AUTO-123456789012345678901234567890'}));fixture.render()})
  const mobile=page.locator('[data-testid=sold-items-mobile]')
  await mobile.getByRole('heading',{name:'Довга назва проданого товару для мобільного звіту 29',exact:true}).waitFor()
  assert.equal(await mobile.locator('article').count(),30)
  const last=mobile.locator('article').last()
  await last.scrollIntoViewIfNeeded()
  assert.equal(await last.isVisible(),true)
  const layout=await page.evaluate(()=>({w:document.documentElement.scrollWidth,v:innerWidth,y:scrollY}))
  assert.ok(layout.w<=layout.v+1,JSON.stringify(layout));assert.ok(layout.y>0)
  await page.screenshot({path:process.env.TEMP+'/forsage-sold-report-mobile-last.png'})
  await page.evaluate(()=>scrollTo(0,0))
  await page.screenshot({path:process.env.TEMP+'/forsage-sold-report-mobile.png'})
  assert.deepEqual(errors,[])
  console.log('PASS: mobile 390px has no horizontal overflow; last product remains reachable')
} finally {
  if(browser)await browser.close()
  await server.close()
}
