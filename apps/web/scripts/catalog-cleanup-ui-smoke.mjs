// Actual cleanup page/model, synthetic IPC/AI only. No production DB, paid AI, writes or external network.
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
  '@/components/Layout': 'export const Layout=({title,children})=><main><h1>{title}</h1>{children}</main>',
  '@/stores/authStore': `import{useSyncExternalStore}from'react';const listen=fn=>{fixture.listeners.push(fn);return()=>{fixture.listeners=fixture.listeners.filter(x=>x!==fn)}};export const useAuthStore=selector=>selector(useSyncExternalStore(listen,()=>fixture.auth));useAuthStore.getState=()=>fixture.auth;`,
  '@/lib/desktopBridge': 'export const desktopBridge=()=>fixture.bridge;export const isDesktopRuntime=()=>true',
  '@/lib/api': `export const api={post:async(path,body)=>{fixture.ai.push({path,body});if(fixture.holdAi)await new Promise(resolve=>fixture.finishAi=resolve);if(fixture.aiFail)throw Error('ШІ тимчасово недоступний');return{data:{reviews:body.groups.map(g=>({group_id:g.id,verdict:'same',reason:'Synthetic advice only'}))}}}}`,
}
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import CatalogCleanupPage from'/src/features/admin/CatalogCleanupPage.tsx';import'/src/index.css';createRoot(document.getElementById('root')).render(<MemoryRouter><CatalogCleanupPage/></MemoryRouter>);`
const bootstrap = `
window.fixture={...window.testOptions,scans:0,previews:[],applies:[],skus:[],ai:[],listeners:[]};
fixture.auth={session:{user:{id:'owner',app_metadata:{role:fixture.role??'owner',tenant_id:'shop'}}}};
const product=(id,name,sku,qty,barcode)=>({id,name,sku,qty_on_hand:qty,barcode,additional_barcodes:['extra-'+id],brand:'Mannol',unit:'шт',fingerprint:'field-'+id,purchase_price:12000,retail_price:16000});
fixture.products=[product('target','Олива Mannol 5W30 4л C3 повна назва для перевірки розміру та характеристик TARGET','8206-1',2,'2000000000010'),product('source','Олива Mannol 5W30 4л C3 повна назва іншої картки SOURCE','AUTO-02',1,'2000000000027'),product('sku','Mannol DEXRON III арт. 8206-1 1л','AUTO-03',0,'2000000000034')];
fixture.groups=[{id:'exact',level:'exact',product_ids:['target','source'],suggested_target_id:'target',reasons:['Збіг артикула в назві'],conflicts:[]},{id:'conflict',level:'conflict',product_ids:['target','source'],suggested_target_id:'target',reasons:['Схожі назви'],conflicts:['Різний об’єм: 1л і 4л']}];
if(fixture.manyGroups)fixture.groups=Array.from({length:25},(_,i)=>({...fixture.groups[0],id:'group-'+i}));
fixture.scan=()=>({products:fixture.products,groups:fixture.groups,sku_suggestions:[{product_id:'sku',sku:'8206-1',evidence:'Назва містить арт. 8206-1',preview_fingerprint:'sku-snapshot'}],capability:{available:!fixture.unsupported,reason:fixture.unsupported?'Сервер не підтвердив сумісність':undefined},warnings:[],total:3});
fixture.bridge={lan:{firstRunStatus:async()=>({mode:fixture.mode??'hub',configured:true,canPair:false})},catalog:{
cleanupScan:async()=>{fixture.scans++;if(fixture.scanFail)throw Error('Перевірка не оновилася');return fixture.scan()},
cleanupPreview:async input=>{fixture.previews.push(input);if(fixture.holdPreview)await new Promise(resolve=>fixture.finishPreview=resolve);return{...input,fingerprint:'merge-snapshot',products:fixture.products.filter(p=>[input.target_id,...input.source_ids].includes(p.id)),blockers:fixture.blocked?['Є відкрита накладна']:[],warnings:['Історичні документи не переписуються'],quantity_before:[2,1],quantity_after:3,history_counts:{sale_items:4},barcodes:['2000000000010','2000000000027'],photos:[],can_apply:!fixture.blocked}},
cleanupApply:async input=>{fixture.applies.push(input);if(fixture.holdApply)await new Promise(resolve=>fixture.finishApply=resolve);if(fixture.applyFail)throw Error('Відповідь втрачено');return{target_id:input.target_id,source_ids:input.source_ids,backupPath:'synthetic-backup'}},
cleanupApplySku:async input=>{fixture.skus.push(input);if(fixture.holdSku)await new Promise(resolve=>fixture.finishSku=resolve);if(fixture.skuFail)throw Error('Відповідь втрачено');return{updated:1}},
}};
`
const server = await createServer({
  cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  optimizeDeps: { entries: [], noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-router-dom', 'lucide-react'] },
  esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'], alias: { '@': path.join(root, 'apps/web/src') } },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [tailwindcss(), {
    name: 'cleanup-synthetic-fixtures', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:cleanup.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:cleanup.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
      for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
      if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
    },
    configureServer(vite) { vite.middlewares.use('/cleanup-test', async (_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml('/cleanup-test', '<html><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:cleanup.tsx"></script></body></html>')) }) },
  }],
})
let browser
const errors = [], external = [], passed = []
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0]
  async function setup(options = {}) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : (external.push(route.request().url()), route.abort()))
    await page.addInitScript(options => { window.testOptions = options }, options)
    await page.goto(base + 'cleanup-test')
    await page.getByRole('heading', { name: 'Очищення номенклатури', exact: true }).waitFor()
    return page
  }
  const scan = page => page.getByRole('button', { name: 'Перевірити номенклатуру', exact: true }).click()
  async function choose(page) {
    await page.getByRole('button', { name: 'Порівняти картки', exact: true }).first().click()
    const targets = page.getByRole('radio')
    assert.equal(await page.locator('input:checked').count(), 0)
    await targets.first().check()
    await page.getByLabel(/Об’єднати картку:.*SOURCE/).check()
    await page.getByLabel('Причина об’єднання', { exact: true }).fill('Перевірив назву, бренд і об’єм')
  }

  const explicit = await setup({ holdPreview: true, holdApply: true, applyFail: true })
  await scan(explicit); await choose(explicit)
  const counted = explicit.getByLabel(/Я окремо звірив фактичну кількість/)
  await counted.check()
  await explicit.getByLabel(/Об’єднати картку:.*SOURCE/).uncheck()
  assert.equal(await counted.isChecked(), false)
  await explicit.getByLabel(/Об’єднати картку:.*SOURCE/).check()
  assert.deepEqual(await explicit.evaluate(() => [fixture.applies.length, fixture.ai.length]), [0, 0])
  const nameStyle = await explicit.getByRole('link', { name: /SOURCE/ }).evaluate(el => ({ whitespace: getComputedStyle(el).whiteSpace, overflow: getComputedStyle(el).textOverflow }))
  assert.notEqual(nameStyle.whitespace, 'nowrap'); assert.notEqual(nameStyle.overflow, 'ellipsis')
  await explicit.getByRole('button', { name: 'Перевірити об’єднання', exact: true }).evaluate(button => { button.click(); button.click() })
  await explicit.waitForFunction(() => fixture.previews.length === 1 && fixture.finishPreview)
  await explicit.evaluate(() => fixture.finishPreview())
  const dialog = explicit.getByRole('dialog', { name: 'Підтвердити конкретне об’єднання' })
  await dialog.waitFor(); assert.equal(await dialog.getByRole('button', { name: 'Підтвердити об’єднання', exact: true }).isDisabled(), true)
  await dialog.getByText(/Фактичну кількість ще не перевірено/).waitFor()
  await dialog.getByLabel('Підтверджую однаковий товар', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Підтвердити об’єднання', exact: true }).evaluate(button => { button.click(); button.click() })
  await explicit.waitForFunction(() => fixture.applies.length === 1 && fixture.finishApply)
  await explicit.keyboard.press('Escape'); assert.equal(await dialog.count(), 1)
  await explicit.evaluate(() => fixture.finishApply())
  await dialog.getByRole('alert').filter({ hasText: 'Відповідь втрачено' }).waitFor()
  await explicit.evaluate(() => { fixture.applyFail = false; fixture.holdApply = false })
  await dialog.getByRole('button', { name: 'Підтвердити об’єднання', exact: true }).click()
  await explicit.getByRole('status').filter({ hasText: 'Картки об’єднано' }).waitFor()
  const requests = await explicit.evaluate(() => fixture.applies)
  assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]); assert.ok(requests[0].operation_id)
  assert.equal(requests[0].stock_review, 'pending'); assert.equal('qty_on_hand' in requests[0], false)
  assert.equal(await explicit.evaluate(() => fixture.scans), 2)
  await explicit.close(); passed.push('explicit target/source/fresh-preview/confirmation, pending physical stock, serialized write and same-ID retry')

  const blocked = await setup({ blocked: true })
  await blocked.evaluate(() => { fixture.products[0].sku = null; fixture.products[0].barcode = null; fixture.products[0].brand = null })
  await scan(blocked); await choose(blocked)
  await blocked.getByRole('button', { name: 'Перевірити об’єднання', exact: true }).click()
  await blocked.getByRole('alert').filter({ hasText: 'Є відкрита накладна' }).waitFor()
  assert.equal(await blocked.getByRole('button', { name: 'Підтвердити об’єднання', exact: true }).isDisabled(), true)
  await blocked.getByRole('button', { name: 'Скасувати', exact: true }).click()
  await blocked.getByLabel('Рівень збігу', { exact: true }).selectOption('conflict')
  await blocked.getByRole('button', { name: 'Порівняти картки', exact: true }).click()
  assert.equal(await blocked.getByRole('radio').first().isDisabled(), true)
  await blocked.getByRole('button', { name: 'ШІ: перевірити цю групу', exact: true }).click()
  await blocked.getByText(/Synthetic advice only/).waitFor()
  assert.equal(await blocked.getByRole('button', { name: 'Перевірити об’єднання', exact: true }).isDisabled(), true)
  const ai = await blocked.evaluate(() => fixture.ai[0])
  assert.equal(ai.path, '/api/v1/ai/catalog-duplicates-review'); assert.equal('qty_on_hand' in ai.body.groups[0].products[0], false)
  assert.equal('purchase_price' in ai.body.groups[0].products[0], false)
  assert.equal(ai.body.groups[0].products[0].sku, ''); assert.equal(ai.body.groups[0].products[0].barcode, null); assert.equal(ai.body.groups[0].products[0].brand, null)
  assert.equal(await blocked.evaluate(() => fixture.applies.length), 0)
  await blocked.close(); passed.push('open documents/conflicts stay blocked, optional AI only and cannot authorize a merge')

  const sku = await setup({ skuFail: true }); await scan(sku)
  await sku.getByRole('button', { name: 'Перевірити артикул', exact: true }).click()
  const skuDialog = sku.getByRole('dialog', { name: 'Підтвердити артикул з назви' })
  assert.equal(await skuDialog.getByRole('button', { name: 'Зберегти артикул', exact: true }).isDisabled(), true)
  await skuDialog.getByLabel('Підтверджую артикул', { exact: true }).check()
  await skuDialog.getByRole('button', { name: 'Зберегти артикул', exact: true }).click()
  await skuDialog.getByRole('alert').filter({ hasText: 'Відповідь втрачено' }).waitFor()
  await sku.evaluate(() => { fixture.skuFail = false })
  await skuDialog.getByRole('button', { name: 'Зберегти артикул', exact: true }).click()
  await sku.getByRole('status').filter({ hasText: 'Підтверджений артикул записано' }).waitFor()
  const skuRequests = await sku.evaluate(() => fixture.skus)
  assert.deepEqual(skuRequests[0], skuRequests[1]); assert.equal(skuRequests[0].preview_fingerprint, 'sku-snapshot')
  assert.equal('qty_on_hand' in skuRequests[0], false)
  await sku.close(); passed.push('separate explicitly confirmed AUTO-SKU proposal, fingerprint and same-ID retry')

  const search = await setup({ manyGroups: true }); await scan(search)
  assert.equal(await search.getByRole('button', { name: 'Порівняти картки', exact: true }).count(), 12)
  await search.getByRole('button', { name: 'Наступні групи', exact: true }).click()
  await search.getByRole('button', { name: 'Наступні групи', exact: true }).click()
  assert.equal(await search.getByRole('button', { name: 'Порівняти картки', exact: true }).count(), 1)
  await search.getByLabel('Пошук серед результатів', { exact: true }).fill('extra-source')
  assert.equal(await search.getByRole('button', { name: 'Порівняти картки', exact: true }).count(), 12)
  await search.getByLabel('Пошук серед результатів', { exact: true }).fill('unknown-article')
  await search.getByText(/За цим фільтром груп не знайдено/).waitFor()
  await search.getByLabel('Пошук серед результатів', { exact: true }).fill('')
  await search.evaluate(() => { fixture.scanFail = true })
  await scan(search); await search.getByRole('alert').filter({ hasText: 'Перевірка не оновилася' }).waitFor()
  assert.equal(await search.getByRole('button', { name: 'Порівняти картки', exact: true }).count(), 12)
  await search.close(); passed.push('full-name/code search, group pagination/reset, failed scan does not erase last results')

  for (const [options, text] of [[{ role: 'cashier' }, 'лише власнику й адміністратору'], [{ mode: 'client' }, 'лише на головному ПК']]) {
    const page = await setup(options)
    await page.getByRole('alert').filter({ hasText: text }).waitFor()
    assert.equal(await page.evaluate(() => fixture.scans), 0)
    assert.equal(await page.evaluate(() => fixture.applies.length), 0)
    await page.close()
  }
  const unsupported = await setup({ unsupported: true }); await scan(unsupported); await choose(unsupported)
  await unsupported.getByRole('alert').filter({ hasText: 'Сервер не підтвердив сумісність' }).waitFor()
  assert.equal(await unsupported.getByRole('button', { name: 'Перевірити об’єднання', exact: true }).isDisabled(), true)
  assert.equal(await unsupported.getByRole('button', { name: 'Перевірити артикул', exact: true }).isDisabled(), false)
  await unsupported.close(); passed.push('owner/admin only, manager-PC hard stop, capability fail-closed')

  const stale = await setup({ holdAi: true }); await scan(stale); await choose(stale)
  await stale.getByRole('button', { name: 'ШІ: перевірити цю групу', exact: true }).click()
  await stale.waitForFunction(() => typeof fixture.finishAi === 'function')
  await stale.evaluate(() => { fixture.auth = { session: { user: { id: 'cashier', app_metadata: { role: 'cashier', tenant_id: 'shop' } } } }; fixture.listeners.forEach(fn => fn()); fixture.finishAi() })
  await stale.getByRole('alert').filter({ hasText: 'лише власнику й адміністратору' }).waitFor()
  assert.equal(await stale.getByText(/Synthetic advice only/).count(), 0)
  assert.equal(await stale.evaluate(() => fixture.applies.length), 0)
  await stale.close(); passed.push('late AI response cannot update another user/role context')

  const stalePreview = await setup({ holdPreview: true }); await scan(stalePreview); await choose(stalePreview)
  await stalePreview.getByRole('button', { name: 'Перевірити об’єднання', exact: true }).click()
  await stalePreview.waitForFunction(() => typeof fixture.finishPreview === 'function')
  await stalePreview.evaluate(() => { fixture.auth = { session: { user: { id: 'another-owner', app_metadata: { role: 'owner', tenant_id: 'another-shop' } } } }; fixture.listeners.forEach(fn => fn()); fixture.finishPreview() })
  await stalePreview.getByRole('button', { name: 'Перевірити номенклатуру', exact: true }).waitFor()
  assert.equal(await stalePreview.getByRole('dialog').count(), 0)
  assert.equal(await stalePreview.getByRole('button', { name: 'Порівняти картки', exact: true }).count(), 0)
  assert.equal(await stalePreview.evaluate(() => fixture.applies.length), 0)
  await stalePreview.close(); passed.push('late preview cannot cross user/tenant context or preserve another user’s selected cards')

  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log(JSON.stringify({ passed, scenarios: passed.length, liveWrites: 0, externalRequests: external.length }, null, 2))
} finally { await browser?.close(); await server.close() }
