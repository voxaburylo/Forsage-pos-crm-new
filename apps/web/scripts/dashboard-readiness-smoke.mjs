// Real statistics page, isolated fake APIs. No live documents, accounts or network.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const { chromium } = await import('playwright')
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const mocks = {
  '@/lib/api': 'export const api={get:()=>window.fixture.read(false)}',
  '@/lib/desktopBridge': 'export const desktopBridge=()=>window.fixture.desktop==="old"?{pos:{}}:window.fixture.desktop?{pos:{dashboardSummary:()=>window.fixture.read(true)}}:undefined',
  '@/stores/authStore': 'export const useAuthStore=fn=>fn({session:{user:{app_metadata:{role:window.fixture.role}}}})',
  '@/features/staff/staffApi': 'export const staffApi={tireServiceReport:()=>window.fixture.readTires()}',
  '@/lib/utils': "export const formatMoney=n=>(n/100).toFixed(2)+' грн'",
  '@/lib/businessDate': "export const businessDateKey=()=> '2026-10-03';export const businessDateRangeUtc=(from,to)=>({from:from+'T00:00:00Z',to:to+'T23:59:59.999Z'})",
  '@/features/analytics/AnalyticsLayout': "export const AnalyticsLayout=({children,title})=><main className='analytics-content'><h1>{title}</h1>{children}</main>",
  '@/components/ui': 'export const Card=({children,className})=><div className={className}>{children}</div>;export const Button=({children,onClick})=><button onClick={onClick}>{children}</button>',
  'react-router-dom': 'export const useNavigate=()=>()=>{}',
}
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import DashboardPage from '/src/pages/DashboardPage.tsx';
import '/src/index.css';
import '/src/features/analytics/analyticsLayout.css';
const root=createRoot(document.getElementById('root'));
const f=window.fixture={mode:'error',role:'owner',desktop:false,tireMode:'ok',pending:[],tirePending:[],key:0,
 data:{total_revenue:12345,cogs:6000,gross_profit:6345,total_receipts:2,average_receipt:6173,daily:[],
 low_stock:2,overdue_count:1,debt:{count:1,total:999},inventory:{purchase_value:20000,retail_value:40000}}};
f.read=local=>{
 const data=structuredClone(f.data);
 const result=local?{analytics:data,low_stock:data.low_stock,overdue_count:data.overdue_count,debt:data.debt,inventory:data.inventory}:{data};
 if(f.mode==='error')return Promise.reject(Error('offline'));
 if(f.mode==='pending')return new Promise(resolve=>f.pending.push(()=>resolve(result)));
 return Promise.resolve(result);
};
f.readTires=()=>f.tireMode==='error'?Promise.reject(Error('tire report offline')):
 f.tireMode==='pending'?new Promise(resolve=>f.tirePending.push(()=>resolve({data:[]}))):Promise.resolve({data:f.tireData??[]});
