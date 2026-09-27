// Actual React components, isolated browser and fake persistence. All non-loopback
import { createSmokeCache } from './ui-smoke-cache.mjs'
// requests are blocked; no credentials, shop data, printer or real clipboard used.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const mocks = {
  '@/lib/desktopBridge': 'export const desktopBridge=()=>window.fixture.bridge',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),success:m=>fixture.success.push(m),warning:m=>fixture.errors.push(m)}',
}
const entry = `
import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
import {ProductPhotoUpload} from '/src/features/products/ProductPhotoUpload.tsx';
const root=createRoot(document.getElementById('root'));
const f=window.fixture={uploads:[],commits:[],errors:[],success:[],submits:0,holdUpload:true,holdCommit:true};
f.bridge={catalog:{savePhoto:async(folder,bytes)=>{
 f.uploads.push({folder,size:bytes.byteLength,magic:[...new Uint8Array(bytes).slice(0,2)]});
 if(f.uploadError)throw Error('test upload failure');
 if(f.holdUpload)await new Promise(resolve=>f.finishUpload=resolve);
 return URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'}));
}}};
function Fixture({id}){
 const [url,setUrl]=useState(null),[busy,setBusy]=useState(false);
 return <form onSubmit={e=>{e.preventDefault();f.submits++}}>
 <ProductPhotoUpload productId={id} currentPhotoUrl={url} onBusyChange={setBusy} onPhotoUrl={async next=>{
 f.commits.push({id,url:next}); if(f.commitError)throw Error('test commit failure');
 if(f.holdCommit)await new Promise(resolve=>f.finishCommit=resolve);setUrl(next);
 }}/><button type="submit" disabled={busy}>Save product</button></form>
}
f.mount=(id='photo-a')=>root.render(<Fixture key={id} id={id}/>);f.mount();
`
const server = await createServer({cacheDir:createSmokeCache(),
  configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'readiness-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:readiness.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:readiness.tsx') return transformWithEsbuild(entry, 'readiness.tsx', { loader: 'tsx', jsx: 'automatic' })
      if (id.startsWith('\0')) return mocks[id.slice(1)]
      for (const [name, source] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) return source
    },
    configureServer(server) {
      server.middlewares.use('/readiness', async (_req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end(await server.transformIndexHtml('/readiness', '<html><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:readiness.tsx"></script></body></html>'))
      })
    },
  }],
})
let browser
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } }), errors = [], blocked = []
  page.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message) })
  const base = server.resolvedUrls.local[0]
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(base).origin) return route.continue()
    blocked.push(url.origin); return route.abort()
  })
  await page.goto(base + 'readiness')
  await page.getByRole('button', { name: 'Save product' }).waitFor()
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width=2400; canvas.height=1200
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const file = { name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }
  const upload = () => page.locator('input[type=file]').first().setInputFiles(file)
  await upload(); await page.waitForFunction(() => fixture.uploads.length === 1)
  assert(await page.getByRole('button', { name: 'Save product' }).isDisabled())
  // Another paste while upload is pending must not create another write.
  await page.evaluate(async png => {
    const blob = await (await fetch('data:image/png;base64,'+png)).blob()
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'duplicate.png', {type:'image/png'}))
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt}))
  }, png)
  assert.equal(await page.evaluate(() => fixture.uploads.length), 1)
  await page.evaluate(() => fixture.finishUpload())
  await page.waitForFunction(() => fixture.commits.length === 1)
  assert(await page.getByRole('button', { name: 'Save product' }).isDisabled())
  await page.evaluate(() => fixture.finishCommit())
  await page.getByAltText('Фото товару').waitFor()
  assert.equal(await page.evaluate(() => fixture.submits), 0)
  assert.deepEqual(await page.evaluate(() => fixture.uploads[0].magic), [255,216])
  await page.waitForFunction(() => document.querySelector('img')?.naturalWidth === 1200)
  assert.equal(await page.getByAltText('Фото товару').evaluate(img => img.naturalHeight), 600)
  await page.evaluate(() => { fixture.holdUpload=false; fixture.holdCommit=false; fixture.commitError=true })
  const previous = await page.getByAltText('Фото товару').getAttribute('src')
  await upload(); await page.waitForFunction(() => fixture.errors.includes('test commit failure'))
  assert.equal(await page.getByAltText('Фото товару').getAttribute('src'), previous)
  assert.equal(await page.getByRole('button', { name: 'Save product' }).isDisabled(), false)
  await page.evaluate(() => { fixture.commitError=false; fixture.uploadError=true })
  await upload(); await page.waitForFunction(() => fixture.errors.includes('test upload failure'))
  assert.equal(await page.evaluate(() => fixture.commits.length), 2)
  await page.evaluate(() => { fixture.uploadError=false })
  await page.getByRole('button', { name: 'Прибрати фото' }).click()
  await page.waitForFunction(() => !document.querySelector('img'))
  assert.equal(await page.evaluate(() => fixture.submits), 0)
  await page.evaluate(() => { fixture.holdUpload=true })
  await upload(); await page.waitForFunction(() => fixture.uploads.length === 4)
  const commits = await page.evaluate(() => fixture.commits.length)
  await page.evaluate(() => fixture.mount('photo-b'))
  await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'))
  await page.evaluate(() => fixture.finishUpload())
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => fixture.commits.length), commits, 'Late upload attached to another product')
  assert.equal(await page.getByAltText('Фото товару').count(), 0)
  console.log('PASS: real image conversion, upload/save lock, duplicate paste, failure/retry, remove, no accidental submit, stale upload isolation')

  await page.goto(base + 'tests/fixtures/catalog-chunk.html')
  await page.locator('[data-product="0"]').waitFor()
  const main = page.locator('#app-main-scroll')
  await page.waitForTimeout(200)
  const initial = await main.evaluate(el => el.scrollHeight)
  await page.getByRole('checkbox', { name: 'Обрати 0', exact: true }).check()
  for (const fraction of [.25, .5, 1, 0]) {
    await main.evaluate((el, fraction) => { el.scrollTop = fraction * el.scrollHeight }, fraction)
    await page.waitForTimeout(200)
    assert(await page.locator('[data-product]').count() < 200)
    assert(Math.abs(initial - await main.evaluate(el => el.scrollHeight)) < 20)
  }
  assert(await page.getByRole('checkbox', { name: 'Обрати 0', exact: true }).isChecked())
  await page.setViewportSize({ width: 390, height: 700 }); await page.waitForTimeout(200)
  const mobileHeight = await main.evaluate(el => el.scrollHeight)
  await main.evaluate(el => { el.scrollTop = el.scrollHeight }); await page.waitForTimeout(200)
  await page.locator('[data-product="999"]').waitFor()
  assert(await page.locator('[data-product]').count() < 150)
  assert(Math.abs(mobileHeight - await main.evaluate(el => el.scrollHeight)) < 20)
  await main.evaluate(el => { el.scrollTop = 0 }); await page.waitForTimeout(200)
  assert(await page.getByRole('checkbox', { name: 'Обрати 0', exact: true }).isChecked())
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log('PASS: 1000 catalog rows, desktop/mobile, bottom reachable, stable scrolling, selection persists, no external requests')
} finally { await browser?.close(); await server.close() }
