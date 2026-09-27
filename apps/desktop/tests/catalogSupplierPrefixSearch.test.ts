import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {beforeEach,afterEach,it,expect} from 'vitest'
import {LocalDatabase} from '../src/db/localDatabase'
import {LocalCatalogRepository} from '../src/repositories/catalogRepository'
import {normalizeCatalogSearchQuery,articleSearchTerms} from '../src/lib/catalogSearchQuery'
let root:string,db:LocalDatabase,catalog:LocalCatalogRepository
beforeEach(()=>{root=mkdtempSync(path.join(tmpdir(),'forsage-prefix-search-'));db=new LocalDatabase(root);catalog=new LocalCatalogRepository(db)
 for(const p of [
  {id:'bo',sku:'1457434310',name:'Фільтр паливний',qty_on_hand:1},
  {id:'wx-name',sku:'AUTO-1',name:'Фільтр WIX WA9428',qty_on_hand:2},
  {id:'wx-sku',sku:'WA9428',name:'Фільтр повітряний',qty_on_hand:0},
  {id:'wx-spaced',sku:'AUTO-2',name:'Фільтр WA 9428',qty_on_hand:0},
  {id:'hbj',sku:'J1325037',name:'Фільтр паливний',qty_on_hand:3},
  {id:'decoy-wx',sku:'WX WA9429',name:'Фільтр WIX WA9429',qty_on_hand:100},
  {id:'decoy-bo',sku:'BO 1234567890',name:'BO ремінь',qty_on_hand:100},
  {id:'decoy-hbj',sku:'HBJ J1325038',name:'Фільтр',qty_on_hand:100},
  {id:'different-prefix',sku:'WL9428',name:'Масляний фільтр',qty_on_hand:100},
  {id:'mann',sku:'W67/1',name:'Фільтр MANN',qty_on_hand:1},
 ])catalog.saveProduct({...p,unit:'шт'})
})
afterEach(()=>{db.close();if(path.dirname(path.resolve(root))===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-prefix-search-'))rmSync(root,{recursive:true,force:true})})
it.each([['BO 1457434310','1457434310',['bo']],['WX WA9428','WA9428',['wx-name','wx-sku','wx-spaced']],['HBJ J1325037','J1325037',['hbj']]])('finds the whole article with or without %s', (tagged,bare,expected)=>{
 const a=catalog.listProducts({query:tagged as string,limit:2}), b=catalog.listProducts({query:bare as string,limit:2})
 expect(a).toEqual(b);expect(a.total).toBe(expected.length)
 const all=[...a.data,...catalog.listProducts({query:tagged as string,limit:2,offset:2}).data]
 expect(all.map(p=>p.id).sort()).toEqual([...expected].sort())
 expect(catalog.searchProducts(tagged as string,undefined,10).map(p=>p.id).sort()).toEqual([...expected].sort())
})
it('preserves the manufacturer prefix, exact digits and stock-first sorting',()=>{
 expect(catalog.listProducts({query:'wx wa9428'}).data[0].id).toBe('wx-name')
 expect(catalog.listProducts({query:'WX WA9999'}).total).toBe(0)
 expect(catalog.listProducts({query:'HBJ J1325039'}).total).toBe(0)
 expect(catalog.listProducts({query:'W 67/1'}).data.map(p=>p.id)).toEqual(['mann'])
 expect(normalizeCatalogSearchQuery('WX')).toBe('WX')
 expect(normalizeCatalogSearchQuery('BO1457434310')).toBe('BO1457434310')
 expect(normalizeCatalogSearchQuery('BO мастило 5W40')).toBe('BO мастило 5W40')
 expect(normalizeCatalogSearchQuery('ABC J1325037')).toBe('ABC J1325037')
 expect(articleSearchTerms('WX WA9428')).not.toContain('WX')
 expect(articleSearchTerms('WX WA9428')).not.toContain('9428')
})
