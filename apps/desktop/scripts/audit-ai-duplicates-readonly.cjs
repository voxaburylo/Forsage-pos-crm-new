// Diagnostic candidates, NOT permission to merge/delete. Never imports LocalDatabase.
const {DatabaseSync}=require('node:sqlite')
const {writeFileSync}=require('node:fs')
const path=require('node:path')
const [databasePath,reportPath]=process.argv.slice(2)
if(!databasePath||!path.isAbsolute(databasePath))throw Error('Absolute database path required')
if(reportPath&&(!path.isAbsolute(reportPath)||path.extname(reportPath)!=='.json'))throw Error('Absolute JSON report path required')
const db=new DatabaseSync(databasePath,{readOnly:true,timeout:2000})
const normal=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('uk').replace(/\s+/g,' ').trim()
const code=value=>normal(value).toUpperCase().replace(/[^\p{L}\p{N}]/gu,'')
const synthetic=value=>/^(?:AI-[A-F0-9]{8}|AUTO[-_][A-F0-9-]{8,})$/i.test(String(value??''))
const tokens=value=>normal(value).replace(/(\d)\s*(?:л|l)(?=$|[^\p{L}\p{N}])/gu,'$1л').match(/[\p{L}\p{N}]+/gu)??[]
const unit=value=>normal(value).replace(/\./g,'').replace(/^(?:штук|штука|штуки|pcs|pc)$/,'шт')
function differentOilVariant(a,b){
 const grades=name=>new Set((normal(name).match(/\d{1,2}\s*w\s*-?\s*\d{2}/g)??[]).map(x=>x.replace(/[\s-]/g,'')))
 const volumes=name=>new Set([...normal(name).matchAll(/(\d+(?:[.,]\d+)?)\s*(?:л|l)(?=$|[^\p{L}\p{N}])/gu)].map(x=>x[1].replace(',','.')))
 for(const extract of [grades,volumes]){const left=extract(a),right=extract(b);if(left.size&&right.size&&![...left].some(x=>right.has(x)))return true}
 return false
}
const fullName=p=>{
  const words=tokens(p.name),brand=tokens(p.brand)
  for(const token of brand)if(!words.includes(token))words.push(token)
  const numbers=normal(p.name).match(/\d+(?:[.,]\d+)?/g)??[]
  return JSON.stringify([words.sort(),numbers.map(n=>n.replace(',','.')),unit(p.unit)])
}
const technical=value=>[...new Set([
  ...(normal(value).match(/\d{6,}/g)??[]),
  ...(normal(value).match(/[\p{L}\p{N}]+(?:[-/][\p{L}\p{N}]+)*/gu)??[])
    .filter(t=>/[a-z]/i.test(t)&&(t.match(/\d/g)?.length??0)>=3&&t.length>=5)
    .filter(t=>!/^\d{1,2}w-?\d{2}$/i.test(t)&&!/^\d.*(?:w|v|a|ah|mah|ml|mm|мм|мл|л|kg|кг|l)(?:$|\/)/i.test(t)),
].map(code))]
const compact=p=>({id:p.id,name:p.name,sku:p.sku,barcode:p.barcode,brand:p.brand,unit:p.unit,qty_on_hand:p.qty_on_hand,
  purchase_price:p.purchase_price,retail_price:p.retail_price,created_at:p.created_at,ai_document_links:p.ai_links,created_with_ai_document:p.created_with_ai})
