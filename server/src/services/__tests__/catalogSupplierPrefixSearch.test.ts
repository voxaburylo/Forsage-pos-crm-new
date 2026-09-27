import {readFileSync} from 'node:fs'
import {it,expect,vi} from 'vitest'
vi.mock('../../db/supabase.js',()=>({db:{}}))
const {query}=vi.hoisted(()=>({query:vi.fn().mockResolvedValue({rows:[{total:0,data:[]}]})}))
vi.mock('../../db/pg.js',()=>({pool:{query}}))
import {productListSearchTerms,listProducts} from '../productService.js'
import {buildProductSearchTerms} from '../searchService.js'
import {normalizeCatalogSearchQuery} from '../../lib/catalogSearchQuery.js'
it.each([['BO 1457434310','1457434310'],['WX WA9428','WA9428'],['HBJ J1325037','J1325037']])('never uses the detached prefix as an OR match: %s',async(tagged,bare)=>{
 expect(productListSearchTerms(tagged)).toEqual(productListSearchTerms(bare))
 expect(buildProductSearchTerms(tagged)).toEqual(buildProductSearchTerms(bare))
 const terms=productListSearchTerms(tagged);for(const t of terms)expect(t.replace(/[^0-9]/g,'')).toBe(bare.replace(/[^0-9]/g,''))
 await listProducts({search:tagged,page:1,per_page:10,sort_dir:'asc'},'tenant')
 const call=query.mock.calls.at(-1)![0];expect(call.values.flat()).not.toContain('%WX%');expect(call.values.flat()).not.toContain('%HBJ%');expect(call.values.flat()).not.toContain('%BO%')
 expect(call.values).toContain(bare)
})
it('keeps both runtime parsers identical and preserves meaningful article prefixes',()=>{
 expect(readFileSync(new URL('../../lib/catalogSearchQuery.ts',import.meta.url),'utf8').replace(/\r/g,'')).toBe(readFileSync(new URL('../../../../apps/desktop/src/lib/catalogSearchQuery.ts',import.meta.url),'utf8').replace(/\r/g,''))
 expect(normalizeCatalogSearchQuery('W 67/1')).toBe('W 67/1')
 expect(buildProductSearchTerms('WA9428').some(x=>/[а-я]/i.test(x))).toBe(false)
 expect(productListSearchTerms('W 67/1')).not.toContain('67')
})
