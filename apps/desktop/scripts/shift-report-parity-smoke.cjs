// Compares built local SQLite reports with the built server reducer. Synthetic data only.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const dist = path.resolve(__dirname,process.argv.includes('--staged')?'../release/staged/win-unpacked/resources/app.asar/dist':'../dist')
const { LocalDatabase } = require(path.join(dist,'db/localDatabase'))
const { LocalCatalogRepository } = require(path.join(dist,'repositories/catalogRepository'))
const { LocalPosRepository } = require(path.join(dist,'repositories/posRepository'))
const { LocalOrderRepository } = require(path.join(dist,'repositories/orderRepository'))
;(async()=>{
 const { aggregateShiftSnapshot } = await import(pathToFileURL(path.resolve(__dirname,'../../../server/dist/lib/shiftReport.js')).href)
 const root=mkdtempSync(path.join(tmpdir(),'forsage-shift-parity-'))
 const tenant='00000000-0000-0000-0000-000000000001'
 let db,checks=0
 try{
  db=new LocalDatabase(root)
  const pos=new LocalPosRepository(db),catalog=new LocalCatalogRepository(db)
  const customer=pos.saveCustomer({full_name:'Перевірка звіту',phone:'0678881122'}).data.id
  const product=catalog.upsertProduct({id:randomUUID(),sku:'PARITY',name:'Контрольний товар',qty_on_hand:100,retail_price:1000,purchase_price:600}).id
  function compare(cashier,shift){
   const local=pos.getShiftReport(cashier)
   const copies=db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type='sale.completed'").all().map(row=>JSON.parse(row.payload_json))
   const sales=db.prepare('SELECT * FROM sales WHERE shift_id=? AND tenant_id=? AND deleted_at IS NULL').all(shift,tenant).map(row=>{
    const copy=copies.find(item=>item.id===row.id)
    const parts={cash_amount:0,card_amount:0,transfer_amount:0,debt_amount:0}
    if(copy)for(const payment of copy.payments)parts[payment.method+'_amount']+=payment.amount
    else for(const key of Object.keys(parts))parts[key]=Number(row[key]??0)
    return {...row,...parts,is_debt:Boolean(row.is_debt),is_fiscal:Boolean(row.is_fiscal)}
   })
   const rawReturns=db.prepare('SELECT * FROM customer_returns WHERE shift_id=? AND tenant_id=? AND deleted_at IS NULL AND status=?').all(shift,tenant,'completed')
   const cashRows=db.prepare('SELECT * FROM cash_operations WHERE shift_id=? AND tenant_id=? AND deleted_at IS NULL AND type<>?').all(shift,tenant,'sale_cash')
   const operations=cashRows.map(row=>{
    const refund=rawReturns.find(item=>item.id===row.id)
    return {...row,type:row.type==='cash_in'?'in':'out',created_by:row.created_by||cashier,
     refund:refund?{method:refund.refund_method,status:refund.status,amount:refund.refund_kopecks}:null}
   })
   const refunds=rawReturns.map(row=>{
    const cash=cashRows.find(op=>op.id===row.id && op.type==='return_cash')
    return {id:row.id,sale_id:row.sale_id,refund_method:row.refund_method,amount:row.refund_kopecks,
     // Current old server copies have no return.shift_id. Cash links / unique intervals must still agree.
     shift_id:null,cash_shift_id:cash?shift:null,cash_amount:cash?cash.amount:null,
     sale_total:db.prepare('SELECT total FROM sales WHERE id=?').get(row.sale_id).total,
     known_links:cash?[shift]:[],intervals:[shift]}
   })
   const orders=db.prepare('SELECT id,sale_id FROM customer_orders WHERE tenant_id=?').all(tenant)
   const payments=db.prepare('SELECT * FROM order_payments WHERE shift_id=? AND tenant_id=? AND deleted_at IS NULL').all(shift,tenant).map(row=>({...row,is_fiscal:Boolean(row.is_fiscal)}))
   // Check both legacy evidence and the exact modern copy metadata.
   for(const mode of ['legacy','recorded']){
    const mapped=mode==='legacy'?refunds:refunds.map(row=>({...row,shift_id:shift,shift_link_recorded:true,known_links:[shift]}))
    const server=aggregateShiftSnapshot({shift:{...local.shift,tenant_id:tenant},sales,orders,payments,operations,refunds:mapped},shift,tenant)
    for(const key of ['total_sales','gross_revenue','refund_total','total_revenue','payment_received_total',
      'payment_refunded_total','payment_net_total','by_method','refunds_by_method','cash_breakdown','unassigned_refunds_count']){
     assert.deepEqual(server[key],local[key],mode+' local/server mismatch: '+key)
    }
    checks++
   }
  }
  for(const [method,refundMethod] of [['cash','cash'],['card','terminal'],['transfer','terminal'],['cash','credit'],['debt','debt_reduction']]){
   const cashier=randomUUID()
   let shift=pos.openShift({cashier_id:cashier,opening_cash:10000})
   const sale=pos.checkout({cashier_id:cashier,customer_id:customer,shift_id:shift,
    items:[{product_id:product,qty:2,unit_price:1000}],payments:[{method,amount:2000}]}).sale_id
   compare(cashier,shift)
   const item=pos.getSaleForReturn(sale).items[0]
   const request={sale_id:sale,approved_by:cashier,shift_id:shift,refund_method:refundMethod,stock_action:'return_to_stock',
    items:[{sale_item_id:item.id,product_id:product,quantity:1}]}
   pos.createReturn({...request,client_operation_id:randomUUID()});compare(cashier,shift)
   pos.closeShift(cashier,pos.getExpectedCash(cashier).expected_amount,null,shift)
   shift=pos.openShift({cashier_id:cashier,opening_cash:10000})
   pos.createReturn({...request,shift_id:shift,client_operation_id:randomUUID()});compare(cashier,shift)
   pos.closeShift(cashier,pos.getExpectedCash(cashier).expected_amount,null,shift)
  }
  const cashier=randomUUID(),shift=pos.openShift({cashier_id:cashier,opening_cash:10000})
  const orders=new LocalOrderRepository(db)
  const order=orders.saveOrder({manager_id:cashier,customer_id:customer,items:[{product_id:product,name:'Контрольний товар',qty:1,buy_price:600,sell_price:1000,item_status:'arrived'}]})
  orders.addPayment(order.id,{payment_id:randomUUID(),user_id:cashier,shift_id:shift,amount:1000,method:'cash'})
  compare(cashier,shift)
  orders.completeOrder(order.id,{user_id:cashier,shift_id:shift});compare(cashier,shift)
  db.prepare('UPDATE customer_orders SET deleted_at=? WHERE id=?').run(new Date().toISOString(),order.id)
  compare(cashier,shift)
  console.log(JSON.stringify({passed:true,checks,packaged:process.argv.includes('--staged'),liveDataModified:false}))
 }finally{
  db?.close()
  if(path.dirname(root)===path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-shift-parity-'))rmSync(root,{recursive:true,force:true})
 }
})().catch(error=>{console.error(error);process.exitCode=1})
