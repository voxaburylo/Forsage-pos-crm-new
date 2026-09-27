// Real report UI, synthetic data only. Never opens a live database or a printer.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')
const require=createRequire(path.join(root,'apps/web/package.json'))
const {createServer,transformWithEsbuild}=await import(pathToFileURL(require.resolve('vite')).href)
const mocks={
  '@/features/analytics/AnalyticsLayout':'export function AnalyticsLayout({children}){return <main style={{padding:12,maxWidth:"100%",boxSizing:"border-box"}}>{children}</main>}',
  '@/stores/authStore':'export const useAuthStore=fn=>fn({session:{user:{app_metadata:{role:"owner"}}}})',
  '@/lib/desktopBridge':'export const isDesktopRuntime=()=>false;export const desktopBridge=()=>null',
  '@/features/staff/staffApi':'export const staffApi={tireServiceReport:async date=>{fixture.requests.push(date);if(date==="2026-09-20")await new Promise(r=>fixture.release=r);if(fixture.fail)throw Error("Test failure");return {...structuredClone(fixture.report),date}}}',
  '@/features/pos/shiftApi':'export const shiftApi={current:()=>{throw Error("No mutations in smoke test")}}',
  '@/features/reports/reportApi':'export const reportApi={}',
  '@/components/ui/Toast':'export const toast={error:m=>fixture.toasts.push(m),success:m=>fixture.toasts.push(m)};export function ToastContainer(){return null}',
}
const row={employee_id:'worker',employee_name:'Андрій',services_qty:61,service_revenue:2196000,commission_earned:768600,daily_rate:0,earned:768600,paid:0,penalty:0,balance:768600,due:768600,cash_revenue:2196000,cash_handed_over:0,cash_pending:2196000,salary_available_on:'2026-09-24',salary_ready:false,payable_due:0}
const fixture={fail:false,requests:[],toasts:[],report:{date:'2026-09-22',details_version:1,data:[row,{...row,employee_id:'worker2',employee_name:'Петро'}],
  receipts:Array.from({length:61},(_,i)=>({id:'sale-'+i,sale_number:'TIRE-'+i,completed_at:'2026-09-22T13:40:00Z',employee_id:'worker',employee_name:'Андрій',services_qty:1,service_revenue:36000,cash_revenue:36000,payment_method:'cash',total:36000,cashier_name:'Никита',notes:'Шиномонтаж: заміна 4 коліс R16. '+ 'ДовгийКоментар'.repeat(15),commission_earned:12600,services:[{id:'line-'+i,description:'Балансування',qty:1,unit_price:36000,total:36000}]})),
  salary_operations:[],cash_handovers:[],totals:{services_qty:61,service_revenue:2196000,cash_revenue:2196000,cash_handed_over:0,cash_pending:2196000,due:768600,payable_due:0}}}
const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import DailyReport from '@/features/reports/DailyReport';import '@/index.css';createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/analytics/sales?tab=tire&employee=worker&date=2026-09-22']}><DailyReport/></MemoryRouter>)`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[{
  name:'tire-report-fixture',enforce:'pre',resolveId(id){if(id==='virtual:tire.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){
    if(id==='\0virtual:tire.tsx')return transformWithEsbuild(entry,'tire.tsx',{loader:'tsx',jsx:'automatic'})
    let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined
    for(const[name,mock]of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock
    if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})
  },configureServer(server){server.middlewares.use('/tire-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/tire-test',`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script>window.fixture=${JSON.stringify(fixture)}</script><script type="module" src="/@id/__x00__virtual:tire.tsx"></script></body></html>`))})},
}]})
let browser
try{
  await server.listen();browser=await chromium.launch({headless:true})
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],blocked=[]
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});const base=server.resolvedUrls.local[0]
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin===new URL(base).origin)return route.continue();blocked.push(route.request().url());return route.abort()})
  await page.goto(base+'tire-test')
  await page.getByRole('heading',{name:'Шиномонтаж — роботи та зарплата'}).waitFor()
  const andrii=page.getByRole('article',{name:'Роботи та зарплата: Андрій'})
  await andrii.waitFor();assert.equal(await page.getByLabel('Дата робіт шиномонтажу').inputValue(),'2026-09-22')
  assert.equal(await page.getByLabel('Працівник шиномонтажу').inputValue(),'worker')
  assert.equal(await page.getByRole('region',{name:/^Чек TIRE-/}).count(),50)
  await page.getByRole('button',{name:'Ще чеки (11)'}).click()
  assert.equal(await page.getByRole('region',{name:/^Чек TIRE-/}).count(),61)
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Експорт в Excel'}).click()
  const download=await downloadPromise;const XLSX=require('xlsx');const workbook=XLSX.readFile(await download.path())
  assert.deepEqual(workbook.SheetNames,['Підсумок','Чеки','Операції']);assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['Чеки']).length,61)
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['Підсумок']).length,1)
  await page.getByLabel('Працівник шиномонтажу').selectOption('worker2')
  await page.getByRole('article',{name:'Роботи та зарплата: Петро'}).waitFor()
  assert.equal(await page.getByRole('region',{name:/^Чек TIRE-/}).count(),0)
  await page.getByLabel('Працівник шиномонтажу').selectOption('worker')
  await page.setViewportSize({width:360,height:780})
  await andrii.waitFor();await andrii.getByRole('heading',{name:'Розрахунок зарплати за 22.09.2026'}).scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'Mobile report must not scroll horizontally')
  assert.equal(await page.getByRole('button',{name:'Виплатити з каси'}).count(),0)
  assert.equal(await page.getByRole('button',{name:'Внести готівку до каси'}).count(),0)
  await page.getByLabel('Дата робіт шиномонтажу').fill('2026-09-20');await page.waitForFunction(()=>typeof fixture.release==='function')
  await page.getByLabel('Дата робіт шиномонтажу').fill('2026-09-21')
  await page.getByRole('heading',{name:'Розрахунок зарплати за 21.09.2026'}).waitFor()
  await page.evaluate(()=>fixture.release());await page.waitForTimeout(100)
  assert.equal(await page.getByRole('heading',{name:'Розрахунок зарплати за 20.09.2026'}).count(),0)
  await page.evaluate(()=>fixture.fail=true);await page.getByRole('button',{name:'Оновити',exact:true}).click()
  await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('article').count(),0)
  await page.evaluate(()=>fixture.fail=false);await page.getByRole('button',{name:'Оновити',exact:true}).click();await andrii.waitFor()
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log('PASS: deep link, worker/date filters, 61 receipts without hidden cap, three-sheet Excel, readable 360px layout, reachable salary footer, read-only web, stale-response protection, error/retry')
}finally{await browser?.close();await server.close()}
