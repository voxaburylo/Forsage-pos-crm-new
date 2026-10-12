// Real forms with delayed synthetic writes; no live accounts, money or database.
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
  '@/features/customers/customerApi':'export const customerApi=fixture.customers',
  '@/features/customers/customerVehiclesApi':'export const customerVehiclesApi=fixture.vehicles',
  '@/features/pos/posCustomerMoneyApi':'export const posCustomerMoneyApi={getDeposit:async()=>({data:{balance:0}})}',
  '@/features/admin/pricingApi':'export const pricingApi={listTiers:async()=>({data:[]})}',
  '@/features/admin/adminApi':'export const adminApi=fixture.admin;export const ROLE_LABELS={cashier:"Касир",tire_worker:"Шиномонтажник"}',
  '@/features/staff/staffApi':'export const staffApi=fixture.staff',
  '@/features/settings/commissionApi':'export const commissionApi={listRules:async()=>({data:[]})}',
  '@/features/pos/shiftApi':'export const shiftApi={current:()=>fixture.defer("shift",{})}',
  '@/lib/desktopBridge':'export const desktopBridge=()=>({});export const isDesktopRuntime=()=>true',
  '@/lib/offlineDB':'export const searchCustomersOffline=async()=>[]',
  '@/stores/authStore':'export const useAuthStore=select=>select({session:{user:{id:"owner",app_metadata:{role:"owner"}}}})',
  '@/components/ui/Toast':'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.warnings.push(m),success:m=>fixture.messages.push(m)};export function ToastContainer(){return null}',
  '@/components/Layout':'export function Layout({children,title}){return <main><h1>{title}</h1>{children}</main>}',
  '@/features/analytics/AnalyticsLayout':'export function AnalyticsLayout({children,title}){return <main><h1>{title}</h1>{children}</main>}',
}
const entry=`
import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import{createMemoryRouter,RouterProvider,Routes,Route,useNavigate,useLocation,useParams}from'react-router-dom';
import Form from'/src/features/customers/CustomerFormPage.tsx';import{QuickCustomerModal}from'/src/features/customers/QuickCustomerModal.tsx';import{QuickCustomerEditModal,CustomerEditor}from'/src/features/customers/QuickCustomerEditModal.tsx';import{NavigationGuard,useUnsavedChanges}from'/src/hooks/useUnsavedChanges.ts';import Staff from'/src/features/staff/StaffPage.tsx';import Payroll from'/src/features/analytics/PayrollPage.tsx';import{ConfirmDialog}from'/src/components/ui/ConfirmDialog.tsx';import'/src/index.css';
function FullEditor(){const{id}=useParams();const[draft,setDraft]=useState({dirty:false,busy:false});useUnsavedChanges(draft.dirty,draft.busy);return <CustomerEditor key={id} inline open customer={fixture.customer(id)} onClose={()=>{}} onDraftStateChange={setDraft} onSaved={c=>fixture.selected.push(c)}/>}
function App(){const[open,setOpen]=useState(true),[id,setId]=useState('a'),[mounted,setMounted]=useState(true);const navigate=useNavigate(),location=useLocation();useEffect(()=>{fixture.go=navigate;fixture.show=setOpen;fixture.switchCustomer=setId;fixture.unmount=()=>setMounted(false)},[navigate]);const close=()=>{fixture.closes++;setOpen(false)};return <><NavigationGuard/><div data-testid="location">{location.pathname}</div>{mounted&&(fixture.mode==='quick'?<QuickCustomerModal open={open} onClose={close} onCreated={c=>fixture.selected.push(c)}/>:fixture.mode==='edit'?<QuickCustomerEditModal open={open} customer={fixture.customer(id)} onClose={close} onSaved={c=>fixture.selected.push(c)}/>:fixture.mode==='confirm'?<ConfirmDialog open={open} title="Test confirmation" onClose={close} onConfirm={()=>fixture.defer('confirm',{})}/>:fixture.mode==='staff'?<Staff/>:fixture.mode==='payroll'?<Payroll/>:<Routes><Route path='/customers/new' element={<Form/>}/><Route path='/customers/:id/edit' element={<Form/>}/><Route path='/customers/:id' element={<FullEditor/>}/><Route path='*' element={<p>Destination</p>}/></Routes>)}</>}
createRoot(document.getElementById('root')).render(<RouterProvider router={createMemoryRouter([{path:'*',element:<App/>}],{initialEntries:[fixture.route]})}/>);`
const bootstrap=`
window.fixture={mode:window.testMode,route:window.testRoute??'/customers/new',pending:[],reads:[],salaryReads:[],errors:[],warnings:[],messages:[],selected:[],closes:0,salaryPayments:window.testSalaryPayments??[]};
fixture.customer=id=>({id,phone:'+38067111111'+(id==='a'?'1':'2'),full_name:'Client '+id,email:'',notes:'',tags:[],card_barcode:null,discount_pct:0,client_status:'client',loyalty_mode:'discount',bonus_balance:0,debt_balance:0,updated_at:'version-'+id});
fixture.defer=(kind,body)=>new Promise((resolve,reject)=>fixture.pending.push({kind,body,resolve,reject}));
fixture.customers={list:async()=>({data:[]}),get:id=>fixture.mode==='full'?new Promise((resolve,reject)=>fixture.reads.push({id,resolve,reject})):Promise.resolve({data:fixture.customer(id)}),create:body=>fixture.defer('customer-create',body),update:(id,body)=>fixture.defer('customer-update',{id,...body})};
fixture.vehicles={list:id=>fixture.defer('garage',{id}),create:(id,body)=>fixture.defer('car-create',{id,...body}),update:(id,carId,body)=>fixture.defer('car-update',{id,carId,...body}),delete:(id,carId)=>fixture.defer('car-delete',{id,carId})};
fixture.worker={id:'worker',full_name:'Test Worker',phone:'+380674444444',email:'',role:'cashier',is_active:true,base_rate:10000,rate_period:'day'};
fixture.admin={listUsers:async()=>({data:[fixture.worker]}),createUser:body=>fixture.defer('staff-create',body),saveUserSettings:(id,body,rules)=>fixture.defer('staff-settings',{id,body,rules}),resetPassword:(id,password)=>fixture.defer('password',{id,password}),deleteUser:id=>fixture.defer('archive',{id}),restoreUser:id=>fixture.defer('restore',{id})};
fixture.staff={summary:async period=>{fixture.salaryReads.push({kind:'summary',period});return {data:[]}},listSalary:async period=>{fixture.salaryReads.push({kind:'history',period});return {data:fixture.salaryPayments}},dailySummary:async date=>{fixture.salaryReads.push({kind:'daily',date});return {data:[{employee_id:'worker',earned:12600,paid:0,balance:12600}]}},setPin:(id,pin)=>fixture.defer('pin',{id,pin}),createSalary:body=>fixture.defer('salary',body),dailyPayout:body=>fixture.defer('payout',body),deleteSalary:id=>fixture.defer('salary-delete',{id})};
`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[tailwindcss(),{
  name:'customer-staff-actions',enforce:'pre',resolveId(id){if(id==='virtual:actions.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){if(id==='\0virtual:actions.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const[name,mock]of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock;if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},
  configureServer(server){server.middlewares.use('/actions-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/actions-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:actions.tsx"></script></body></html>'))})},
}]})
let browser
try{
  await server.listen();browser=await chromium.launch({headless:true});const base=server.resolvedUrls.local[0],errors=[],blocked=[]
  async function setup(mode,route='/customers/new',salaryPayments=[],{timezoneId,now}={}){
    const page=await browser.newPage({viewport:{width:1400,height:1100},timezoneId})
    if(now)await page.clock.setFixedTime(new Date(now))
    page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});page.on('dialog',d=>d.accept())
    await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():(blocked.push(r.request().url()),r.abort()))
    await page.addInitScript(({mode,route,salaryPayments})=>{window.testMode=mode;window.testRoute=route;window.testSalaryPayments=salaryPayments},{mode,route,salaryPayments})
    await page.goto(base+'actions-test');await page.waitForFunction(()=>typeof fixture.go==='function')
    return page
  }
  const double=locator=>locator.evaluate(element=>{element.click();element.click()})
  const count=(page,kind)=>page.evaluate(kind=>fixture.pending.filter(p=>p.kind===kind).length,kind)
  const wait=(page,kind,n=1)=>page.waitForFunction(({kind,n})=>fixture.pending.filter(p=>p.kind===kind).length===n,{kind,n})
  const openPayroll=page=>page.getByRole('row').filter({hasText:'Test Worker'}).getByRole('button',{name:'Операції',exact:true}).click()
  const dayCases=[
    ['2026-09-30T20:59:59.000Z','2026-09-30'],
    ['2026-09-30T21:00:00.000Z','2026-10-01'],
    ['2026-12-31T21:59:59.000Z','2026-12-31'],
    ['2026-12-31T22:00:00.000Z','2027-01-01'],
  ]
  const observedDays=[],expectedDays=[]
  for(const timezoneId of ['America/Los_Angeles','Asia/Tokyo','Europe/Moscow'])for(const [now,expectedDate] of dayCases){
    const day=await setup('payroll','/analytics/payroll',[],{timezoneId,now})
    await openPayroll(day)
    const reads=await day.evaluate(()=>fixture.salaryReads)
    const initialPeriod=await day.locator('input[type="month"]').inputValue()
    await day.getByRole('dialog').locator('select').first().selectOption('salary')
    await day.getByPlaceholder('Сума, грн').fill('126,50')
    await double(day.getByRole('button',{name:'Зберегти операцію',exact:true}));await wait(day,'salary')
    const salary=await day.evaluate(()=>fixture.pending.find(p=>p.kind==='salary').body)
    await day.evaluate(()=>fixture.pending.find(p=>p.kind==='salary').reject(Error('Boundary salary failure')))
    await day.waitForFunction(()=>fixture.errors.includes('Boundary salary failure'))
    await day.keyboard.press('Escape');await openPayroll(day)
    await double(day.getByRole('button',{name:'Видати денний заробіток з каси',exact:true}));await wait(day,'shift')
    await day.evaluate(()=>fixture.pending.find(p=>p.kind==='shift').resolve({data:{id:'boundary-shift'}}));await wait(day,'payout')
    const payout=await day.evaluate(()=>fixture.pending.find(p=>p.kind==='payout').body)
    observedDays.push({timezoneId,now,reads,initialPeriod,salaryDate:salary.work_date,salaryPeriod:salary.period,payoutDate:payout.work_date})
    expectedDays.push({timezoneId,now,reads:[{kind:'summary',period:expectedDate.slice(0,7)},{kind:'history',period:expectedDate.slice(0,7)},{kind:'daily',date:expectedDate}],
      initialPeriod:expectedDate.slice(0,7),salaryDate:expectedDate,salaryPeriod:expectedDate.slice(0,7),payoutDate:expectedDate})
    assert.equal(salary.amount,12650);assert.equal(salary.employee_id,'worker');assert.equal(payout.employee_id,'worker')
    assert.equal(await count(day,'salary'),1);assert.equal(await count(day,'shift'),1);assert.equal(await count(day,'payout'),1)
    await day.evaluate(()=>fixture.pending.find(p=>p.kind==='payout').reject(Error('Boundary payout failure')))
    await day.waitForFunction(()=>fixture.errors.includes('Boundary payout failure'));await day.close()
  }
  assert.deepEqual(observedDays,expectedDays,'Initial month, daily summary, salary creation and payout use the same Kyiv working day on every PC')

  const crossedPreflights=[],expectedPreflights=[]
  for(const [before,after,workDate] of [
    ['2026-09-30T20:59:59.000Z','2026-09-30T21:00:00.000Z','2026-09-30'],
    ['2026-12-31T21:59:59.000Z','2026-12-31T22:00:00.000Z','2026-12-31'],
  ])for(const kind of ['salary','payout']){
    const midnight=await setup('payroll','/analytics/payroll',[],{timezoneId:'Europe/Kyiv',now:before})
    await openPayroll(midnight)
    if(kind==='salary'){
      await midnight.getByRole('dialog').locator('select').first().selectOption('advance')
      await midnight.getByPlaceholder('Сума, грн').fill('126,50')
    }
    const action=midnight.getByRole('button',{name:kind==='salary'?'Зберегти операцію':'Видати денний заробіток з каси',exact:true})
    await double(action);await wait(midnight,'shift')
    await midnight.clock.setFixedTime(new Date(after));await double(action)
    assert.equal(await count(midnight,'shift'),1,'Busy duplicate clicks do not start another preflight')
    await midnight.evaluate(()=>fixture.pending.find(p=>p.kind==='shift').resolve({data:{id:'midnight-shift'}}));await wait(midnight,kind)
    const body=await midnight.evaluate(kind=>fixture.pending.find(p=>p.kind===kind).body,kind)
    crossedPreflights.push({kind,before,after,workDate:body.work_date,...(kind==='salary'?{period:body.period}:{})})
    expectedPreflights.push({kind,before,after,workDate,...(kind==='salary'?{period:workDate.slice(0,7)}:{})})
    assert.equal(await count(midnight,kind),1)
    await midnight.evaluate(kind=>fixture.pending.find(p=>p.kind===kind).reject(Error('Midnight fixture failure')),kind)
    await midnight.waitForFunction(()=>fixture.errors.includes('Midnight fixture failure'));await midnight.close()
  }
  assert.deepEqual(crossedPreflights,expectedPreflights,'An action keeps the Kyiv day captured before its awaited shift check')

  // Selecting an earlier month is deliberate; only the current working day comes from Kyiv.
  const past=await setup('payroll','/analytics/payroll',[],{timezoneId:'America/Los_Angeles',now:'2026-09-30T21:00:00.000Z'})
  await past.getByRole('button',{name:'Операції',exact:true}).waitFor()
  await past.getByLabel('Попередній місяць').click()
  assert.equal(await past.locator('input[type="month"]').inputValue(),'2026-09')
  await past.locator('input[type="month"]').fill('2026-08')
  await openPayroll(past)
  await past.getByPlaceholder('Сума, грн').fill('126,50')
  await past.getByPlaceholder('Примітка').fill('Explicit August salary')
  await past.getByRole('dialog').locator('select').first().selectOption('advance')
  for(let attempt=1;attempt<=2;attempt++){
    await double(past.getByRole('button',{name:'Зберегти операцію',exact:true}));await wait(past,'shift',attempt)
    await past.evaluate(attempt=>fixture.pending.filter(p=>p.kind==='shift')[attempt-1].resolve({data:{id:'past-period-shift'}}),attempt)
    await wait(past,'salary',attempt)
    assert.deepEqual(await past.evaluate(attempt=>fixture.pending.filter(p=>p.kind==='salary')[attempt-1].body,attempt),{
      employee_id:'worker',employee_name:'Test Worker',amount:12650,type:'advance',method:'cash',period:'2026-08',
      note:'Explicit August salary',shift_id:'past-period-shift',work_date:'2026-10-01',
    },'An explicit salary period is not replaced by the current working month')
    if(attempt===1){
      await past.evaluate(()=>fixture.pending.find(p=>p.kind==='salary').reject(Error('Retry this explicit period')))
      await past.waitForFunction(()=>fixture.errors.includes('Retry this explicit period'))
      assert.equal(await past.locator('input[type="month"]').inputValue(),'2026-08')
      assert.equal(await past.getByPlaceholder('Сума, грн').inputValue(),'126,50')
      assert.equal(await past.getByPlaceholder('Примітка').inputValue(),'Explicit August salary')
    }else{
      await past.evaluate(()=>fixture.pending.filter(p=>p.kind==='salary')[1].resolve({data:{id:'saved-explicit-period'}}))
      await past.waitForFunction(()=>fixture.messages.includes('Операцію збережено'))
      await past.waitForFunction(()=>fixture.salaryReads.filter(r=>r.kind==='summary').length===4)
    }
  }
  assert.equal(await count(past,'salary'),2,'One failed attempt plus one manual retry; no duplicate submissions')
  assert.deepEqual(await past.evaluate(()=>fixture.salaryReads.filter(r=>r.kind==='summary').map(r=>r.period)),['2026-10','2026-09','2026-08','2026-08'])
  assert.equal(await past.locator('input[type="month"]').inputValue(),'2026-08')
  await past.close()

  const timestampCases=[
    ['summer-before','2026-09-30T20:59:59.000Z','30.09.2026'],
    ['summer-after','2026-09-30T21:00:00.000Z','01.10.2026'],
    ['winter-before','2026-12-31T21:59:59.000Z','31.12.2026'],
    ['winter-after','2026-12-31T22:00:00.000Z','01.01.2027'],
    ['explicit-offset','2026-10-01T00:00:00+03:00','01.10.2026'],
    ['invalid','not-a-timestamp','Invalid Date'],
  ]
  const timestampPayments=timestampCases.map(([id,created_at])=>({id,employee_id:'worker',employee_name:'Test Worker',
    amount:12600,type:'advance',method:'cash',period:'2026-09',work_date:'2026-09-29',created_at,note:'Timestamp '+id}))
  for(const timezoneId of ['America/Los_Angeles','Asia/Tokyo']){
    const timestamps=await setup('payroll','/analytics/payroll',timestampPayments,{timezoneId})
    await openPayroll(timestamps)
    for(const [id,,expected] of timestampCases){
      const row=timestamps.locator('.analytics-payment-row').filter({hasText:'Timestamp '+id})
      assert.ok((await row.locator('p.text-xs').innerText()).startsWith(expected),`${timezoneId}: ${id} displays actual creation date in Kyiv`)
      assert.equal((await row.locator('strong').innerText()).replace(/\s+/g,' '),'−126,00 ₴')
    }
    assert.deepEqual(await timestamps.evaluate(()=>fixture.salaryPayments),timestampPayments,'Date rendering leaves salary period, work date and timestamp unchanged')
    assert.deepEqual(await timestamps.evaluate(()=>fixture.pending),[],'Viewing timestamps creates no salary operation')
    await timestamps.close()
  }
  const quick=await setup('quick');await quick.getByRole('button',{name:'Новий клієнт',exact:true}).click()
  await quick.getByLabel('Телефон *',{exact:true}).fill('+380671234567')
  await quick.getByLabel("Ім'я",{exact:true}).fill('New client')
  await quick.locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit()});await wait(quick,'customer-create')
  assert.equal(await quick.getByLabel("Ім'я",{exact:true}).isDisabled(),true)
  await quick.keyboard.press('Escape');assert.equal(await quick.getByRole('dialog').count(),1)
  await quick.evaluate(()=>fixture.show(false));await quick.getByRole('dialog').waitFor({state:'detached'})
  await quick.evaluate(()=>fixture.show(true));await quick.getByRole('dialog').waitFor()
  await quick.getByRole('button',{name:'Новий клієнт',exact:true}).click()
  await quick.getByLabel('Телефон *',{exact:true}).fill('+380679999999')
  await quick.getByLabel("Ім'я",{exact:true}).fill('Current client')
  await quick.locator('form').evaluate(form=>form.requestSubmit());await wait(quick,'customer-create',2)
  await quick.evaluate(()=>fixture.pending.find(p=>p.kind==='customer-create').resolve({data:fixture.customer('a')}))
  await quick.waitForTimeout(100)
  assert.equal(await quick.evaluate(()=>fixture.selected.length),0);assert.equal(await quick.getByRole('dialog').count(),1)
  assert.equal(await quick.getByLabel("Ім'я",{exact:true}).isDisabled(),true,'old finally must not enable a newer save')
  await quick.evaluate(()=>fixture.pending.filter(p=>p.kind==='customer-create')[1].resolve({data:fixture.customer('b')}))
  await quick.getByRole('dialog').waitFor({state:'detached'})
  assert.deepEqual(await quick.evaluate(()=>fixture.selected.map(c=>c.id)),['b']);await quick.close()
  const full=await setup('full','/customers/a/edit');await full.waitForFunction(()=>fixture.reads.length===1)
  await full.evaluate(()=>fixture.go('/customers/b/edit'));await full.waitForFunction(()=>fixture.reads.length===2)
  await full.evaluate(()=>fixture.reads[1].resolve({data:fixture.customer('b')}))
  await full.getByLabel("Ім'я",{exact:true}).fill('Edited B')
  await full.evaluate(()=>fixture.reads[0].resolve({data:fixture.customer('a')}));await full.waitForTimeout(100)
  assert.equal(await full.getByLabel("Ім'я",{exact:true}).inputValue(),'Edited B')
  await full.locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit()});await wait(full,'customer-update')
  assert.equal(await full.evaluate(()=>fixture.pending.find(p=>p.kind==='customer-update').body.id),'b')
  assert.equal(await full.evaluate(()=>fixture.pending.find(p=>p.kind==='customer-update').body.expected_updated_at),'version-b')
  assert.equal(await full.evaluate(()=>fixture.pending.find(p=>p.kind==='customer-update').body.full_name),'Edited B')
  await full.evaluate(()=>fixture.go('/elsewhere'));await full.waitForTimeout(100)
  assert.equal(await full.getByTestId('location').innerText(),'/customers/b','pending card save blocks navigation')
  await full.evaluate(()=>fixture.unmount());await full.locator('form').waitFor({state:'detached'})
  await full.evaluate(()=>fixture.go('/elsewhere'));await full.waitForFunction(()=>document.querySelector('[data-testid=location]').textContent==='/elsewhere')
  await full.evaluate(()=>fixture.pending.find(p=>p.kind==='customer-update').resolve({data:fixture.customer('b')}));await full.waitForTimeout(100)
  assert.equal(await full.getByTestId('location').innerText(),'/elsewhere');await full.close()
  const edit=await setup('edit');await wait(edit,'garage')
  const addCar=edit.getByRole('button',{name:'Додати автомобіль',exact:true})
  assert.equal(await addCar.isDisabled(),true)
  await edit.evaluate(()=>fixture.pending.find(p=>p.kind==='garage').resolve({data:[]}))
  await edit.getByLabel('Марка *',{exact:true}).fill('Test brand');await edit.getByLabel('Модель *',{exact:true}).fill('Test model')
  await double(addCar);await wait(edit,'car-create');await edit.keyboard.press('Escape')
  assert.equal(await edit.getByRole('dialog').count(),1)
  await edit.evaluate(()=>fixture.switchCustomer('b'));await wait(edit,'garage',2)
  await edit.evaluate(()=>{fixture.pending.filter(p=>p.kind==='garage')[1].resolve({data:[]});fixture.pending.find(p=>p.kind==='car-create').resolve({data:{id:'old-car',brand:'WRONG CUSTOMER',model:'Late'}})})
  await edit.waitForTimeout(100);assert.equal(await edit.getByText('WRONG CUSTOMER Late').count(),0)
  await edit.locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit()});await wait(edit,'customer-update')
  await edit.evaluate(()=>fixture.switchCustomer('a'));await wait(edit,'garage',3)
  await edit.evaluate(()=>fixture.pending.find(p=>p.kind==='customer-update').resolve({data:fixture.customer('b')}));await edit.waitForTimeout(100)
  assert.equal(await edit.evaluate(()=>fixture.selected.length),0);assert.equal(await edit.getByRole('dialog').count(),1);await edit.close()
  const staff=await setup('payroll','/analytics/payroll');await openPayroll(staff)
  await staff.getByRole('dialog').locator('select').first().selectOption('salary')
  await staff.getByPlaceholder('Сума, грн').fill('126,50')
  await double(staff.getByRole('button',{name:'Зберегти операцію',exact:true}));await wait(staff,'salary')
  assert.equal(await staff.evaluate(()=>fixture.pending.find(p=>p.kind==='salary').body.amount),12650)
  assert.equal(await staff.getByPlaceholder('Сума, грн').isDisabled(),true)
  await staff.keyboard.press('Escape');assert.equal(await staff.getByRole('dialog').count(),1)
  await staff.evaluate(()=>fixture.pending.find(p=>p.kind==='salary').reject(Error('Test write failure')))
  await staff.waitForFunction(()=>fixture.errors.includes('Test write failure'))
  assert.equal(await staff.getByPlaceholder('Сума, грн').inputValue(),'126,50')
  await staff.getByPlaceholder('Сума, грн').fill('126junk');await staff.getByRole('button',{name:'Зберегти операцію',exact:true}).click()
  await staff.waitForTimeout(100);assert.equal(await count(staff,'salary'),1);await staff.close()
  for (const fund of ['cashbox','owner_funds']) {
    const payout=await setup('payroll','/analytics/payroll');await openPayroll(payout)
    await double(payout.getByRole('button',{name:fund==='cashbox'?'Видати денний заробіток з каси':'Видати коштами власника',exact:true}));await wait(payout,'shift')
    await payout.keyboard.press('Escape');assert.equal(await payout.getByRole('dialog').count(),1)
    await payout.evaluate(()=>fixture.pending.find(p=>p.kind==='shift').resolve({data:{id:'test-shift'}}));await wait(payout,'payout')
    assert.equal(await payout.evaluate(()=>fixture.pending.find(p=>p.kind==='payout').body.fund_source),fund)
    await payout.evaluate(()=>fixture.pending.find(p=>p.kind==='payout').resolve({data:{amount:12600}}))
    await payout.waitForFunction(()=>fixture.messages.some(m=>m.includes('Виплачено')));await payout.close()
  }
  const access=await setup('staff');await access.getByRole('button',{name:/Test Worker/}).click()
  await access.getByRole('dialog').waitFor()
  assert.equal(await access.getByPlaceholder('0000',{exact:true}).count(),0, 'PIN editor removed')
  await access.getByPlaceholder('Мінімум 8 символів',{exact:true}).fill('synthetic-password')
  await double(access.getByPlaceholder('Мінімум 8 символів',{exact:true}).locator('..').getByRole('button'));await wait(access,'password')
  await access.evaluate(()=>fixture.unmount());await access.getByRole('dialog').waitFor({state:'detached'})
  await access.evaluate(()=>fixture.pending.find(p=>p.kind==='password').resolve());await access.waitForTimeout(100)
  assert.equal(await access.evaluate(()=>fixture.messages.includes('Пароль успішно змінено')),false);await access.close()
  const create=await setup('staff');await create.getByRole('button',{name:'Додати співробітника',exact:true}).click()
  await create.getByLabel("Повне ім'я *",{exact:true}).fill('Synthetic Employee')
  await create.getByLabel('Телефон *',{exact:true}).fill('+380675555555')
  await create.getByLabel('Пароль *',{exact:true}).fill('synthetic-password')
  await create.locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit()});await wait(create,'staff-create')
  await create.keyboard.press('Escape');assert.equal(await create.getByRole('dialog').count(),1)
  await create.evaluate(()=>fixture.pending.find(p=>p.kind==='staff-create').resolve({data:{id:'new-staff'}}))
  await create.getByRole('dialog').waitFor({state:'detached'});await create.close()
  const archived=await setup('staff');await archived.getByTitle('Видалити',{exact:true}).click()
  await double(archived.getByRole('button',{name:'В архів',exact:true}));await wait(archived,'archive')
  await archived.evaluate(()=>fixture.pending.find(p=>p.kind==='archive').reject(Error('Archive test failure')))
  await archived.waitForFunction(()=>fixture.errors.includes('Archive test failure'))
  assert.equal(await archived.getByRole('dialog').count(),1);await archived.close()
  const confirm=await setup('confirm');await double(confirm.getByRole('button',{name:'Підтвердити',exact:true}));await wait(confirm,'confirm')
  await confirm.keyboard.press('Escape');assert.equal(await confirm.getByRole('dialog').count(),1)
  await confirm.evaluate(()=>fixture.pending[0].reject(Error('Expected confirmation error')))
  await confirm.getByRole('alert').waitFor();assert.match(await confirm.getByRole('alert').innerText(),/Expected confirmation error/)
  await confirm.getByRole('button',{name:'Підтвердити',exact:true}).click();await wait(confirm,'confirm',2)
  await confirm.evaluate(()=>fixture.pending[1].resolve(false));await confirm.waitForTimeout(100)
  assert.equal(await confirm.getByRole('dialog').count(),1)
  await confirm.getByRole('button',{name:'Підтвердити',exact:true}).click();await wait(confirm,'confirm',3)
  await confirm.evaluate(()=>fixture.pending[2].resolve());await confirm.getByRole('dialog').waitFor({state:'detached'});await confirm.close()
  const salaryPayments=[
    {id:'reversal',type:'bonus',source:'commission_reversal',amount:-6300,note:'Synthetic commission reversal'},
    {id:'legacy-bonus',type:'bonus',amount:1000,note:'Synthetic legacy positive bonus'},
    {id:'legacy-rate',type:'salary',amount:2000,note:'Synthetic legacy salary'},
    {id:'legacy-advance',type:'advance',amount:3000,note:'Synthetic legacy advance'},
    {id:'legacy-penalty',type:'penalty',amount:4000,note:'Synthetic legacy penalty'},
  ].map(row=>({...row,employee_id:'worker',employee_name:'Test Worker',method:'cash',period:'2026-10',created_at:'2026-10-02T09:00:00.000Z'}))
  const history=await setup('payroll','/analytics/payroll',salaryPayments)
  await openPayroll(history)
  const rendered=[]
  for(const payment of salaryPayments){
    const row=history.locator('.analytics-payment-row').filter({hasText:payment.note})
    const amount=row.locator('strong')
    rendered.push({id:payment.id,label:await row.locator('p.font-semibold').innerText(),
      amount:(await amount.innerText()).replace(/\s+/g,' '),
      red:await amount.evaluate(element=>element.classList.contains('text-red-500')),
      green:await amount.evaluate(element=>element.classList.contains('text-green-600'))})
  }
  assert.deepEqual(await history.evaluate(()=>fixture.salaryPayments),salaryPayments,'Rendering never rewrites salary amounts or sources')
  assert.deepEqual(await history.evaluate(()=>fixture.pending),[],'Viewing signed salary history creates no money operation')
  assert.deepEqual(rendered,[
    {id:'reversal',label:'Сторно нарахування за повернення',amount:'−63,00 ₴',red:true,green:false},
    {id:'legacy-bonus',label:'Премія',amount:'+10,00 ₴',red:false,green:true},
    {id:'legacy-rate',label:'Ставка',amount:'+20,00 ₴',red:false,green:true},
    {id:'legacy-advance',label:'Виплата / аванс',amount:'−30,00 ₴',red:true,green:false},
    {id:'legacy-penalty',label:'Штраф',amount:'−40,00 ₴',red:true,green:false},
  ],'Commission reversals have one negative sign and a source-aware label; legacy types retain their labels and signed effect')
  await history.close()
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log('PASS: 12 staff working-day/month cases in LA/Tokyo/Moscow, 4 salary/payout preflights across Kyiv midnight, explicit past period preserved through one failed attempt and manual retry; actual creation dates use Kyiv at summer/winter boundaries without rewriting stored data; customer/vehicle/staff double clicks, busy forms/close, stale client/modal replies, garage readiness, exact salary decimals, invalid amount rejection, retained input on error, confirmation retry, signed commission reversal history and unchanged legacy salary types. No live data or services.')
}finally{await browser?.close();await server.close()}
