import { expect, it, vi } from 'vitest'
import { readReportPages } from './readReportPages.js'
it('reads through a server cap smaller than requested and does not skip records',async()=>{
 const rows=Array.from({length:1201},(_,id)=>({id})); const query={order:vi.fn(),range:vi.fn(async(from:number)=>({data:rows.slice(from,from+100),error:null}))};query.order.mockReturnValue(query)
 expect((await readReportPages(query)).data).toEqual(rows);expect(query.range).toHaveBeenCalledTimes(14)
})
it('does not return partial rows as a successful report',async()=>{const query={order:vi.fn(),range:vi.fn().mockResolvedValueOnce({data:[{id:1}]}).mockResolvedValueOnce({error:{message:'offline'}})};query.order.mockReturnValue(query);expect(await readReportPages(query)).toEqual({data:[],error:{message:'offline'}})})
