import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { CatalogAgentRepository, agentFingerprint, preservesTechnicalName, skuFromName, gridAgentPrice, catalogCodeFromName } from '../src/repositories/catalogAgentRepository'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
let db: LocalDatabase, catalog: LocalCatalogRepository, agent: CatalogAgentRepository, root: string
const product = (name='Фильтр W811/80', sku='AUTO-TEST', qty=0) => catalog.saveProduct({id:randomUUID(),name,sku,unit:'шт',qty_on_hand:qty,purchase_price:10000,retail_price:11000})
const patch = (p:any, changes:any) => ({product_id:p.id,fingerprint:agentFingerprint(p),changes})
beforeEach(()=>{root=mkdtempSync(path.join(tmpdir(),'forsage-agent-test-')); db=new LocalDatabase(root);catalog=new LocalCatalogRepository(db);agent=new CatalogAgentRepository(db)})
afterEach(()=>{db.close();if(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(root).startsWith('forsage-agent-test-'))rmSync(root,{recursive:true,force:true})})
describe('catalog agent safety',()=>{
  it('scans without changing stock, documents or products and flags missing category/low markup',()=>{
    const p=product('Фильтр W811/80','AUTO-X',3)
    const before=db.prepare('SELECT * FROM products').all()
    const movements=db.prepare('SELECT count(*) n FROM inventory_movements').get()
    const result=agent.scan({min_markup:15})
    expect(result.issues.find(x=>x.kind==='sku').changes).toEqual({sku:'W811/80'})
    expect(result.issues.some(x=>x.kind==='price')).toBe(true)
    expect(result.issues.some(x=>x.kind==='category')).toBe(true)
    expect(db.prepare('SELECT * FROM products').all()).toEqual(before)
    expect(db.prepare('SELECT count(*) n FROM inventory_movements').get()).toEqual(movements)
    expect(result.products[0].id).toBe(p.id)
  })
  it('preserves current stock, metadata and extra barcodes; audit and retries are transactional',()=>{
    const p=product('Фильтр W811/80','AUTO-X',3)
    db.prepare('UPDATE products SET notes=?,specs_json=?,qty_on_hand=2 WHERE id=?').run('Keep note','{"a":"b"}',p.id)
    const input={operation_id:randomUUID(),items:[patch(p,{name:'Фільтр W811/80',sku:'W811/80'})]}
    expect(agent.apply(input,'owner').updated).toBe(1)
    expect(agent.apply(input,'owner').updated).toBe(1)
    const saved=db.prepare('SELECT * FROM products WHERE id=?').get(p.id) as any
    expect(saved).toMatchObject({qty_on_hand:2,name:'Фільтр W811/80',sku:'W811/80',notes:'Keep note',specs_json:'{"a":"b"}'})
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='catalog_agent.update'").get()).toEqual({n:1})
  })
  it('rejects stock writes, guessed SKU, changed numbers and stale prices; rolls back the whole batch',()=>{
    const a=product(),b=product('Фильтр W67/1','AUTO-B')
    const run=(changes:any)=>agent.apply({operation_id:randomUUID(),items:[patch(a,changes)]},'owner')
    expect(()=>run({qty_on_hand:9})).toThrow('заборонено')
    expect(()=>run({sku:'MADEUP123'})).toThrow('лише з назви')
    expect(()=>run({name:'Фільтр W67/1'})).toThrow('технічні')
    expect(()=>run({retail_price:99999})).toThrow('таблиці')
    expect(()=>run({retail_price:null})).toThrow('таблиці')
    db.prepare('UPDATE products SET retail_price=12000 WHERE id=?').run(b.id)
    expect(()=>agent.apply({operation_id:randomUUID(),items:[patch(a,{name:'Фільтр W811/80'}),patch(b,{name:'Фільтр W67/1'})]},'owner')).toThrow('вже змінено')
    expect(catalog.findById(a.id)?.name).toBe(a.name)
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action LIKE 'catalog_agent.%'").get()).toEqual({n:0})
  })
  it('refuses SKU collision and maps retail proposals to current grid/rounding',()=>{
    const a=product();product('Інший','w811-80')
    expect(()=>agent.apply({operation_id:randomUUID(),items:[patch(a,{sku:'W811/80'})]},'owner')).toThrow('іншому товару')
    const settings={markup_rules:[{minPrice:0,maxPrice:100000,markupPct:30}],price_rounding_enabled:true,price_rounding_step:100,price_rounding_dir:'up'}
    expect(gridAgentPrice(10001,settings)).toBe(13100)
    expect(gridAgentPrice(10001,{...settings,price_rounding_enabled:false,price_rounding_dir:'nearest'})).toBe(13000)
    expect(gridAgentPrice(100,{})).toBeNull()
  })
  it('archives only a confirmed empty duplicate with no history and never merges stock',()=>{
    const primary=product('Однаковий товар','AUTO-P'), duplicate=product('Однаковий товар','AUTO-D')
    const input={operation_id:randomUUID(),items:[{...patch(duplicate,{}),primary_id:primary.id,primary_fingerprint:agentFingerprint(primary)}]}
    expect(agent.apply(input,'owner').updated).toBe(1)
    expect(catalog.findById(primary.id)).not.toBeNull()
    const gone=db.prepare('SELECT deleted_at,qty_on_hand FROM products WHERE id=?').get(duplicate.id) as any
    expect(gone.deleted_at).toBeTruthy();expect(gone.qty_on_hand).toBe(0)
    expect(db.prepare("SELECT count(*) n FROM inventory_movements WHERE product_id=?").get(duplicate.id)).toEqual({n:0})
  })
  it('protects unique metadata on empty duplicate cards',()=>{
    const primary=product('Same','AUTO-P'),duplicate=product('Same','AUTO-D')
    db.prepare('UPDATE products SET notes=? WHERE id=?').run('Important',duplicate.id)
    expect(()=>agent.apply({operation_id:randomUUID(),items:[{...patch(duplicate,{}),primary_id:primary.id,primary_fingerprint:agentFingerprint(primary)}]},'owner')).toThrow('окремі дані')
  })
  it('blocks duplicate with stock or any document and also rechecks after scan',()=>{
    const primary=product('Same','AUTO-P'), duplicate=product('Same','AUTO-D')
    const make=()=>({operation_id:randomUUID(),items:[{...patch(duplicate,{}),primary_id:primary.id,primary_fingerprint:agentFingerprint(primary)}]})
    db.prepare('UPDATE products SET qty_on_hand=1 WHERE id=?').run(duplicate.id)
    expect(()=>agent.apply(make(),'owner')).toThrow('залишок')
    db.prepare('UPDATE products SET qty_on_hand=0 WHERE id=?').run(duplicate.id)
    db.prepare('CREATE TABLE future_document (product_id TEXT)').run()
    db.prepare('INSERT INTO future_document VALUES (?)').run(duplicate.id)
    expect(()=>agent.apply(make(),'owner')).toThrow('документи')
  })
  it.each([
    ['Масло 4 л','Олива 4 м'], ['Смазка 500 мл','Мастило 500 л'],
    ['Ключ 1.5 мм','Ключ 1/5 мм'], ['Кабель 12 В','Кабель 12 Вт'],
  ])('blocks changed units and decimal meaning: %s', (before,after)=>{
    expect(preservesTechnicalName(before,after)).toBe(false)
    const p=product(before)
    expect(()=>agent.apply({operation_id:randomUUID(),items:[patch(p,{name:after})]},'owner')).toThrow('технічні')
    expect(catalog.findById(p.id)?.name).toBe(before)
  })
  it('allows a decimal comma to become a decimal point without changing units',()=>{
    expect(preservesTechnicalName('Ключ 1,5 мм','Ключ 1.5 мм')).toBe(true)
  })
  it('keeps variants separate and limits channels to owner/admin',()=>{
    expect(preservesTechnicalName('Рулетка 7.5м Greener','Рулетка 5м Greener')).toBe(false)
    expect(preservesTechnicalName('Фильтр W811/80','Фільтр W811/80')).toBe(true)
    expect(skuFromName('Масло 10W40 4L')).toBeNull()
    for(const [name,sku] of [['Масло 10W40','10W40'],['Фільтр W811/80','811'],['Фільтр ABCD1234','1234'],['Свічка ВАЗ2101','ВАЗ2101']])expect(catalogCodeFromName(name,sku)).toBe(false)
    expect(catalogCodeFromName('Фільтр W 67/1','W67/1')).toBe(true)
    expect(catalogCodeFromName('Деталь 0 451 103 292','0451103292')).toBe(true)
    for(const role of ['cashier','manager','storekeeper'])expect(isDesktopChannelAllowed('desktop:catalog:agent-apply',role)).toBe(false)
    expect(isDesktopChannelAllowed('desktop:catalog:agent-apply','owner')).toBe(true)
  })
})
