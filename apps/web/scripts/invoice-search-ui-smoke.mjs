// Isolated real React UI; synthetic data only, no shop server or database writes.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const mocks = {
  '@/features/suppliers/supplierApi': 'export const supplierApi = window.fixture.api',
  '@/components/ui/Toast': 'export const toast={error:m=>window.fixture.errors.push(m)};export function ToastContainer(){return null}',
  '@/components/Layout': 'export function Layout({children,title,actions}) { return <main><h1>{title}</h1>{actions}{children}</main> }',
}
const entry = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route,useNavigate} from 'react-router-dom';
import InvoicesPage from '/src/features/suppliers/InvoicesPage.tsx';
import {InvoiceSupplierPicker} from '/src/features/suppliers/InvoiceSupplierPicker.tsx';
function Detail(){const go=useNavigate();return <button onClick={()=>go('/suppliers/invoices')}>Back to list</button>}
function Picker(){const [value,setValue]=useState('s250');return <form onSubmit={e=>{e.preventDefault();fixture.submits++}}><InvoiceSupplierPicker value={value} onChange={setValue}/><output>{value}</output><button type='button'>Outside</button></form>}
const root=createRoot(document.getElementById('root'));
fixture.mountPicker=()=>root.render(<Picker/>);
root.render(<MemoryRouter initialEntries={['/suppliers/invoices']}><Routes><Route path='/suppliers/invoices' element={<InvoicesPage/>}/><Route path='/suppliers/invoices/:id' element={<Detail/>}/></Routes></MemoryRouter>);
`
const bootstrap = `window.fixture={errors:[],queries:[],supplierQueries:[],submits:0,total:145};
fixture.api={listInvoices:async q=>{fixture.queries.push(q);const total=q.search?25:fixture.total;return {data:Array.from({length:Math.max(0,Math.min(20,total-(q.page-1)*20))},(_,i)=>({id:'i'+((q.page-1)*20+i),invoice_number:'INV-'+((q.page-1)*20+i),status:'posted',total:100,created_at:'2026-09-21',supplier:{id:'s',name:'Supplier'}})),pagination:{page:q.page,total,total_pages:Math.ceil(total/20),per_page:20}}},
get:async id=>({data:{id,name:'АвтоКомфорт'}}),list:async q=>{fixture.supplierQueries.push(q);if(fixture.supplierFail)throw Error('offline');if(q.search==='slow')await new Promise(r=>fixture.release=r);return {data:q.search?[{id:q.search==='slow'?'old':'found',name:q.search==='slow'?'Old result':'АвтоКомфорт'}]:Array.from({length:50},(_,i)=>({id:'s'+((q.page-1)*50+i),name:'Supplier '+((q.page-1)*50+i)})),pagination:{page:q.page,total_pages:q.search?1:5,total:q.search?1:250}}}};`
const server = await createServer({cacheDir:createSmokeCache(), configFile:false,root:path.join(root,'apps/web'),logLevel:'error',
  esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},
  plugins:[{name:'invoice-fixture',enforce:'pre',resolveId(id){if(id==='virtual:invoice.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
    async load(id){
      if(id==='\0virtual:invoice.tsx')return transformWithEsbuild(entry,'invoice.tsx',{loader:'tsx',jsx:'automatic'})
      let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined
      for(const [name,mock] of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock
      if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})
    },configureServer(server){server.middlewares.use('/invoice-test',async(_req,res)=>{
      res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/invoice-test','<html><head><meta charset="utf-8"></head><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:invoice.tsx"></script></body></html>'))
    })}}],
})
let browser
try{
  await server.listen();browser=await chromium.launch({headless:true})
  const page=await browser.newPage(),errors=[],blocked=[];page.on('pageerror',e=>{errors.push(e.message);console.error('UI error:',e.message)})
  const base=server.resolvedUrls.local[0]
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin===new URL(base).origin)return route.continue();blocked.push(route.request().url());return route.abort()})
  await page.goto(base+'invoice-test')
  await page.getByRole('button',{name:'INV-0',exact:true}).waitFor()
  await page.getByLabel('Номер сторінки').fill('7');await page.getByLabel('Номер сторінки').press('Enter')
  await page.getByRole('button',{name:'INV-120',exact:true}).click();await page.getByText('Back to list').click()
  await page.getByRole('button',{name:'INV-120',exact:true}).waitFor()
  assert.equal(await page.getByLabel('Номер сторінки').inputValue(),'7')
  await page.getByLabel('Знайти накладні за товаром').fill('5449000351081')
  await page.waitForFunction(()=>fixture.queries.at(-1).search==='5449000351081')
  assert.equal(await page.getByLabel('Номер сторінки').inputValue(),'1')
  await page.getByLabel('Номер сторінки').fill('2');await page.getByText('Перейти',{exact:true}).click()
  await page.getByRole('button',{name:'INV-20',exact:true}).click();await page.getByText('Back to list').click()
  await page.getByRole('button',{name:'INV-20',exact:true}).waitFor()
  assert.equal(await page.getByLabel('Знайти накладні за товаром').inputValue(),'5449000351081')
  assert.equal(await page.getByLabel('Номер сторінки').inputValue(),'2')
  await page.getByLabel('Номер сторінки').fill('999');await page.getByText('Перейти',{exact:true}).click()
  assert.match((await page.evaluate(()=>fixture.errors)).at(-1),/від 1 до 2/)
  await page.getByRole('button',{name:'Чернетка',exact:true}).click()
  await page.waitForFunction(()=>fixture.queries.at(-1).status==='draft'&&fixture.queries.at(-1).page===1)
  await page.getByLabel('Знайти накладні за товаром').fill('')
  await page.waitForFunction(()=>!fixture.queries.at(-1).search)
  await page.getByLabel('Номер сторінки').fill('8');await page.getByText('Перейти',{exact:true}).click()
  await page.getByRole('button',{name:'INV-140',exact:true}).click()
  await page.evaluate(()=>fixture.total=100);await page.getByText('Back to list').click()
  await page.getByRole('button',{name:'INV-80',exact:true}).waitFor()
  assert.equal(await page.getByLabel('Номер сторінки').inputValue(),'5')
  console.log('PASS: page entry, back navigation, retained search/status, filter reset, invalid input, last-page clamp')
  await page.evaluate(()=>fixture.mountPicker())
  const input=page.getByRole('combobox',{name:'Постачальник'})
  await page.waitForFunction(()=>document.querySelector('[role=combobox]')?.value==='АвтоКомфорт')
  await input.click();await page.getByRole('option',{name:'Supplier 0',exact:true}).waitFor()
  await page.getByText('Показати ще',{exact:true}).click();await page.getByRole('option',{name:'Supplier 50',exact:true}).waitFor()
  await input.fill('комф');await page.getByRole('option',{name:'АвтоКомфорт',exact:true}).waitFor()
  await input.press('ArrowDown');await input.press('Enter')
  await page.waitForFunction(()=>document.querySelector('output').textContent==='found')
  assert.equal(await page.evaluate(()=>fixture.submits),0)
  await input.click();await input.fill('slow');await page.waitForFunction(()=>!!fixture.release)
  await input.fill('new');await page.getByRole('option',{name:'АвтоКомфорт',exact:true}).waitFor()
  await page.evaluate(()=>fixture.release());await page.waitForTimeout(80)
  assert.equal(await page.getByRole('option',{name:'Old result'}).count(),0)
  await page.evaluate(()=>fixture.supplierFail=true);await input.fill('fail')
  await page.getByRole('alert').waitFor();await page.evaluate(()=>fixture.supplierFail=false)
  await page.getByText('Повторити',{exact:true}).click();await page.getByRole('option',{name:'АвтоКомфорт',exact:true}).waitFor()
  await input.press('Escape');assert.equal(await input.getAttribute('aria-expanded'),'false')
  assert.equal(await page.evaluate(()=>fixture.submits),0);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log('PASS: selected supplier beyond first page, load more, substring search, keyboard selection, no form submission, stale response, retry')
}finally{await browser?.close();await server.close()}
