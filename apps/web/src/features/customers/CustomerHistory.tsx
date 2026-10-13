import { useEffect, useRef, useState } from 'react'
import { Card, Button } from '@/components/ui'
import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { businessDateRangeUtc } from '@/lib/businessDate'
import { formatDateTime, formatMoney } from '@/lib/utils'
import { customerMoneyLabel } from './customerUi'
import { SaleDetailModal } from '@/features/sales/SaleDetailModal'
import { useListViewState, useViewNavigation } from '@/hooks/useViewNavigation'
import { useAuthStore } from '@/stores/authStore'

export function CustomerHistory({ customerId, revision = 0 }: { customerId: string; revision?: number }) {
  const userScope = useAuthStore(state => `${state.session?.user?.id ?? ''}:${state.session?.user?.app_metadata?.role ?? ''}`)
  const { open } = useViewNavigation(`/customers/${encodeURIComponent(customerId)}`)
  const [view, setView] = useListViewState(`customer:history:${customerId}`, { kind: 'sales' as 'sales'|'deposit', from: '', to: '' })
  const { kind, from, to } = view
  const [selected, setSelected] = useState<{ customerId: string; saleId: string } | null>(null)
  const [rows,setRows]=useState<any[]>([]),[more,setMore]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('')
  const [retry,setRetry]=useState(0)
  const generation=useRef(0), busy=useRef(false)
  const asOf=useRef(new Date().toISOString())
  const historyKey=JSON.stringify([customerId,userScope,kind,from,to,retry,revision])
  const [loadedKey,setLoadedKey]=useState('')
  const visibleRows=loadedKey===historyKey?rows:[]
  async function load(offset: number, token: number) {
    busy.current=true;setLoading(true);setError('')
    try {
      if(from && to && from>to) throw new Error('Дата початку має бути не пізніше дати завершення')
      const options={offset,limit:50,
        ...(from?{from:businessDateRangeUtc(from,from).from}:{}),
        to:to?businessDateRangeUtc(to,to).to:asOf.current}
      const local=desktopBridge()?.pos.customerHistory
      const result=local ? await local(customerId,kind,options) :
        await api.get<{data:any[];has_more:boolean}>(`/api/v1/customers/${customerId}/history/${kind}?${new URLSearchParams(Object.entries(options).map(([k,v])=>[k,String(v)]))}`)
      if(token!==generation.current)return
      setLoadedKey(historyKey)
      setRows(previous=>offset?Array.from(new Map([...previous,...result.data].map(row=>[row.id,row])).values()):result.data)
      setMore(result.has_more)
    }catch(e){if(token===generation.current)setError(e instanceof Error?e.message:'Не вдалося завантажити історію')}
    finally{if(token===generation.current){busy.current=false;setLoading(false)}}
  }
  useEffect(()=>{
    const token=++generation.current
    asOf.current=new Date().toISOString()
    setRows([]);setMore(false);void load(0,token)
    return()=>{generation.current++}
  },[customerId,userScope,kind,from,to,retry,revision])
  return <Card>
    <h3 className="mb-3 font-semibold">Історія клієнта</h3>
    <div className="mb-4 flex flex-wrap gap-3">
      <select aria-label="Вид історії" value={kind} onChange={e=>setView(previous=>({...previous,kind:e.target.value as typeof kind}))} className="max-w-full rounded border p-2">
        <option value="sales">Чеки</option><option value="deposit">Рух коштів рахунку</option>
      </select>
      <label className="text-sm">З <input aria-label="Історія від" type="date" value={from} onChange={e=>setView(previous=>({...previous,from:e.target.value}))} className="max-w-full rounded border p-2"/></label>
      <label className="text-sm">До <input aria-label="Історія до" type="date" value={to} onChange={e=>setView(previous=>({...previous,to:e.target.value}))} className="max-w-full rounded border p-2"/></label>
    </div>
    {error && <div role="alert" className="mb-3 text-sm text-red-700">{error} <button onClick={()=>setRetry(v=>v+1)} className="underline">Повторити</button></div>}
    {!loading&&!error&&loadedKey===historyKey&&visibleRows.length===0&&<p className="text-sm text-gray-500">За цей період операцій немає</p>}
    <div className="divide-y">{visibleRows.map(row=><div key={row.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm">
      <div className="min-w-0 break-words">
        {kind==='sales' ? <button type="button" className="text-left font-medium text-yellow-800 hover:underline" onClick={()=>setSelected({customerId,saleId:row.id})}>{'Чек №'+row.sale_number}</button> : <p>{row.notes||'Операція рахунку'}</p>}
        <p className="text-xs text-gray-500">{formatDateTime(row.completed_at??row.created_at)} · {customerMoneyLabel(row.payment_method??row.method)}</p>
      </div>
      <div><strong>{formatMoney(kind==='sales'?row.total:row.amount)}</strong>
        {kind==='deposit'&&<p className="text-xs text-gray-500">Залишок: {formatMoney(row.balance_after)}</p>}
      </div>
    </div>)}</div>
    {loading&&<p role="status" className="py-3">Завантаження…</p>}
    {more&&loadedKey===historyKey&&<Button variant="secondary" loading={loading} onClick={()=>{if(!busy.current)void load(rows.length,generation.current)}}>Показати ще</Button>}
    <SaleDetailModal saleId={selected?.customerId===customerId?selected.saleId:null} onClose={()=>setSelected(null)} onReturn={sale=>open(`/returns?sale=${encodeURIComponent(sale.sale_number)}`)}/>
  </Card>
}
