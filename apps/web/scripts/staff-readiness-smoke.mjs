// Actual staff page and report hook, with isolated data; no live API or documents.
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
import StaffAnalytics from '/src/features/analytics/StaffAnalytics.tsx';
import '/src/index.css';
import '/src/features/analytics/analyticsLayout.css';
const root=createRoot(document.getElementById('root'));
const f=window.fixture={mode:'error',desktop:false,pending:[],key:0,requests:[],
 data:[{manager_id:'seller',manager_name:'Контрольний касир',sales_revenue:10000,sales_cogs:6000,orders_revenue:0,orders_cogs:0,total_revenue:10000,total_cogs:6000,gross_profit:4000,salary_cost:1000,bonus_cost:100,advance_cost:900,penalty_cost:50,total_payouts:900,net_profit:2950}]};
f.read=request=>{
 f.requests.push(request);const result={data:structuredClone(f.data)};
 if(f.mode==='error')return Promise.reject(Error('offline'));
 if(f.mode==='pending')return new Promise(resolve=>f.pending.push(()=>resolve(result)));
 return Promise.resolve(result);
};
f.render=()=>root.render(React.createElement(StaffAnalytics,{key:++f.key}));
f.render();
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false,
  root: path.join(root, 'apps/web'), logLevel: 'error', esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), { name: 'isolated-staff', enforce: 'pre',
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
  await page.clock.setFixedTime(new Date('2026-10-04T10:00:00Z'))
  const errors = []
  page.on('pageerror', error => { errors.push(error.message) })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(server.resolvedUrls.local[0]+'audit')
  const exportButton = page.getByRole('button', { name: 'Експорт в Excel' })
  await page.getByRole('alert').waitFor()
  assert.equal(await exportButton.isDisabled(), true)
  assert.equal(await page.getByText('Немає фінансових даних за обраний період', { exact: true }).count(), 0)
  await page.evaluate(() => { fixture.mode = 'ok' })
  await page.getByRole('button', {name:'Спробувати ще раз'}).click()
  await page.getByText('Контрольний касир', {exact:true}).waitFor()
  assert.equal(await exportButton.isEnabled(), true)
  console.log('PASS: failed reports stay distinct from zero turnover and retry loads real rows')

  await page.evaluate(() => { fixture.good = structuredClone(fixture.data); fixture.data[0].total_payouts = 1900; fixture.render() })
  await page.getByText('Звіт працівників містить неповні або неузгоджені дані', {exact:true}).waitFor()
  assert.equal(await exportButton.isDisabled(), true)
  assert.equal(await page.getByText('Контрольний касир', {exact:true}).count(), 0)
  await page.evaluate(() => { fixture.data = structuredClone(fixture.good); fixture.render() })
  await page.getByText('Контрольний касир', {exact:true}).waitFor()
  await exportButton.click()
  assert.deepEqual(await page.evaluate(() => ({
    paid:fixture.exported[0]['Виплачено за вибрані дні роботи, грн'],
    earned:fixture.exported[0]['Нараховано зарплати, грн'],
    result:fixture.exported[0]['Результат після нарахувань, грн'],
  })), {paid:9,earned:10,result:29.5})
  assert.equal(await page.getByText(/Рекомендована премія|Топ продажів|Чистий прибуток/).count(), 0)
  console.log('PASS: malformed totals cannot be shown/exported; real payroll columns replace invented bonuses')

  await page.evaluate(() => { fixture.requests=[];fixture.desktop=true;fixture.render() })
  // The old row has the same label; await the new render's request, not that old DOM.
  await page.waitForFunction(() => fixture.requests.length > 0)
  await page.getByText('Контрольний касир', {exact:true}).waitFor()
  assert.deepEqual(await page.evaluate(() => fixture.requests), [{
    input:{kind:'staff',startDate:'2026-10-01',endDate:'2026-10-04',from:'2026-09-30T21:00:00.000Z',to:'2026-10-04T20:59:59.999Z'}
  }])
  await page.evaluate(() => { fixture.requests=[];fixture.desktop='old';fixture.render() })
  await page.getByText('Для локальної аналітики запустіть оновлену програму',{exact:true}).waitFor()
  assert.equal((await page.evaluate(() => fixture.requests)).length,0)
  assert.equal(await exportButton.isDisabled(),true)
  console.log('PASS: desktop stays on local Kyiv-period data; missing bridge never falls back to web')

  await page.evaluate(() => { fixture.desktop=false;fixture.mode='ok';fixture.render() })
  await page.getByText('Контрольний касир',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Інший період',exact:true}).click()
  await page.getByLabel('Дата початку').fill('2026-10-05')
  await page.getByRole('alert').waitFor()
  assert.equal(await exportButton.isDisabled(),true)
  assert.equal(await page.getByText('Контрольний касир',{exact:true}).count(),0)
  await page.getByLabel('Дата завершення').fill('2026-10-05')
  await page.getByText('Контрольний касир',{exact:true}).waitFor()
  await page.evaluate(() => { fixture.mode='pending';fixture.data=[{...fixture.good[0],manager_name:'Застарілий результат'}] })
  await page.getByRole('button',{name:'Цей місяць',exact:true}).click()
  await page.waitForFunction(() => fixture.pending.length===1)
  assert.equal(await exportButton.isDisabled(),true)
  await page.evaluate(() => { fixture.mode='ok';fixture.data=structuredClone(fixture.good) })
  await page.getByRole('button',{name:'3 місяці',exact:true}).click()
  await page.getByText('Контрольний касир',{exact:true}).waitFor()
  await page.evaluate(() => fixture.pending.shift()())
  await page.waitForTimeout(100)
  assert.equal(await page.getByText('Застарілий результат',{exact:true}).count(),0)
  console.log('PASS: reversed dates and late responses cannot display or export another period')

  await page.evaluate(() => { fixture.data=[];fixture.render() })
  await page.getByText('Немає фінансових даних за обраний період',{exact:true}).waitFor()
  assert.equal(await page.getByRole('alert').count(),0)
  assert.equal(await exportButton.isDisabled(),true)

  await page.setViewportSize({width:390,height:844})
  await page.evaluate(() => { fixture.data=Array.from({length:30},(_,i)=>({...fixture.good[0],manager_id:'employee-'+i,
    manager_name:'Працівник із довгим ім’ям для перевірки мобільного звіту '+i}));fixture.render() })
  const last=page.getByText('Працівник із довгим ім’ям для перевірки мобільного звіту 29',{exact:true})
  await last.waitFor();await last.scrollIntoViewIfNeeded()
  assert.equal(await last.isVisible(),true)
  const layout=await page.evaluate(() => ({w:document.documentElement.scrollWidth,v:innerWidth,y:scrollY}))
  assert.ok(layout.w<=layout.v+1,JSON.stringify(layout));assert.ok(layout.y>0)
  await page.evaluate(() => scrollTo(0,0))
  await page.screenshot({path:process.env.TEMP+'/forsage-staff-report-mobile.png',fullPage:false})
  assert.deepEqual(errors,[])
  console.log('PASS: 390px layout has no horizontal overflow and reaches the last employee')
} finally {
  if(browser)await browser.close()
  await server.close()
}
