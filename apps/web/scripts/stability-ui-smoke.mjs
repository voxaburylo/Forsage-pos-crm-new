// Real components with synthetic data. No shop API, database, or printer access.
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
  '@/lib/desktopBridge': 'export const desktopBridge=()=>window.fixture.bridge;export const isDesktopRuntime=()=>true',
  '@/lib/api': 'export const api={get:async()=>{throw Error("Unexpected server request")}}',
  '@/stores/authStore': 'export const useAuthStore=Object.assign(s=>s({session:null}),{getState:()=>({session:null})})',
  '@/features/admin/adminApi': 'export const adminApi={listUsers:async()=>({data:[{id:"worker",full_name:"Тестовий працівник",is_active:true,role:"cashier"}]})};export const ROLE_LABELS={cashier:"Касир"}',
  '@/features/pos/shiftApi': 'export const shiftApi={}',
  '@/components/Layout': 'export function Layout({children,title}){return <main><h1>{title}</h1>{children}</main>}',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),success:()=>{}};export const ToastContainer=()=>null',
}
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import PayrollPage from '/src/features/analytics/PayrollPage.tsx';
import {BackupSettingsCard} from '/src/features/settings/BackupSettingsCard.tsx';
const root=createRoot(document.getElementById('root'));fixture.backups=()=>root.render(<BackupSettingsCard/>);root.render(<PayrollPage/>);`
const bootstrap = `window.fixture={errors:[],pages:[],copy:{id:'shift',closed_at:'2026-09-22T15:00:00Z',captured_at:'2026-09-22T15:01:00Z',local_ready:true,exports_ready:true,export_directory:'fixtures',cloud_completed_at:null,local_error:null,cloud_error:null}};
fixture.bridge={staff:{salarySummary:async()=>[{employee_id:'worker',earned:45100,paid:0,balance:45100}],dailySummary:async()=>[],listSalary:async q=>{fixture.pages.push(q.page);return Array.from({length:Math.max(0,Math.min(200,451-(q.page-1)*200))},(_,i)=>({id:String((q.page-1)*200+i),employee_id:'worker',amount:100,type:'salary',method:'cash',created_at:'2026-09-22T10:00:00Z',note:'Операція '+((q.page-1)*200+i)}))}},listBackups:async()=>[{fileName:'test.db',filePath:'fixtures/test.db',sizeBytes:1000,createdAt:'2026-09-22T12:00:00Z'}],shiftBackups:{status:async()=>[fixture.copy]}};`
const server = await createServer({cacheDir:createSmokeCache(), configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[{
  name:'stability-fixture',enforce:'pre',resolveId(id){if(id==='virtual:stability.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){
    if(id==='\0virtual:stability.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'})
    let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined
    for(const [name,mock] of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock
    if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})
  },configureServer(server){server.middlewares.use('/stability-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/stability-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:stability.tsx"></script></body></html>'))})},
}]})
let browser
try {
  await server.listen(); browser=await chromium.launch({headless:true})
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
  const base=server.resolvedUrls.local[0]
  await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort())
  await page.goto(base+'stability-test')
  await page.getByRole('button',{name:'Операції',exact:true}).click()
  await page.getByText('Показано 50 з 451',{exact:true}).waitFor()
  assert.deepEqual(await page.evaluate(()=>fixture.pages),[1,2,3])
  for(let i=0;i<8;i++)await page.getByRole('button',{name:'Показати ще 50',exact:true}).click()
  await page.getByText('Показано 450 з 451',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Показати ще 50',exact:true}).click()
  await page.getByText('Показано 451 з 451',{exact:true}).waitFor()
  assert.equal(await page.locator('.analytics-payment-row').count(),451)
  assert.equal(await page.getByRole('button',{name:'Показати ще 50',exact:true}).count(),0)
  await page.evaluate(()=>fixture.backups())
  await page.getByText('Обидва файли готові',{exact:true}).waitFor()
  await page.getByText('Підтвердженої зовнішньої копії немає',{exact:true}).waitFor()
  await page.evaluate(()=>{fixture.copy.cloud_completed_at='2026-09-22T15:05:00Z';fixture.copy.local_ready=false;fixture.copy.exports_ready=false})
  await page.getByRole('button',{name:'Оновити',exact:true}).click()
  await page.getByText('Файли не готові або недоступні',{exact:true}).waitFor()
  assert.match(await page.locator('body').innerText(),/Дані станом на/)
  assert.equal(await page.getByText('Обидва файли готові',{exact:true}).count(),0)
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>fixture.errors),[])
  console.log('PASS: all 451 payroll records, incremental display, local/external backup separation, missing files, refresh')
} finally {await browser?.close();await server.close()}
