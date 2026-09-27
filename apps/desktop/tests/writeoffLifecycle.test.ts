import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalWarehouseRepository } from '../src/repositories/warehouseRepository'

describe('writeoff atomic lifecycle', () => {
  let root:string,db:LocalDatabase,warehouse:LocalWarehouseRepository
  beforeEach(()=>{
    root=mkdtempSync(path.join(tmpdir(),'forsage-writeoff-lifecycle-'))
    db=new LocalDatabase(root);warehouse=new LocalWarehouseRepository(db)
    new LocalCatalogRepository(db).upsertProduct({id:'p',name:'Олива',sku:'OIL',qty_on_hand:10,purchase_price:123,unit:'л'})
  })
  afterEach(()=>{vi.restoreAllMocks();db.close();if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-writeoff-lifecycle-'))rmSync(root,{recursive:true,force:true})})
  const input=()=>({operation_id:'op',user_id:'cashier',reason:'damage',items:[{product_id:'p',qty:1.5}]})
  const stock=()=>db.prepare('SELECT qty_on_hand n FROM products WHERE id=?').get('p')
  it('replays after reopen and offers a read-only result lookup scoped to the cashier',()=>{
    const result=warehouse.createWriteoff(input())
    expect(stock()).toEqual({n:8.5})
    db.close();db=new LocalDatabase(root);warehouse=new LocalWarehouseRepository(db)
    expect(warehouse.createWriteoff(input()).id).toBe(result.id)
    expect(warehouse.getWriteoffByOperation('op','cashier').id).toBe(result.id)
    expect(warehouse.getWriteoffByOperation('absent','cashier')).toBeNull()
    expect(()=>warehouse.getWriteoffByOperation('op','other')).toThrow('іншому')
    expect(stock()).toEqual({n:8.5})
    expect(db.prepare('SELECT count(*) n FROM writeoffs').get()).toEqual({n:1})
  })
  it('locks before reading stock even without an operation id',()=>{
    const other=new DatabaseSync(db.databasePath,{timeout:0})
    const prepare=db.prepare.bind(db)
    let checked=false
    vi.spyOn(db,'prepare').mockImplementation(sql=>{
      if(!checked&&sql.includes('SELECT id, name, sku, barcode, unit')){
        checked=true
        expect(()=>other.prepare('UPDATE products SET qty_on_hand=1 WHERE id=?').run('p')).toThrow(/locked|busy/i)
      }
      return prepare(sql)
    })
    try {warehouse.createWriteoff({...input(),operation_id:undefined});expect(checked).toBe(true);expect(stock()).toEqual({n:8.5})}
    finally {other.close()}
  })
  it('rolls back all rows, movements and the operation receipt if the outbox fails',()=>{
    db.exec("CREATE TRIGGER fail_writeoff BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='writeoff.created' BEGIN SELECT RAISE(ABORT,'injected failure'); END")
    expect(()=>warehouse.createWriteoff(input())).toThrow('injected failure')
    expect(stock()).toEqual({n:10});expect(warehouse.getWriteoffByOperation('op','cashier')).toBeNull()
    expect(db.prepare('SELECT count(*) n FROM writeoffs').get()).toEqual({n:0})
    expect(db.prepare("SELECT count(*) n FROM inventory_movements WHERE source_type='writeoff'").get()).toEqual({n:0})
  })
  it.each([0,-1,NaN,Infinity,0.0001,'2',null])('rejects invalid quantity %s without writes',qty=>{
    expect(()=>warehouse.createWriteoff({...input(),items:[{product_id:'p',qty:qty as number}]})).toThrow(/кількість/i)
    expect(stock()).toEqual({n:10})
  })
  it('rejects duplicate rows and excessive stock without a partial document',()=>{
    expect(()=>warehouse.createWriteoff({...input(),items:[{product_id:'p',qty:2},{product_id:'p',qty:2}]})).toThrow('кілька разів')
    expect(()=>warehouse.createWriteoff({...input(),items:[{product_id:'p',qty:11}]})).toThrow('Недостатньо')
    expect(stock()).toEqual({n:10});expect(db.prepare('SELECT count(*) n FROM writeoffs').get()).toEqual({n:0})
  })
  it('rejects services and invalid reasons',()=>{
    expect(()=>warehouse.createWriteoff({...input(),reason:'anything'})).toThrow('причину')
    db.prepare('UPDATE products SET is_service=1 WHERE id=?').run('p')
    expect(()=>warehouse.createWriteoff(input())).toThrow('Послугу')
  })
  it('protects aggregate costs and retains correct thousandths',()=>{
    db.prepare('UPDATE products SET purchase_price=2000000000 WHERE id=?').run('p')
    expect(()=>warehouse.createWriteoff(input())).toThrow('Сума списання')
    db.prepare('UPDATE products SET purchase_price=123,qty_on_hand=0.3 WHERE id=?').run('p')
    warehouse.createWriteoff({...input(),items:[{product_id:'p',qty:0.1}]})
    expect(stock()).toEqual({n:0.2})
  })
})
