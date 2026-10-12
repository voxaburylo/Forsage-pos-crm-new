// Actual StaffPage/PayrollPage, controlled browser clock and synthetic APIs only.
// No shop database, fiscal/print devices or external requests are permitted.
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
const redProof = process.argv.includes('--red-proof')
const mocks = {
  '@/components/Layout': 'export function Layout({children,title}){return <main><h1>{title}</h1>{children}</main>}',
  '@/features/analytics/AnalyticsLayout': 'export function AnalyticsLayout({children,title}){return <main><h1>{title}</h1>{children}</main>}',
  '@/features/admin/adminApi': 'export const adminApi=fixture.admin;export const ROLE_LABELS={cashier:"Касир"}',
  '@/features/staff/staffApi': 'export const staffApi=fixture.staff',
  '@/features/settings/commissionApi': 'export const commissionApi={listRules:async()=>({data:[]})}',
  '@/features/pos/shiftApi': 'export const shiftApi={current:()=>fixture.defer("shift",{})}',
  '@/lib/desktopBridge': 'export const desktopBridge=()=>({});export const isDesktopRuntime=()=>true',
  '@/stores/authStore': 'export const useAuthStore=select=>select({session:{user:{id:"synthetic-owner",app_metadata:{role:"owner"}}}})',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.warnings.push(m),success:m=>fixture.messages.push(m)};export function ToastContainer(){return null}',
}
const entry = `
import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';
import Staff from'/src/features/staff/StaffPage.tsx';import Payroll from'/src/features/analytics/PayrollPage.tsx';import'/src/index.css';
createRoot(document.getElementById('root')).render(<MemoryRouter>{fixture.mode==='staff'?<Staff/>:<Payroll/>}</MemoryRouter>);
`
const bootstrap = `
window.fixture={...window.testConfig,reads:[],pending:[],errors:[],warnings:[],messages:[],holdDates:window.testConfig.holdDates??[]};
fixture.worker={id:'worker',full_name:'Test Worker',phone:'+380674444444',email:'',role:'cashier',is_active:true,base_rate:10000,rate_period:'day'};
fixture.rows=amount=>[{employee_id:'worker',earned:amount,paid:0,penalty:0,balance:amount}];
fixture.defer=(kind,body)=>new Promise((resolve,reject)=>fixture.pending.push({kind,body,resolve,reject}));
fixture.admin={listUsers:async()=>({data:[fixture.worker]})};
fixture.staff={
 summary:async period=>{fixture.reads.push({kind:'summary',period});return {data:fixture.rows(99900)}},
 listSalary:async period=>{fixture.reads.push({kind:'history',period});return {data:[]}},
 dailySummary:async date=>{fixture.reads.push({kind:'daily',date});if(fixture.holdDates.includes(date))return fixture.defer('daily',{date});return {data:fixture.rows(date===fixture.oldDate?12600:date===fixture.newDate?7300:4800)}},
 createSalary:body=>fixture.defer('salary',body),dailyPayout:body=>fixture.defer('payout',body),
 deleteSalary:id=>fixture.defer('delete',{id}),setPin:(id,pin)=>fixture.defer('pin',{id,pin}),
};
`
const server = await createServer({
  cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'payroll-day-rollover-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:rollover.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:rollover.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
      for (const [name, mock] of Object.entries(mocks)) {
        if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
      }
      if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
    },
    configureServer(vite) {
      vite.middlewares.use('/rollover-test', async (_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(await vite.transformIndexHtml('/rollover-test', '<html><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:rollover.tsx"></script></body></html>'))
      })
    },
  }],
})

