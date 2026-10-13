// Real LocalSyncAgent and sync hooks; synthetic IPC and HTTP, never a live store.
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
  '@/lib/desktopBridge': 'export const desktopBridge=()=>fixture.bridge;export const isDesktopRuntime=()=>true',
  '@/lib/desktopAccessState': 'export const isDesktopAccessLocked=()=>false',
  '@/lib/api': 'export const request=async url=>{fixture.http.push(url);return{ok:true}};export const api={get:async url=>{fixture.http.push(url);return{}},post:async(url,body)=>{fixture.http.push(url);return{data:{already_uploaded:true,sha256:"synthetic-hash",results:[]}}}}',
  '@/stores/authStore': 'export const useAuthStore=select=>select({session:{user:{id:"worker",app_metadata:{role:"owner"}}},offlineMode:fixture.offlineMode})',
  '@/lib/offlineDB': 'const forbidden=async()=>{fixture.browserDb++;throw Error("Browser cache forbidden on desktop")};export const applySyncChanges=forbidden,cacheStaff=forbidden,countPendingSales=forbidden,ensurePersistentStorage=forbidden,getLocalSyncState=forbidden,markSyncAttempt=forbidden,markSyncError=forbidden',
  '@/components/ui/Toast': 'export const toast={success:()=>{},error:()=>{}}',
}
const entry = `import React,{useEffect}from'react';import{createRoot}from'react-dom/client';import{LocalSyncAgent}from'/src/components/LocalSyncAgent.tsx';import{useShiftBackups}from'/src/hooks/useShiftBackups.ts';import{syncDesktopNow}from'/src/lib/desktopSyncApi.ts';fixture.manualSync=syncDesktopNow;function ForcedBackup(){useShiftBackups(true);return null}function App(){useEffect(()=>{fixture.mounted=true},[]);return<><LocalSyncAgent/>{fixture.forceBackup&&<ForcedBackup/>}</>}createRoot(document.getElementById('root')).render(<App/>);`
const bootstrap = `
window.fixture={...window.testOptions,http:[],ipc:[],browserDb:0,mounted:false};
fixture.bridge={lan:{firstRunStatus:async()=>{if(fixture.statusFail)throw Error('Status unavailable');return fixture.status}},sync:{listPending:async()=>{fixture.ipc.push('outbox-read');return[]},getPullState:async()=>{fixture.ipc.push('pull-state');return{reset_generation:0}}},shiftBackups:{pending:async()=>{fixture.ipc.push('backup-pending');return fixture.backupJob?[{id:'synthetic-backup',sha256:'synthetic-hash'}]:[]},upload:async()=>fixture.ipc.push('backup-upload'),confirmed:async()=>fixture.ipc.push('backup-confirmed'),failed:async()=>fixture.ipc.push('backup-failed')}};
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  optimizeDeps: { entries: [], noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react-dom/client'] }, esbuild: { jsx: 'automatic' },
  resolve: { dedupe: ['react', 'react-dom'], alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [{
    name: 'lan-background-fixture', enforce: 'pre', resolveId(id) { if (id === 'virtual:lan-background.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:lan-background.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
      for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
      if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
    },
    configureServer(vite) { vite.middlewares.use('/lan-background-test', async (_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml('/lan-background-test', '<html><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:lan-background.tsx"></script></body></html>')) }) },
  }],
})
let browser
const errors = [], blocked = [], passed = []
try {
  await server.listen(); browser = await chromium.launch({ headless: true }); const base = server.resolvedUrls.local[0]
  async function setup(options) {
    const page = await browser.newPage(); page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : (blocked.push(route.request().url()), route.abort()))
    await page.addInitScript(options => { window.testOptions = options }, options)
    await page.goto(base + 'lan-background-test'); await page.waitForFunction(() => fixture.mounted)
    // Settle immediate hook effects. All mocked transport promises resolve locally.
    await page.waitForTimeout(50); return page
  }
  for (const scenario of [
    { name: 'LAN verified local session', status: { mode: 'client', canPair: false, configured: true }, offlineMode: true },
    { name: 'LAN stale online flag cannot enable upload', status: { mode: 'client', canPair: false, configured: true }, offlineMode: false, forceBackup: true },
    { name: 'unpaired clean workstation', status: { mode: 'standalone', canPair: true, configured: false }, offlineMode: false },
    { name: 'unknown device mode fails closed', statusFail: true, offlineMode: false },
  ]) {
    const page = await setup({ ...scenario, backupJob: true })
    assert.deepEqual(await page.evaluate(() => fixture.http), [], `${scenario.name}: background agent must not request cloud health or backup`)
    await page.evaluate(async () => { await fixture.manualSync(); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('forsage:desktop-sync-requested')) })
    await page.waitForTimeout(100)
    assert.deepEqual(await page.evaluate(() => fixture.http), [])
    assert.deepEqual(await page.evaluate(() => fixture.ipc), [], 'No client outbox/backup may be read for cloud upload')
    assert.equal(await page.evaluate(() => fixture.browserDb), 0)
    await page.close(); passed.push(scenario.name)
  }
  const main = await setup({ status: { mode: 'hub', canPair: false, configured: false }, offlineMode: false, backupJob: false })
  await main.waitForFunction(() => fixture.http.includes('/api/v1/health'))
  await main.evaluate(() => fixture.manualSync())
  assert.ok((await main.evaluate(() => fixture.ipc)).includes('outbox-read'))
  assert.equal(await main.evaluate(() => fixture.browserDb), 0)
  await main.close(); passed.push('existing hub keeps health monitoring and cloud outbox path')
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log(JSON.stringify({ passed: true, cases: passed, liveWrites: 0, externalRequests: 0 }))
} finally { await browser?.close(); await server.close() }
