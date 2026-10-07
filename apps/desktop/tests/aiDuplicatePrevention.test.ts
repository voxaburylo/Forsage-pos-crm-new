import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { AiInvoiceMatcher, rememberInvoiceProductName } from '../src/repositories/aiInvoiceIdentity'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'

describe('real invoice duplicate regressions, read-only matching', () => {
  let root:string,db:LocalDatabase,catalog:LocalCatalogRepository
  beforeEach(()=>{root=mkdtempSync(path.join(tmpdir(),'forsage-ai-duplicate-'));db=new LocalDatabase(root);catalog=new LocalCatalogRepository(db)})
  afterEach(()=>{db.close();if(path.dirname(root)===tmpdir()&&path.basename(root).startsWith('forsage-ai-duplicate-'))rmSync(root,{recursive:true,force:true})})
  const add=(id:string,name:string,sku=id)=>catalog.upsertProduct({id,name,sku,qty_on_hand:1})
  it('never routes electrolyte (12) through an archived BRC gas-filter pack code',()=>{
    add('old','Фильтр газа BRC d38 d33 d18','(12)');db.prepare('UPDATE products SET deleted_at=? WHERE id=?').run('2026-09-01','old')
    add('filter','Фильтр газа BRC d38 d33 d18');add('electrolyte','Электролит AvtoMaster 1L','80457')
    const matcher=new AiInvoiceMatcher(db,tenant),before=db.prepare('SELECT total_changes() n').get()
    expect(matcher.review({name:'Электролит 1л AvtoMaster',sku:'(12)',brand:'AvtoMaster'})).toMatchObject({status:'matched',product_id:'electrolyte'})
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(before)
    expect(matcher.review({name:'Інший новий товар',sku:'(12)'}).candidates.some(c=>c.id==='filter')).toBe(false)
  })
  it('does not match an active short SKU when the full name is different',()=>{
    add('filter','Фильтр газа BRC d38 d33 d18','12')
    expect(new AiInvoiceMatcher(db,tenant).review({name:'Электролит 1л AvtoMaster',sku:'12'}).status).not.toBe('matched')
  })
  it('uses a full six-digit factory number in the oil name, not a generic standard',()=>{
    add('elf','Elf FULLTECH FE 5W30 5л/4,26кг(3)/216689','49747')
    expect(new AiInvoiceMatcher(db,tenant).review({name:'Elf EVOL. FULLTECH FE 5W30 5л/4,26кг(3)216689'})).toMatchObject({status:'matched',product_id:'elf'})
  })
  it.each([
    ['Elf EVOL 900 SXR 5W30 1л 216642','Elf EVOL 900 SXR 5W30 5л 216642'],
    ['Elf EVOL 900 SXR 5W30 1л 216642','Elf EVOL 900 SXR 5W40 1л 216642'],
    ['Наконечник лівий Ланос CTR CE0292L','Наконечник правий Ланос CTR CE0292L'],
    ['Молдинг капота 2170 чорний FLAGMUS','Молдинг капота 2170 хром FLAGMUS'],
    ['Мовіль 1л світлий Норма Авто Bitgum','Мовіль 1л темний Норма Авто Bitgum'],
  ])('does not auto-link incompatible variants: %s', (source,other)=>{
    add('other',other,'COMMON-123')
    const matcher=new AiInvoiceMatcher(db,tenant)
    expect(matcher.review({name:source,sku:'COMMON-123'}).status).toBe('review')
    expect(matcher.review({name:source}).candidates).toHaveLength(0)
  })
  it('remembers an explicitly stored full source name, including different word order',()=>{
    add('ours','Олива Mannol Dexron III Automatic Plus ATF 1L 8206-1')
    db.prepare('INSERT INTO product_aliases(id,tenant_id,product_id,alias,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('alias',tenant,'ours','8206-1 DEXRON III AUTOMATIC PLUS ATF 1L Олива трансмісійна','2026-09-01','2026-09-01')
    expect(new AiInvoiceMatcher(db,tenant).review({name:'8206-1 DEXRON III AUTOMATIC PLUS ATF 1L Олива трансмісійна'})).toMatchObject({status:'matched',product_id:'ours'})
  })
  it('remembers a validated source and never learns an incompatible pack size',()=>{
    add('ours','Олива Mannol Dexron III Automatic Plus ATF 1L 8206-1')
    const raw={name:'Mannol Трансмісійна рідина АКПП Automatic Plus 8206-1 1L',brand:'Mannol'}
    rememberInvoiceProductName(db,tenant,'ours',raw)
    rememberInvoiceProductName(db,tenant,'ours',raw)
    expect(db.prepare('SELECT COUNT(*) n FROM product_aliases').get()).toEqual({n:1})
    expect(new AiInvoiceMatcher(db,tenant).review(raw)).toMatchObject({status:'matched',product_id:'ours'})
    rememberInvoiceProductName(db,tenant,'ours',{...raw,name:raw.name.replace('1L','4L')})
    expect(db.prepare('SELECT COUNT(*) n FROM product_aliases').get()).toEqual({n:1})
  })
  it('does not treat a shared dimension as a factory identity',()=>{
    add('ours','Болт 10x1000 виріб')
    expect(new AiInvoiceMatcher(db,tenant).review({name:'Ремінь 10x1000 інший виріб'}).status).not.toBe('matched')
  })
  it('does not turn a shared specification or a partial part number into an exact match',()=>{
    add('ours','Фільтр W811/800 MANN')
    expect(new AiInvoiceMatcher(db,tenant).review({name:'Фільтр W811/80 MANN'}).status).not.toBe('matched')
  })
})
