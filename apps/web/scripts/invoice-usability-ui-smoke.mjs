// Real invoice UI; synthetic documents only. No shop database or external calls.
import assert from 'node:assert/strict'
import { startFixture, require } from './ai-invoice-ui-fixture.mjs'
const XLSX = require('xlsx')

const test = await startFixture()
const { page, reset, paste, openTable, getDraft, errors } = test
const selected = process.argv[2]
const cases = []
function scenario(name, run) { if (!selected || selected === name) cases.push([name, run]) }

scenario('draft', async () => {
  await reset()
  await page.evaluate(() => {
    const product = { id: 'p', name: 'Товар із чернетки', sku: 'OLD', barcode: '', unit: 'шт', retail_price: 15000, purchase_price: 10000, category_id: null }
    sessionStorage.setItem('invoice-test-record', JSON.stringify({ id: 'existing', supplier_id: 'supplier', invoice_number: 'DRAFT', status: 'draft', total: 20000, paid_amount: 5000, notes: '', edit_revision: 'r3', items: [{ id: 'line', product_id: 'p', qty: 2, purchase_price: 10000, total: 20000, product }] }))
    sessionStorage.setItem('start-route', '/suppliers/invoices/existing/edit')
  })
  await page.reload()
  await page.locator('input[data-invoice-quantity]:visible').waitFor()
  assert.equal(await page.getByRole('button', { name: '+ Новий рядок', exact: true }).count(), 1, 'Existing draft retains add-row control')
  assert.equal(await page.getByRole('button', { name: 'Excel', exact: true }).count(), 1)
  assert.equal(await page.getByText('Групова націнка:', { exact: true }).count(), 1)
  assert.equal(await page.getByText('💵 Оплата постачальнику', { exact: true }).count(), 0, 'Paid draft cannot repeat initial payment')
  await page.getByRole('button', { name: '+ Новий рядок', exact: true }).click()
  await page.getByPlaceholder('Назва товару', { exact: true }).filter({ visible: true }).nth(1).fill('Тимчасовий рядок')
  await page.getByRole('button', { name: 'Видалити рядок', exact: true }).filter({ visible: true }).nth(1).click()
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').count(), 1)
  await page.getByRole('button', { name: 'Буфер', exact: true }).click()
  await page.getByPlaceholder('Вставте скопійовану таблицю', { exact: false }).fill('NEW-1\tНовий товар\t3\t25')
  await page.getByRole('button', { name: 'Імпортувати дані', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('input[data-invoice-quantity]').length === 4)
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').first().inputValue(), '2')
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').last().inputValue(), '3')
  await page.getByRole('button', { name: 'Провести', exact: true }).click()
  await page.waitForFunction(() => fixture.writes.length === 1)
  const body = await page.evaluate(() => fixture.writes[0])
  assert.equal(body.invoice_id, 'existing')
  assert.equal(body.expected_revision, 'r3')
  assert.equal(body.items.length, 2)
  assert.equal(body.items[0].product_id, 'p')
  assert.equal(body.items[1].purchase_price, 2500)
  assert.deepEqual(body.payments, [])
})

scenario('viewport', async () => {
  await reset()
  const rows = Array.from({ length: 35 }, (_, i) => ['Товар ' + i, 'VIEW-' + i, 1, 100])
  await paste('Назва\tАртикул\tКількість\tЦіна\n' + rows.map(row => row.join('\t')).join('\n'))
  await openTable()
  const post = page.getByRole('button', { name: 'Провести', exact: true })
  await post.waitFor()
  for (const zoom of [1, 1.25, 1.5]) {
    await page.setViewportSize({ width: Math.floor(1366 / zoom), height: Math.floor(768 / zoom) })
    for (const fraction of [0, 0.5, 1]) {
      await page.evaluate(f => { const pane = document.getElementById('test-scroll'); pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * f }, fraction)
      const box = await post.boundingBox()
      assert.ok(box && box.y >= 0 && box.y + box.height <= 768 / zoom, `Existing invoice action stays visible at ${zoom * 100}% scroll ${fraction}`)
      assert.equal(await post.evaluate(button => { const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }), true)
    }
    await page.getByPlaceholder('Назва товару', { exact: true }).filter({ visible: true }).last().scrollIntoViewIfNeeded()
    assert.equal(await page.getByPlaceholder('Назва товару', { exact: true }).filter({ visible: true }).last().evaluate(input => { const r = input.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === input }), true, 'Footer does not hide the last editable line')
  }
  assert.equal(await page.evaluate(() => fixture.writes.length), 0)
  await page.setViewportSize({ width: 1366, height: 900 })
})

scenario('keyboard', async () => {
  await reset()
  await page.evaluate(() => sessionStorage.setItem('start-route', '/suppliers/invoices/new?fresh=keyboard'))
  await page.reload()
  const search = page.getByPlaceholder('Знайти існуючий товар за назвою, артикулом або штрихкодом...')
  await search.fill('WX WA9428'); await search.press('Enter'); await page.waitForTimeout(450)
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').count(), 0, 'Unresolved text Enter cannot create a new product line')
  assert.equal(await search.inputValue(), 'WX WA9428')
  await page.evaluate(() => { fixture.searchResults = [{ id: 'known', name: 'Точний товар', sku: 'WA9428', barcode: '2000177521924', unit: 'шт', retail_price: 15000, purchase_price: 10000 }] })
  await search.fill('2000177521924'); await page.waitForTimeout(400)
  await search.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').count(), 0, 'IME Enter is not a selection')
  await search.press('Enter'); await page.locator('input[data-invoice-quantity]:visible').waitFor()
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').count(), 1)
  await page.getByPlaceholder('Немає', { exact: true }).filter({ visible: true }).press('Enter')
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => fixture.writes.length), 0, 'Enter in a numeric/text field cannot post the invoice')
  await search.fill('немає'); await page.waitForTimeout(400); await search.press('ArrowDown')
  assert.match(await page.locator(':focus').innerText(), /^Точний товар\s+WA9428/)
  await page.locator(':focus').press('Enter')
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').inputValue(), '2', 'Explicit keyboard result choice increments the existing line once')
})

