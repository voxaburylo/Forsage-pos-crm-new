// Real login + access gate, isolated credentials/status mocks; never touches user accounts.
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
  '@/lib/auth': 'export const signIn=window.fixture.signIn,restoreDesktopSession=window.fixture.restore;export const signOut=window.fixture.signOut;',
  '@/lib/desktopBridge': 'export const isDesktopRuntime=()=>true;export const desktopBridge=()=>window.fixture.bridge',
  '@/lib/apiBaseUrl': 'export const API_BASE_URL="http://unused.invalid"',
  '@/stores/authStore': 'export const useAuthStore={getState:()=>({setSession(){},session:{user:{phone:"+380671111111"}}})}',
  '@/components/ProtectedRoute': 'export const homePathForRole=()=>"/work"',
}
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter,Routes,Route}from'react-router-dom';import{DesktopAccessGate}from'/src/components/DesktopAccessGate.tsx';import Login from'/src/pages/LoginPage.tsx';createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={[fixture.mode==='login'?'/login':'/work']}><DesktopAccessGate/><Routes><Route path='/login' element={<Login/>}/><Route path='*' element={<div id='desktop-workspace'>Working draft<input defaultValue='unsaved'/></div>}/></Routes></MemoryRouter>);`
const bootstrap = `window.fixture={mode:window.testMode??'gate',statuses:[],logins:[],restores:[],exits:0};fixture.bridge={auth:{rememberedStatus:()=>new Promise((resolve,reject)=>fixture.statuses.push({resolve,reject}))}};fixture.restore=()=>new Promise((resolve,reject)=>fixture.restores.push({resolve,reject}));fixture.signIn=(...args)=>new Promise(resolve=>fixture.logins.push({args,resolve:()=>resolve({user:{app_metadata:{role:'cashier'}}})}));fixture.signOut=async()=>{fixture.exits++};localStorage.setItem('forsage:last-login-phone','+380671111111');`
const server = await createServer({cacheDir:createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error', esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'access-race-fixture', enforce: 'pre',
  resolveId(id) { if (id === 'virtual:access.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
  async load(id) {
    if (id === '\0virtual:access.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
    let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
    for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
    if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
  },
  configureServer(server) { server.middlewares.use('/access-test', async (_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await server.transformIndexHtml('/access-test', '<html><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:access.tsx"></script></body></html>')) }) },
}] })
let browser
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0], errors = [], blocked = []
  async function setup(mode) {
    const page = await browser.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/*', r => new URL(r.request().url()).origin === new URL(base).origin ? r.continue() : (blocked.push(r.request().url()), r.abort()))
    await page.addInitScript(mode => { window.testMode = mode }, mode)
    await page.goto(base + 'access-test'); await page.waitForFunction(() => fixture.statuses.length > 0)
    return page
  }
  // Pending status before password login must not relock the authenticated session.
  for (const failOld of [false, true]) {
    const page = await setup('gate')
    await page.evaluate(() => fixture.statuses[0].resolve({ locked: true }))
    await page.getByRole('dialog').waitFor()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => fixture.statuses.length === 2)
    await page.locator('input[autocomplete="current-password"]').fill('test-only')
    await page.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
    await page.waitForFunction(() => fixture.logins.length === 1)
    await page.evaluate(() => fixture.logins[0].resolve())
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.evaluate(fail => fail ? fixture.statuses[1].reject(Error('old IPC failure')) : fixture.statuses[1].resolve({ locked: true }), failOld)
    await page.waitForFunction(() => fixture.statuses.length === 3)
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal(await page.locator('#desktop-workspace input').inputValue(), 'unsaved')
    assert.equal(await page.locator('#desktop-workspace').getAttribute('inert'), null)
    await page.evaluate(() => fixture.statuses[2].reject(Error('fresh IPC failure')))
    await page.getByRole('dialog').waitFor()
    assert.notEqual(await page.locator('#desktop-workspace').getAttribute('inert'), null)
    await page.close()
  }
  // Password-only form, no PIN/check boxes/change-user button.
  const login = await setup('login')
  await login.waitForFunction(() => fixture.restores.length === 1)
  assert.equal(await login.locator('form').count(),0)
  await login.evaluate(() => fixture.restores[0].resolve(null))
  await login.locator('input[autocomplete=username]').fill('+380672222222')
  await login.locator('input[autocomplete="current-password"]').fill('manual-password')
  assert.equal(await login.locator('input').count(),2)
  assert.equal(await login.getByRole('checkbox').count(),0)
  assert.equal(await login.getByRole('button',{name:/Змінити користувача|PIN/}).count(),0)
  await login.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await login.waitForFunction(() => fixture.logins.length === 1)
  assert.deepEqual(await login.evaluate(() => fixture.logins[0].args), ['+380672222222', 'manual-password'])
  await login.evaluate(() => fixture.logins[0].resolve()); await login.locator('#desktop-workspace').waitFor()
  await login.close()
  // Restart in the same day opens workspace automatically.
  const restored = await setup('login')
  await restored.waitForFunction(() => fixture.restores.length === 1)
  await restored.evaluate(() => fixture.restores[0].resolve({user:{app_metadata:{role:'cashier'}}}))
  await restored.locator('#desktop-workspace').waitFor()
  assert.equal(await restored.evaluate(()=>fixture.logins.length),0)
  await restored.close()
  // Full exit from the expired-day overlay opens normal login for another employee.
  const exiting = await setup('gate')
  await exiting.evaluate(() => fixture.statuses[0].resolve({locked:true}))
  await exiting.getByRole('dialog').waitFor()
  await exiting.getByRole('button',{name:'Вийти',exact:true}).click()
  await exiting.waitForFunction(()=>fixture.restores.length===1 && fixture.exits===1)
  await exiting.evaluate(()=>fixture.restores[0].resolve(null))
  await exiting.locator('form').waitFor()
  assert.equal(await exiting.locator('input[autocomplete=username]').getAttribute('readonly'),null)
  await exiting.close()
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log('PASS: password-only login; same-day automatic restore; full logout; stale status cannot relock; draft retained; duplicate submit blocked. No live accounts or services.')
} finally { await browser?.close(); await server.close() }
