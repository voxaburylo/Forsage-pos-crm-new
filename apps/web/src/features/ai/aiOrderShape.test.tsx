import {describe,it,expect,vi} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import type {ReactNode} from 'react'
vi.mock('@/components/ui',()=>({Modal:({children}:{children:ReactNode})=><div>{children}</div>,Button:({children}:{children:ReactNode})=><button>{children}</button>}))
import {assertAiOrderShape} from './aiOrderShape'
import {toDraft,OrderConfirmModal,orderDraftTotal} from './OrderConfirmModal'
import {aiOrderPayload} from './localAiAction'

describe('AI order data integrity',()=>{
 it.each([null,[],true,'order',{items:{}},{items:[null]},{items:[[]]},{items:['row']}])('blocks malformed structure %j',payload=>{
   expect(()=>assertAiOrderShape(payload)).toThrow()
   expect(()=>toDraft(payload as any)).toThrow()
   expect(()=>aiOrderPayload(payload as any)).toThrow()
 })
 it.each(['customer_name','customer_phone','car_make','vin','plate','comment'])('does not stringify malformed %s',key=>{
   expect(()=>toDraft({[key]:{text:'value'}})).toThrow()
 })
 it.each(['name','part_number','qty','buy_price_uah','sell_price_uah'])('does not coerce malformed item %s',key=>{
   expect(()=>toDraft({items:[{name:'Ключ',qty:1,[key]:['12']}]})).toThrow()
 })
 it('keeps incomplete but well-formed data editable and preserves leading zero article',()=>{
   expect(toDraft({items:[{name:'Ключ',part_number:'0012'}]}).items[0]).toMatchObject({name:'Ключ',qty:'',part_number:'0012'})
   expect(aiOrderPayload({vin:'wvwzzz1jzxw000001'}).vehicle_info?.vin).toBe('WVWZZZ1JZXW000001')
 })
 it('never concatenates spaces in an order price',()=>{
   expect(()=>aiOrderPayload({items:[{name:'Ключ',qty:1,sell_price_uah:'12 34'}]})).toThrow('ціни')
   expect(aiOrderPayload({items:[{name:'Ключ',qty:1,sell_price_uah:'1 234,50'}]}).items[0].sell_price).toBe(123450)
 })
 it('limits both line and aggregate values before any customer write',()=>{
   expect(()=>aiOrderPayload({items:[{name:'Ключ',qty:1000,sell_price_uah:100000}]})).toThrow('Сума')
   expect(()=>aiOrderPayload({items:Array.from({length:3},()=>({name:'Ключ',qty:1,buy_price_uah:10000000}))})).toThrow('Сума')
   expect(()=>aiOrderPayload({car_year:true})).toThrow()
 })
 it('uses the same validated amounts and kopeck rounding in preview as in the write',()=>{
   expect(orderDraftTotal(toDraft({items:[{name:'Ключ',qty:2,sell_price_uah:'1 234,50'}]}))).toBe(2469)
   expect(orderDraftTotal(toDraft({items:[{name:'Ключ',qty:'1,5',sell_price_uah:'1,01'}]}))).toBe(1.52)
   expect(orderDraftTotal(toDraft({items:[{name:'Ключ',qty:2,sell_price_uah:'12 34'}]}))).toBeNull()
   expect(orderDraftTotal(toDraft({items:[{name:'Ключ',qty:''}]}))).toBeNull()
 })
 it('renders a clear failure instead of crashing the whole page',()=>{
   const markup=renderToStaticMarkup(<OrderConfirmModal action={{id:'bad',tool:'create_order',title:'Order',changes:[],payload:{items:[null]}}} applying={false} onClose={()=>{}} onConfirm={()=>{throw Error('Must not write')}}/>)
   expect(markup).toContain('Замовлення не створено')
   expect(markup).toContain('role="alert"')
 })
})
