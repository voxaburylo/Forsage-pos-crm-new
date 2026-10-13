import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TireServiceDetails } from './TireServiceDetails'
import type { TireServiceReport } from '@/features/staff/staffApi'

export const tireFixture: TireServiceReport = {
  date: '2026-09-22', details_version: 1,
  data: [{employee_id:'worker',employee_name:'Андрій',services_qty:2,service_revenue:36000,commission_earned:12600,daily_rate:0,earned:12600,paid:10000,penalty:0,balance:2600,due:2600,cash_revenue:36000,cash_handed_over:36000,cash_pending:0,salary_available_on:'2026-09-24',salary_ready:true,payable_due:2600}],
  receipts: [{id:'sale',sale_number:'TIRE-47',completed_at:'2026-09-22T13:40:00Z',employee_id:'worker',employee_name:'Андрій',services_qty:2,service_revenue:36000,cash_revenue:36000,payment_method:'cash',total:36000,cashier_name:'Никита',notes:'Заміна 4 коліс R16',commission_earned:12600,services:[{id:'line',description:'Балансування',qty:2,unit_price:18000,total:36000}]}],
  salary_operations:[{id:'payout',employee_id:'worker',type:'advance',source:'manual',amount:10000,method:'cash',note:'Виплата за 22 вересня',work_date:'2026-09-22',created_at:'2026-09-25T07:00:00Z',created_by:'cashier',cashier_name:'Никита',sale_id:null,fund_source:'owner_funds'}],
  cash_handovers:[], totals:{services_qty:2,service_revenue:36000,cash_revenue:36000,cash_handed_over:36000,cash_pending:0,due:2600,payable_due:2600},
}
function markup(overrides: Partial<Parameters<typeof TireServiceDetails>[0]> = {}) {
  return renderToStaticMarkup(<TireServiceDetails report={tireFixture} date="2026-09-22" today="2026-09-25" employeeId="" loading={false} error={false} onDate={()=>{}} onEmployee={()=>{}} onRefresh={()=>{}} canPay={true} canMutate={false} busy={false} onPay={()=>{}} {...overrides} />)
}
it('shows work, cashier, comment, actual payout time, owner funds and the calculation after all operations', () => {
  const html = markup()
  for (const text of ['Андрій','Никита','TIRE-47','Балансування','Заміна 4 коліс R16','25.09.2026','кошти власника','126,00','100,00','26,00']) expect(html).toContain(text)
  expect(html.indexOf('Розрахунок зарплати за')).toBeGreaterThan(html.indexOf('Виплата за 22 вересня'))
  expect(html).not.toContain('<table'); expect(html).not.toContain('overflow-auto'); expect(html).not.toContain('max-h-')
  expect(html).not.toContain('Виплатити з каси')
})
it('never presents an error or loading state as a zero salary', () => {
  expect(markup({error:true})).toContain('Не вдалося завантажити звіт')
  expect(markup({error:true})).not.toContain('126,00')
  expect(markup({loading:true})).not.toContain('126,00')
  expect(markup({loading:true})).toContain('Завантажуємо операції')
})
it('shows inactive worker history without offering payout or pretending the waiting period is the reason', () => {
  const report = structuredClone(tireFixture)
  Object.assign(report.data[0], { employee_active: false, salary_ready: false, payable_due: 0 })
  const html = markup({ report, canMutate: true })
  expect(html).toContain('Працівник неактивний')
  expect(html).toContain('лише збережені нарахування')
  expect(html).toContain('TIRE-47')
  expect(html).not.toContain('Виплатити з каси')
  expect(html).not.toContain('доступна з 24.09.2026')
})
it('shows a compact existing calculation before long history and retains a single set of payout controls', () => {
  const html = markup({ canMutate: true })
  expect(html.indexOf('Короткий підсумок зарплати')).toBeLessThan(html.indexOf('Чеки касира'))
  expect(html.indexOf('Розрахунок зарплати за')).toBeGreaterThan(html.indexOf('Виплата за 22 вересня'))
  expect(html.match(/Виплатити з каси/g)).toHaveLength(1)
  expect(html.match(/Виплатити коштами власника/g)).toHaveLength(1)
})
it('keeps a payroll month and selected employee visible before a day is chosen without a false zero report', () => {
  const html = markup({ report: null, date: '', period: '2026-09', employeeId: 'worker' })
  expect(html).toContain('Період зарплати: 2026-09')
  expect(html).toContain('Вибраний працівник із зарплати')
  expect(html).toContain('Оберіть дату робіт')
  expect(html).not.toContain('даних немає')
  expect(html).not.toContain('Короткий підсумок зарплати')
})
it('filters employees and explains missing comments and legacy report details', () => {
  expect(markup({employeeId:'another'})).not.toContain('TIRE-47')
  expect(markup({employeeId:'another'})).toContain('не підтверджує відсутність минулих робіт')
  const report = structuredClone(tireFixture)
  report.details_version=undefined; report.receipts[0].notes=null
  expect(markup({report})).toContain('Джерело звіту ще не оновлено')
  expect(markup({report})).toContain('не заповнений')
})
it('distinguishes accrued salary from payable salary and disables actions while saving', () => {
  const report = structuredClone(tireFixture)
  Object.assign(report.data[0],{salary_ready:false,payable_due:0,cash_pending:36000})
  const html = markup({report,canMutate:true,busy:true})
  expect(html).toContain('24.09.2026');expect(html).not.toContain('Виплатити з каси')
  expect(html).toContain('disabled=""'); expect(html).not.toContain('Внести готівку до каси')
})
it('shows already registered POS cash separately from historical handovers without another deposit action', () => {
  const report = structuredClone(tireFixture)
  Object.assign(report.data[0], { cash_register_received: 30000, cash_revenue: 30000, cash_handed_over: 10000 })
  const html = markup({report,canMutate:true})
  expect(html).toContain('Готівка за чеками, вже врахована в касі')
  expect(html).toContain('300,00')
  expect(html).toContain('Окремі внесення в історії')
  expect(html).toContain('Повторне внесення не потрібне')
  expect(html).not.toContain('ще передати')
  expect(html).not.toContain('Внести готівку до каси')
  expect(html).toContain('Виплатити з каси')
})
it('does not invent registered cash for an older source or offer a duplicate deposit', () => {
  const report = structuredClone(tireFixture)
  Object.assign(report.data[0], {cash_pending:36000})
  const html = markup({report,canMutate:true})
  expect(html).toContain('Оновіть програму, щоб перевірити облік готівки')
  expect(html).not.toContain('Внести готівку до каси')
  expect(html).not.toContain('Готівка за чеками, вже врахована в касі')
})
it('shows a dated negative commission reversal without claiming that unpaid money was advanced', () => {
  const report = structuredClone(tireFixture)
  report.date = '2026-09-23'
  report.receipts = []
  Object.assign(report.data[0], { services_qty: 0, service_revenue: 0, commission_earned: -6300,
    earned: -6300, paid: 0, penalty: 0, balance: -6300, due: 0, payable_due: 0,
    cash_revenue: 0, cash_register_received: 0, cash_handed_over: 0 })
  report.salary_operations = [{ ...report.salary_operations![0], id: 'reversal', type: 'bonus',
    source: 'commission_reversal', amount: -6300, note: 'Часткове повернення робіт',
    work_date: '2026-09-23', created_at: '2026-09-23T08:00:00Z', fund_source: null, sale_id: 'sale' }]
  const html = markup({ report, date: report.date, canMutate: true })
  expect(html).toContain('Сторно нарахування за повернення')
  expect(html).toContain('-63,00')
  expect(html).toContain('23.09.2026')
  expect(html).toContain('Часткове повернення робіт')
  expect(html).not.toContain('TIRE-47')
  expect(html).not.toContain('Виплатити з каси')
  expect(html).not.toContain('Виплачено наперед')
  expect(html).toContain('Від’ємний залишок зарплати')
})
it('keeps the original receipt and original commission visible in its own work day', () => {
  const report = structuredClone(tireFixture)
  Object.assign(report.data[0], { earned: 12600, paid: 0, balance: 12600, due: 12600,
    cash_register_received: 36000, cash_handed_over: 0 })
  report.salary_operations = [{ ...report.salary_operations![0], id: 'commission', type: 'bonus',
    source: 'commission', amount: 12600, note: 'Початкове нарахування', work_date: report.date,
    created_at: '2026-09-22T13:40:00Z', fund_source: null, sale_id: 'sale' }]
  const html = markup({ report })
  expect(html).toContain('TIRE-47')
  expect(html).toContain('360,00')
  expect(html).toContain('126,00')
  expect(html).toContain('22.09.2026')
  expect(html).not.toContain('Сторно нарахування за повернення')
})
