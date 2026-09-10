// Never runs migrations/index writes against the working database.
const { DatabaseSync,backup }=require('node:sqlite')
const { mkdtempSync,mkdirSync,rmSync }=require('node:fs')
const { tmpdir }=require('node:os')
const path=require('node:path')
const { LocalDatabase }=require('../dist/db/localDatabase.js')
const { LocalCatalogRepository }=require('../dist/repositories/catalogRepository.js')
async function main(){
  const sourcePath=process.argv[2]
  if(!sourcePath||!path.isAbsolute(sourcePath))throw Error('Pass an absolute database path; only an isolated copy is modified.')
  const root=mkdtempSync(path.join(tmpdir(),'forsage-session-benchmark-'))
  let db
  try{
    mkdirSync(path.join(root,'data'))
    const source=new DatabaseSync(sourcePath,{readOnly:true,timeout:2000})
    try{await backup(source,path.join(root,'data','forsage.db'))}finally{source.close()}
    db=new LocalDatabase(root)
    const catalog=new LocalCatalogRepository(db)
    const queries=['ремень','ремінь','фільтр','фильтр','масло','booster','2003093555486']
    // Warm up compiled code/search indexes before measuring retained heap.
    queries.forEach(query=>catalog.listProducts({query,limit:50}))
    global.gc?.()
    const initialHeap=process.memoryUsage().heapUsed
    const times=[]
    const start=performance.now()
    for(let cycle=0;cycle<40;cycle++){
      for(const query of queries){
        const t=performance.now()
        const page=catalog.listProducts({query,limit:50,offset:0})
        if(new Set(page.data.map(p=>p.id)).size!==page.data.length)throw Error('Duplicate products')
        times.push(performance.now()-t)
        if(page.total>50)catalog.listProducts({query,limit:50,offset:50})
      }
      await new Promise(resolve=>setImmediate(resolve))
    }
    global.gc?.()
    times.sort((a,b)=>a-b)
    console.log(JSON.stringify({requests:times.length,totalSeconds:+((performance.now()-start)/1000).toFixed(2),
      medianMs:+times[Math.floor(times.length*.5)].toFixed(2),p95Ms:+times[Math.floor(times.length*.95)].toFixed(2),
      maxMs:+times.at(-1).toFixed(2),retainedHeapDeltaMiB:+((process.memoryUsage().heapUsed-initialHeap)/1024/1024).toFixed(2),
      gcAvailable:!!global.gc,scope:'repository only; not a physical full-shift UI test'}))
  }finally{
    db?.close()
    if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-session-benchmark-'))rmSync(root,{recursive:true,force:true})
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