scenario('retry', async () => {
  await reset()
  await paste('Назва\tАртикул\tКількість\tЦіна\nТовар повтору\tTRY\t2\t100')
  await openTable()
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled)
  await page.evaluate(() => { fixture.failPreview = true })
  await page.locator('input[data-invoice-quantity]:visible').fill('3')
  await page.getByRole('alert').filter({ hasText: 'Preview unavailable' }).waitFor()
  const retry = page.getByRole('button', { name: 'Повторити перевірку', exact: true })
  assert.equal(await retry.count(), 1, 'Failed match exposes existing-action retry without editing a row')
  assert.equal(await retry.isEnabled(), true)
  assert.equal(await page.getByRole('status').count(), 0, 'Failure is not endless pending')
  const before = await page.evaluate(() => fixture.previewCalls.length)
  await retry.evaluate(button => { button.click(); button.click() })
  await page.waitForFunction(n => fixture.previewCalls.length === n + 1, before)
  await page.getByRole('alert').filter({ hasText: 'Preview unavailable' }).waitFor()
  await page.waitForTimeout(700)
  assert.equal(await page.evaluate(() => fixture.previewCalls.length), before + 1, 'No automatic retry storm or double-click duplicate')
  await page.evaluate(() => { fixture.failPreview = false })
  await retry.click()
  await page.waitForFunction(() => document.querySelector('button[type=submit]').textContent === 'Провести' && !document.querySelector('button[type=submit]').disabled)
  assert.equal((await getDraft()).items[0].qty, 3)
  assert.equal((await getDraft()).items[0].purchase_price, 10000)
  assert.equal(await page.evaluate(() => fixture.writes.length), 0, 'Successful retry does not auto-post')
})

scenario('clipboard', async () => {
  await reset()
  await page.evaluate(() => sessionStorage.setItem('start-route', '/suppliers/invoices/new?fresh=clipboard'))
  await page.reload()
  await page.getByRole('button', { name: 'Буфер', exact: true }).click()
  await page.getByPlaceholder('Вставте скопійовану таблицю', { exact: false }).fill('Закупівля\tНазва\tКількість\tАртикул\tЦіна продажу\tКомірка\n125,50\tТовар тест\t1,250\t00012\t190,00\tA-3')
  await page.getByRole('button', { name: 'Імпортувати дані', exact: true }).click()
  await page.locator('input[data-invoice-quantity]:visible').first().waitFor()
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').count(), 1, 'Column headings are not products')
  assert.equal(await page.getByPlaceholder('Назва товару', { exact: true }).filter({ visible: true }).inputValue(), 'Товар тест')
  assert.equal(await page.getByPlaceholder('Артикул', { exact: true }).filter({ visible: true }).inputValue(), '00012')
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').inputValue(), '1.25')
  assert.equal(await page.locator('input[data-invoice-price=purchase]:visible').inputValue(), '125.50')
  assert.equal(await page.locator('input[data-invoice-price=retail]:visible').inputValue(), '190.00')
  assert.equal(await page.getByPlaceholder('Немає', { exact: true }).filter({ visible: true }).inputValue(), 'A-3')
  const bad = 'Назва\tКількість\tЗакупівля\nКлюч\tпомилка\t120'
  await page.getByPlaceholder('Вставте скопійовану таблицю', { exact: false }).fill(bad)
  await page.getByRole('button', { name: 'Імпортувати дані', exact: true }).click()
  await page.waitForFunction(() => fixture.errors.some(error => error.includes('кількість')))
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').count(), 1, 'Bad input does not append a partial/default row')
  assert.equal(await page.getByPlaceholder('Вставте скопійовану таблицю', { exact: false }).inputValue(), bad)
})

