import { it, expect } from 'vitest'
import { navigationAllowed } from './navigationAccess'
it('offers read-only web destinations without mutation screens',()=>{
 for(const path of ['/pos','/orders/new','/inventory','/suppliers/invoices/new','/settings']) expect(navigationAllowed(path,false)).toBe(false)
 for(const path of ['/products','/customers','/analytics','/reports']) expect(navigationAllowed(path,false)).toBe(true)
 expect(navigationAllowed('/inventory',true)).toBe(true)
})
