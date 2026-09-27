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
  return renderToStaticMarkup(<TireServiceDetails report={tireFixture} date="2026-09-22" today="2026-09-25" employeeId="" loading={false} error={false} onDate={()=>{}} onEmployee={()=>{}} onRefresh={()=>{}} canPay={true} canMutate={false} busy={false} onHandOver={()=>{}} onPay={()=>{}} {...overrides} />)
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
it('filters employees and explains missing comments and legacy report details', () => {
  expect(markup({employeeId:'another'})).not.toContain('TIRE-47')
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
  expect(html).toContain('disabled=""'); expect(html).toContain('Внести готівку до каси')
})
