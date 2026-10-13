// Actual POS page, customer dialogs, receipt and payment; synthetic in-memory APIs only.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const mocks = {
  '@/features/pos/usePOS': `import{usePOSStore}from'/src/stores/posStore.ts';export function usePOS(){return{store:usePOSStore(),checkShift:()=>{},completeSale:fixture.pay,resolveFiscalRecovery:()=>{},fiscalRecovery:null}}`,
  '@/features/pos/SearchPanel': `import{forwardRef,useImperativeHandle}from'react';export const SearchPanel=forwardRef((_,ref)=>{useImperativeHandle(ref,()=>({clear:()=>fixture.clears++,scanBarcode:()=>{},focus:()=>{}}));return <input aria-label="Fixture search"/>})`,
  '@/features/pos/ReceiptPrint': 'export function ReceiptPrint(){return null};export const printReceipt=()=>{throw Error("Unexpected printing")}',
  '@/features/pos/usePOSBarcodeScanner': 'export const usePOSBarcodeScanner=()=>{}',
  '@/features/pos/cartRecovery': 'export const connectOpenReceipts=()=>{const close=()=>{};close.flush=()=>{};return close}',
  '@/hooks/useServerStatus': 'export const useServerStatus=()=>true',
  '@/hooks/useOfflineSync': 'export const useOfflineSync=()=>({pendingCount:0,syncing:false,incrementPending:()=>{},syncPendingSales:()=>{}})',
  '@/lib/desktopAccessState': 'export const isDesktopAccessLocked=()=>false',
  '@/lib/audioService': 'export const initAudio=()=>{};export const playCashRegister=()=>{}',
  '@/lib/offlineDB': 'export const searchCustomersOffline=async()=>[];export const cacheCurrentShift=async()=>{};export const decrementCachedStock=async()=>{};export const enqueueSale=async()=>{throw Error("Unexpected offline sale")};export const getCachedStaff=async()=>[]',
  '@/lib/desktopBridge': 'export const desktopBridge=()=>({catalog:{listStaff:async()=>[]},orders:{count:async()=>0},fiscal:{getConfig:async()=>({enabled:false})}});export const isDesktopRuntime=()=>true',
  '@/features/admin/adminApi': 'export const adminApi={getSettings:async()=>({data:{bank_terminal_enabled:false}})}',
  '@/features/admin/pricingApi': 'export const pricingApi={listTiers:async()=>({data:[]})}',
  '@/features/customers/customerApi': 'export const customerApi=fixture.customers',
  '@/features/customers/customerVehiclesApi': 'export const customerVehiclesApi={list:async()=>({data:[]})}',
  '@/features/pos/posCustomerMoneyApi': 'export const posCustomerMoneyApi={getDeposit:async()=>({data:{balance:0}})}',
  '@/features/pos/saleApi': 'export const saleApi={list:async params=>{fixture.receiptReads.push(params);return{data:[]}},listSuspended:async()=>({data:[]}),checkAfterPayment:async()=>({data:null})}',
  '@/features/pos/shiftApi': 'export const shiftApi={}',
  '@/lib/api': 'export const api={get:()=>{throw Error("Unexpected remote read")},post:()=>{throw Error("Unexpected remote write")}}',
  '@/stores/authStore': 'export const useAuthStore=select=>select(useAuthStore.getState());useAuthStore.getState=()=>({session:{user:{id:"synthetic-user",app_metadata:{role:"owner"}}},offlineMode:false})',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.errors.push(m),success:m=>fixture.messages.push(m)};export function ToastContainer(){return null}',
}
for (const name of ['ShiftCloseModal','CashOperationModal','DebtPaymentModal','CashReconciliationModal','FavoritesPanel','CrossSellPanel','ReadyOrdersPanel','QuickChargeModal','HelpModal','SuspendModal','SuspendedListModal','OfflineSalesModal']) mocks['@/features/pos/' + name] = 'export function ' + name + '(){return null}'
const entry = `
import React from'react';import{createRoot}from'react-dom/client';import{createMemoryRouter,RouterProvider,useLocation}from'react-router-dom';import POSPage from'/src/features/pos/POSPage.tsx';import{usePOSStore}from'/src/stores/posStore.ts';import{NavigationGuard}from'/src/hooks/useUnsavedChanges.ts';import'/src/index.css';
const s=usePOSStore.getState();s.replaceOpenReceipts([]);s.setCurrentShift({id:'shift',cashier_id:'synthetic-user',opened_at:'2026-10-13T08:00:00Z',opening_cash:0});s.setPriceRounding({enabled:false});
for(const id of ['part-one','part-two'])s.addItem({productId:id,sku:id,name:id,unit:'шт',qty:1,unitPrice:10000,discount:0,qtyOnHand:2});s.setSelectedProductId('part-one');fixture.store=usePOSStore;
fixture.select=()=>usePOSStore.getState().setCustomer({id:'client',phone:'0671234567',name:'Клієнт перевірки',debtBalance:0,tierDiscountPct:0,tierName:null,loyaltyMode:'discount',vipLevel:'standard',riskProfile:'low'});
function History(){const location=useLocation();fixture.historyLocation=location;return <p>Повна історія</p>}
createRoot(document.getElementById('root')).render(<RouterProvider router={createMemoryRouter([{path:'/sales',element:<History/>},{path:'*',element:<><NavigationGuard/><POSPage/></>}],{initialEntries:['/pos']})}/>);`
const bootstrap = `window.fixture={errors:[],messages:[],writes:[],payments:[],receiptReads:[],clears:0,confirms:0};window.IntersectionObserver=class{observe(){}disconnect(){}};window.confirm=()=>{fixture.confirms++;return false};
fixture.customer={id:'client',phone:'0671234567',full_name:'Клієнт перевірки',discount_pct:0,loyalty_mode:'discount',debt_balance:0,bonus_balance:0,deposit_balance:0,credit_limit:0,tags:[]};
fixture.write=async body=>{fixture.writes.push(body);if(fixture.pauseWrites)await new Promise(resolve=>fixture.release=resolve);fixture.customer={...fixture.customer,...body};return{data:fixture.customer}};
fixture.customers={list:async()=>({data:[]}),get:async()=>({data:fixture.customer}),create:fixture.write,update:async(_id,body)=>fixture.write(body)};
fixture.pay=async(...args)=>{fixture.payments.push(args);await new Promise(resolve=>fixture.finishPayment=resolve);return false};`
const server = await createServer({ cacheDir: createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},plugins:[tailwindcss(),{
  name:'pos-dialog-smoke',enforce:'pre',
  resolveId(id,importer){
    if(id==='virtual:pos-dialog.tsx'||Object.hasOwn(mocks,id))return '\0'+id
    if(id.startsWith('./')&&importer?.replaceAll('\\','/').endsWith('/features/pos/POSPage.tsx')){const name='@/features/pos/'+id.slice(2);if(Object.hasOwn(mocks,name))return '\0'+name}
  },
  async load(id){if(id==='\0virtual:pos-dialog.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const[name,mock]of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock;if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},
  configureServer(instance){instance.middlewares.use('/pos-dialog-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await instance.transformIndexHtml('/pos-dialog-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:pos-dialog.tsx"></script></body></html>'))})},
}]})
let browser
const errors=[],blocked=[],passed=[]
try{
  await server.listen();browser=await chromium.launch({headless:true});const base=server.resolvedUrls.local[0]
  async function setup(){const page=await browser.newPage({viewport:{width:1366,height:768}});page.setDefaultTimeout(10000);page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():(blocked.push(route.request().url()),route.abort()));await page.goto(base+'pos-dialog-test');await page.locator('.receipt-header').waitFor();return page}
  if(!process.env.FORSAGE_DIALOG_CASE||process.env.FORSAGE_DIALOG_CASE==='create'){
    const page=await setup();await page.getByRole('button',{name:/Додати клієнта/}).click();await page.getByRole('button',{name:'Новий клієнт',exact:true}).click();await page.getByLabel("Ім'я",{exact:true}).fill('Незбережений клієнт');await page.keyboard.press('Escape');
    assert.equal(await page.getByLabel("Ім'я",{exact:true}).count(),1,'Escape must not bypass rejected dirty confirmation');assert.equal(await page.getByLabel("Ім'я",{exact:true}).inputValue(),'Незбережений клієнт');assert.equal(await page.evaluate(()=>fixture.confirms),1);
    await page.getByRole('button',{name:'Новий клієнт',exact:true}).focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Delete');assert.deepEqual(await page.evaluate(()=>({ids:fixture.store.getState().items.map(i=>i.productId),selected:fixture.store.getState().selectedProductId})),{ids:['part-one','part-two'],selected:'part-one'},'Dialog keyboard must not change background basket');
    await page.getByLabel('Телефон *',{exact:true}).fill('0671234567');await page.evaluate(()=>fixture.pauseWrites=true);await page.getByRole('button',{name:'Створити й додати до чека',exact:true}).click();await page.waitForFunction(()=>fixture.writes.length===1);await page.keyboard.press('Escape');assert.equal(await page.getByLabel("Ім'я",{exact:true}).count(),1,'Escape must not close during save');await page.evaluate(()=>fixture.release());await page.waitForFunction(()=>fixture.store.getState().customer?.name==='Незбережений клієнт');passed.push('full POS creation dirty/busy Escape; arrows/delete preserve basket');await page.close()
  }
  if(!process.env.FORSAGE_DIALOG_CASE||process.env.FORSAGE_DIALOG_CASE==='edit'){
    const page=await setup();await page.evaluate(()=>fixture.select());await page.getByRole('button',{name:'Редагувати вибраного клієнта',exact:true}).click();await page.getByLabel("Ім'я",{exact:true}).fill('Змінений клієнт');await page.keyboard.press('Escape');assert.equal(await page.getByLabel("Ім'я",{exact:true}).inputValue(),'Змінений клієнт');await page.evaluate(()=>fixture.pauseWrites=true);await page.getByRole('button',{name:'Зберегти картку',exact:true}).click();await page.waitForFunction(()=>fixture.writes.length===1);await page.keyboard.press('Escape');assert.equal(await page.getByLabel("Ім'я",{exact:true}).count(),1);await page.evaluate(()=>fixture.release());await page.locator('.receipt-header').getByText('Змінений клієнт',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0,'Save returns directly to same receipt, no customer search');assert.deepEqual(await page.evaluate(()=>fixture.store.getState().items.map(i=>i.productId)),['part-one','part-two']);passed.push('selected customer direct edit; dirty/busy Escape; save returns same basket');await page.close()
  }
  if(!process.env.FORSAGE_DIALOG_CASE||process.env.FORSAGE_DIALOG_CASE==='payment'){
    const page=await setup()
    await page.getByRole('button',{name:'💰 ОПЛАТИТИ (F2)',exact:true}).click()
    await page.getByPlaceholder('0.00',{exact:true}).fill('200')
    await page.getByRole('button',{name:'ОПЛАТИТИ',exact:true}).click()
    await page.waitForFunction(()=>fixture.payments.length===1)
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('button',{name:'Обробка...',exact:true}).count(),1,'Escape must not close in-flight payment')
    await page.evaluate(()=>fixture.finishPayment())
    await page.getByRole('button',{name:'ОПЛАТИТИ',exact:true}).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('button',{name:'ОПЛАТИТИ',exact:true}).count(),0,'Idle payment Escape closes')
    assert.deepEqual(await page.evaluate(()=>fixture.store.getState().items.map(i=>i.productId)),['part-one','part-two'])
    passed.push('full POS payment Escape while busy/idle; no duplicate payment or basket loss')
    await page.close()
  }
  if(!process.env.FORSAGE_DIALOG_CASE||process.env.FORSAGE_DIALOG_CASE==='history'){
    const page=await setup()
    await page.getByTitle('Останні чеки за 14 днів, пошук і повторний друк').click()
    await page.getByPlaceholder(/Номер чека/).fill('OLD-2026-0001')
    await page.getByRole('link',{name:'Перегляд усіх чеків і повернення'}).click()
    await page.getByText('Повна історія',{exact:true}).waitFor()
    assert.equal(await page.evaluate(()=>fixture.historyLocation.search),'?search=OLD-2026-0001')
    assert.equal(await page.evaluate(()=>fixture.historyLocation.state.returnView.to),'/pos')
    assert.deepEqual(await page.evaluate(()=>fixture.store.getState().items.map(i=>i.productId)),['part-one','part-two'])
    assert.deepEqual(await page.evaluate(()=>fixture.writes),[])
    passed.push('recent receipt print picker opens full history with query and return context; no printing or basket loss')
    await page.close()
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);console.log(JSON.stringify({passed:true,cases:passed,liveWrites:0,printing:0,externalRequests:0}))
}finally{await browser?.close();await server.close()}
