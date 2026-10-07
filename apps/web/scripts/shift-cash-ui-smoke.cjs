// Synthetic cash only. No shop database, printers or external requests.
const path = require('node:path'), assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
const { chromium } = require('playwright')
process.chdir(path.resolve(__dirname, '../../..')); mkdirSync('tmp', { recursive: true })
;(async () => {
  const { createServer } = await import('../node_modules/vite/dist/node/index.js')
  const fixture = String.raw`
import React from 'react';import{createRoot}from'react-dom/client';import'/src/index.css'
const {useAuthStore}=await import('/src/stores/authStore.ts')
useAuthStore.getState().setOfflineSession({access_token:'fixture',refresh_token:'fixture',user:{id:'cashier',app_metadata:{role:'owner',tenant_id:'fixture'}}})
const {staffApi}=await import('/src/features/staff/staffApi.ts')
staffApi.tireServiceReport=async()=>({data:[]})
window.calls={cash:0,report:0,close:[],reconcile:[]};window.mode='good';window.pending=[]
window.cash={opening_cash:1000,cash_sales:200,cash_returns:50,cash_in:300,cash_out:100,expected_amount:1350}
window.report={shift:{id:'shift',cashier_id:'cashier',status:'open',opening_cash:1000},
 cash_breakdown:window.cash,total_sales:1,gross_revenue:500,refund_total:50,total_revenue:450,
 payment_received_total:500,payment_refunded_total:50,payment_net_total:450,unassigned_refunds_count:0,
 by_method:{cash:200,card:300,transfer:0,account:0,debt:0},refunds_by_method:{cash:50,card:0,transfer:0,account:0,debt:0},
 sales:[{id:'sale',status:'returned',total:500}]}
const read=async kind=>{
 window.calls[kind]++
 const value=structuredClone(kind==='cash'?window.cash:window.report)
 if(window.mode==='fail')throw Error('Fixture failed')
 if(window.mode==='bad'){if(kind==='cash')value.expected_amount++;else delete value.cash_breakdown}
 if(window.mode==='hold')await new Promise(resolve=>window.pending.push(resolve))
 return value
}
window.forsageDesktop={pos:{
 expectedCash:()=>read('cash'),shiftReport:()=>read('report'),
 reconcile:(...args)=>{window.calls.reconcile.push(args);return new Promise(resolve=>window.finish=resolve)},
 closeShift:(...args)=>{window.calls.close.push(args);return new Promise(resolve=>window.finish=resolve)}
}}
const{shiftApi}=await import('/src/features/pos/shiftApi.ts')
window.useServerFixtures=()=>{
 delete window.forsageDesktop
 shiftApi.report=async()=>({data:await read('report')})
 shiftApi.expectedCash=async()=>{window.calls.cash++;throw Error('Separate server cash request is forbidden')}
 shiftApi.close=async(...args)=>{window.calls.close.push(args);return new Promise(resolve=>window.finish=resolve)}
}
const{CashReconciliationModal}=await import('/src/features/pos/CashReconciliationModal.tsx')
const{ShiftCloseModal}=await import('/src/features/pos/ShiftCloseModal.tsx')
const root=createRoot(document.getElementById('root'))
window.show=(kind='reconcile',open=true)=>root.render(kind==='reconcile'
 ?React.createElement(CashReconciliationModal,{open,onClose:()=>window.show(kind,false)})
 :React.createElement(ShiftCloseModal,{open,shiftId:'shift',onClose:()=>window.show(kind,false),onClosed:()=>window.show(kind,false)}))
window.show()
`
  const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:shift-fixture"></script></body></html>'
  const server=await createServer({root:path.resolve('apps/web'),configFile:path.resolve('apps/web/vite.config.ts'),
    server:{host:'127.0.0.1',port:5188,strictPort:true},plugins:[{name:'shift-fixture',
      resolveId(id){if(id==='virtual:shift-fixture')return '\0virtual:shift-fixture'},
      load(id){if(id==='\0virtual:shift-fixture')return fixture},
      configureServer(dev){dev.middlewares.use((req,res,next)=>{
        if(req.url!=='/__shift_fixture')return next()
        res.setHeader('Content-Type','text/html');dev.transformIndexHtml('/__shift_fixture',html).then(result=>res.end(result))
      })}
    }]})
  await server.listen();let browser
  try{
    browser=await chromium.launch({channel:'chrome',headless:true})
    const page=await browser.newPage({viewport:{width:1100,height:900}}), errors=[]
    page.on('pageerror',e=>errors.push(e.message))
    await page.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:5188/')?r.continue():r.fulfill({status:503,body:'Test blocks external requests'}))
    await page.goto('http://127.0.0.1:5188/__shift_fixture')
    const input=page.getByLabel('Фактична сума в касі',{exact:true})
    await input.waitFor()
    for(const text of ['','1abc','1.234','-1','1e2']){
      await input.fill(text);await input.press('Enter')
      assert.equal(await page.getByRole('button',{name:'Зберегти звірку',exact:true}).isDisabled(),true)
    }
    assert.equal(await page.evaluate(()=>calls.reconcile.length),0)
    await input.fill('13,50')
    await page.setViewportSize({width:320,height:700})
    const save=page.getByRole('button',{name:'Зберегти звірку',exact:true})
    await save.scrollIntoViewIfNeeded()
    const saveBox=await save.boundingBox()
    assert.ok(saveBox.y>=0 && saveBox.y+saveBox.height<=700,'reconciliation save clipped')
    await page.screenshot({path:'tmp/stage20-reconciliation-320.png',animations:'disabled'})
    await save.evaluate(el=>{el.click();el.click()})
    await page.waitForFunction(()=>calls.reconcile.length===1)
    await input.press('Enter');assert.equal(await page.evaluate(()=>calls.reconcile.length),1)
    assert.equal(await page.evaluate(()=>calls.reconcile[0][1]),1350)
    await page.evaluate(()=>window.finish({ok:true}));await input.waitFor({state:'hidden'})
    const show=async(kind,mode)=>{
      await page.evaluate(({kind,mode})=>{window.mode=mode;window.show(kind)},{kind,mode})
    }
    await show('reconcile','fail');await page.getByRole('alert').waitFor()
    assert.equal(await input.count(),0,'failed reload displays old amount')
    await page.evaluate(()=>window.show('reconcile',false));await page.getByRole('alert').waitFor({state:'hidden'})
    await show('reconcile','hold');await page.waitForFunction(()=>pending.length===1)
    await page.getByRole('button',{name:'Закрити звірку',exact:true}).click()
    await page.waitForFunction(()=>!document.querySelector('input'))
    await show('reconcile','bad');await page.getByRole('alert').waitFor()
    await page.evaluate(()=>pending.shift()());await page.getByRole('alert').waitFor()
    assert.equal(await input.count(),0,'late success overrides newer failure')
    await page.evaluate(()=>window.show('reconcile',false));await page.getByRole('alert').waitFor({state:'hidden'})
    await show('close','good');await input.waitFor()
    const cashReads=await page.evaluate(()=>calls.cash)
    assert.equal(await page.evaluate(()=>calls.report),1)
    await input.fill('13,50')
    for(const width of [1100,390,320]){
      await page.setViewportSize({width,height:800})
      const button=page.getByRole('button',{name:'Закрити зміну',exact:true})
      await button.scrollIntoViewIfNeeded()
      const box=await button.boundingBox()
      assert.ok(box.y>=0 && box.y+box.height<=800,'close button clipped')
      assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth+1),'horizontal overflow')
      await page.screenshot({path:'tmp/stage20-close-'+width+'.png',animations:'disabled'})
    }
    await page.getByRole('button',{name:'Закрити зміну',exact:true}).evaluate(el=>{el.click();el.click()})
    await page.waitForFunction(()=>calls.close.length===1)
    assert.equal(await page.evaluate(()=>calls.cash),cashReads,'close preview queried cash separately')
    assert.equal(await page.evaluate(()=>calls.close[0][3]),'shift')
    assert.equal(await page.evaluate(()=>calls.close[0][1]),1350)
    await page.evaluate(()=>window.finish({ok:true}));await input.waitFor({state:'hidden'})
    await show('close','bad');await page.getByRole('alert').waitFor()
    assert.equal(await page.getByRole('button',{name:'Закрити зміну',exact:true}).isDisabled(),true)
    assert.equal(await input.count(),0)
    await page.screenshot({path:'tmp/stage20-close-error-320.png'})
    await page.evaluate(()=>window.show('close',false));await page.getByRole('alert').waitFor({state:'hidden'})
    await page.evaluate(()=>window.useServerFixtures())
    const beforeServer=await page.evaluate(()=>({cash:calls.cash,report:calls.report,close:calls.close.length}))
    await show('close','good');await input.waitFor()
    await input.fill('13,50')
    assert.equal(await page.evaluate(()=>calls.report),beforeServer.report+1)
    assert.equal(await page.evaluate(()=>calls.cash),beforeServer.cash,'server preview queried cash separately')
    await page.getByRole('button',{name:'Закрити зміну',exact:true}).evaluate(el=>{el.click();el.click()})
    await page.waitForFunction(count=>calls.close.length===count+1,beforeServer.close)
    const serverClose=await page.evaluate(()=>calls.close.at(-1))
    assert.equal(serverClose[0],'shift')
    assert.equal(serverClose[1],1350)
    await page.evaluate(()=>window.finish({data:{ok:true}}));await input.waitFor({state:'hidden'})
    await show('close','bad');await page.getByRole('alert').waitFor()
    assert.equal(await input.count(),0,'incomplete server report must block closing')
    assert.equal(await page.getByRole('button',{name:'Закрити зміну',exact:true}).isDisabled(),true)
    assert.equal(errors.length,0,errors.join('\n'))
    console.log(JSON.stringify({passed:true,checks:['strict decimal input and Enter guard','single reconciliation on double click',
      'failed reload discards old cash','late response ignored','closing uses one report snapshot','single close with exact shift id',
      'old bridge cannot close','1100/390/320 close button reachable','server uses one snapshot and one close','incomplete server report cannot close'],liveDataModified:false}))
  }finally{if(browser)await browser.close();await server.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
