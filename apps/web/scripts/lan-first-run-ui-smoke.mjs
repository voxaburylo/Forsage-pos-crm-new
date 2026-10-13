// Actual LoginPage, LAN first-run UI and auth.ts. IPC/auth are synthetic; no LAN/cloud requests.
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
  '@/lib/desktopBridge': 'export const desktopBridge=()=>fixture.bridge;export const isDesktopRuntime=()=>true',
  '@/lib/supabase': 'export const supabase={auth:{signInWithPassword:async()=>{fixture.cloud.push("login");return{data:{session:null},error:{message:"Invalid login credentials"}}},getSession:async()=>{fixture.cloud.push("get");return{data:{session:null}}},setSession:async()=>{fixture.cloud.push("set");throw Error("Cloud forbidden")},signOut:async()=>{fixture.cloud.push("logout")}}}',
  '@/lib/desktopServerSession': 'export const restoreDesktopServerSession=async()=>{fixture.cloud.push("restore");return null}',
  '@/stores/authStore': 'export const useAuthStore={getState:()=>({session:fixture.session,setOfflineSession:session=>{fixture.session=session;fixture.sessions.push(session.user.id)},setSession:session=>{fixture.session=session}})}',
  '@/components/ProtectedRoute': 'export const homePathForRole=role=>role==="manager"?"/orders":"/pos"',
  '@/lib/desktopAccessState': 'export const confirmDesktopUnlocked=()=>fixture.unlocks++',
  '@/lib/apiBaseUrl': 'export const API_BASE_URL="https://forbidden.invalid"',
}
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{MemoryRouter,Routes,Route,useLocation}from'react-router-dom';import LoginPage from'/src/pages/LoginPage.tsx';import'/src/index.css';function App(){const location=useLocation();return <><p data-testid="location">{location.pathname}</p><Routes><Route path='/login' element={<LoginPage/>}/><Route path='*' element={<p>Робочий екран</p>}/></Routes></>};createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/login']}><App/></MemoryRouter>);`
const bootstrap = `
window.fixture={...window.testOptions,cloud:[],sessions:[],session:null,unlocks:0,statusReads:0,discoverReads:0,pairs:[],logins:[],restores:0};
fixture.user={id:'worker',role:'manager',tenant_id:'shop',phone:'+380671234567',email:'380671234567@forsage.internal',full_name:'Worker'};
fixture.status=fixture.initialStatus??{mode:'standalone',configured:false,canPair:true};fixture.hubs=fixture.initialHubs??[{address:'192.168.1.10',name:'Магазин'}];
fixture.bridge={lan:{firstRunStatus:async()=>{fixture.statusReads++;if(fixture.statusFail)throw Error('Synthetic status failure');return fixture.status},discover:async()=>{fixture.discoverReads++;if(fixture.discoveryFail)throw Error('Автоматичний пошук заблоковано');return fixture.hubs},pair:async input=>{fixture.pairs.push(input);if(fixture.holdPair)await new Promise(resolve=>fixture.finishPair=resolve);if(fixture.pairFail)throw Error('Код підключення не підходить');fixture.status={mode:'client',configured:true,canPair:false};if(fixture.lostReply)throw Error('Lost reply');return{mode:'client',configured:true}}},auth:{restore:async()=>{fixture.restores++;return fixture.remembered?fixture.user:null},login:async(phone,password)=>{fixture.logins.push({phone,password});if(fixture.loginFail)throw Error('Невірний пароль головного ПК');return fixture.user},loginOnline:async()=>{fixture.cloud.push('provision');throw Error('Forbidden')},logout:async()=>({success:true})}};
`
const server = await createServer({
  cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  optimizeDeps: { entries: [], noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-router-dom', 'lucide-react'] },
  esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'], alias: { '@': path.join(root, 'apps/web/src') } },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [tailwindcss(), {
    name: 'lan-first-run-fixtures', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:lan-first-run.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:lan-first-run.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
      for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
      if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
    },
    configureServer(vite) { vite.middlewares.use('/lan-first-run-test', async (_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml('/lan-first-run-test', '<html><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:lan-first-run.tsx"></script></body></html>')) }) },
  }],
})
let browser
const errors = [], blocked = [], passed = []
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0]
  async function setup(options = {}) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : (blocked.push(route.request().url()), route.abort()))
    await page.addInitScript(options => { window.testOptions = options }, options)
    await page.goto(base + 'lan-first-run-test')
    return page
  }
  const ready = page => page.getByText('Підключення збережено.', { exact: true }).waitFor()
  const connect = page => page.getByRole('button', { name: 'Підключити цей ПК', exact: true })
  const phone = page => page.getByLabel('Логін (номер телефону)', { exact: true })
  const password = page => page.getByLabel('Пароль', { exact: true })
  const noCloud = async page => assert.deepEqual(await page.evaluate(() => fixture.cloud), [])

  const fresh = await setup({ holdPair: true })
  await fresh.getByLabel('Головний ПК', { exact: true }).waitFor()
  assert.equal(await fresh.getByLabel('Головний ПК', { exact: true }).inputValue(), '192.168.1.10')
  assert.equal(await phone(fresh).count(), 0); assert.equal(await fresh.evaluate(() => fixture.restores), 0)
  const code = fresh.getByLabel('Код підключення', { exact: true })
  assert.equal(await code.getAttribute('type'), 'password')
  await code.fill('synthetic-connection-code')
  await connect(fresh).evaluate(button => { button.form.requestSubmit(); button.form.requestSubmit() })
  await fresh.waitForFunction(() => fixture.pairs.length === 1 && typeof fixture.finishPair === 'function')
  assert.equal(await code.isDisabled(), true)
  await fresh.evaluate(() => fixture.finishPair()); await ready(fresh)
  assert.equal(await code.count(), 0)
  assert.equal(await fresh.evaluate(() => JSON.stringify(localStorage).includes('synthetic-connection-code')), false)
  await fresh.getByRole('button', { name: 'Перейти до входу', exact: true }).click()
  await phone(fresh).fill('0671234567'); await password(fresh).fill('synthetic-password')
  await fresh.evaluate(() => { fixture.loginFail = true })
  await fresh.getByRole('button', { name: 'Увійти', exact: true }).click()
  await fresh.getByRole('alert').filter({ hasText: 'Невірний пароль головного ПК' }).waitFor()
  assert.equal(await password(fresh).inputValue(), 'synthetic-password'); await noCloud(fresh)
  await fresh.evaluate(() => { fixture.loginFail = false })
  await fresh.getByRole('button', { name: 'Увійти', exact: true }).click()
  await fresh.waitForFunction(() => document.querySelector('[data-testid=location]').textContent === '/orders')
  assert.deepEqual(await fresh.evaluate(() => fixture.logins.map(row => row.phone)), ['+380671234567', '+380671234567'])
  await noCloud(fresh); await fresh.close(); passed.push('clean single-hub setup, serialized pairing, secret removal, normal LAN login and failure without cloud')

  const multiple = await setup({ initialHubs: [{ address: '192.168.1.11', name: 'Перший' }, { address: '192.168.1.12', name: 'Другий' }] })
  await multiple.getByLabel('Головний ПК', { exact: true }).waitFor()
  await multiple.getByLabel('Код підключення', { exact: true }).fill('code')
  assert.equal(await connect(multiple).isDisabled(), true)
  await multiple.getByLabel('Головний ПК', { exact: true }).selectOption('192.168.1.12')
  await connect(multiple).click(); await ready(multiple)
  assert.equal(await multiple.evaluate(() => fixture.pairs[0].hubAddress), '192.168.1.12')
  await noCloud(multiple); await multiple.close(); passed.push('multiple hubs require an explicit choice')

  const manual = await setup({ initialHubs: [], pairFail: true })
  await manual.getByLabel('Адреса головного ПК', { exact: true }).fill('192.168.5.20')
  await manual.getByLabel('Порт (зазвичай 3210)', { exact: true }).fill('4321')
  await manual.getByLabel('Код підключення', { exact: true }).fill('bad-code')
  await connect(manual).click()
  await manual.getByRole('alert').filter({ hasText: 'Код підключення не підходить' }).waitFor()
  assert.equal(await manual.getByLabel('Код підключення', { exact: true }).inputValue(), '')
  assert.equal(await manual.getByLabel('Адреса головного ПК', { exact: true }).inputValue(), '192.168.5.20')
  assert.equal(await phone(manual).count(), 0)
  await manual.evaluate(() => { fixture.pairFail = false; fixture.lostReply = true })
  await manual.getByLabel('Код підключення', { exact: true }).fill('good-code')
  await connect(manual).click(); await ready(manual)
  assert.deepEqual(await manual.evaluate(() => fixture.pairs[1]), { hubAddress: '192.168.5.20', accessKey: 'good-code', port: 4321 })
  assert.equal(await manual.evaluate(() => fixture.pairs.length), 2)
  await noCloud(manual); await manual.close(); passed.push('manual IP/custom port, failed-code clear, same address retry, persisted pairing with lost reply')

  const discovery = await setup({ discoveryFail: true })
  await discovery.getByText('Автоматичний пошук заблоковано', { exact: true }).waitFor()
  await discovery.getByLabel('Адреса головного ПК', { exact: true }).waitFor()
  await discovery.evaluate(() => { fixture.discoveryFail = false })
  await discovery.getByRole('button', { name: 'Повторити пошук', exact: true }).click()
  await discovery.getByLabel('Головний ПК', { exact: true }).waitFor()
  await noCloud(discovery); await discovery.close(); passed.push('blocked discovery allows manual fallback and safe retry')

  const main = await setup({ initialStatus: { mode: 'hub', configured: true, canPair: false } })
  await phone(main).waitFor()
  assert.equal(await main.getByLabel('Код підключення', { exact: true }).count(), 0)
  assert.equal(await main.evaluate(() => fixture.discoverReads), 0)
  assert.equal(await main.evaluate(() => fixture.restores), 1)
  await main.close(); passed.push('existing main PC retains ordinary login without pairing/discovery')

  const remembered = await setup({ initialStatus: { mode: 'client', configured: true, canPair: false }, remembered: true })
  await remembered.waitForFunction(() => document.querySelector('[data-testid=location]').textContent === '/orders')
  assert.equal(await remembered.evaluate(() => fixture.discoverReads), 0)
  await noCloud(remembered); await remembered.close(); passed.push('configured LAN remembered access restores without internet or pairing')

  const failure = await setup({ statusFail: true })
  await failure.getByRole('alert').filter({ hasText: 'хмарний вхід не запускався' }).waitFor()
  assert.equal(await phone(failure).count(), 0)
  await failure.evaluate(() => { fixture.statusFail = false; fixture.status = { mode: 'client', configured: true, canPair: false } })
  await failure.getByRole('button', { name: 'Повторити перевірку', exact: true }).click()
  await phone(failure).waitFor(); await noCloud(failure); await failure.close(); passed.push('status failure blocks fallback and safely retries')

  const damaged = await setup({ initialStatus: { mode: 'client', configured: false, canPair: false } })
  await damaged.getByRole('alert').filter({ hasText: 'Збережені замовлення не видалено' }).waitFor()
  assert.equal(await phone(damaged).count(), 0); assert.equal(await connect(damaged).count(), 0)
  assert.equal(await damaged.evaluate(() => fixture.pairs.length + fixture.discoverReads + fixture.restores), 0)
  await noCloud(damaged); await damaged.close(); passed.push('damaged client never overwrites cached store binding')

  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log(JSON.stringify({ passed: true, cases: passed, liveWrites: 0, externalRequests: 0 }))
} finally { await browser?.close(); await server.close() }
