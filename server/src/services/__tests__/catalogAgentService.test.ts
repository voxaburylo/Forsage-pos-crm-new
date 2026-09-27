import {describe,it,expect,vi} from 'vitest'
vi.mock('../aiService.js',()=>({getAiConfig:vi.fn(),recordAiUsage:vi.fn()}))
import {catalogReviewSchema,validateCatalogProposals,CATALOG_AGENT_INSTRUCTION} from '../catalogAgentService.js'
const p={id:'00000000-0000-4000-8000-000000000001',name:'Фильтр MANN W811/80',sku:'AUTO-X',brand:'MANN',category_id:null}
const input={products:[p],categories:[{id:'00000000-0000-4000-8000-000000000002',name:'Фільтри'}]}
const proposal={...p,name:'Фільтр MANN W811/80',sku:'W811/80',reason:'Переклад'}
const out=(changes:any={})=>{const {brand,...r}=proposal;return {proposals:[{...r,...changes}]}}
describe('catalog AI cannot mutate or invent identifiers',()=>{
 it('accepts only bounded metadata without stock, prices or tools',()=>{
  expect(catalogReviewSchema.safeParse(input).success).toBe(true)
  expect(catalogReviewSchema.safeParse({...input,products:[{...p,qty_on_hand:9}]}).success).toBe(false)
  expect(CATALOG_AGENT_INSTRUCTION).toContain('недовірені дані')
  expect(validateCatalogProposals(out(),input)).toHaveLength(1)
 })
 it('rejects changed variant, invented SKU/category, brand or unknown IDs',()=>{
  for(const change of [{name:'Фільтр MANN W67/1'},{name:'Фільтр MANN H811/80'},{sku:'811'},{sku:'FAKE123'},{category_id:'madeup'},{id:'other'},{name:'Фільтр W811/80'},{qty_on_hand:5}])expect(()=>validateCatalogProposals(out(change),input)).toThrow()
  expect(()=>validateCatalogProposals({proposals:[]},input)).toThrow('неповну')
 })
})
