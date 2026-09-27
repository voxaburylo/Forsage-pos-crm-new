import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createAiToolBudget, parseAiReadArguments } from './aiToolSafety.js'
describe('AI tool request bounds', () => {
  it('preserves exact article/barcode strings and applies documented defaults', () => {
    expect(parseAiReadArguments('search_products',{query:'  0012345  '})).toEqual({query:'0012345',limit:8})
    expect(parseAiReadArguments('list_products_page',{})).toEqual({page:1,per_page:200,filter:'all'})
    expect(parseAiReadArguments('find_duplicate_products',{})).toEqual({by:'name',limit:20})
  })
  it.each(['', '  ', {}, [], 1457434310, 'x'.repeat(201)])('rejects invalid query %s', query => {
    for(const name of ['search_products','search_customers']) expect(()=>parseAiReadArguments(name,{query})).toThrow('Некоректні')
  })
  it.each([0,-1,1.5,Infinity,NaN,'2',{},[],null,10001])('rejects malformed page %s', page => {
    expect(()=>parseAiReadArguments('list_products_page',{page})).toThrow()
  })
  it.each(['search_products','search_customers','list_categories','list_brands','list_products_page','find_duplicate_products'])('rejects model-supplied tenant override for %s', name => {
    expect(()=>parseAiReadArguments(name,{query:'filter',tenant_id:'other'})).toThrow()
  })
  it('rejects invalid enums, IDs, limits and unknown tool names', () => {
    for(const [name,args] of [
      ['get_product',{product_id:'*'}], ['list_products_page',{filter:'everything'}],
      ['search_products',{query:'filter',limit:16}], ['search_customers',{query:'John',limit:21}],
      ['list_products_page',{per_page:201}], ['find_duplicate_products',{limit:41}],
      ['find_duplicate_products',{by:'password'}], ['__proto__',{}], ['run_sql',{}],
    ] as const) expect(()=>parseAiReadArguments(name,args)).toThrow()
  })
  it('accepts valid product IDs without accepting extra fields', () => {
    const product_id='00000000-0000-4000-8000-000000000001'
    expect(parseAiReadArguments('get_product',{product_id})).toEqual({product_id})
    expect(()=>parseAiReadArguments('get_product',{product_id,tenant_id:'other'})).toThrow()
  })
  it('bounds total calls across all rounds before executing a batch', () => {
    const reserve=createAiToolBudget()
    reserve(20); reserve(19)
    expect(()=>reserve(2)).toThrow('Забагато')
    reserve(1)
    expect(()=>reserve(1)).toThrow()
    expect(()=>createAiToolBudget()(40)).not.toThrow()
  })
  it('guards integration before tool dispatch and read execution', () => {
    const source=readFileSync(new URL('./aiService.ts',import.meta.url),'utf8')
    expect(source).toContain('args = parseAiReadArguments(name, args)')
    expect(source.indexOf('reserveToolCalls(calls.length)')).toBeLessThan(source.indexOf('for (const call of calls)'))
  })
})
