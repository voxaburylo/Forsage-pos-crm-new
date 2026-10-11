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
const row={employee_id:'worker',employee_name:'Андрій',services_qty:61,service_revenue:2196000,commission_earned:768600,daily_rate:0,earned:768600,paid:0,penalty:0,balance:768600,due:768600,cash_revenue:2196000,cash_register_received:2196000,cash_handed_over:0,cash_pending:0,salary_available_on:'2026-09-24',salary_ready:false,payable_due:0}
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
  assert.equal((await andrii.innerText()).includes('Готівка за чеками, вже врахована в касі'),true)
  assert.equal((await andrii.innerText()).includes('Повторне внесення не потрібне'),true)
  assert.equal((await andrii.innerText()).includes('ще передати'),false)
  await page.getByLabel('Дата робіт шиномонтажу').fill('2026-09-20');await page.waitForFunction(()=>typeof fixture.release==='function')
  await page.getByLabel('Дата робіт шиномонтажу').fill('2026-09-21')
  await page.getByRole('heading',{name:'Розрахунок зарплати за 21.09.2026'}).waitFor()
  await page.evaluate(()=>fixture.release());await page.waitForTimeout(100)
  assert.equal(await page.getByRole('heading',{name:'Розрахунок зарплати за 20.09.2026'}).count(),0)
  await page.evaluate(()=>fixture.fail=true);await page.getByRole('button',{name:'Оновити',exact:true}).click()
  await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('article').count(),0)
  await page.evaluate(()=>fixture.fail=false);await page.getByRole('button',{name:'Оновити',exact:true}).click();await andrii.waitFor()
  // Display/export contract for an original receipt and later dated reversals.
  // Real refund writes are covered by the desktop native/repository tests.
  await page.evaluate(()=>{
    const receipt={...fixture.report.receipts[0],sale_number:'RETURN-HISTORY-360',services_qty:2,
      services:[{id:'return-history-line',description:'Балансування',qty:2,unit_price:18000,total:36000}]}
    const worker={...fixture.report.data[0],services_qty:2,service_revenue:36000,commission_earned:12600,
      earned:12600,paid:0,balance:12600,due:12600,cash_revenue:36000,cash_register_received:36000}
    fixture.originalReport={...fixture.report,date:'2026-09-22',data:[worker],receipts:[receipt],salary_operations:[],
      totals:{services_qty:2,service_revenue:36000,cash_revenue:36000,cash_register_received:36000,
        cash_handed_over:0,cash_pending:0,due:12600,payable_due:0}}
  })
  for(const day of ['2026-09-23','2026-09-24']){
    await page.evaluate(day=>{
      const original=fixture.originalReport
      const worker={...original.data[0],services_qty:0,service_revenue:0,commission_earned:-6300,
        earned:-6300,paid:0,balance:-6300,due:0,payable_due:0,cash_revenue:0,cash_register_received:0}
      fixture.report={...original,date:day,data:[worker],receipts:[],
        salary_operations:[{id:'reversal-'+day,employee_id:'worker',type:'bonus',source:'commission_reversal',
          amount:-6300,method:'cash',note:'Повернення робіт за 22 вересня',work_date:day,
          created_at:day+'T08:00:00Z',created_by:'cashier',cashier_name:'Никита',sale_id:'sale-0',fund_source:null}],
        totals:{...original.totals,services_qty:0,service_revenue:0,cash_revenue:0,cash_register_received:0,due:0}}
    },day)
    await page.getByLabel('Дата робіт шиномонтажу').fill(day)
    await andrii.getByRole('heading',{name:'Розрахунок зарплати за '+day.split('-').reverse().join('.')}).waitFor()
    const text=await andrii.innerText()
    assert(text.includes('Сторно нарахування за повернення'))
    assert(text.includes('-63,00'))
    assert(text.includes('Від’ємний залишок зарплати'))
    assert(!text.includes('Виплачено наперед'))
    assert.equal(await page.getByRole('region',{name:/^Чек /}).count(),0)
    const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Експорт в Excel'}).click()
    const file=await downloading,book=XLSX.readFile(await file.path())
    const operations=XLSX.utils.sheet_to_json(book.Sheets['Операції'])
    assert.equal(operations.length,1);assert.equal(operations[0]['Сума (грн)'],-63)
    assert.equal(operations[0]['День робіт'],day)
    assert.equal(operations[0]['Операція'],'Сторно нарахування за повернення')
    assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Підсумок'])[0]['Процент (грн)'],-63)
    assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Чеки']).length,0)
  }
  await page.evaluate(()=>{fixture.report=structuredClone(fixture.originalReport)})
  await page.getByLabel('Дата робіт шиномонтажу').fill('2026-09-22')
  await page.getByRole('region',{name:'Чек RETURN-HISTORY-360'}).waitFor()
  const historyDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Експорт в Excel'}).click()
  const historyFile=await historyDownload,historyBook=XLSX.readFile(await historyFile.path())
  const originalRows=XLSX.utils.sheet_to_json(historyBook.Sheets['Чеки'])
  assert.equal(originalRows.length,1);assert.equal(originalRows[0]['День робіт'],'2026-09-22')
  assert.equal(originalRows[0]['Сума робіт (грн)'],360)
  assert.equal(originalRows[0]['Нарахування за чек (грн)'],126)
  assert.equal(XLSX.utils.sheet_to_json(historyBook.Sheets['Операції']).length,0)
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log('PASS: deep link, worker/date filters, 61 receipts without hidden cap, three-sheet Excel, readable 360px layout, reachable salary footer, read-only web, stale-response protection, error/retry, original receipt and two dated negative reversals in UI/Excel')
}finally{await browser?.close();await server.close()}
