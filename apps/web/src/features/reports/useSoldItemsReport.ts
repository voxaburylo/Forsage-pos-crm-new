import { useEffect, useState } from 'react'
import type { SoldItem } from '@/types/report'
import { reportApi } from './reportApi'
import { validSoldRange } from './soldReportData'
export function useSoldItemsReport(from:string,to:string,active:boolean,scope:string) {
  const key=JSON.stringify([from,to,active,scope])
  const valid=validSoldRange(from,to)
  const [state,setState]=useState<{key:string;rows:SoldItem[];pending:boolean;error:string}>({key:'',rows:[],pending:true,error:''})
  useEffect(()=>{
    if(!active||!valid)return
    let current=true
    setState({key,rows:[],pending:true,error:''})
    reportApi.soldItems(from,to).then(response=>{
      if(current)setState({key,rows:response.data,pending:false,error:''})
    }).catch(error=>{
      if(current)setState({key,rows:[],pending:false,error:error instanceof Error?error.message:'Не вдалося завантажити звіт'})
    })
    return()=>{current=false}
  },[key,from,to,active,valid])
  const current=state.key===key
  return {rows:active&&valid&&current?state.rows:[],
    loading:active&&valid&&(!current||state.pending),
    error:!active?'':!valid?'Виберіть правильну дату початку й завершення':current?state.error:''}
}
