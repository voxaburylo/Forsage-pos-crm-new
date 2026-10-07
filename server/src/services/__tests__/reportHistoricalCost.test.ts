import { it,expect } from 'vitest'
import { aggregatePeriod } from '../../lib/periodReport.js'
it('uses captured cost, discounted sale total and dated refunds, not current product cost',()=>{
 const report=aggregatePeriod({
  sales:[{id:'s',sale_number:'S',selected:true,status:'completed',total:18000,completed_at:'2026-09-13T12:00:00Z',
   payment_method:'cash',cash_amount:18000,card_amount:0,transfer_amount:0,debt_amount:0,is_debt:false,customer_id:null,customer:null}],
  lines:[{id:'l',sale_id:'s',qty:2,total:20000,cost:5000}],
  returns:[{id:'r',sale_id:'s',created_at:'2026-09-13T13:00:00Z',amount:9000,stock_action:'return_to_stock'}],
  refundLines:[{id:'rl',return_id:'r',sale_item_id:'l',quantity:1,total_kopecks:9000}],orders:[],payments:[],
 },'2026-09-13','2026-09-13')
 expect(report).toMatchObject({profit:4000,total_revenue:18000,net_revenue:9000})
})
