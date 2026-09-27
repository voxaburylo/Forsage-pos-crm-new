import {it,expect} from 'vitest'
import {offlineProductMatchesQuery} from './offlineDB'
it.each([
 ['BO 1457434310',{sku:'1457434310',name:'Фільтр'}],
 ['WX WA9428',{sku:'AUTO-1',name:'Фільтр WIX WA9428'}],
 ['WX WA9428',{sku:'AUTO-1',name:'Фільтр WA 9428'}],
 ['HBJ J1325037',{sku:'J1325037',name:'Фільтр'}],
 ['wx\tWA9428',{sku:'WA9428',name:'Фільтр'}],
])('cache finds the full article for %s',(query,product)=>expect(offlineProductMatchesQuery(product,query)).toBe(true))
it('does not accept only the tag, or a different manufacturer article',()=>{
 for(const sku of ['WX WA9429','WX WF8123','WL9428','BO 12345','HBJ J1325038'])expect(offlineProductMatchesQuery({sku,name:'Фільтр'},'WX WA9428')).toBe(false)
 expect(offlineProductMatchesQuery({sku:'HBJ J1325038'},'HBJ J1325037')).toBe(false)
})
