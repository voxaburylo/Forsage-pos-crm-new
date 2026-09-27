import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
describe('reference edits survive failed queue writes without partial changes',()=>{
  let root:string,db:LocalDatabase,catalog:LocalCatalogRepository,supply:LocalSupplyRepository
  beforeEach(()=>{root=mkdtempSync(path.join(tmpdir(),'forsage-reference-life-'));db=new LocalDatabase(root);catalog=new LocalCatalogRepository(db);supply=new LocalSupplyRepository(db)})
  afterEach(()=>{db.close();if(path.dirname(root)===tmpdir()&&path.basename(root).startsWith('forsage-reference-life-'))rmSync(root,{recursive:true,force:true})})
  const fail=()=>db.prepare("CREATE TEMP TRIGGER no_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT,'simulated full disk'); END").run()
  it('rolls back creation of supplier, category and brand',()=>{
    fail()
    expect(()=>supply.saveSupplier({name:'Постачальник'})).toThrow('simulated')
    expect(()=>catalog.createCategory('Категорія')).toThrow('simulated')
    expect(()=>catalog.createBrand('Марка')).toThrow('simulated')
    for(const table of ['suppliers','categories','brands'])expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toMatchObject({n:0})
  })
  it('rolls back edits and supplier archive',()=>{
    const s=supply.saveSupplier({name:'Постачальник'}),c=catalog.createCategory('Категорія'),b=catalog.createBrand('Марка')
    fail()
    expect(()=>supply.saveSupplier({name:'Змінено'},s.id)).toThrow('simulated')
    expect(()=>supply.deleteSupplier(s.id)).toThrow('simulated')
    expect(()=>catalog.updateCategory(c.id,'Змінено')).toThrow('simulated')
    expect(()=>catalog.updateBrand(b.id,{name:'Змінено'})).toThrow('simulated')
    expect(supply.getSupplier(s.id).name).toBe('Постачальник')
    expect(db.prepare('SELECT name FROM categories WHERE id=?').get(c.id)).toMatchObject({name:'Категорія'})
    expect(db.prepare('SELECT name FROM brands WHERE id=?').get(b.id)).toMatchObject({name:'Марка'})
  })
  it('recreating an archived brand restores its identity instead of failing UNIQUE',()=>{
    const brand=catalog.createBrand('WIX','US')
    catalog.deleteBrand(brand.id)
    const restored=catalog.createBrand('wix')
    expect(restored).toMatchObject({id:brand.id,country:'US'})
    expect(db.prepare('SELECT deleted_at FROM brands WHERE id=?').get(brand.id)).toMatchObject({deleted_at:null})
    expect(()=>catalog.createBrand('WIX')).toThrow('вже існує')
  })
  it('does not leave a brand restored if its outgoing event cannot be saved',()=>{
    const brand=catalog.createBrand('WIX');catalog.deleteBrand(brand.id);fail()
    expect(()=>catalog.createBrand('WIX')).toThrow('simulated')
    expect((db.prepare('SELECT deleted_at FROM brands WHERE id=?').get(brand.id) as any).deleted_at).toBeTruthy()
  })
  it('rejects duplicate category names on edit regardless of Cyrillic case',()=>{
    catalog.createCategory('Фільтри');const other=catalog.createCategory('Масла')
    expect(()=>catalog.updateCategory(other.id,'ФІЛЬТРИ')).toThrow('вже існує')
  })
})
