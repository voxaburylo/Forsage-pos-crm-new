import type { CatalogIssue } from './catalogAgentModel'
export interface ReviewedProduct { id:string; name:string; sku:string; brand:string; category_id:string|null; fingerprint:string }
/** Validate the whole reply before marking any product as reviewed. */
export function catalogReviewIssues(raw: unknown, batch: ReviewedProduct[], categories: Array<{id:string}>): CatalogIssue[] {
  if (!Array.isArray(raw) || raw.length !== batch.length) throw new Error('ШІ повернув неповну перевірку. Пакет не зараховано.')
  const originals=new Map(batch.map(p=>[p.id,p]))
  const knownCategories=new Set(categories.map(c=>c.id))
  const seen=new Set<string>()
  const issues:CatalogIssue[]=[]
  for (const value of raw) {
    if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Некоректна пропозиція ШІ')
    const proposal=value as Record<string,unknown>
    if (Object.keys(proposal).some(key=>!['id','name','sku','category_id','reason'].includes(key))) throw new Error('ШІ повернув зайві поля. Пакет не зараховано.')
    if (typeof proposal.id!=='string' || !originals.has(proposal.id) || seen.has(proposal.id)) throw new Error('Невідомий або повторний товар у відповіді ШІ')
    const before=originals.get(proposal.id)!
    seen.add(proposal.id)
    for (const [field,max] of [['name',500],['sku',100],['reason',500]] as const) {
      const text=proposal[field]
      if (typeof text!=='string' || text.length>max || (field==='name' && !text.trim())) throw new Error('Некоректне поле «'+field+'» у відповіді ШІ')
    }
    if (proposal.category_id!==null && typeof proposal.category_id!=='string') throw new Error('Некоректна категорія у відповіді ШІ')
    if (proposal.category_id!==before.category_id && (!proposal.category_id || !knownCategories.has(proposal.category_id as string))) throw new Error('ШІ запропонував невідому категорію')
    const changes:Record<string,unknown>={}
    for (const key of ['name','sku','category_id'] as const) if (proposal[key]!==before[key]) changes[key]=proposal[key]
    if (Object.keys(changes).length) issues.push({id:before.id+':ai',product_id:before.id,fingerprint:before.fingerprint,name:before.name,sku:before.sku,kind:'ai',before,changes,reason:proposal.reason as string})
  }
  return issues
}
