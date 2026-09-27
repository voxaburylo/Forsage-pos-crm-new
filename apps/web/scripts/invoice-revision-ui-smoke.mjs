// Real invoice React form with isolated synthetic services. No shop DB or network.
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
  '@/features/suppliers/supplierApi': 'export const supplierApi=window.fixture.api',
  '@/features/products/productApi': 'export const productApi=window.fixture.products',
  '@/features/admin/adminApi': 'export const adminApi={getSettings:async()=>({data:{quick_percents:[]}}),listCategories:async()=>({data:[]})}',
  '@/features/admin/pricingApi': 'export const pricingApi=window.fixture.pricing',
  '@/features/pos/shiftApi': 'export const shiftApi={}',
  '@/features/suppliers/RowPhotoCell': 'export function RowPhotoCell(){return null}',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.warnings.push(m),success:m=>fixture.messages.push(m)};export function ToastContainer(){return null}',
  '@/components/Layout': 'export function Layout({children,title,onBack}){return <main><h1>{title}</h1><button onClick={onBack}>Назад тест</button>{children}</main>}',
}
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route,useLocation} from 'react-router-dom';
import InvoiceFormPage from '/src/features/suppliers/InvoiceFormPage.tsx';import '/src/index.css';
function Location(){return <div data-testid="location">{useLocation().pathname}</div>}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/suppliers/invoices/i/edit']}><Location/><Routes><Route path='/suppliers/invoices/:id/edit' element={<InvoiceFormPage/>}/><Route path='*' element={<div>Saved destination</div>}/></Routes></MemoryRouter>);`
const bootstrap = `
window.fixture={errors:[],warnings:[],messages:[],writes:[],productWrites:[],payments:[],posts:[],deletes:[],prices:[]};
fixture.pricing={autoRetail:async(purchase,category)=>{fixture.prices.push({purchase,category});return new Promise(r=>fixture.resolvePrice=r)}};
const product={id:'p',sku:'CIRCLE',name:'Круг тестовий',barcode:'2000177521924',unit:'pcs',retail_price:1500,purchase_price:1000,category_id:null};
fixture.invoice={id:'i',invoice_number:'TEST',supplier_id:'s',supplier:{id:'s',name:'Тестовий постачальник'},status:'draft',total:46000,paid_amount:0,notes:'',edit_revision:'r1',updated_at:'2026-09-23T12:00:00Z',items:[{id:'line',product_id:'p',qty:46,purchase_price:1000,total:46000,product}]};
if(sessionStorage.getItem('latest-invoice'))fixture.invoice=JSON.parse(sessionStorage.getItem('latest-invoice'));
fixture.next=()=>fixture.invoice.edit_revision='r'+(Number(fixture.invoice.edit_revision.slice(1))+1);
fixture.api={getInvoice:async()=>({data:structuredClone(fixture.invoice)}),get:async()=>({data:fixture.invoice.supplier}),list:async()=>({data:[fixture.invoice.supplier],pagination:{page:1,total_pages:1}}),
commitReceiving:async(body)=>{if(body.expected_revision!==fixture.invoice.edit_revision)throw Error('DOCUMENT_CONFLICT: changed');fixture.writes.push(body);await new Promise(r=>setTimeout(r,40));Object.assign(fixture.invoice,body);fixture.posts.push(body.expected_revision);fixture.invoice.status='posted';fixture.next();return {data:structuredClone(fixture.invoice)}},
updateInvoice:async(id,body)=>{if(body.expected_revision!==fixture.invoice.edit_revision)throw Error('DOCUMENT_CONFLICT: changed');fixture.writes.push(body);await new Promise(r=>setTimeout(r,40));Object.assign(fixture.invoice,body);fixture.next();return {data:structuredClone(fixture.invoice)}},
postInvoice:async(id,revision)=>{fixture.posts.push(revision);if(revision!==fixture.invoice.edit_revision)throw Error('DOCUMENT_CONFLICT: changed');fixture.invoice.status='posted';fixture.next();return {data:structuredClone(fixture.invoice)}},
deleteInvoice:async(id,revision)=>{if(revision!==fixture.invoice.edit_revision)throw Error('DOCUMENT_CONFLICT: changed');fixture.deletes.push(id)},payInvoice:async()=>{throw Error('Unexpected payment')}};
fixture.products={search:async()=>({data:[product]}),get:async()=>({data:product}),update:async(id,body)=>{fixture.productWrites.push(body);return {data:product}}};
window.forsageDesktop={};
if(window.seedInvoiceDraft){localStorage.setItem('forsage:supply-invoice:edit-i:draft:v2',JSON.stringify(window.seedInvoiceDraft));}
if(window.seedStatus)fixture.invoice.status=window.seedStatus;
`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[tailwindcss(),{
  name:'invoice-revision-fixture',enforce:'pre',resolveId(id){if(id==='virtual:invoice-revision.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){
    if(id==='\0virtual:invoice-revision.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'})
    let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined
    for(const [name,mock] of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock
    if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})
  },configureServer(server){server.middlewares.use('/invoice-revision-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/invoice-revision-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:invoice-revision.tsx"></script></body></html>'))})},
}]})
let browser
try {
  await server.listen();browser=await chromium.launch({headless:true})
  const base=server.resolvedUrls.local[0],errors=[],blocked=[]
  async function setup(seed,status) {
    const page=await browser.newPage({viewport:{width:1280,height:900}})
    page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});page.on('dialog',dialog=>dialog.accept())
    page.on('console',m=>{if(m.type()==='error')console.error(m.text())})
    await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():(blocked.push(route.request().url()),route.abort()))
    if(seed)await page.addInitScript(({seed,status})=>{window.seedInvoiceDraft=seed;window.seedStatus=status},{seed,status})
    await page.goto(base+'invoice-revision-test')
    try { await page.locator('input[data-invoice-quantity]:visible').waitFor() }
    catch(error) { console.error(await page.locator('body').innerText(),await page.evaluate(()=>fixture.errors));throw error }
    return page
  }
  const page=await setup()
  const qty=page.locator('input[data-invoice-quantity]:visible')
  await qty.fill('98')
  await page.evaluate(()=>{fixture.invoice.items[0].qty=60;fixture.invoice.items[0].total=60000;fixture.invoice.total=60000;fixture.next();sessionStorage.setItem('latest-invoice',JSON.stringify(fixture.invoice))})
  await page.getByRole('button',{name:'Провести',exact:true}).click()
  await page.getByRole('alert').waitFor()
  assert.equal(await qty.inputValue(),'98')
  assert.deepEqual(await page.evaluate(()=>({writes:fixture.writes.length,products:fixture.productWrites.length,posts:fixture.posts.length})),{writes:0,products:0,posts:0})
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('forsage:supply-invoice:edit-i:draft:v2'))?.items[0]?.qty===98)
  await page.reload();await page.getByRole('alert').waitFor()
  assert.equal(await qty.inputValue(),'98')
  await page.getByRole('button',{name:'Я звірив — залишити мої правки'}).click()
  assert.equal(await page.getByRole('alert').count(),0)
  assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  // Final input + two synchronous submissions: one invoice update and one posting.
  await qty.fill('99')
  await page.locator('form[data-supply-invoice-form]').evaluate(form=>{form.requestSubmit();form.requestSubmit()})
  await page.waitForFunction(()=>document.querySelector('[data-testid=location]').textContent==='/suppliers/invoices')
  assert.deepEqual(await page.evaluate(()=>({writes:fixture.writes.length,qty:fixture.writes[0].items[0].qty,base:fixture.writes[0].expected_revision,posts:fixture.posts})),{writes:1,qty:99,base:'r2',posts:['r2']})
  assert.equal(await page.evaluate(()=>fixture.productWrites.length),0)
  assert.equal(await page.evaluate(()=>localStorage.getItem('forsage:supply-invoice:edit-i:draft:v2')),null)
  await page.close()
  const seed={supplierId:'s',invoiceNumber:'TEST',notes:'Мої правки',items:[{client_key:'c',product_id:'p',product_name:'Круг тестовий',sku:'CIRCLE',qty:98,purchase_price:1000,retail_price:1500,total:98000,category_id:null}],paidAmount:'',paymentMethod:'cash',fundSource:'owner_funds',serverInvoiceId:'i',savedAt:'2026-09-23T13:00:00Z'}
  const legacy=await setup(seed)
  await legacy.getByRole('alert').waitFor();assert.equal(await legacy.locator('input[data-invoice-quantity]:visible').inputValue(),'98')
  await legacy.getByRole('button',{name:'Завантажити актуальну',exact:true}).click()
  assert.equal(await legacy.locator('input[data-invoice-quantity]:visible').inputValue(),'46')
  assert.equal(await legacy.evaluate(()=>fixture.writes.length),0)
  await legacy.close()
  const posted=await setup({...seed,baseRevision:'old'},'posted')
  await posted.getByRole('alert').waitFor()
  assert.equal(await posted.locator('input[data-invoice-quantity]:visible').inputValue(),'98')
  assert.equal(await posted.getByRole('button',{name:'Я звірив — залишити мої правки'}).count(),0)
  assert.equal(await posted.evaluate(()=>JSON.parse(localStorage.getItem('forsage:supply-invoice:edit-i:draft:v2')).items[0].qty),98)
  await posted.close()
  const prices=await setup()
  const purchase=prices.locator('input[data-invoice-price=purchase]:visible'),retail=prices.locator('input[data-invoice-price=retail]:visible')
  await purchase.focus();await purchase.blur()
  assert.equal(await prices.evaluate(()=>fixture.prices.length),0)
  await purchase.fill('20');await purchase.blur()
  await prices.waitForFunction(()=>fixture.prices.length===1)
  assert.equal(await prices.getByRole('button',{name:'Розрахунок цін...'}).isDisabled(),true)
  await retail.fill('35');await retail.blur()
  await prices.evaluate(()=>fixture.resolvePrice({data:{retail_price:2500}}))
  await prices.getByRole('button',{name:'Провести',exact:true}).waitFor()
  assert.equal(await retail.inputValue(),'35.00')
  assert.equal(await prices.evaluate(()=>fixture.writes.length),0)
  await prices.close()
  const failure=await setup()
  await failure.locator('input[data-invoice-quantity]:visible').fill('98')
  await failure.evaluate(()=>{fixture.api.commitReceiving=async body=>{fixture.failedBody=body;throw Error('RECEIVING_LINE:0: Картка змінилася — перевірте рядок')}})
  await failure.getByRole('button',{name:'Провести',exact:true}).click()
  await failure.waitForFunction(()=>fixture.errors.some(message=>message.includes('Картка змінилася')))
  assert.equal(await failure.locator('input[data-invoice-quantity]:visible').inputValue(),'98')
  assert.equal(await failure.evaluate(()=>JSON.parse(localStorage.getItem('forsage:supply-invoice:edit-i:draft:v2')).commitInvoiceId),'i')
  assert.equal(await failure.evaluate(()=>fixture.productWrites.length),0)
  await failure.reload()
  assert.equal(await failure.locator('input[data-invoice-quantity]:visible').inputValue(),'98')
  await failure.getByRole('button',{name:'Провести',exact:true}).click()
  await failure.waitForFunction(()=>document.querySelector('[data-testid=location]').textContent==='/suppliers/invoices')
  assert.equal(await failure.evaluate(()=>fixture.writes[0].invoice_id),'i')
  await failure.close()
  const scan=await setup()
  await scan.evaluate(()=>{
    fixture.products.search=async query=>({data:query==='4820000000028'
      ? [{id:'existing-card',name:'Назва з бази',sku:'REAL-SKU',barcode:'4820000000028',unit:'pcs',retail_price:9000,purchase_price:8000,category_id:null}]
      : [fixture.invoice.items[0].product]})
  })
  await scan.locator('input[data-invoice-quantity]:visible').fill('98')
  const scanInput=scan.getByPlaceholder('скан / ввід',{exact:true}).filter({visible:true})
  await scanInput.fill('4820000000028');await scanInput.blur()
  await scan.waitForFunction(()=>fixture.messages.some(message=>message.includes('Назва з бази')))
  assert.deepEqual(await scan.evaluate(()=>fixture.errors),[])
  assert.equal(await scan.locator('input[data-invoice-quantity]:visible').inputValue(),'98')
  assert.equal(await scan.locator('input[data-invoice-price=purchase]:visible').inputValue(),'10.00')
  await scan.getByRole('button',{name:'Провести',exact:true}).click()
  await scan.waitForFunction(()=>fixture.writes.length===1)
  assert.equal(await scan.evaluate(()=>fixture.writes[0].items[0].product_id),'existing-card')
  assert.equal(await scan.evaluate(()=>fixture.writes[0].items[0].qty),98)
  await scan.close()
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log('PASS: atomic receiving; stale revision blocks writes; edits and invoice identity survive failure/reload; row error; explicit comparison; double submit; late pricing; no partial product calls or live connections')
} finally {await browser?.close();await server.close()}