f.render=()=>root.render(React.createElement(DashboardPage,{key:++f.key}));
f.render();
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false,
  root: path.join(root, 'apps/web'), logLevel: 'error', esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), { name: 'isolated-statistics', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:audit' || Object.hasOwn(mocks, id)) return '\0'+id },
    load(id) {
      if (id === '\0virtual:audit') return entry
      if (id.startsWith('\0')) return mocks[id.slice(1)]
      for (const [name, source] of Object.entries(mocks)) {
        if (name.startsWith('@/') && id.replaceAll('\\','/').replace(/\.tsx?$/, '').endsWith('/src/'+name.slice(2))) return source
      }
    },
    configureServer(server) {
      server.middlewares.use('/audit', async (_req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end(await server.transformIndexHtml('/audit', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:audit"></script></body></html>'))
      })
    },
  }],
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(server.resolvedUrls.local[0]+'audit')
  await page.getByRole('alert').filter({hasText:'Не вдалося завантажити статистику'}).waitFor()
  assert.equal(await page.getByText('0.00 грн', {exact:true}).count(), 0)
  console.log('PASS: loading failure is not shown as a zero day')

  await page.evaluate(() => { fixture.mode='ok';fixture.render() })
  await page.getByText('123.45 грн',{exact:true}).first().waitFor()
  await page.getByLabel('Дата продажів').fill('2026-10-01')
  await page.getByText('Продажі за вибраний період',{exact:true}).waitFor()
  assert.equal(await page.getByText('Продано сьогодні',{exact:true}).count(), 0)
  console.log('PASS: selected historical date is not mislabeled as today')

  await page.evaluate(() => { fixture.tireMode='error';fixture.render() })
  await page.getByText('Не вдалося завантажити дані шиномонтажу',{exact:true}).waitFor()
  assert.equal(await page.getByText('Працівників шиномонтажу ще не налаштовано або за день немає нарахувань',{exact:true}).count(),0)
  assert.equal(await page.getByText('123.45 грн',{exact:true}).count()>0,true)
  console.log('PASS: salary request failure is not reported as zero payroll')

  await page.evaluate(() => { fixture.tireMode='ok';fixture.desktop='old';fixture.render() })
  await page.getByRole('alert').filter({hasText:'Оновіть локальну програму'}).waitFor()
  assert.equal(await page.getByText('0.00 грн',{exact:true}).count(),0)
  console.log('PASS: old desktop cannot silently substitute an incomplete or cloud report')

  await page.evaluate(() => { fixture.desktop=true;fixture.mode='ok';fixture.render() })
  await page.getByText('123.45 грн',{exact:true}).first().waitFor()
  await page.evaluate(() => { delete fixture.data.inventory;fixture.render() })
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByText('123.45 грн',{exact:true}).count(),0)
  console.log('PASS: incomplete data is not accepted as an apparently complete report')

  await page.evaluate(() => {
    fixture.data.inventory={purchase_value:20000,retail_value:40000};fixture.desktop=false;
    fixture.role='cashier';fixture.mode='pending';fixture.render();
  })
  await page.waitForFunction(() => fixture.pending.length===1)
  await page.evaluate(() => { fixture.mode='ok';fixture.data.total_revenue=77777 })
  await page.getByRole('button',{name:'7 днів',exact:true}).click()
  await page.getByText('777.77 грн',{exact:true}).first().waitFor()
  await page.evaluate(() => fixture.pending.shift()())
  assert.equal(await page.getByText('123.45 грн',{exact:true}).count(),0)
  assert.equal(await page.getByText('Валовий прибуток',{exact:true}).count(),0)
  console.log('PASS: late old-period result cannot replace current-period data')

  await page.evaluate(() => {
    fixture.mode='ok';fixture.data.total_revenue=0;fixture.data.total_receipts=0;fixture.data.average_receipt=0;
    fixture.data.cogs=0;fixture.data.gross_profit=0;fixture.data.daily=[];fixture.render();
  })
  await page.getByText('0.00 грн',{exact:true}).first().waitFor()
  assert.equal(await page.getByRole('alert').count(),0)
  console.log('PASS: a successfully loaded empty period still shows real zero values')
  await page.evaluate(() => { fixture.role='owner';fixture.tireData=[{employee_id:'one'}];fixture.render() })
  await page.getByText('Не вдалося завантажити дані шиномонтажу',{exact:true}).waitFor()
  console.log('PASS: incomplete tire-service rows do not silently become zero wages')

  await page.setViewportSize({width:390,height:844})
  await page.evaluate(() => {
    fixture.tireData=Array.from({length:20},(_,i)=>({
      employee_id:'worker-'+i,employee_name:'Працівник шиномонтажу з довгим прізвищем '+i,
      services_qty:1,service_revenue:10000,commission_earned:1260,earned:1260,paid:0,due:1260,
    }));fixture.render();
  })
  await page.getByText('Працівник шиномонтажу з довгим прізвищем 19',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Переглянути →',exact:true}).last().scrollIntoViewIfNeeded()
  const layout=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,
    height:window.innerHeight,lastBottom:[...document.querySelectorAll('button')].at(-1).getBoundingClientRect().bottom}))
  assert.ok(layout.scroll<=layout.width,'statistics page must not scroll sideways on a phone')
  assert.ok(layout.lastBottom<=layout.height+1,'last report action must be reachable by vertical scrolling')
  assert.deepEqual(errors,[])
  console.log('PASS: real responsive styles fit a 390px phone and the bottom of a long list is reachable')
} finally { await browser?.close(); await server.close() }
