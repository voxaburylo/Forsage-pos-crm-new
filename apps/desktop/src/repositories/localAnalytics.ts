import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
export function localAnalytics(db: LocalDatabase, input: {kind:'abc'|'staff';from:string;to:string;startDate:string;endDate:string}): any[] {
 if(!['abc','staff'].includes(input.kind)||!Number.isFinite(Date.parse(input.from))||!Number.isFinite(Date.parse(input.to))||input.from>input.to)throw new Error('Некоректний період')
 const tenant=DEFAULT_TENANT_ID
 const lines=db.prepare(`SELECT si.product_id, si.qty, si.purchase_price,
  (si.qty*si.unit_price-si.discount) line_net, s.total,
  SUM(si.qty*si.unit_price-si.discount) OVER(PARTITION BY s.id) lines_net,
  COALESCE(o.manager_id,s.manager_id,s.cashier_id) employee_id, o.id order_id
  FROM sale_items si JOIN sales s ON s.id=si.sale_id AND s.tenant_id=si.tenant_id
  LEFT JOIN customer_orders o ON o.sale_id=s.id AND o.tenant_id=s.tenant_id AND o.deleted_at IS NULL
  WHERE si.tenant_id=? AND si.deleted_at IS NULL AND s.deleted_at IS NULL AND s.status IN ('completed','returned')
  AND s.completed_at>=? AND s.completed_at<=?`).all(tenant,input.from,input.to) as any[]
 const returns=db.prepare(`SELECT ri.product_id, -ri.quantity qty, si.purchase_price, -ri.total_kopecks line_net,
  1 total, 1 lines_net, COALESCE(o.manager_id,s.manager_id,s.cashier_id) employee_id,o.id order_id
  FROM customer_return_items ri JOIN customer_returns r ON r.id=ri.return_id AND r.tenant_id=ri.tenant_id
  JOIN sale_items si ON si.id=ri.sale_item_id AND si.tenant_id=ri.tenant_id
  JOIN sales s ON s.id=si.sale_id AND s.tenant_id=si.tenant_id
  LEFT JOIN customer_orders o ON o.sale_id=s.id AND o.tenant_id=s.tenant_id AND o.deleted_at IS NULL
  WHERE ri.tenant_id=? AND ri.deleted_at IS NULL AND r.deleted_at IS NULL AND r.status='completed'
  AND r.created_at>=? AND r.created_at<=?`).all(tenant,input.from,input.to) as any[]
 const entries=[...lines,...returns]
 if(input.kind==='abc') {
  const products=db.prepare('SELECT id,sku,name,qty_on_hand currentStock FROM products WHERE tenant_id=? AND deleted_at IS NULL AND is_active=1 AND is_service=0').all(tenant) as any[]
  const map=new Map(products.map(p=>[p.id,{...p,soldQty:0,profit:0}]))
  for(const line of entries){const p=map.get(line.product_id);if(!p)continue;p.soldQty+=Number(line.qty);p.profit+=Number(line.line_net)*(line.lines_net>0?line.total/line.lines_net:1)-line.qty*line.purchase_price}
  const rows=[...map.values()].sort((a,b)=>b.profit-a.profit||a.id.localeCompare(b.id));const total=rows.reduce((s,r)=>s+Math.max(0,r.profit),0);let cumulative=0
  return rows.map(r=>{const before=total?cumulative/total:0;cumulative+=Math.max(0,r.profit);return {...r,profit:Math.round(r.profit),cumulative_pct:total?100*cumulative/total:0,abc_class:r.soldQty<=0||r.profit<=0?'Z':before<.8?'A':before<.95?'B':'C'}})
 }
 const staff=db.prepare('SELECT id,full_name FROM staff_users WHERE tenant_id=?').all(tenant) as any[]
 const map=new Map(staff.map(p=>[p.id,{manager_id:p.id,manager_name:p.full_name,sales_revenue:0,sales_cogs:0,orders_revenue:0,orders_cogs:0,salary_cost:0,bonus_cost:0,advance_cost:0,penalty_cost:0}]))
 for(const line of entries){const p=map.get(line.employee_id);if(!p)continue;const revenue=Number(line.line_net)*(line.lines_net>0?line.total/line.lines_net:1),cost=line.qty*line.purchase_price;if(line.order_id){p.orders_revenue+=revenue;p.orders_cogs+=cost}else{p.sales_revenue+=revenue;p.sales_cogs+=cost}}
 const salary=db.prepare('SELECT employee_id,type,SUM(amount) amount FROM salary_payments WHERE tenant_id=? AND deleted_at IS NULL AND work_date>=? AND work_date<=? GROUP BY employee_id,type').all(tenant,input.startDate,input.endDate) as any[]
 for(const row of salary){const p=map.get(row.employee_id);if(p)(p as any)[row.type+'_cost']+=Number(row.amount)}
 return [...map.values()].map(p=>{const total_revenue=Math.round(p.sales_revenue+p.orders_revenue),total_cogs=Math.round(p.sales_cogs+p.orders_cogs),gross_profit=total_revenue-total_cogs;return {...p,total_revenue,total_cogs,gross_profit,total_payouts:p.advance_cost,net_profit:gross_profit-p.salary_cost-p.bonus_cost+p.penalty_cost}}).sort((a,b)=>b.net_profit-a.net_profit)
}
