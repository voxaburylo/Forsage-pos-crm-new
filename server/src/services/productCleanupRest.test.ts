import { beforeEach, describe, expect, it, vi } from 'vitest'
const state=vi.hoisted(()=>({rows:[] as any[],writes:[] as any[],race:null as null|(()=>void)}))
vi.mock('../db/supabase.js',()=>({db:{from:(table:string)=>{
  let mode='read',payload:any
  const filters:Array<(row:any)=>boolean>=[]
  const field=(r:any,k:string)=>k==='specs->>merged_into_product_id'?r.specs?.merged_into_product_id:r[k]
  const run=(single:boolean)=>{
    const matches=table==='products'?state.rows.filter(r=>filters.every(f=>f(r))):[]
    if(mode==='insert') {const created={id:'new',...payload};state.rows.push(created);state.writes.push(created);return {data:created,error:null}}
    if(mode==='update') {
      for(const row of matches){Object.assign(row,payload);state.writes.push({...payload})}
      return {data:single?structuredClone(matches[0]??null):structuredClone(matches),error:single&&!matches.length?{code:'PGRST116',message:'No rows'}:null}
    }
    return {data:single?structuredClone(matches[0]??null):structuredClone(matches),error:null}
  }
  const chain:any={
    select:()=>chain,eq:(k:string,v:unknown)=>{filters.push(r=>field(r,k)===v);return chain},
    is:(k:string,v:unknown)=>{filters.push(r=>v===null?field(r,k)==null:field(r,k)===v);return chain},
    neq:(k:string,v:unknown)=>{filters.push(r=>field(r,k)!==v);return chain},in:()=>chain,
    update:(value:any)=>{mode='update';payload=value;const race=state.race;state.race=null;race?.();return chain},
    insert:(value:any)=>{mode='insert';payload=value;return chain},
    single:async()=>run(true),maybeSingle:async()=>run(true),then:(resolve:any,reject:any)=>Promise.resolve(run(false)).then(resolve,reject),
  }
  return chain
}}}))
vi.mock('./auditService.js',()=>({logAction:vi.fn()}))
import { createProduct, updateProduct } from './productService.js'
const stamp='2026-10-13T10:00:00Z'
const markers={cleanup_sources:[{id:'source'}],cleanup_stock_review:{status:'checked'},cleanup_mirror_receipts:{op:{payload_hash:'hash'}},
  cleanup_mirrored_at:stamp,cleanup_barcodes:['OLD'],merge_operation_id:'prior'}
const row=(specs:any={})=>({id:'product',tenant_id:'shop',sku:'SKU1',name:'Product',specs,updated_at:stamp,deleted_at:null,qty_on_hand:1,purchase_price:100,retail_price:200})
const createInput=(specs:any={})=>({sku:'SKU1',name:'Replacement',purchase_price:100,retail_price:200,specs} as any)
beforeEach(()=>{state.rows=[];state.writes=[];state.race=null})
describe('REST catalog cleanup boundaries',()=>{
  it('never restores a merged source through create with the same SKU',async()=>{
    state.rows=[{...row({merged_into_product_id:'target',merge_operation_id:'op'}),deleted_at:stamp,is_active:false}]
    await expect(createProduct(createInput(),'owner','shop')).rejects.toMatchObject({code:'PRODUCT_MERGED'})
    expect(state.writes).toEqual([])
    expect(state.rows[0].deleted_at).toBe(stamp)
  })
  it('retains every stored cleanup marker while replacing ordinary specs',async()=>{
    state.rows=[row({...markers,colour:'red'})]
    await updateProduct('product',{specs:{colour:'blue',cleanup_barcodes:'forged'}} as any,'owner','shop')
    expect(state.rows[0].specs).toEqual({...markers,colour:'blue'})
  })
  it('does not allow reserved cleanup metadata to be injected into a new or ordinary card',async()=>{
    await createProduct(createInput({colour:'red',merged_into_product_id:'forged',cleanup_sources:'forged'}),'owner','shop')
    expect(state.rows[0].specs).toEqual({colour:'red'})
    state.rows=[row()]
    await updateProduct('product',{specs:{colour:'blue',cleanup_mirror_receipts:'forged'}} as any,'owner','shop')
    expect(state.rows[0].specs).toEqual({colour:'blue'})
  })
  it('allows the existing ordinary restore flow but preserves stored provenance of an archived target',async()=>{
    state.rows=[{...row(markers),deleted_at:stamp}]
    await createProduct(createInput({colour:'blue'}),'owner','shop')
    expect(state.rows[0]).toMatchObject({deleted_at:null,specs:{...markers,colour:'blue'}})
  })
  it('does not overwrite a merge completed between the REST read and specs update',async()=>{
    state.rows=[row()]
    state.race=()=>{state.rows[0].specs={...markers};state.rows[0].updated_at='2026-10-13T11:00:00Z'}
    await expect(updateProduct('product',{specs:{colour:'blue'}},'owner','shop')).rejects.toMatchObject({code:'PRODUCT_CHANGED'})
    expect(state.writes).toEqual([]);expect(state.rows[0].specs).toEqual(markers)
  })
  it('does not resurrect a source merged after the duplicate lookup',async()=>{
    state.rows=[{...row(),deleted_at:stamp}]
    state.race=()=>{state.rows[0].specs={merged_into_product_id:'target'};state.rows[0].updated_at='2026-10-13T11:00:00Z'}
    await expect(createProduct(createInput(),'owner','shop')).rejects.toMatchObject({code:'PRODUCT_CHANGED'})
    expect(state.writes).toEqual([]);expect(state.rows[0].deleted_at).toBe(stamp)
  })
  it('preserves tenant scope and an omitted specs field on ordinary edits',async()=>{
    state.rows=[row(markers),{...row(),id:'foreign',tenant_id:'other'}]
    await updateProduct('product',{name:'Renamed'},'owner','shop')
    expect(state.rows[0].specs).toEqual(markers);expect(state.rows[1].name).toBe('Product')
    expect(state.writes[0]).not.toHaveProperty('specs')
  })
})
