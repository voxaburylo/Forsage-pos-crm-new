// 25.11.2026 (власник: «долги, предоплата за заказ и выдача — в одном окне», «покупка и долг одной оплатой»).
// Справжні вікна каси на вигаданих даних: без бази, банку, ПРРО й принтера. Усі записи — у пам'ять тесту.
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
  '@/stores/authStore': 'export const useAuthStore=Object.assign(sel=>sel({session:{user:{id:"cashier",app_metadata:{role:"cashier"}}}}),{getState:()=>({session:{user:{id:"cashier",app_metadata:{role:"cashier"}}}})})',
  '@/features/customers/customerApi': 'export const customerApi={get:async id=>{fixture.customerReads++;return{data:{id,bonus_balance:0,...fixture.customer}}}}',
  '@/features/admin/adminApi': 'export const adminApi={getSettings:async()=>({data:{bank_terminal_enabled:false}})}',
  '@/lib/api': 'export const api={get:async()=>{throw Error("Unexpected network API")}}',
  '@/lib/desktopBridge': 'export const desktopBridge=()=>({fiscal:{getConfig:async()=>({enabled:false})},pos:{payDebt:async()=>({data:{}})},orders:{listReady:async()=>fixture.orders,handOver:async()=>{throw Error("bridge handOver must go through posOrderApi")}},catalog:{}})',
  '@/features/pos/posCustomerMoneyApi': `export const posCustomerMoneyApi={
    payDebt:async(id,body)=>{fixture.debtPayments.push({id,...body});if(fixture.failDebt)throw Error("тестова відмова");fixture.customer.debt_balance-=body.amount;return{data:{}}},
    getDeposit:async()=>({data:{balance:fixture.customer.deposit_balance??0}}),
    searchCustomers:async()=>({data:[]}),listDebtors:async()=>({data:fixture.debtors??[]}),
    addDeposit:async()=>{throw Error("not expected")},payOutDeposit:async()=>{throw Error("not expected")}}`,
  '@/features/pos/posOrderApi': `export const posOrderApi={
    listReady:async()=>({data:fixture.orders}),
    canHandOver:()=>true,
    handOver:async(id,itemIds)=>{fixture.handOvers.push(id);fixture.handOverItems.push(itemIds??null);if(itemIds)return{data:{success:true,sale_id:'s2',sale_number:'L-2',debt_amount:0,moved_to_account:2000,rest_order_number:78}};const o=fixture.orders.find(x=>x.id===id);const debt=o.total_amount-o.total_paid;fixture.orders=fixture.orders.filter(x=>x.id!==id);fixture.customer.debt_balance+=debt;return{data:{success:true,sale_id:'s1',sale_number:'L-1',debt_amount:debt}}},
    addPayment:async(id,body)=>{fixture.orderPayments.push({id,...body});const o=fixture.orders.find(x=>x.id===id);o.total_paid+=body.amount;return{data:{}}},
    complete:async(id,body)=>{fixture.completed.push({id,...body});fixture.orders=fixture.orders.filter(x=>x.id!==id);return{data:{}}}}`,
  '@/features/orders/orderItemPhotos': 'export const useOrderItemPhotos=()=>({})',
}

const entry = `
import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';
import{usePOSStore}from'/src/stores/posStore.ts';import{PaymentModal}from'/src/features/pos/PaymentModal.tsx';
import{DebtPaymentModal}from'/src/features/pos/DebtPaymentModal.tsx';import{ToastContainer}from'/src/components/ui/Toast.tsx';import{HandOverOrderButton}from'/src/features/orders/HandOverOrderButton.tsx';import'/src/index.css';
const params=new URLSearchParams(location.search);const view=params.get('view');
const s=usePOSStore.getState();s.replaceOpenReceipts([]);
s.setCustomer({id:'client-1',name:'Тест',phone:'0670000000',debtBalance:1,tierDiscountPct:0,tierName:null,vipLevel:'standard',riskProfile:'low'});
s.addItem({productId:'part',sku:'TEST-1',name:'Тестовий товар',unit:'шт',qty:1,unitPrice:10000,discount:0,qtyOnHand:10});
const customer={id:'client-1',full_name:'Тест',phone:'0670000000',debt_balance:fixture.customer.debt_balance,deposit_balance:fixture.customer.deposit_balance};
createRoot(document.getElementById('root')).render(<MemoryRouter><ToastContainer/>{view==='handover'?<HandOverOrderButton order={fixture.orders[0]} onDone={()=>fixture.paid++}/>:view==='payment'
  ?<PaymentModal open onClose={()=>fixture.closes++} onConfirm={async(...args)=>{fixture.sales.push(args);return true}}/>
  :<DebtPaymentModal open initialCustomer={params.get('nocustomer')?null:customer} initialMode={params.get('mode')||null} onClose={()=>fixture.closes++} onPaid={()=>fixture.paid++}/>}</MemoryRouter>);
`
const fixtureScript = (state) => `<script>window.fixture=Object.assign({sales:[],debtPayments:[],orderPayments:[],completed:[],handOvers:[],handOverItems:[],closes:0,paid:0,customerReads:0},${JSON.stringify(state)})</script>`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0 }, plugins: [tailwindcss(), {
    name: 'customer-settlements-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:settlements.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
    async load(id) {
      if (id === '\0virtual:settlements.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
      let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
      for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
      if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
    },
    configureServer(server) { server.middlewares.use('/settlements-test', async (req, res) => {
      const state = JSON.parse(decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('state') ?? '%7B%7D'))
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(await server.transformIndexHtml('/settlements-test', '<html><body><div id="root"></div>' + fixtureScript(state) + '<script type="module" src="/@id/__x00__virtual:settlements.tsx"></script></body></html>'))
    }) },
  }] })

