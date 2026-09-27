import { describe, expect, it } from 'vitest'
import { staffPaySettings, normalizedStaffPhone, staffTransactionAmount } from './staffFormModel'
const form={role:'cashier',salaryMode:'rate_and_pct',base_rate:'500,50',pos_revenue:'7,5',pos_profit:'',order_revenue:'2',order_profit:'',tire_revenue:'',tire_profit:''}
describe('staff payroll form validation before save',()=>{
  it('normalizes phones and decimal input',()=>{
    expect(normalizedStaffPhone('067 111 22 33')).toBe(normalizedStaffPhone('+380671112233'))
    expect(staffPaySettings(form)).toEqual({base_rate:50050,rules:[{rule_type:'pos_sales',pct_from_revenue:7.5,pct_from_profit:0},{rule_type:'order_sales',pct_from_revenue:2,pct_from_profit:0}]})
  })
  it('rejects invalid money and percentages before an employee is created',()=>{
    for(const value of ['-1','Infinity','oops'])expect(()=>staffPaySettings({...form,base_rate:value})).toThrow()
    for(const value of ['-1','101','NaN'])expect(()=>staffPaySettings({...form,pos_revenue:value})).toThrow()
  })
  it('does not save obsolete rules for a tire worker or rate-only mode',()=>{
    expect(staffPaySettings({...form,role:'tire_worker',tire_revenue:'10'}).rules).toEqual([{rule_type:'tire_service',pct_from_revenue:10,pct_from_profit:0}])
    expect(staffPaySettings({...form,salaryMode:'only_rate'}).rules).toEqual([])
  })
})
describe('staff transaction amount', () => {
  it.each([['126,50',12650],['126.50',12650],['1 234,05',123405],['0,01',1],['1.15',115]])('parses %s exactly', (text, expected) => {
    expect(staffTransactionAmount(text)).toBe(expected)
  })
  it.each(['', 'NaN', 'Infinity', '126oops', '126,123', '-1', '0', '1e3', '1.2.3', '9007199254740992'])('rejects %s instead of truncating or rounding', text => {
    expect(() => staffTransactionAmount(text)).toThrow()
  })
})
