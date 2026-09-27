import { expect, it } from 'vitest'
import { BoundedCache } from './boundedCache'
it('keeps the newest 12 pages during 10,000 searches',()=>{
  const cache=new BoundedCache<number,unknown[]>(12)
  for(let i=0;i<10_000;i++)cache.set(i,Array.from({length:50},()=>({id:String(i)})))
  expect(cache.size).toBe(12);expect(cache.get(0)).toBeUndefined();expect(cache.get(9999)).toHaveLength(50)
  cache.clear();expect(cache.size).toBe(0)
})
it('refreshes the least-recently-used order and overwrites existing values',()=>{
  const cache=new BoundedCache<string,number>(2);cache.set('a',1);cache.set('b',2);expect(cache.get('a')).toBe(1);cache.set('c',3)
  expect(cache.get('b')).toBeUndefined();cache.set('a',4);expect(cache.get('a')).toBe(4);expect(cache.size).toBe(2)
})
it.each([0,-1,Infinity,NaN,1.5])('rejects invalid capacity %s',limit=>expect(()=>new BoundedCache(limit)).toThrow())