scenario('timeout', async () => {
  await reset()
  await paste('Назва\tАртикул\tКількість\tЦіна\nТовар очікування\tWAIT\t2\t100')
  await openTable()
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled)
  await page.clock.install()
  try {
    await page.evaluate(() => {
      fixture.normalPreview = fixture.bridge.supply.previewInvoiceFromAi
      fixture.bridge.supply.previewInvoiceFromAi = async ({ rows }) => {
        fixture.hangingRows = rows
        return new Promise(resolve => { fixture.finishLatePreview = resolve })
      }
    })
    await page.locator('input[data-invoice-quantity]:visible').fill('4')
    await page.clock.runFor(250)
    await page.clock.runFor(30_001)
    const retry = page.getByRole('button', { name: 'Повторити перевірку', exact: true })
    assert.equal(await retry.isEnabled(), true)
    assert.equal(await page.getByRole('status').count(), 0)
    await page.evaluate(() => { fixture.bridge.supply.previewInvoiceFromAi = fixture.normalPreview })
    await retry.click()
    await page.clock.runFor(500)
    await page.getByRole('button', { name: 'Провести', exact: true }).waitFor()
    await page.evaluate(() => fixture.finishLatePreview(fixture.hangingRows.map(row => ({ name: row.name, source_name: row.name, brand: '', product_id: null, status: 'review', reason: 'Застаріла відповідь', candidates: [], validation_errors: ['Застаріла відповідь'] }))))
    await page.clock.runFor(500)
    assert.equal(await page.locator('[data-ai-issue]').count(), 0, 'Late timed-out answer cannot override successful retry')
    assert.equal(await page.locator('input[data-invoice-quantity]:visible').inputValue(), '4')
    assert.equal(await page.evaluate(() => fixture.writes.length), 0)
  } finally { await page.clock.resume() }
})

