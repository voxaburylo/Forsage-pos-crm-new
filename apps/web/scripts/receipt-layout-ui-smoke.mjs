// Real React receipt + native Electron raster, synthetic sales only.
import { createSmokeCache } from './ui-smoke-cache.mjs'
// No shop database, network service, print bridge or physical printer is used.
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')
const require=createRequire(path.join(root,'apps/web/package.json'))
const desktopRequire=createRequire(path.join(root,'apps/desktop/package.json'))
const {createServer,transformWithEsbuild}=await import(pathToFileURL(require.resolve('vite')).href)
const work=fs.mkdtempSync(path.join(os.tmpdir(),'forsage-receipt-layout-'))
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';
import {ReceiptPrint,printReceipt} from '/src/features/pos/ReceiptPrint.tsx';
const count=Number(new URLSearchParams(location.search).get('count'))||2;
const sale={id:'synthetic',sale_number:'TEST-NOT-A-SALE',completed_at:'2026-09-26T06:15:00Z',total:count*15000,discount:0,payment_method:'transfer',sale_items:Array.from({length:count},(_,i)=>({product_id:'test-'+i,qty:1,unit_price:15000,total:15000,discount:0,product:{name:i%2?'Пильовик ШРКШ внутрішній Ланос FSO (комплект з хомутами)':'Ремкомплект куліси Ланос FSO',unit:'шт'}}))};
window.fixture={jobs:[],errors:[]};
window.forsageDesktop={print:{listPrinters:async()=>[{name:'POS-58-Series'}],html:async(html,options)=>{fixture.jobs.push({html,options});return {success:true}}}};
window.fixturePrint=printReceipt;
createRoot(document.getElementById('root')).render(<ReceiptPrint sale={sale} shopName="ТЕСТ — НЕ ПРОДАЖ" shopAddress="Тестова довга адреса магазину автозапчастин" shopPhone="0000000000" sellerName="Тестовий касир" paperWidthMm={58}/>);`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[{
 name:'receipt-fixture',enforce:'pre',resolveId(id){if(id==='virtual:receipt.tsx')return '\0'+id},
 async load(id){if(id==='\0virtual:receipt.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'})},
 configureServer(server){server.middlewares.use('/receipt-test',async(req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/receipt-test','<html><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:receipt.tsx"></script></body></html>'))})},
}]})
let browser
try {
 await server.listen();browser=await chromium.launch({headless:true})
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
 const base=server.resolvedUrls.local[0]
 await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort())
 const cases=[]
 for(const count of [1,2,18,45]){
  await page.goto(base+'receipt-test?count='+count)
  await page.locator('.receipt-print').waitFor({state:'attached'})
  await page.evaluate(()=>{localStorage.clear();fixturePrint();fixturePrint()})
  await page.waitForFunction(()=>fixture.jobs.length===1)
  const job=await page.evaluate(()=>fixture.jobs[0])
  assert.equal(job.options.printerRole,'receipt');assert.equal(job.options.deviceName,'POS-58-Series')
  assert.equal(job.html.match(/class="rp-item-name"/g).length,count)
  assert.match(job.html,/РАЗОМ:/);assert.match(job.html,/Дякуємо за покупку!/);assert.match(job.html,new RegExp((count*150).toFixed(2).replace('.','\\.')))
  // Calibration footer only in the test fixture. Its full-width black band
  // proves the bitmap includes the end, not merely the top with some ink.
  const html=job.html.replace('</body>','<style>.receipt-print::after{content:"";display:block;height:4px;background:#000;margin-top:4px}</style></body>')
  cases.push({count,html})
 }
 assert.deepEqual(errors,[])
 const file=path.join(work,'cases.json');fs.writeFileSync(file,JSON.stringify(cases))
 const executable=desktopRequire('electron')
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(executable,[path.join(root,'apps/desktop/scripts/receipt-layout-smoke.cjs'),file,'--software',...(process.argv.includes('--packaged')?['--packaged']:[])],{cwd:root,windowsHide:true,env,stdio:['ignore','pipe','pipe']})
  let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v)
  const timer=setTimeout(()=>{child.kill();reject(Error('Receipt layout timed out'))},90_000)
  child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,out,err})})
 })
 process.stdout.write(result.out)
 assert.equal(result.code,0,result.err+'\n'+result.out)
 console.log('Real receipt UI/raster: 1/2/18/45 items, exact totals, one job per double click, footer preserved; NO PHYSICAL PRINT')
} finally {
 await browser?.close();await server.close()
 if(path.dirname(work)===path.resolve(os.tmpdir())&&path.basename(work).startsWith('forsage-receipt-layout-'))fs.rmSync(work,{recursive:true,force:true})
}
