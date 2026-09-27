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
}
const entry=`
import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import{MemoryRouter,Routes,Route,useNavigate,useLocation}from'react-router-dom';
import Form from'/src/features/customers/CustomerFormPage.tsx';import{QuickCustomerModal}from'/src/features/customers/QuickCustomerModal.tsx';import{QuickCustomerEditModal}from'/src/features/customers/QuickCustomerEditModal.tsx';import Staff from'/src/features/staff/StaffPage.tsx';import{ConfirmDialog}from'/src/components/ui/ConfirmDialog.tsx';import'/src/index.css';
function App(){const[open,setOpen]=useState(true),[id,setId]=useState('a'),[mounted,setMounted]=useState(true);const navigate=useNavigate(),location=useLocation();useEffect(()=>{fixture.go=navigate;fixture.show=setOpen;fixture.switchCustomer=setId;fixture.unmount=()=>setMounted(false)},[navigate]);const close=()=>{fixture.closes++;setOpen(false)};return <><div data-testid="location">{location.pathname}</div>{mounted&&(fixture.mode==='quick'?<QuickCustomerModal open={open} onClose={close} onCreated={c=>fixture.selected.push(c)}/>:fixture.mode==='edit'?<QuickCustomerEditModal open={open} customer={fixture.customer(id)} onClose={close} onSaved={c=>fixture.selected.push(c)}/>:fixture.mode==='confirm'?<ConfirmDialog open={open} title="Test confirmation" onClose={close} onConfirm={()=>fixture.defer('confirm',{})}/>:fixture.mode==='staff'?<Staff/>:<Routes><Route path='/customers/new' element={<Form/>}/><Route path='/customers/:id/edit' element={<Form/>}/><Route path='*' element={<p>Destination</p>}/></Routes>)}</>}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={[fixture.route]}><App/></MemoryRouter>);`
const bootstrap=`
window.fixture={mode:window.testMode,route:window.testRoute??'/customers/new',pending:[],reads:[],errors:[],warnings:[],messages:[],selected:[],closes:0};
fixture.customer=id=>({id,phone:'+38067111111'+(id==='a'?'1':'2'),full_name:'Client '+id,email:'',notes:'',tags:[],card_barcode:null,discount_pct:0,client_status:'client',loyalty_mode:'discount',bonus_balance:0,debt_balance:0,updated_at:'version-'+id});
fixture.defer=(kind,body)=>new Promise((resolve,reject)=>fixture.pending.push({kind,body,resolve,reject}));
fixture.customers={list:async()=>({data:[]}),get:id=>fixture.mode==='full'?new Promise((resolve,reject)=>fixture.reads.push({id,resolve,reject})):Promise.resolve({data:fixture.customer(id)}),create:body=>fixture.defer('customer-create',body),update:(id,body)=>fixture.defer('customer-update',{id,...body})};
fixture.vehicles={list:id=>fixture.defer('garage',{id}),create:(id,body)=>fixture.defer('car-create',{id,...body}),update:(id,carId,body)=>fixture.defer('car-update',{id,carId,...body}),delete:(id,carId)=>fixture.defer('car-delete',{id,carId})};
fixture.worker={id:'worker',full_name:'Test Worker',phone:'+380674444444',email:'',role:'cashier',is_active:true,base_rate:10000,rate_period:'day'};
fixture.admin={listUsers:async()=>({data:[fixture.worker]}),createUser:body=>fixture.defer('staff-create',body),saveUserSettings:(id,body,rules)=>fixture.defer('staff-settings',{id,body,rules}),resetPassword:(id,password)=>fixture.defer('password',{id,password}),deleteUser:id=>fixture.defer('archive',{id}),restoreUser:id=>fixture.defer('restore',{id})};
fixture.staff={summary:async()=>({data:[]}),listSalary:async()=>({data:[]}),dailySummary:async()=>({data:[{employee_id:'worker',earned:12600,paid:0,balance:12600}]}),setPin:(id,pin)=>fixture.defer('pin',{id,pin}),createSalary:body=>fixture.defer('salary',body),dailyPayout:body=>fixture.defer('payout',body),deleteSalary:id=>fixture.defer('salary-delete',{id})};
`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[tailwindcss(),{
  name:'customer-staff-actions',enforce:'pre',resolveId(id){if(id==='virtual:actions.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){if(id==='\0virtual:actions.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const[name,mock]of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock;if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},
  configureServer(server){server.middlewares.use('/actions-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/actions-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:actions.tsx"></script></body></html>'))})},
}]})
let browser
try{
  await server.listen();browser=await chromium.launch({headless:true});const base=server.resolvedUrls.local[0],errors=[],blocked=[]
  async function setup(mode,route='/customers/new'){
    const page=await browser.newPage({viewport:{width:1400,height:1100}})
    page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});page.on('dialog',d=>d.accept())
    await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():(blocked.push(r.request().url()),r.abort()))
    await page.addInitScript(({mode,route})=>{window.testMode=mode;window.testRoute=route},{mode,route})
    await page.goto(base+'actions-test');await page.waitForFunction(()=>typeof fixture.go==='function')
    return page
  }
  const double=locator=>locator.evaluate(element=>{element.click();element.click()})
  const count=(page,kind)=>page.evaluate(kind=>fixture.pending.filter(p=>p.kind===kind).length,kind)
  const wait=(page,kind,n=1)=>page.waitForFunction(({kind,n})=>fixture.pending.filter(p=>p.kind===kind).length===n,{kind,n})
  const quick=await setup('quick');await quick.getByRole('button',{name:'Новий клієнт',exact:true}).click()
  await quick.getByLabel('Телефон *',{exact:true}).fill('+380671234567')
  await quick.getByLabel("Ім'я *",{exact:true}).fill('New client')
  await quick.locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit()});await wait(quick,'customer-create')
  assert.equal(await quick.getByLabel("Ім'я *",{exact:true}).isDisabled(),true)
  await quick.keyboard.press('Escape');assert.equal(await quick.getByRole('dialog').count(),1)
  await quick.evaluate(()=>fixture.show(false));await quick.getByRole('dialog').waitFor({state:'detached'})
  await quick.evaluate(()=>fixture.show(true));await quick.getByRole('dialog').waitFor()
  await quick.getByRole('button',{name:'Новий клієнт',exact:true}).click()
  await quick.getByLabel('Телефон *',{exact:true}).fill('+380679999999')
  await quick.getByLabel("Ім'я *",{exact:true}).fill('Current client')
  await quick.locator('form').evaluate(form=>form.requestSubmit());await wait(quick,'customer-create',2)
  await quick.evaluate(()=>fixture.pending.find(p=>p.kind==='customer-create').resolve({data:fixture.customer('a')}))
  await quick.waitForTimeout(100)
  assert.equal(await quick.evaluate(()=>fixture.selected.length),0);assert.equal(await quick.getByRole('dialog').count(),1)
  assert.equal(await quick.getByLabel("Ім'я *",{exact:true}).isDisabled(),true,'old finally must not enable a newer save')
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
  const staff=await setup('staff');await staff.getByRole('button',{name:/Test Worker/}).click()
  await staff.getByRole('button',{name:/Виплати/}).click()
  await staff.getByLabel('Сума (грн)',{exact:true}).fill('126,50')
  await double(staff.getByRole('button',{name:'Зберегти операцію',exact:true}));await wait(staff,'salary')
  assert.equal(await staff.evaluate(()=>fixture.pending.find(p=>p.kind==='salary').body.amount),12650)
  assert.equal(await staff.getByLabel('Сума (грн)',{exact:true}).isDisabled(),true)
  await staff.keyboard.press('Escape');assert.equal(await staff.getByRole('dialog').count(),1)
  await staff.evaluate(()=>fixture.pending.find(p=>p.kind==='salary').reject(Error('Test write failure')))
  await staff.waitForFunction(()=>fixture.errors.includes('Test write failure'))
  assert.equal(await staff.getByLabel('Сума (грн)',{exact:true}).inputValue(),'126,50')
  await staff.getByLabel('Сума (грн)',{exact:true}).fill('126junk');await staff.getByRole('button',{name:'Зберегти операцію',exact:true}).click()
  await staff.waitForTimeout(100);assert.equal(await count(staff,'salary'),1);await staff.close()
  for (const fund of ['cashbox','owner_funds']) {
    const payout=await setup('staff');await payout.getByRole('button',{name:/Test Worker/}).click()
    await double(payout.getByRole('button',{name:fund==='cashbox'?'Видати з каси':'Кошти власника',exact:true}));await wait(payout,'shift')
    await payout.keyboard.press('Escape');assert.equal(await payout.getByRole('dialog').count(),1)
    await payout.evaluate(()=>fixture.pending.find(p=>p.kind==='shift').resolve({data:{id:'test-shift'}}));await wait(payout,'payout')
    assert.equal(await payout.evaluate(()=>fixture.pending.find(p=>p.kind==='payout').body.fund_source),fund)
    await payout.evaluate(()=>fixture.pending.find(p=>p.kind==='payout').resolve({data:{amount:12600}}))
    await payout.waitForFunction(()=>fixture.messages.some(m=>m.includes('Видано')));await payout.close()
  }
  const access=await setup('staff');await access.getByRole('button',{name:/Test Worker/}).click()
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
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log('PASS: customer/vehicle/staff double clicks, busy forms/close, stale client/modal replies, garage readiness, exact salary decimals, invalid amount rejection, retained input on error, confirmation retry. No live data or services.')
}finally{await browser?.close();await server.close()}
