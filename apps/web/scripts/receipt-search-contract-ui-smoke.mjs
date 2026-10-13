// Actual receipt finder, return form and saleApi; synthetic read-only transports.
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
  '@/lib/desktopBridge': 'export const desktopBridge=()=>fixture.desktop?fixture.bridge:null;export const isDesktopRuntime=()=>fixture.desktop',
  '@/lib/api': 'export const api={get:async url=>{if(!url.startsWith("/api/v1/sales?"))throw Error("Unexpected read "+url);return fixture.read(Object.fromEntries(new URL(url,location.origin).searchParams))},post:()=>{throw Error("Writes forbidden")}}',
  '@/lib/offlineDB': 'export const getLocalSyncState=async()=>({reset_generation:0})',
  '@/stores/authStore': 'const state={session:{user:{id:"synthetic-cashier",app_metadata:{role:"cashier",tenant_id:"synthetic"}}}};export const useAuthStore=Object.assign(select=>select(state),{getState:()=>state})',
  '@/features/pos/returnApi': 'export const returnApi={hasPending:()=>false,getSaleItems:async id=>{fixture.itemReads.push(id);return{data:{sale:{id,fiscal_number:null},items:[]}}}}',
  '@/features/pos/usePOSBarcodeScanner': 'export const usePOSBarcodeScanner=()=>{}',
  '@/features/orders/orderApi': 'export const orderApi={}',
  '@/components/Layout': 'export function Layout({children,title}){return <main><h1>{title}</h1>{children}</main>}',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.errors.push(m)};export function ToastContainer(){return null}',
}
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import{ReceiptFinderModal}from'/src/features/pos/ReceiptFinderModal.tsx';import ReturnForm from'/src/features/pos/ReturnForm.tsx';createRoot(document.getElementById('root')).render(<MemoryRouter>{fixture.kind==='finder'?<ReceiptFinderModal open onClose={()=>{}} onSelect={()=>{throw Error('Printing forbidden')}}/>:<ReturnForm/>}</MemoryRouter>);`
const bootstrap = `
window.fixture={...window.fixtureOptions,requests:[],errors:[],itemReads:[]};
fixture.rows=Array.from({length:1006},(_,i)=>({id:'receipt-'+i,sale_number:i===1001?'REC-OLD-1001':'REC-'+i,total:10000,status:'completed',payment_method:'cash',completed_at:new Date().toISOString(),sale_items:[],barcode:'200000000'+i}));
fixture.read=async params=>{fixture.requests.push(params);let rows=params.history_filter_version==='1'?fixture.rows:fixture.rows.slice(0,1000);if(params.search)rows=rows.filter(row=>row.sale_number.includes(params.search));if(params.product_barcode)rows=rows.filter(row=>row.barcode===params.product_barcode);return{data:rows.slice(0,Number(params.per_page||20)),pagination:{total:rows.length},...(fixture.legacy?{}:{filter_version:1})}};
fixture.bridge={pos:{listSales:params=>fixture.read(params)},fiscal:{listUnresolvedReturns:async()=>[]}};
`
const server = await createServer({
  cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  optimizeDeps: { entries: [], noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-router-dom', 'lucide-react'] },
  esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'], alias: { '@': path.join(root, 'apps/web/src') } },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [{
    name: 'receipt-search-contract-fixtures', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:receipt-contract.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:receipt-contract.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
      for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
      if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
    },
    configureServer(vite) { vite.middlewares.use('/receipt-contract', async (_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml('/receipt-contract', '<html><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:receipt-contract.tsx"></script></body></html>')) }) },
  }],
})
let browser
const errors = [], blocked = [], passed = []
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0]
  async function setup(kind, desktop, legacy = false) {
    const page = await browser.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : (blocked.push(route.request().url()), route.abort()))
    await page.addInitScript(options => { window.fixtureOptions = options }, { kind, desktop, legacy })
    await page.goto(base + 'receipt-contract')
    return page
  }
  for (const desktop of [true, false]) {
    const finder = await setup('finder', desktop)
    await finder.waitForFunction(() => fixture.requests.length > 0)
    assert.equal(await finder.evaluate(() => fixture.requests[0].history_filter_version), '1', 'Finder must require the uncapped v1 contract')
    await finder.getByPlaceholder(/Номер чека/).fill('REC-OLD-1001')
    await finder.getByText('#REC-OLD-1001', { exact: true }).waitFor()
    const finderReads = await finder.evaluate(() => fixture.requests)
    assert.ok(finderReads.every(params => params.history_filter_version === '1' && params.status === 'completed' && Number.isFinite(Date.parse(params.date_from))))
    assert.ok(finderReads.some(params => params.product_barcode === 'REC-OLD-1001'))
    assert.ok(finderReads.some(params => params.search === 'REC-OLD-1001'))
    await finder.close()

    const legacyFinder = await setup('finder', desktop, true)
    await legacyFinder.getByRole('alert').filter({ hasText: 'неповний список не показано' }).waitFor()
    assert.equal(await legacyFinder.getByText('Останні чеки за 14 днів', { exact: true }).count(), 0)
    await legacyFinder.evaluate(() => { fixture.legacy = false })
    await legacyFinder.getByPlaceholder(/Номер чека/).press('Enter')
    await legacyFinder.getByText('#REC-0', { exact: true }).waitFor()
    await legacyFinder.close()

    const returns = await setup('return', desktop, true)
    const search = returns.getByPlaceholder("Номер чека, телефон, ім'я або штрихкод товару")
    await search.fill('REC-OLD-1001')
    await returns.getByRole('button', { name: 'Знайти', exact: true }).click()
    await returns.waitForFunction(() => fixture.requests.length > 0)
    assert.equal(await returns.evaluate(() => fixture.requests[0].history_filter_version), '1', 'Return lookup must require the uncapped v1 contract')
    await returns.waitForFunction(() => fixture.errors.some(message => message.includes('неповний список не показано')))
    assert.deepEqual(await returns.evaluate(() => fixture.itemReads), [], 'Unverified receipt must not enter the return flow')
    assert.equal(await search.inputValue(), 'REC-OLD-1001')
    await returns.evaluate(() => { fixture.legacy = false })
    await returns.getByRole('button', { name: 'Знайти', exact: true }).click()
    await returns.waitForFunction(() => fixture.itemReads.includes('receipt-1001'))
    const returnReads = await returns.evaluate(() => fixture.requests)
    assert.ok(returnReads.every(params => params.history_filter_version === '1' && !params.date_from && Number(params.per_page) === 12))
    assert.ok(returnReads.some(params => params.search === 'REC-OLD-1001'))
    assert.ok(returnReads.some(params => params.product_barcode === 'REC-OLD-1001' && params.status === 'completed'))
    await returns.close()
    passed.push(`${desktop ? 'desktop' : 'server'}: finder and return v1, synthetic receipt beyond 1000, old-source failure and read-only retry`)
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log(JSON.stringify({ passed: true, cases: passed, liveWrites: 0, printing: 0, externalRequests: 0 }))
} finally { await browser?.close(); await server.close() }
