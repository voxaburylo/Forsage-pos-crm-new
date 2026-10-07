// Real assistant + ordinary receiving form; synthetic services only, all external network blocked.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')
export const require=createRequire(path.join(root,'apps/web/package.json'))
const {createServer,transformWithEsbuild}=await import(pathToFileURL(require.resolve('vite')).href)
const {default:tailwind}=await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const mocks={
'@/lib/desktopBridge':'export const desktopBridge=()=>fixture.bridge;export const isDesktopRuntime=()=>true;export const desktopProductToProduct=p=>p',
'@/lib/api':'export const api={get:async()=>{throw Error("Unexpected server request")},post:async()=>({data:{vin:null}})}',
'@/stores/authStore':'const state={session:{user:{id:"test-user",app_metadata:{role:"cashier",tenant_id:"fixture"}}}};fixture.authState=state;export const useAuthStore=Object.assign(s=>s(state),{getState:()=>state})',
'@/features/admin/adminApi':'export const adminApi={getSettings:async()=>({data:{quick_percents:[]}}),listCategories:async()=>({data:[]})}',
'@/features/products/productApi':'export const requestDesktopSync=()=>{};export const productApi={search:async()=>({data:[]}),getSupplierPrices:async()=>({data:[]})}',
'@/features/admin/pricingApi':'export const pricingApi={autoRetail:async(purchase)=>({data:{retail_price:Math.round(purchase*1.3/100)*100}})}',
'@/features/pos/shiftApi':'export const shiftApi={}',
'@/features/suppliers/RowPhotoCell':'export const RowPhotoCell=()=>null',
'@/features/suppliers/supplierApi':'export const supplierApi=fixture.supplierApi',
'@/features/ai/aiApi':'export const aiApi={status:async()=>{if(!fixture.online)throw Error("Offline");return {data:{enabled:true,has_key:true,model:"test",usage:{cost_usd:0,requests:0}}}},chat:async body=>{fixture.aiCalls.push(body);return {data:fixture.response}},recognizeSupplyInvoice:async body=>{fixture.photoCalls.push(body);return {data:fixture.response}}}',
'@/features/ai/OrderConfirmModal':'export const OrderConfirmModal=()=>null',
'@/lib/processingUploads':'export const dataUrlToBlob=()=>({type:"image/jpeg"});export const uploadProcessingBlob=async()=>({path:"test-user/ai/photo.jpg",mimeType:"image/jpeg"});export const removeProcessingUploads=async()=>{}',
'@/components/Layout':'export function Layout({children,title,onBack}){return <main className="min-w-0 p-4"><h1>{title}</h1>{onBack&&<button onClick={onBack}>Назад тест</button>}{children}</main>}',
'@/components/ui/Toast':'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.warnings.push(m),success:m=>fixture.messages.push(m)};export const ToastContainer=()=>null',
}
const entry=String.raw`import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route,useLocation} from 'react-router-dom';
import AiAssistantPage from '/src/features/ai/AiAssistantPage.tsx';import InvoiceFormPage from '/src/features/suppliers/InvoiceFormPage.tsx';import '/src/index.css';
function Location(){const l=useLocation();fixture.location=l.pathname+l.search;return <p data-testid="location">{fixture.location}</p>}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={[sessionStorage.getItem('start-route')||'/']}><Location/><Routes><Route path="/" element={<AiAssistantPage/>}/><Route path="/suppliers/invoices/new" element={<InvoiceFormPage/>}/><Route path="*" element={<p>Документ збережено</p>}/></Routes></MemoryRouter>);`
const bootstrap=String.raw`
window.fixture={online:false,errors:[],warnings:[],messages:[],writes:[],previewCalls:[],aiCalls:[],photoCalls:[],catalog:[],mode:'new',
response:{reply:'Розібрано',usage:{cost_usd:0},actions:[{id:'photo',tool:'create_products_bulk',payload:{invoice_total:240,products:[{name:'Товар з фото',sku:'',qty_on_hand:2,purchase_price_uah:120}]}}]}};
fixture.supplier={id:'supplier',name:'Постачальник тест'};
fixture.supplierApi={list:async()=>({data:[fixture.supplier],pagination:{total_pages:1}}),get:async()=>({data:fixture.supplier}),getInvoice:async()=>{throw Error('INVOICE_NOT_FOUND')},commitReceiving:async body=>{fixture.writes.push(body);return {data:{id:body.invoice_id,status:'posted',edit_revision:'r1'}}}};
fixture.bridge={catalog:{listCategories:async()=>[],getSettings:async()=>({}),findByBarcode:async code=>fixture.catalog.find(p=>p.barcode===code)||null,findBySku:async code=>fixture.catalog.find(p=>p.sku===code)||null},
supply:{getInvoice:async()=>{throw Error('INVOICE_NOT_FOUND')},listSuppliers:async()=>({data:[fixture.supplier]}),
previewInvoiceFromAi:async ({rows})=>{fixture.previewCalls.push(structuredClone(rows));if(fixture.failPreview)throw Error('Preview unavailable');await new Promise(r=>setTimeout(r,rows[0].qty===7?700:15));
return rows.map(row=>{let candidates=[],status='new',id=null,errors=[],reason='Новий товар';
if(fixture.mode==='mixed'){
if(row.sku==='44'||row.sku==='OUR44'){candidates=[fixture.catalog[0]];status='matched';id=candidates[0].id}
else if(row.name.includes('Спірний')){candidates=fixture.catalog.slice(1);status='review';reason='Є кілька схожих карток'}
if(row.sku==='ARCHIVED')errors.push('Артикул належить видаленій картці. Виправте артикул.');
}
const chosen=fixture.catalog.find(p=>p.id===row.match_choice);
if(chosen&&!candidates.some(p=>p.id===chosen.id))candidates.push(chosen);
if((chosen||id)&&row.unit==='компл')errors.push('Одиниця накладної комплект, у базі шт. Уточніть.');
return {name:row.name,source_name:row.source_name||row.name,brand:'',product_id:id,status,reason,candidates,validation_errors:errors};
})},createInvoiceFromAi:async()=>{throw Error('Old direct write path must not run')}}};
`
export async function startFixture(){
const server=await createServer({configFile:false,cacheDir:createSmokeCache(),root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[tailwind(),{
name:'ai-ordinary-invoice',enforce:'pre',resolveId(id){if(id==='virtual:ordinary.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
async load(id){if(id==='\0virtual:ordinary.tsx')return transformWithEsbuild(entry,'entry.tsx',{loader:'tsx',jsx:'automatic'});
let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const [name,mock] of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock;
if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},
configureServer(s){s.middlewares.use('/ai-invoice-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await s.transformIndexHtml('/ai-invoice-test','<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:ordinary.tsx"></script></body></html>'))})}
}]})
await server.listen()
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1366,height:900}}),errors=[]
page.on('pageerror',error=>errors.push(error.message))
const base=server.resolvedUrls.local[0]
await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort())
async function reset(){await page.goto(base+'ai-invoice-test');await page.evaluate(()=>{localStorage.clear();sessionStorage.clear()});await page.reload();await page.getByRole('button',{name:'Excel / файл',exact:true}).waitFor()}
async function paste(text){await page.locator('textarea').evaluate((element,text)=>{const data=new DataTransfer();data.setData('text/plain',text);element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))},text)}
async function openTable(){await page.getByRole('button',{name:'Перевірити таблицю',exact:true}).click();await page.locator('[data-supply-invoice-form]').waitFor()}
async function getDraft(){return page.evaluate(()=>JSON.parse(localStorage.getItem(decodeURIComponent(fixture.location.split('resume=')[1]))))}
return {page,errors,reset,paste,openTable,getDraft,close:async()=>{await browser.close();await server.close()}}
}
