// Actual UI, synthetic employees/money, blocked external network. Never opens shop data.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')
const require=createRequire(path.join(root,'apps/web/package.json'))
const {createServer,transformWithEsbuild}=await import(pathToFileURL(require.resolve('vite')).href)
const {default:tailwindcss}=await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const mocks={
  '@/features/analytics/AnalyticsLayout':'export function AnalyticsLayout({children,title}){return <main><h1>{title}</h1>{children}</main>}',
  '@/features/admin/adminApi':'export const adminApi={listUsers:async()=>({data:fixture.users})};export const ROLE_LABELS={tire_worker:"Шиномонтажник"}',
  '@/features/staff/staffApi':'export const staffApi=fixture.staff',
  '@/features/pos/shiftApi':'export const shiftApi={current:()=>fixture.defer("shift",{})}',
  '@/features/reports/reportApi':'export const reportApi={soldItems:async()=>({data:[]})}',
  '@/lib/desktopBridge':'export const desktopBridge=()=>fixture.desktop?{}:null;export const isDesktopRuntime=()=>fixture.desktop',
  '@/stores/authStore':'export const useAuthStore=select=>select({session:{user:{id:"test-owner",app_metadata:{role:"owner"}}}})',
  '@/components/ui/Toast':'export const toast={error:m=>fixture.errors.push(m),success:m=>fixture.messages.push(m)};export function ToastContainer(){return null}',
}
const entry=`
import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';
import Payroll from'/src/features/analytics/PayrollPage.tsx';import DailyReport from'/src/features/reports/DailyReport.tsx';import'/src/index.css';
const root=createRoot(document.getElementById('root'));let version=0;
fixture.mount=()=>root.render(<MemoryRouter key={++version} initialEntries={['/analytics/sales?tab=tire&date=2026-09-22']}><>{fixture.mode==='tire'?<DailyReport/>:<Payroll/>}</></MemoryRouter>);
fixture.unmount=()=>root.render(<p>Test destination</p>);fixture.mount();
`
const bootstrap=`
window.fixture={mode:window.testMode??'payroll',desktop:window.testDesktop??true,failRead:window.testFail??false,delaySummary:false,pending:[],reads:[],errors:[],messages:[]};
fixture.users=['a','b'].map(id=>({id,full_name:'Worker '+id,is_active:true,role:'tire_worker'}));
fixture.defer=(kind,body)=>new Promise((resolve,reject)=>fixture.pending.push({kind,body,resolve,reject}));
fixture.rows=()=>fixture.users.map(u=>({employee_id:u.id,earned:12650,paid:0,balance:12650}));
fixture.staff={
 summary:async period=>{fixture.reads.push({kind:'summary',period});if(fixture.failRead)throw Error('Test payroll unavailable');if(fixture.delaySummary)return fixture.defer('summary',{period});return {data:fixture.rows()}},
 listSalary:async()=>({data:[{id:'payment-a',employee_id:'a',amount:500,type:'salary',method:'cash',created_at:'2026-09-22T10:00:00Z',note:'Test operation'}]}),
 dailySummary:async date=>{fixture.reads.push({kind:'daily',date});return {data:fixture.rows()}},
 createSalary:body=>fixture.defer('salary',body),dailyPayout:body=>fixture.defer('payout',body),deleteSalary:id=>fixture.defer('delete',{id}),
 tireServiceReport:async date=>{fixture.reads.push({kind:'tire',date});if(fixture.failRead)throw Error('Test tire report unavailable');return {date,details_version:1,data:[{employee_id:'a',employee_name:'Worker a',services_qty:1,service_revenue:10000,commission_earned:1260,daily_rate:0,earned:1260,paid:0,penalty:0,balance:1260,due:1260,cash_revenue:10000,cash_handed_over:0,cash_pending:10000,salary_available_on:'2026-09-24',salary_ready:true,payable_due:1260}],receipts:[],salary_operations:[],cash_handovers:[],totals:{services_qty:1,service_revenue:10000,cash_revenue:10000,cash_handed_over:0,cash_pending:10000,due:1260,payable_due:1260}}},
 tireCashHandover:body=>fixture.defer('handover',body)
};
`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[tailwindcss(),{
  name:'payroll-actions',enforce:'pre',resolveId(id){if(id==='virtual:payroll.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){if(id==='\0virtual:payroll.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const[name,mock]of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock;if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},
  configureServer(server){server.middlewares.use('/payroll-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/payroll-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:payroll.tsx"></script></body></html>'))})},
}]})
let browser
try{
  await server.listen();browser=await chromium.launch({headless:true});const base=server.resolvedUrls.local[0],errors=[],blocked=[]
  async function setup(mode='payroll',desktop=true,fail=false){
    const page=await browser.newPage({viewport:{width:1440,height:1100},timezoneId:'America/Los_Angeles'})
    await page.clock.install({time:new Date('2026-09-25T22:30:00Z')})
    page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});page.on('dialog',d=>d.accept())
    await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():(blocked.push(r.request().url()),r.abort()))
    await page.addInitScript(({mode,desktop,fail})=>{window.testMode=mode;window.testDesktop=desktop;window.testFail=fail},{mode,desktop,fail})
    await page.goto(base+'payroll-test');await page.waitForFunction(()=>typeof fixture.mount==='function');return page
  }
  const double=l=>l.evaluate(e=>{e.click();e.click()})
  const count=(p,kind)=>p.evaluate(kind=>fixture.pending.filter(p=>p.kind===kind).length,kind)
  const wait=(p,kind,n=1)=>p.waitForFunction(({kind,n})=>fixture.pending.filter(p=>p.kind===kind).length===n,{kind,n})
  const resolve=(p,kind,data)=>p.evaluate(({kind,data})=>fixture.pending.find(p=>p.kind===kind).resolve(data),{kind,data})
  const open=(p,id='a')=>p.getByRole('row').filter({hasText:'Worker '+id}).getByRole('button',{name:'Операції',exact:true}).click()

  const p=await setup();await open(p)
  assert.equal(await p.evaluate(()=>fixture.reads.find(r=>r.kind==='daily').date),'2026-09-26','Kyiv work day, not PC date')
  await p.getByPlaceholder('Сума, грн').fill('126,50');await p.getByPlaceholder('Примітка').fill('For worker a')
  await double(p.getByRole('button',{name:'Зберегти операцію',exact:true}));await wait(p,'shift')
  assert.equal(await p.getByPlaceholder('Сума, грн').isDisabled(),true)
  await p.keyboard.press('Escape');assert.equal(await p.getByRole('dialog').count(),1)
  await resolve(p,'shift',{data:{id:'shift-test'}});await wait(p,'salary')
  const payload=await p.evaluate(()=>fixture.pending.find(p=>p.kind==='salary').body)
  assert.equal(payload.amount,12650);assert.equal(payload.employee_id,'a');assert.equal(payload.work_date,'2026-09-26')
  await p.evaluate(()=>fixture.pending.find(p=>p.kind==='salary').reject(Error('Write failed')))
  await p.waitForFunction(()=>fixture.errors.includes('Write failed'));assert.equal(await p.getByPlaceholder('Сума, грн').inputValue(),'126,50')
  await p.getByPlaceholder('Сума, грн').fill('126junk');await p.getByRole('button',{name:'Зберегти операцію'}).click()
  await p.waitForFunction(()=>fixture.errors.length===2);assert.equal(await count(p,'salary'),1)
  await p.keyboard.press('Escape');await open(p,'b')
  assert.equal(await p.getByPlaceholder('Сума, грн').inputValue(),'');assert.equal(await p.getByPlaceholder('Примітка').inputValue(),'');await p.close()

  for(const fund of ['cashbox','owner_funds']){
    const page=await setup();await open(page)
    await double(page.getByRole('button',{name:fund==='cashbox'?'Видати денний заробіток з каси':'Видати коштами власника',exact:true}));await wait(page,'shift')
    assert.equal(await page.getByLabel('Попередній місяць').isDisabled(),true)
    await resolve(page,'shift',{data:{id:'shift-test'}});await wait(page,'payout')
    assert.equal(await page.evaluate(()=>fixture.pending.find(p=>p.kind==='payout').body.fund_source),fund)
    await page.evaluate(()=>fixture.failRead=true);await resolve(page,'payout',{data:{amount:12650}})
    await page.getByText(/Не вдалося оновити дані/).waitFor()
    assert.equal(await page.getByRole('button',{name:'Видати денний заробіток з каси'}).isDisabled(),true)
    await page.keyboard.press('Escape');await page.getByRole('alert').waitFor()
    await page.evaluate(()=>fixture.failRead=false);await page.getByRole('button',{name:'Повторити завантаження'}).click()
    await open(page);assert.equal(await count(page,'payout'),1,'Read retry must never repeat payment');await page.close()
  }

  const failed=await setup('payroll',true,true);await failed.getByRole('alert').waitFor()
  assert.equal(await failed.getByRole('button',{name:'Операції',exact:true}).count(),0)
  assert.equal(await failed.locator('body').innerText().then(t=>t.includes('0,00')),false,'Failure is not zero payroll')
  await failed.evaluate(()=>fixture.failRead=false);await failed.getByRole('button',{name:'Повторити завантаження'}).click();await open(failed);await failed.close()

  const readOnly=await setup('payroll',false);await open(readOnly)
  await readOnly.getByText(/У вебверсії доступний лише перегляд/).waitFor()
  assert.equal(await readOnly.getByPlaceholder('Сума, грн').count(),0);assert.equal(await readOnly.getByTitle('Скасувати операцію').count(),0);await readOnly.close()

  const del=await setup();await open(del);await double(del.getByTitle('Скасувати операцію'));await wait(del,'delete')
  assert.equal(await del.getByRole('button',{name:'Зберегти операцію'}).isDisabled(),true)
  await del.evaluate(()=>fixture.pending.find(p=>p.kind==='delete').reject(Error('Delete failed')))
  await del.waitForFunction(()=>fixture.errors.includes('Delete failed'));assert.equal(await del.locator('.analytics-payment-row').count(),1);await del.close()

  const stale=await setup();await open(stale);await stale.getByRole('button',{name:'Видати денний заробіток з каси'}).click();await wait(stale,'shift')
  await stale.evaluate(()=>fixture.unmount());await stale.getByText('Test destination').waitFor()
  await resolve(stale,'shift',{data:{id:'shift-test'}});await stale.waitForTimeout(50);assert.equal(await count(stale,'payout'),0);await stale.close()

  const late=await setup();await open(late);await late.getByPlaceholder('Сума, грн').fill('20')
  await late.getByRole('button',{name:'Зберегти операцію'}).click();await wait(late,'shift')
  await resolve(late,'shift',{data:{id:'shift-test'}});await wait(late,'salary')
  await late.evaluate(()=>fixture.unmount());await late.getByText('Test destination').waitFor()
  await late.evaluate(()=>fixture.mount());await open(late,'b');await late.getByPlaceholder('Сума, грн').fill('77')
  const readsBeforeLate=await late.evaluate(()=>fixture.reads.length)
  await resolve(late,'salary',{data:{id:'old-operation'}});await late.waitForTimeout(50)
  assert.equal(await late.getByPlaceholder('Сума, грн').inputValue(),'77')
  assert.equal(await late.evaluate(()=>fixture.reads.length),readsBeforeLate)
  assert.deepEqual(await late.evaluate(()=>fixture.messages),[]);await late.close()

  const periods=await setup();await periods.getByRole('button',{name:'Операції',exact:true}).first().waitFor()
  await periods.evaluate(()=>fixture.delaySummary=true)
  await periods.getByLabel('Попередній місяць').click();await wait(periods,'summary')
  await periods.getByLabel('Попередній місяць').click();await wait(periods,'summary',2)
  await periods.evaluate(()=>fixture.pending.filter(p=>p.kind==='summary')[1].resolve({data:fixture.rows().map(r=>({...r,earned:33300}))}))
  await periods.getByRole('button',{name:'Операції',exact:true}).first().waitFor()
  await periods.evaluate(()=>fixture.pending.filter(p=>p.kind==='summary')[0].resolve({data:fixture.rows().map(r=>({...r,earned:99900}))}))
  await periods.waitForTimeout(50);assert.equal((await periods.locator('body').innerText()).includes('999'),false);await periods.close()

  for(const [kind,fund] of [['handover',null],['payout','cashbox'],['payout','owner_funds']]){
    const tire=await setup('tire');const name=kind==='handover'?'Внести готівку до каси':fund==='cashbox'?'Виплатити з каси':'Виплатити коштами власника'
    await double(tire.getByRole('button',{name,exact:true}));await wait(tire,'shift')
    assert.equal(await tire.getByLabel('Дата робіт шиномонтажу').isDisabled(),true)
    await resolve(tire,'shift',{data:{id:'shift-test'}});await wait(tire,kind)
    assert.equal(await tire.evaluate(kind=>fixture.pending.find(p=>p.kind===kind).body.work_date,kind),'2026-09-22')
    if(fund)assert.equal(await tire.evaluate(()=>fixture.pending.find(p=>p.kind==='payout').body.fund_source),fund)
    const readCount=await tire.evaluate(()=>fixture.reads.length)
    await tire.evaluate(()=>fixture.unmount());await tire.getByText('Test destination').waitFor()
    await resolve(tire,kind,{data:{amount:1260}});await tire.waitForTimeout(50)
    assert.equal(await tire.evaluate(()=>fixture.reads.length),readCount,'Late mutation cannot start old report read')
    assert.deepEqual(await tire.evaluate(()=>fixture.messages),[]);await tire.close()
  }
  const tirePreflight=await setup('tire');await tirePreflight.getByRole('button',{name:'Внести готівку до каси'}).click();await wait(tirePreflight,'shift')
  await tirePreflight.evaluate(()=>fixture.unmount());await tirePreflight.getByText('Test destination').waitFor()
  await resolve(tirePreflight,'shift',{data:{id:'shift-test'}});await tirePreflight.waitForTimeout(50)
  assert.equal(await count(tirePreflight,'handover'),0);await tirePreflight.close()

  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log('PASS: payroll and tire cash single writes, exact comma amounts, Kyiv date, failed refresh/retry without replay, staff form isolation, stale month/preflight/replies, cancellation errors, read-only web. No live data.')
}finally{await browser?.close();await server.close()}