const readyOrder = { id: 'order-1', order_number: 77, status: 'ready', total_amount: 30000, discount_amount: 0, prepayment: 10000, total_paid: 10000,
  created_at: '2026-11-25T10:00:00Z', pickup_cell: 'A1', customer: { id: 'client-1', phone: '0670000000', full_name: 'Тест', bonus_balance: 0 },
  items: [{ id: 'i1', product_id: null, sku: 'X-1', name: 'Фільтр', source_type: 'supplier', sell_price: 30000, qty: 1, item_status: 'arrived' }] }

let browser
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0], errors = [], blocked = []
  async function open(view, state, mode = '', extra = '') {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue() : (blocked.push(route.request().url()), route.abort()))
    await page.goto(base + 'settlements-test?view=' + view + '&mode=' + mode + extra + '&state=' + encodeURIComponent(JSON.stringify(state)))
    return page
  }
  const fx = (page) => page.evaluate(() => ({ ...window.fixture }))

  // 1. Покупка 100 грн + борг 500 грн готівкою: касир бере 600, продаж отримує 100, борг — окремий запис 500.
  {
    const page = await open('payment', { customer: { debt_balance: 50000, deposit_balance: 0 }, orders: [] })
    const box = page.locator('[data-payment-close-debt]')
    await box.waitFor()
    await box.check()
    await page.locator('[data-payment-with-debt]').getByText('отримати 600,00', { exact: false }).waitFor()
    await page.getByRole('button', { name: 'Без решти', exact: true }).click()
    assert.equal(await page.getByPlaceholder('0.00').last().inputValue(), '600.00', 'quick cash covers purchase plus debt')
    if (process.env.SETTLEMENTS_SHOTS) await page.screenshot({ path: path.join(process.env.SETTLEMENTS_SHOTS, 'payment-with-debt.png') })
    await page.getByRole('button', { name: 'ОПЛАТИТИ', exact: true }).click()
    await page.waitForFunction(() => fixture.debtPayments.length === 1, null, { timeout: 7000 })
    const state = await fx(page)
    assert.equal(state.sales.length, 1); assert.equal(state.sales[0][0], 'cash'); assert.equal(state.sales[0][1], 10000, 'sale gets only its own cash')
    assert.deepEqual({ id: state.debtPayments[0].id, amount: state.debtPayments[0].amount, method: state.debtPayments[0].method }, { id: 'client-1', amount: 50000, method: 'cash' })
    await page.close()
  }
  // 2. Термінал: на терміналі сума покупки й боргу, борг записано як оплату карткою.
  {
    const page = await open('payment', { customer: { debt_balance: 50000, deposit_balance: 0 }, orders: [] })
    await page.getByRole('button', { name: 'Термінал', exact: true }).click()
    await page.locator('[data-payment-close-debt]').check()
    await page.getByRole('button', { name: 'ОПЛАТИТИ', exact: true }).click()
    await page.getByText('покупка 100,00', { exact: false }).waitFor()
    await page.getByRole('button', { name: /Підтвердити/ }).click()
    await page.waitForFunction(() => fixture.debtPayments.length === 1, null, { timeout: 7000 })
    const state = await fx(page)
    assert.equal(state.sales[0][0], 'card'); assert.equal(state.debtPayments[0].method, 'card'); assert.equal(state.debtPayments[0].amount, 50000)
    await page.close()
  }
  // 3. Змішана оплата й продаж у борг: галочки немає або вона вимкнена; без галочки борг не чіпаємо.
  {
    const page = await open('payment', { customer: { debt_balance: 50000, deposit_balance: 0 }, orders: [] })
    await page.locator('[data-payment-close-debt]').waitFor()
    await page.getByRole('button', { name: 'Змішана оплата', exact: true }).click()
    assert.equal(await page.locator('[data-payment-close-debt]').isDisabled(), true, 'mixed payment cannot close the debt here')
    await page.getByRole('button', { name: 'Борг', exact: true }).click()
    assert.equal(await page.locator('[data-payment-close-debt]').count(), 0, 'sale on credit has no close-debt box')
    await page.getByRole('button', { name: 'Готівка', exact: true }).click()
    await page.getByRole('button', { name: 'Без решти', exact: true }).click()
    await page.getByRole('button', { name: 'ОПЛАТИТИ', exact: true }).click()
    await page.waitForFunction(() => fixture.sales.length === 1, null, { timeout: 7000 })
    assert.equal((await fx(page)).sales[0][1], 10000); assert.equal((await fx(page)).debtPayments.length, 0)
    await page.close()
  }
  // 4. Відмова в записі боргу не скасовує продаж і пояснює касиру, що робити.
  {
    const page = await open('payment', { customer: { debt_balance: 50000, deposit_balance: 0 }, orders: [], failDebt: true })
    await page.locator('[data-payment-close-debt]').check()
    await page.getByRole('button', { name: 'Без решти', exact: true }).click()
    await page.getByRole('button', { name: 'ОПЛАТИТИ', exact: true }).click()
    await page.getByText('НЕ закрито', { exact: false }).waitFor({ timeout: 7000 })
    assert.equal((await fx(page)).sales.length, 1)
    await page.close()
  }
  // 5. «Розрахунки клієнта»: боргу немає, є готове замовлення — вікно саме відкриває «Замовлення»;
  //    «Видати товар» доплачує залишок і видає тим самим кодом панелі замовлень.
  {
    const page = await open('settlements', { customer: { debt_balance: 0, deposit_balance: 0 }, orders: [readyOrder] })
    await page.getByRole('heading', { name: 'Розрахунки клієнта' }).waitFor()
    await page.locator('[data-settlement-orders]').getByText('Забрати з комірки: A1', { exact: false }).waitFor({ timeout: 7000 })
    await page.locator('[data-settlement-summary]').getByText('Замовлень: 1 · готові: 1 · доплатити 200,00', { exact: false }).waitFor()
    if (process.env.SETTLEMENTS_SHOTS) { await page.waitForTimeout(600); await page.screenshot({ path: path.join(process.env.SETTLEMENTS_SHOTS, 'settlements-orders.png') }) }
    await page.getByRole('button', { name: 'Видати товар', exact: true }).click()
    await page.getByText('Оплатити і одразу видати товар').waitFor()
    await page.getByRole('button', { name: 'Оплатити і видати товар', exact: true }).click()
    await page.waitForFunction(() => fixture.completed.length === 1, null, { timeout: 7000 })
    const state = await fx(page)
    assert.equal(state.orderPayments.length, 1); assert.equal(state.orderPayments[0].amount, 20000); assert.equal(state.orderPayments[0].id, 'order-1')
    assert.equal(state.completed[0].id, 'order-1')
    await page.locator('[data-settlement-orders]').getByText('У клієнта немає відкритих замовлень').waitFor({ timeout: 7000 })
    await page.waitForFunction(() => fixture.paid >= 1 && fixture.customerReads >= 1, null, { timeout: 7000 })
    await page.close()
  }
  // 6. Є борг — вікно відкривається на «Борг» з усією сумою; оплата боргу — той самий запис.
  {
    const page = await open('settlements', { customer: { debt_balance: 50000, deposit_balance: 0 }, orders: [readyOrder] })
    await page.getByRole('button', { name: 'ОПЛАТИТИ БОРГ', exact: true }).waitFor()
    assert.equal(await page.locator('input[type=number]').inputValue(), '500.00')
    // Замовлення довантажились, але вкладку «Борг» не перемикаємо.
    await page.locator('[data-settlement-tab="orders"]').getByText('Замовлення (1)').waitFor({ timeout: 7000 })
    assert.equal(await page.getByRole('button', { name: 'ОПЛАТИТИ БОРГ', exact: true }).count(), 1)
    await page.getByRole('button', { name: 'ОПЛАТИТИ БОРГ', exact: true }).click()
    await page.waitForFunction(() => fixture.debtPayments.length === 1, null, { timeout: 7000 })
    assert.equal((await fx(page)).debtPayments[0].amount, 50000)
    await page.close()
  }
  // 7. Кнопка «Замовлення» в чеку відкриває вкладку замовлень, навіть коли є борг.
  {
    const page = await open('settlements', { customer: { debt_balance: 50000, deposit_balance: 0 }, orders: [readyOrder] }, 'orders')
    await page.locator('[data-settlement-orders]').getByText('Забрати з комірки: A1', { exact: false }).waitFor({ timeout: 7000 })
    await page.close()
  }
  // 9. «Видати, решта в борг»: касир видає без оплати; після цього вікно показує новий борг клієнта.
  {
    const page = await open('settlements', { customer: { debt_balance: 0, deposit_balance: 0 }, orders: [readyOrder] }, 'orders')
    await page.locator('[data-order-hand-over-debt]').waitFor({ timeout: 7000 })
    page.once('dialog', dialog => { if (!dialog.message().includes('стануть боргом клієнта')) throw Error('unexpected confirm: ' + dialog.message()); void dialog.accept() })
    await page.locator('[data-order-hand-over-debt]').click()
    await page.waitForFunction(() => fixture.handOvers.length === 1, null, { timeout: 7000 })
    await page.locator('[data-settlement-summary]').getByText('Борг: 200,00', { exact: false }).waitFor({ timeout: 7000 })
    assert.deepEqual((await fx(page)).orderPayments, [], 'hand-over on credit takes no money')
    await page.close()
  }
  // 10. Менеджер видає частину: прибуле позначене, неприбуле не вибрати; передоплата 3000 за видане 1000 — 2000 на рахунок.
  {
    const partial = { ...readyOrder, status: 'ordered', total_amount: 30000, total_paid: 30000, prepayment: 30000, customer_id: 'client-1',
      items: [{ ...readyOrder.items[0], id: 'i1', name: 'Фільтр', sell_price: 10000 }, { ...readyOrder.items[0], id: 'i2', name: 'Колодки', sell_price: 20000, item_status: 'ordered' }] }
    const page = await open('handover', { customer: { debt_balance: 0, deposit_balance: 0 }, orders: [partial] })
    await page.locator('[data-order-hand-over]').click()
    const dialog = page.locator('[data-hand-over-dialog]')
    await dialog.waitFor()
    const boxes = dialog.locator('input[type=checkbox]')
    assert.equal(await boxes.nth(0).isChecked(), true, 'arrived line is preselected')
    assert.equal(await boxes.nth(1).isDisabled(), true, 'not-arrived line cannot be handed over')
    const plan = page.locator('[data-hand-over-plan]')
    await plan.getByText('Зайве — на рахунок клієнта').waitFor()
    await plan.getByText('200,00', { exact: false }).first().waitFor()
    await plan.getByText('переходять у нове замовлення', { exact: false }).waitFor()
    if (process.env.SETTLEMENTS_SHOTS) await page.screenshot({ path: path.join(process.env.SETTLEMENTS_SHOTS, 'hand-over-partial.png') })
    await page.locator('[data-hand-over-confirm]').click()
    await page.waitForFunction(() => fixture.handOvers.length === 1 && fixture.paid === 1, null, { timeout: 7000 })
    assert.deepEqual((await fx(page)).handOverItems, [['i1']])
    await page.getByText('Решта — замовлення №78', { exact: false }).waitFor()
    await page.close()
  }
  // 8. Кнопка «Борги» на касі: клієнта ще не вибрано — список боржників, вибір, оплата.
  {
    const debtors = [{ id: 'client-9', full_name: 'Боржник', phone: '0679999999', debt_balance: 25000, deposit_balance: 0 }]
    const page = await open('settlements', { customer: { debt_balance: 0, deposit_balance: 0 }, orders: [], debtors }, 'debt', '&nocustomer=1')
    await page.getByText('Боржники (1)', { exact: false }).waitFor({ timeout: 7000 })
    await page.getByRole('button', { name: /Боржник/ }).click()
    assert.equal(await page.locator('input[type=number]').inputValue(), '250.00')
    assert.equal(await page.getByPlaceholder('Телефон або ПІБ...').count(), 0, 'search hides once the customer is chosen')
    await page.getByRole('button', { name: 'ОПЛАТИТИ БОРГ', exact: true }).click()
    await page.waitForFunction(() => fixture.debtPayments.length === 1, null, { timeout: 7000 })
    const payment = (await fx(page)).debtPayments[0]
    assert.equal(payment.id, 'client-9'); assert.equal(payment.amount, 25000)
    await page.close()
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log(JSON.stringify({ passed: true, cases: ['purchase+debt-cash', 'purchase+debt-terminal', 'mixed-and-credit-excluded', 'debt-failure-keeps-sale', 'orders-tab-issue', 'debt-tab-first', 'orders-tab-requested', 'debtors-button', 'hand-over-on-credit', 'manager-partial-hand-over'], liveWrites: 0 }))
} finally { await browser?.close(); await server.close() }
