import { describe,expect,it } from 'vitest'
import { catalogReviewIssues, type ReviewedProduct } from './catalogReviewValidation'
const batch:ReviewedProduct[]=[{id:'a',name:'Фильтр W67/1',sku:'AUTO-A',brand:'',category_id:null,fingerprint:'f-a'},{id:'b',name:'Олива 4 л',sku:'B',brand:'',category_id:'cat',fingerprint:'f-b'}]
const proposals=()=>batch.map(({id,name,sku,category_id})=>({id,name,sku,category_id,reason:'Перевірено'}))
describe('catalog review response contract',()=>{
  it('accepts unchanged rows and only proposes approved fields',()=>{
    expect(catalogReviewIssues(proposals(),batch,[{id:'cat'}])).toEqual([])
    const data=proposals();data[0].name='Фільтр W67/1'
    expect(catalogReviewIssues(data,batch,[{id:'cat'}])).toMatchObject([{product_id:'a',fingerprint:'f-a',changes:{name:'Фільтр W67/1'}}])
  })
  it.each([null,[],{},[proposals()[0]]])('rejects an incomplete result %j without marking the batch',raw=>{
    expect(()=>catalogReviewIssues(raw,batch,[{id:'cat'}])).toThrow('неповну')
  })
  it('rejects repeated and unknown product identifiers',()=>{
    expect(()=>catalogReviewIssues([proposals()[0],proposals()[0]],batch,[])).toThrow('повторний')
    const data=proposals();data[1].id='other'
    expect(()=>catalogReviewIssues(data,batch,[])).toThrow('Невідомий')
  })
  it('rejects malformed fields and unrequested writes',()=>{
    for(const patch of [{name:{}},{sku:12},{category_id:undefined},{reason:null},{qty_on_hand:9},{name:' '}]) {
      const data=proposals();Object.assign(data[1],patch)
      expect(()=>catalogReviewIssues(data,batch,[{id:'cat'}])).toThrow()
    }
  })
  it('blocks unknown categories and allows unchanged legacy categories',()=>{
    const data=proposals();data[0].category_id='bad'
    expect(()=>catalogReviewIssues(data,batch,[{id:'cat'}])).toThrow('невідому')
    expect(catalogReviewIssues(proposals(),batch,[])).toEqual([])
  })
})
