import {describe,it,expect} from 'vitest'
import {catalogAgentPayload,selectableAgentIssue,retainAgentReview,type CatalogIssue} from './catalogAgentModel'
const row=(id:string,changes:Record<string,any>):CatalogIssue=>({id,product_id:'p',fingerprint:'f',name:'Фільтр',sku:'AUTO',kind:'ai',reason:'Test',changes})
describe('catalog agent confirmation',()=>{
 it('combines different approved fields for one product',()=>expect(catalogAgentPayload([row('a',{name:'New'}),row('b',{sku:'W811/80'})])).toEqual([{product_id:'p',fingerprint:'f',changes:{name:'New',sku:'W811/80'}}]))
 it('retains only unapplied proposals for unchanged cards after refresh',()=>{
  const kept=retainAgentReview([{id:'p',fingerprint:'f'},{id:'q',fingerprint:'new'}],[row('a',{name:'New'}),{...row('b',{sku:'CODE123'}),product_id:'q'}],{p:'f',q:'f',deleted:'f'})
  expect(kept.issues.map(x=>x.id)).toEqual(['a']);expect(kept.reviewed).toEqual({p:'f'})
 })
 it('rejects conflicting proposals, empty changes and archive mixed with editing',()=>{
  expect(()=>catalogAgentPayload([row('a',{name:'New'}),row('b',{name:'Other'})])).toThrow('різні')
  expect(selectableAgentIssue(row('a',{}))).toBe(false)
  expect(()=>catalogAgentPayload([{...row('a',{}),primary_id:'master'},row('b',{name:'New'})])).toThrow('окремо')
  expect(()=>catalogAgentPayload([{...row('a',{}),primary_id:'master',blocked:'stock'}])).toThrow('заблокована')
 })
})