try{
 db.exec('PRAGMA query_only=ON; BEGIN')
 const products=db.prepare(`SELECT p.id,p.tenant_id,p.name,p.sku,p.barcode,p.qty_on_hand,p.unit,p.purchase_price,p.retail_price,p.created_at,b.name brand
 FROM products p LEFT JOIN brands b ON b.id=p.brand_id AND b.tenant_id=p.tenant_id
 WHERE p.deleted_at IS NULL AND p.is_active=1 AND p.is_service=0`).all()
 const byId=new Map(products.map(p=>[p.id,p]))
 const aiLinks=db.prepare(`SELECT i.product_id,s.id invoice_id,s.invoice_number,s.created_at invoice_created,s.posted_at,
 i.created_at item_created FROM supply_invoice_items i JOIN supply_invoices s ON s.id=i.invoice_id AND s.tenant_id=i.tenant_id
 WHERE s.deleted_at IS NULL AND i.deleted_at IS NULL AND s.status='posted' AND (s.notes LIKE '%AI%' OR s.notes LIKE '%ШІ%')`).all()
 for(const p of products){p.ai_links=0;p.created_with_ai=false}
 for(const row of aiLinks){
  const p=byId.get(row.product_id);if(!p)continue;p.ai_links++
  if([row.invoice_created,row.posted_at].some(at=>at&&Math.abs(Date.parse(at)-Date.parse(p.created_at))<=60000))p.created_with_ai=true
 }
 const indexes={barcode:new Map(),sku:new Map(),name:new Map(),part:new Map()}
 function index(kind,key,p){if(!key)return;const all=indexes[kind].get(p.tenant_id+':'+key)??new Set();all.add(p.id);indexes[kind].set(p.tenant_id+':'+key,all)}
 for(const p of products){
  index('barcode',normal(p.barcode),p)
  if(!synthetic(p.sku))index('sku',code(p.sku),p)
  index('name',fullName(p),p)
  for(const part of technical(p.name))index('part',part,p)
 }
 for(const row of db.prepare('SELECT product_id,barcode FROM product_barcodes WHERE deleted_at IS NULL').all()){
  const p=byId.get(row.product_id);if(p)index('barcode',normal(row.barcode),p)
 }
 const pairs=new Map()
 function add(a,b,reason){
  if(a.id===b.id)return
  const ids=[a.id,b.id].sort(),key=ids.join(':')
  const pair=pairs.get(key)??{ids,reasons:[],level:'identifier-or-full-name',cards:ids.map(id=>compact(byId.get(id)))}
  if(!pair.reasons.includes(reason))pair.reasons.push(reason)
  pairs.set(key,pair)
 }
 for(const kind of ['barcode','sku','name']){
  for(const [key,ids]of indexes[kind]){
   const list=[...ids]
   for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++)add(byId.get(list[i]),byId.get(list[j]),kind+':'+key.slice(key.indexOf(':')+1))
  }
 }
 const modelPairs=[]
 for(const p of products.filter(p=>p.created_with_ai||synthetic(p.sku))){
  const keys=new Set([...technical(p.name),...(!synthetic(p.sku)&&code(p.sku).length>=5?[code(p.sku)]:[])])
  for(const key of keys){
   const ids=new Set([...(indexes.sku.get(p.tenant_id+':'+key)??[]),...(indexes.part.get(p.tenant_id+':'+key)??[])])
   if(ids.size>20)continue
   for(const id of ids){
    if(id===p.id)continue
    const other=byId.get(id),pairkey=[id,p.id].sort().join(':')
    if(pairs.has(pairkey)||modelPairs.some(x=>x.pair_key===pairkey))continue
    if(unit(p.unit)!==unit(other.unit)||differentOilVariant(p.name,other.name))continue
    const brandA=code(p.brand),brandB=code(other.brand)
    if(brandA&&brandB&&brandA!==brandB)continue
    const a=new Set(tokens(p.name)),b=new Set(tokens(other.name))
    const common=[...a].filter(t=>b.has(t)).length
    const similarity=common/Math.max(1,Math.min(a.size,b.size))
    if(common<3||similarity<0.5)continue
    modelPairs.push({pair_key:pairkey,level:'technical-number-needs-review',technical_number:key,similarity, cards:[compact(p),compact(other)]})
   }
  }
 }
 const allPairs=[...pairs.values()]
 const invoiceGroups=new Map()
 const invoices=db.prepare(`SELECT s.id,s.supplier_id,s.invoice_number,s.total,s.paid_amount,s.posted_at,s.created_at,
 (SELECT count(*) FROM supply_invoice_items i WHERE i.invoice_id=s.id AND i.deleted_at IS NULL) rows
 FROM supply_invoices s WHERE s.deleted_at IS NULL AND s.status='posted'`).all()
 for(const invoice of invoices){
  const digits=String(invoice.invoice_number??'').replace(/[^0-9]/g,'').replace(/^0+/,'')
  if(!digits)continue
  const key=invoice.supplier_id+':'+digits+':'+String(invoice.posted_at??invoice.created_at).slice(0,10)
  const group=invoiceGroups.get(key)??[];group.push(invoice);invoiceGroups.set(key,group)
 }
 const repeatInvoices=[...invoiceGroups.values()].filter(group=>group.length>1)
 const latestMismatch=db.prepare(`WITH ranked AS(
 SELECT *,row_number()OVER(PARTITION BY tenant_id,product_id ORDER BY created_at DESC,rowid DESC)rn
 FROM inventory_movements WHERE deleted_at IS NULL)
 SELECT p.id,p.name,p.sku,p.qty_on_hand,m.qty_after,m.created_at,m.source_type FROM products p
 JOIN ranked m ON m.product_id=p.id AND m.tenant_id=p.tenant_id AND m.rn=1
 WHERE p.deleted_at IS NULL AND p.is_active=1 AND p.is_service=0 AND abs(p.qty_on_hand-m.qty_after)>0.00001`).all()
 const sourceCounts=db.prepare(`SELECT source_type,count(*) count,sum(qty_delta) delta FROM inventory_movements WHERE deleted_at IS NULL AND source_type LIKE '%sync%' GROUP BY source_type`).all()
 const referencedIds=new Set([...allPairs,...modelPairs].flatMap(pair=>pair.cards.map(card=>card.id)))
 const stats=db.prepare(`SELECT product_id,source_type,count(*) operations,sum(qty_delta) qty_delta,min(created_at) first_at,max(created_at) last_at
 FROM inventory_movements WHERE deleted_at IS NULL GROUP BY product_id,source_type`).all().filter(r=>referencedIds.has(r.product_id))
 const report={created_at:new Date().toISOString(),read_only:true,
 warning:'Candidates only. Same name/code is not proof of identical stock. No quantities, documents or payments changed.',
 counts:{active_products:products.length,used_in_ai_invoices:products.filter(p=>p.ai_links).length,
 created_with_ai_by_timestamp:products.filter(p=>p.created_with_ai).length,synthetic_ai_skus:products.filter(p=>/^AI-[A-F0-9]{8}$/i.test(p.sku)).length,
 identifier_or_fullname_pairs:allPairs.length,ai_related_identifier_pairs:allPairs.filter(pair=>pair.cards.some(p=>p.created_with_ai_document||synthetic(p.sku))).length,
 technical_number_candidates:modelPairs.length,similar_posted_invoice_groups:repeatInvoices.length,stock_vs_last_movement_mismatches:latestMismatch.length},
 pairs:allPairs,model_candidates:modelPairs,movement_summaries:stats,similar_posted_invoices:repeatInvoices,stock_vs_last_movement:latestMismatch,source_counts:sourceCounts}
 if(reportPath)writeFileSync(reportPath,JSON.stringify(report,null,2),{flag:'wx',encoding:'utf8'})
 console.log(JSON.stringify({counts:report.counts,source_counts:sourceCounts,reportPath}))
 const aiPairs=allPairs.filter(pair=>pair.cards.some(p=>p.created_with_ai_document||synthetic(p.sku)))
 console.log('AI-related exact candidates',JSON.stringify(aiPairs.slice(0,12)))
 console.log('Model candidates',JSON.stringify(modelPairs.slice(0,12)))
}finally{db.exec('ROLLBACK');db.close()}