const summer = { before: '2026-09-30T20:59:00.000Z', after: '2026-09-30T21:00:05.000Z', oldDate: '2026-09-30', newDate: '2026-10-01' }
const winter = { before: '2026-12-31T21:59:00.000Z', after: '2026-12-31T22:00:05.000Z', oldDate: '2026-12-31', newDate: '2027-01-01' }
const results = [], pageErrors = [], blocked = []
let browser, base
try {
  await server.listen()
  base = server.resolvedUrls.local[0]
  browser = await chromium.launch({ headless: true })

  async function setup(mode, boundary = summer, timezoneId = 'America/Los_Angeles', extra = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId })
    page.setDefaultTimeout(5000)
    await page.clock.install({ time: new Date(boundary.before) })
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('dialog', dialog => dialog.accept())
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue() : (blocked.push(route.request().url()), route.abort()))
    await page.addInitScript(config => { window.testConfig = config }, { mode, ...boundary, ...extra })
    await page.goto(base + 'rollover-test', { timeout: 30_000 })
    await waitDay(page, boundary.oldDate)
    return page
  }
  async function scenario(name, task) {
    let page
    const use = async (...args) => { page = await setup(...args); return page }
    try {
      await task(use)
      results.push({ name, status: 'PASS' })
      console.log('PASS ' + name)
    } catch (error) {
      const reads = page ? await page.evaluate(() => fixture.reads).catch(() => []) : []
      results.push({ name, status: 'FAIL', error: error.message, reads })
      console.error('FAIL ' + name + ': ' + error.message)
    } finally { await page?.close() }
  }
  const waitDay = (page, date) => page.waitForFunction(date => fixture.reads.some(row => row.kind === 'daily' && row.date === date), date, { timeout: 2500 })
  const waitKind = (page, kind) => page.waitForFunction(kind => fixture.pending.some(row => row.kind === kind), kind)
  const writeCount = page => page.evaluate(() => fixture.pending.filter(row => row.kind !== 'daily').length)
  const financialCount = page => page.evaluate(() => fixture.pending.filter(row => row.kind === 'salary' || row.kind === 'payout').length)
  const open = async (page, mode) => {
    if (mode === 'staff') await page.getByRole('button', { name: /Test Worker/ }).click()
    else await page.getByRole('row').filter({ hasText: 'Test Worker' }).getByRole('button', { name: 'Операції', exact: true }).click()
  }
  const today = (page, mode) => page.getByRole('dialog').getByText(mode === 'staff' ? 'Заробіток сьогодні' : 'Сьогодні', { exact: true }).locator(mode === 'staff' ? '../..' : '..')
  const payout = (page, mode, fund = 'cashbox') => page.getByRole('button', { name: mode === 'staff'
    ? fund === 'cashbox' ? 'Видати з каси' : 'Кошти власника'
    : fund === 'cashbox' ? 'Видати денний заробіток з каси' : 'Видати коштами власника', exact: true })
  const amount = (page, mode) => mode === 'staff' ? page.getByLabel('Сума (грн)', { exact: true }) : page.getByPlaceholder('Сума, грн')
  const note = (page, mode) => mode === 'staff' ? page.getByRole('dialog').locator('textarea') : page.getByPlaceholder('Примітка')
  async function showForm(page, mode) {
    if (mode === 'staff') await page.getByRole('button', { name: /Виплати та Історія/ }).click()
  }
  async function expectToday(page, mode, value) {
    await today(page, mode).filter({ hasText: value }).waitFor()
    assert.ok((await today(page, mode).innerText()).includes(value))
  }
  async function resume(page, boundary, event = 'focus') {
    // A suspended machine advances its wall clock without delivering elapsed timers.
    await page.clock.setSystemTime(new Date(boundary.after))
    await page.evaluate(event => {
      if (event === 'focus') window.dispatchEvent(new Event('focus'))
      else {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        Object.defineProperty(document, 'hidden', { configurable: true, value: true })
        document.dispatchEvent(new Event('visibilitychange'))
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        Object.defineProperty(document, 'hidden', { configurable: true, value: false })
        document.dispatchEvent(new Event('visibilitychange'))
      }
    }, event)
  }
  async function settleDaily(page, date, value, reject = false) {
    await page.evaluate(({ date, value, reject }) => {
      const pending = fixture.pending.find(row => row.kind === 'daily' && row.body.date === date)
      if (!pending) throw Error('Missing deferred daily read for ' + date)
      if (reject) pending.reject(Error('Synthetic daily refresh failure'))
      else pending.resolve({ data: fixture.rows(value) })
    }, { date, value, reject })
    await page.clock.runFor(50)
  }
  async function expectUnavailable(page, mode) {
    assert.equal(await payout(page, mode).isDisabled(), true, 'Cash payout is disabled without a current-day summary')
    assert.equal(await payout(page, mode, 'owner_funds').isDisabled(), true, 'Owner-funded payout is also disabled')
    if (await today(page, mode).count()) {
      const text = await today(page, mode).innerText()
      assert.equal(/126,00|73,00|0,00/.test(text), false, 'Unavailable daily calculation must not display yesterday or a fabricated zero as ready')
    } else {
      assert.ok((await page.getByRole('dialog').getByRole('status').innerText()).length > 0,
        'A hidden daily amount must be accompanied by an explicit unavailable/loading status')
    }
  }

  // Minimal baseline proof deliberately runs BOTH pages even when one fails.
  const timerCases = redProof ? [['summer', summer, 'America/Los_Angeles']] : [
    ['summer', summer, 'America/Los_Angeles'], ['winter', winter, 'Asia/Tokyo'], ['summer', summer, 'Europe/Kyiv'],
  ]
  for (const mode of ['staff', 'payroll']) for (const [season, boundary, zone] of timerCases) {
    await scenario(`${mode}: automatic ${season} midnight (${zone})`, async use => {
      const page = await use(mode, boundary, zone)
      await open(page, mode); await expectToday(page, mode, '126,00')
      await page.clock.runFor(65_000)
      await waitDay(page, boundary.newDate)
      await expectToday(page, mode, '73,00')
      assert.equal(await writeCount(page), 0, 'Day rollover never starts a financial action or shift preflight')
      assert.ok((await page.evaluate(() => fixture.reads.filter(row => row.kind !== 'daily'))).every(row => row.period === boundary.oldDate.slice(0, 7)), 'Selected monthly period remains unchanged across midnight')
    })
  }

  if (!redProof) for (const mode of ['staff', 'payroll']) {
    for (const event of ['focus', 'visibility']) await scenario(`${mode}: suspended clock resumes via ${event}`, async use => {
      const page = await use(mode, winter, 'Asia/Tokyo')
      await open(page, mode); await expectToday(page, mode, '126,00')
      await resume(page, winter, event); await waitDay(page, winter.newDate)
      await expectToday(page, mode, '73,00'); assert.equal(await writeCount(page), 0)
    })

    await scenario(`${mode}: stale payout click is blocked before any day observer runs`, async use => {
      const page = await use(mode)
      await open(page, mode); await expectToday(page, mode, '126,00')
      assert.equal(await payout(page, mode).isDisabled(), false, 'The existing DOM button starts enabled for yesterday')
      const readsBefore = await page.evaluate(() => fixture.reads)
      // Do not run elapsed timers, dispatch focus/visibility, or use a physical click:
      // the handler's fresh wall-clock check must protect the still-stale DOM itself.
      await page.clock.setSystemTime(new Date(summer.after))
      assert.equal(await page.evaluate(() => new Date().toISOString().slice(0, 16)), summer.after.slice(0, 16))
      await expectToday(page, mode, '126,00')
      assert.deepEqual(await page.evaluate(() => fixture.reads), readsBefore, 'No observer has refreshed the stale view yet')
      await payout(page, mode).evaluate(element => element.click())
      // The rejecting handler may safely refresh data itself; that is not a payout retry.
      assert.equal(await writeCount(page), 0, 'A stale daily click cannot start shift preflight or any money request')
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await waitDay(page, summer.newDate); await expectToday(page, mode, '73,00')
      assert.equal(await payout(page, mode).isDisabled(), false)
      assert.equal(await writeCount(page), 0, 'Refreshing the day does not replay the rejected click')
    })

    await scenario(`${mode}: delayed yesterday response cannot overwrite today`, async use => {
      const page = await use(mode, summer, 'America/Los_Angeles', { holdDates: [summer.oldDate] })
      await resume(page, summer); await waitDay(page, summer.newDate)
      await open(page, mode); await expectToday(page, mode, '73,00')
      await settleDaily(page, summer.oldDate, 88800)
      await expectToday(page, mode, '73,00')
      assert.equal((await today(page, mode).innerText()).includes('888,00'), false)
      assert.equal(await writeCount(page), 0)
    })

    await scenario(`${mode}: delayed yesterday failure cannot invalidate today's success`, async use => {
      const page = await use(mode, summer, 'America/Los_Angeles', { holdDates: [summer.oldDate] })
      await resume(page, summer); await waitDay(page, summer.newDate)
      await open(page, mode); await expectToday(page, mode, '73,00')
      await settleDaily(page, summer.oldDate, 0, true)
      await expectToday(page, mode, '73,00')
      assert.equal(await payout(page, mode).isDisabled(), false)
      assert.equal(await payout(page, mode, 'owner_funds').isDisabled(), false)
      assert.equal(await page.getByRole('dialog').getByRole('status').count(), 0, 'An old rejection must not install a stale error/loading status')
      assert.deepEqual(await page.evaluate(() => ({ errors: fixture.errors, warnings: fixture.warnings })), { errors: [], warnings: [] })
      assert.equal(await writeCount(page), 0)
    })

    await scenario(`${mode}: failed refresh locks payouts, next day safely recovers`, async use => {
      const page = await use(mode)
      await open(page, mode); await expectToday(page, mode, '126,00')
      await page.evaluate(date => fixture.holdDates.push(date), summer.newDate)
      await resume(page, summer); await waitDay(page, summer.newDate)
      await expectUnavailable(page, mode)
      await settleDaily(page, summer.newDate, 0, true)
      await expectUnavailable(page, mode)
      const next = { after: '2026-10-01T21:00:05.000Z' }
      await resume(page, next, 'visibility'); await waitDay(page, '2026-10-02')
      await expectToday(page, mode, '48,00')
      assert.equal(await payout(page, mode).isDisabled(), false)
      assert.equal(await writeCount(page), 0, 'Read recovery never retries money')
    })

    await scenario(`${mode}: selected past period and unsaved form survive midnight`, async use => {
      const page = await use(mode)
      if (mode === 'staff') {
        await page.getByRole('button', { name: /Test Worker/ }).waitFor()
        await page.locator('button:has(svg.lucide-chevron-left)').first().click()
      } else {
        await page.getByRole('button', { name: 'Операції', exact: true }).waitFor()
        await page.getByLabel('Попередній місяць').click()
      }
      await open(page, mode); await showForm(page, mode)
      await amount(page, mode).fill('126,50'); await note(page, mode).fill('Unsubmitted boundary operation')
      const formPeriod = mode === 'staff' ? await page.locator('input[type="month"]').inputValue() : null
      const readIndex = await page.evaluate(() => fixture.reads.length)
      await resume(page, summer); await waitDay(page, summer.newDate)
      assert.equal(await amount(page, mode).inputValue(), '126,50')
      assert.equal(await note(page, mode).inputValue(), 'Unsubmitted boundary operation')
      if (mode === 'staff') assert.equal(await page.locator('input[type="month"]').inputValue(), formPeriod)
      const refreshed = await page.evaluate(index => fixture.reads.slice(index).filter(row => row.kind !== 'daily'), readIndex)
      assert.ok(refreshed.length > 0); assert.ok(refreshed.every(row => row.period === '2026-08'))
      assert.equal(await writeCount(page), 0)
    })

    for (const kind of ['salary', 'payout']) await scenario(`${mode}: ${kind} preflight crosses midnight without changing captured day`, async use => {
      const page = await use(mode)
      await open(page, mode); await expectToday(page, mode, '126,00')
      if (kind === 'salary') {
        await showForm(page, mode)
        await page.getByRole('dialog').locator('select').first().selectOption('advance')
        await amount(page, mode).fill('126,50'); await note(page, mode).fill('Started yesterday')
        await page.getByRole('button', { name: 'Зберегти операцію', exact: true }).click()
      } else await payout(page, mode, 'owner_funds').click()
      await waitKind(page, 'shift')
      await resume(page, summer); await waitDay(page, summer.newDate)
      assert.equal(await financialCount(page), 0, 'Pending preflight is not bypassed by day rollover')
      assert.equal(await page.evaluate(() => fixture.pending.filter(row => row.kind === 'shift').length), 1)
      await page.evaluate(() => fixture.pending.find(row => row.kind === 'shift').resolve({ data: { id: 'synthetic-shift' } }))
      await waitKind(page, kind)
      const body = await page.evaluate(kind => fixture.pending.find(row => row.kind === kind).body, kind)
      assert.equal(body.work_date, summer.oldDate)
      assert.equal(body.employee_id, 'worker')
      if (kind === 'salary') { assert.equal(body.period, '2026-09'); assert.equal(body.amount, 12650) }
      else assert.equal(body.fund_source, 'owner_funds')
      assert.equal(await financialCount(page), 1)
      const readIndex = await page.evaluate(() => fixture.reads.length)
      await page.evaluate(kind => fixture.pending.find(row => row.kind === kind).resolve({ data: kind === 'salary' ? { id: 'synthetic-salary' } : { amount: 12600, payment: { id: 'synthetic-payout' } } }), kind)
      await page.clock.runFor(100)
      await page.waitForFunction(index => fixture.reads.slice(index).some(row => row.kind === 'daily'), readIndex)
      const afterAction = await page.evaluate(index => fixture.reads.slice(index).filter(row => row.kind === 'daily'), readIndex)
      assert.ok(afterAction.every(row => row.date === summer.newDate), 'Late completion reloads the latest day, not the action closure day')
      if (kind === 'salary' && mode === 'staff') await page.getByRole('button', { name: /Налаштування/ }).click()
      await expectToday(page, mode, '73,00')
      assert.equal(await financialCount(page), 1, 'Completing the old action never starts another payment')
    })
  }
  assert.deepEqual(pageErrors, [], 'No uncaught browser errors')
  assert.deepEqual(blocked, [], 'No external traffic attempted')
  console.log(JSON.stringify({ isolated: true, mode: redProof ? 'red-proof' : 'full', cases: results.length,
    passed: results.filter(row => row.status === 'PASS').length, results }, null, 2))
  if (results.some(row => row.status === 'FAIL')) process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
}
