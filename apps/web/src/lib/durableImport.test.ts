import {expect,it} from 'vitest'
import {durableImport} from './durableImport'
it('replays original matching after a lost response and changed preview',async()=>{
 const values=new Map<string,string>();const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)} as Storage
 let firstId='';const first={items:[{product_id:null,qty:2}]};await expect(durableImport('u','same-file',first,async(id)=>{firstId=id;throw Error('reply lost')},storage)).rejects.toThrow()
 await durableImport('u','same-file',{items:[{product_id:'created',qty:2}]},async(id,body)=>{expect(id).toBe(firstId);expect(body).toEqual(first)},storage)
 expect(values.size).toBe(0)
})

it('keeps operation identity when clearing the journal fails',async()=>{
 const values=new Map<string,string>();let fail=true;const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>{if(fail)throw Error('storage busy');values.delete(k)}} as Storage
 let original='';await expect(durableImport('cleanup','file',{qty:2},async id=>{original=id;return 1},storage)).rejects.toThrow('storage busy')
 fail=false;await durableImport('cleanup','file',{qty:3},async(id,body)=>{expect(id).toBe(original);expect(body).toEqual({qty:2})},storage)
 expect(values.size).toBe(0)
})
