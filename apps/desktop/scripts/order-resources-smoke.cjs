// Synthetic history only; compare the former sidebar scan with the scalar count.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const dist=path.resolve(__dirname,process.argv.includes('--packaged')?'../release/win-unpacked/resources/app.asar/dist':'../dist')
const {LocalDatabase}=require(path.join(dist,'db/localDatabase'))
const {LocalOrderRepository}=require(path.join(dist,'repositories/orderRepository'))
const {DEFAULT_TENANT_ID}=require(path.join(dist,'db/localTypes'))
const root=fs.mkdtempSync(path.join(os.tmpdir(),'forsage-order-resources-'));let db
try{
  db=new LocalDatabase(root);const repo=new LocalOrderRepository(db),statuses=['ordered','in_progress','arrived','called','no_answer','ready']
  const insert=db.prepare('INSERT INTO customer_orders(id,tenant_id,status,created_at,updated_at) VALUES(?,?,?,?,?)')
  const line=db.prepare('INSERT INTO customer_order_items(id,tenant_id,order_id,name,qty,sell_price,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
  db.transaction(()=>{for(let i=0;i<10_000;i++){const id='fixture-'+i;insert.run(id,DEFAULT_TENANT_ID,i<100?'ready':'completed','2026-01-01','2026-01-01');for(let j=0;j<4;j++)line.run(id+'-'+j,DEFAULT_TENANT_ID,id,'Synthetic product',1,100,'2026-01-01','2026-01-01')}})
  const oldStart=performance.now();let count=0,pages=0
  for(let offset=0;;offset+=500){const rows=repo.listOrders({offset,limit:500});pages++;count+=rows.filter(row=>statuses.includes(row.status)).length;if(rows.length<500)break}
  const scanMs=performance.now()-oldStart;assert.equal(count,100)
  const durations=[];for(let i=0;i<1000;i++){const start=performance.now();assert.equal(repo.countOrders({statuses}),100);durations.push(performance.now()-start)}
  durations.sort((a,b)=>a-b);assert(durations[950]<100,'Scalar count too slow on synthetic 10k history')
  console.log(JSON.stringify({success:true,packaged:process.argv.includes('--packaged'),orders:10000,lines:40000,oldScanPages:pages,oldScanMs:Math.round(scanMs),countRequests:1000,countP95Ms:Number(durations[950].toFixed(2)),countMaxMs:Number(durations[999].toFixed(2)),correctCount:100}))
}finally{db?.close();if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('forsage-order-resources-'))fs.rmSync(root,{recursive:true,force:true})}