scenario('workbook', async () => {
  await reset()
  await page.evaluate(() => sessionStorage.setItem('start-route', '/suppliers/invoices/new?fresh=workbook'))
  await page.reload()
  await page.getByRole('button', { name: 'Excel', exact: true }).click()
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Накладна № TEST'], ['Постачальник', 'Тест']]), 'Титул')
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Назва', 'Кількість', 'Ціна'], ['Ключ другий аркуш', 2, 10]]), 'Товари')
  async function upload() { await page.locator('#file-import').setInputFiles({ name: 'test.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) }) }
  await upload()
  await page.getByRole('dialog').waitFor()
  assert.equal(await page.getByRole('dialog').getByRole('alert').count(), 0)
  await page.getByRole('button', { name: 'Додати 1 позицій у накладну', exact: true }).click()
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').count(), 1)
  assert.equal(await page.getByPlaceholder('Назва товару', { exact: true }).filter({ visible: true }).inputValue(), 'Ключ другий аркуш')
  assert.equal(await page.evaluate(() => fixture.writes.length), 0)
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Без шапки', 1, 12]]), 'Інше')
  await upload()
  await page.waitForFunction(() => fixture.errors.some(error => error.includes('нерозпізнаних аркушів')))
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').count(), 1, 'Unknown second data sheet cannot disappear silently')
  assert.equal(await page.getByRole('dialog').count(), 0)
})

scenario('mapping', async () => {
  await reset()
  await page.evaluate(() => sessionStorage.setItem('start-route', '/suppliers/invoices/new?fresh=mapping'))
  await page.reload()
  await page.getByRole('button', { name: 'Excel', exact: true }).click()
  async function upload(headers, values) {
    const book = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([headers, values])
    sheet.A2.z = '00000'; sheet.C2.z = '0'
    XLSX.utils.book_append_sheet(book, sheet, 'Товари')
    await page.locator('#file-import').setInputFiles({ name: 'custom.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) })
    await page.getByRole('dialog').waitFor()
  }
  const headers = ['Артикул', 'Модель', 'Отримано', 'Собівартість']
  await upload(headers, [12, 'Ключ власний формат', 1.25, 10.49])
  await page.getByRole('dialog').getByRole('alert').waitFor()
  await page.getByRole('dialog').locator('thead select').nth(2).selectOption('qty')
  await page.getByRole('button', { name: 'Додати 1 позицій у накладну', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').first().inputValue(), '1.25')
  assert.equal(await page.getByPlaceholder('Артикул', { exact: true }).filter({ visible: true }).first().inputValue(), '00012')
  await upload(headers, [13, 'Другий файл', 2, 20])
  assert.equal(await page.getByRole('dialog').locator('thead select').nth(2).inputValue(), 'qty', 'Confirmed layout is reused for exact same headers')
  assert.equal(await page.getByRole('dialog').getByRole('alert').count(), 0)
  await page.getByRole('button', { name: 'Додати 1 позицій у накладну', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await upload(['Артикул', 'Модель', 'Собівартість', 'Отримано'], [14, 'Інший порядок', 100, 3])
  assert.notEqual(await page.getByRole('dialog').locator('thead select').nth(2).inputValue(), 'qty', 'Changed format cannot inherit old quantity column')
  await page.getByRole('dialog').getByRole('alert').waitFor()
  assert.equal(await page.locator('input[data-invoice-quantity]:visible').count(), 2)
})

scenario('focus', async () => {
  await reset()
  await page.evaluate(() => {
    fixture.mode = 'mixed'
    fixture.catalog = [
      { id: 'known', name: 'Наявний', sku: 'OUR44', unit: 'шт', retail_price: 15000 },
      { id: 'one', name: 'Варіант один', sku: 'A1', unit: 'шт', retail_price: 15000 },
      { id: 'two', name: 'Варіант два', sku: 'A2', unit: 'шт', retail_price: 15000 },
    ]
  })
  const rows = Array.from({ length: 80 }, (_, i) => [i === 1 || i === 79 ? 'Спірний товар ' + (i + 1) : 'Товар ' + (i + 1), i === 29 ? 'ARCHIVED' : 'SKU-' + i, 1, 100])
  await paste('Назва\tАртикул\tКількість\tЦіна\n' + rows.map(row => row.join('\t')).join('\n'))
  await openTable()
  const problemButton = page.getByRole('button', { name: /^Перевірити рядки/ })
  await problemButton.waitFor()
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled)
  await problemButton.click()
  await page.waitForFunction(() => document.activeElement?.closest('[data-invoice-row]') === document.querySelectorAll('tbody [data-invoice-row]')[1])
  await page.locator('[data-ai-issue]:visible select').first().selectOption('one')
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled)
  await problemButton.click()
  await page.waitForFunction(() => document.activeElement?.closest('[data-invoice-row]') === document.querySelectorAll('tbody [data-invoice-row]')[29])
  assert.equal(await page.locator(':focus').getAttribute('placeholder'), 'Артикул')
  await page.locator(':focus').fill('CORRECTED')
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled)
  await page.setViewportSize({ width: 390, height: 844 })
  await problemButton.click()
  await page.waitForFunction(() => document.activeElement?.closest('[data-invoice-row]')?.querySelector('input[placeholder="Назва товару"]')?.value === 'Спірний товар 80')
  assert.equal(await page.locator(':focus').isVisible(), true, 'Mobile focus uses visible card rather than hidden desktop twin')
  const focused = await page.locator(':focus').boundingBox()
  assert.ok(focused && focused.y >= 0 && focused.y < 844)
  await page.locator(':focus').selectOption('two')
  await page.getByRole('button', { name: 'Провести', exact: true }).waitFor()
  assert.equal(await page.locator('[data-ai-issue]:visible').count(), 0)
  assert.equal(await page.evaluate(() => fixture.writes.length), 0)
  assert.equal((await getDraft()).items.length, 80)
  await page.setViewportSize({ width: 1366, height: 900 })
})

let failures = 0
try {
  // Clock instrumentation lasts for the page lifetime; keep that case isolated at the end.
  for (const [name, run] of cases.sort(([a], [b]) => Number(a === 'timeout') - Number(b === 'timeout'))) {
    try { await run(); console.log('INVOICE_USABILITY_' + name.toUpperCase() + '_OK') }
    catch (error) { failures += 1; console.error(name, error); console.error(await page.evaluate(() => fixture.errors)) }
  }
  assert.deepEqual(errors, [])
  assert.equal(failures, 0, `${failures} invoice usability scenario(s) failed`)
} finally { await test.close() }
