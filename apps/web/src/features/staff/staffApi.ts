import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { durableLocalRequest } from '@/lib/durableLocalRequest'
import { useAuthStore } from '@/stores/authStore'
import { collectSalaryHistory } from './salaryHistory'

export interface EmployeeSummary { employee_id:string; employee_name:string; salary:number; bonus:number; advance:number; penalty:number; earned:number; paid:number; balance:number; total:number }
export interface SalaryPayment { id:string; employee_id:string; employee_name:string; amount:number; type:'salary'|'bonus'|'advance'|'penalty'; method:'cash'|'card'|'transfer'; period:string; note:string|null; created_at:string }
export interface DailySummary { employee_id:string; employee_name:string; earned:number; paid:number; penalty:number; balance:number }
export interface TireServiceReportRow {
  employee_id: string
  employee_name: string
  services_qty: number
  service_revenue: number
  commission_earned: number
  daily_rate: number
  daily_rate_projected?: number
  earned: number
  paid: number
  penalty: number
  balance: number
  due: number
  cash_revenue: number
  cash_handed_over: number
  cash_pending: number
  salary_available_on: string
  salary_ready: boolean
  payable_due: number
}
export interface TireServiceReceipt {
  id: string; sale_number: string; completed_at: string
  employee_id: string; employee_name: string
  services_qty: number; service_revenue: number; cash_revenue: number
  payment_method: string; total: number
  cashier_id?: string; cashier_name?: string | null; notes?: string | null
  services?: Array<{ id: string; description: string; qty: number; unit_price: number; total: number }>
  commission_earned?: number
}
export interface TireSalaryOperation {
  id: string; employee_id: string; type: SalaryPayment['type']; source: string; amount: number
  method: SalaryPayment['method']; note: string | null; work_date: string; created_at: string
  created_by: string | null; cashier_name: string | null; sale_id: string | null; fund_source: string | null
}
export interface TireCashHandover {
  id: string; employee_id: string; amount: number; work_date: string; created_at: string
  note: string | null; created_by: string | null; cashier_name: string | null
}
export interface TireServiceReport {
  data: TireServiceReportRow[]; receipts: TireServiceReceipt[]; date: string
  details_version?: number; salary_operations?: TireSalaryOperation[]; cash_handovers?: TireCashHandover[]
  totals: { services_qty: number; service_revenue: number; cash_revenue: number; cash_handed_over: number; cash_pending: number; due: number; payable_due: number }
}
export interface TireCashHandoverInput {
  employee_id: string; employee_name: string; work_date: string
  shift_id: string; amount: number; operation_id: string
}
export type SalaryFundSource = 'cashbox' | 'owner_funds'
export interface DailyPayoutInput {
  employee_id: string; employee_name: string; method: 'cash' | 'card' | 'transfer'
  fund_source?: SalaryFundSource; shift_id?: string | null; work_date: string
}

function localStaff() { return desktopBridge()?.staff }

export const staffApi = {
  async summary(period: string): Promise<{ data: EmployeeSummary[] }> {
    const local = localStaff()?.salarySummary
    if (local) return { data: await local(period) as EmployeeSummary[] }
    return api.get<{ data: EmployeeSummary[] }>(`/api/v1/salary/summary?period=${period}`)
  },
  async listSalary(period: string): Promise<{ data: SalaryPayment[] }> {
    const local = localStaff()?.listSalary
    const size = 200
    return { data: await collectSalaryHistory<SalaryPayment>(async page => {
      if (local) {
        const data = await local({ period, page, per_page: size }) as SalaryPayment[]
        return { data, has_more: data.length === size }
      }
      const result = await api.get<{ data: SalaryPayment[]; has_more?: boolean }>(`/api/v1/salary?period=${encodeURIComponent(period)}&page=${page}&per_page=${size}`)
      return { data: result.data, has_more: result.has_more ?? result.data.length === size }
    }) }
  },
  async dailySummary(date: string): Promise<{ data: DailySummary[] }> {
    const local = localStaff()?.dailySummary
    if (local) return { data: await local(date) as DailySummary[] }
    return api.get<{ data: DailySummary[] }>(`/api/v1/salary/daily-summary?date=${date}`)
  },
  async tireServiceReport(date: string): Promise<TireServiceReport> {
    const local = localStaff()?.tireServiceReport
    if (local) {
      const result = await local(date) as TireServiceReport | TireServiceReportRow[]
      if (!Array.isArray(result)) return result
      return { data: result, receipts: [], date, totals: { services_qty: 0, service_revenue: 0, cash_revenue: 0, cash_handed_over: 0, cash_pending: 0, due: 0, payable_due: 0 } }
    }
    return api.get<TireServiceReport>('/api/v1/salary/tire-service-report?date=' + encodeURIComponent(date))
  },
  async tireCashHandover(body: TireCashHandoverInput): Promise<{ data: { amount: number } }> {
    const local = localStaff()?.tireCashHandover
    if (local) {
      const data = await local({ ...body, user_id: useAuthStore.getState().session?.user?.id })
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      return { data: data as { amount: number } }
    }
    return api.post<{ data: { amount: number } }>('/api/v1/salary/tire-cash-handover', body)
  },  async setPin(userId: string, pin: string): Promise<void> {
    const local = localStaff()?.setPin
    if (local) { await local(userId, pin); return }
    await api.post('/api/v1/auth/set-pin', { user_id: userId, pin })
  },
  async createSalary(body: any): Promise<{ data: SalaryPayment }> {
    const local = localStaff()?.createSalary
    if (local) return { data: await durableLocalRequest('salary:' + useAuthStore.getState().session?.user?.id, body, operation_id => local({ ...body, operation_id })) as SalaryPayment }
    return api.post<{ data: SalaryPayment }>('/api/v1/salary', body)
  },
  async dailyPayout(body: DailyPayoutInput): Promise<{ data: { amount: number; fund_source?: SalaryFundSource } }> {
    const local = localStaff()?.dailyPayout
    if (local) {
      const user_id = useAuthStore.getState().session?.user?.id
      const payload = { ...body, user_id }
      return { data: await durableLocalRequest('daily-salary:' + user_id, payload, operation_id => local({ ...payload, operation_id })) as { amount: number; fund_source?: SalaryFundSource } }
    }
    return api.post<{ data: { amount: number; fund_source?: SalaryFundSource } }>('/api/v1/salary/daily-payout', body)
  },
  async deleteSalary(id: string): Promise<void> {
    const local = localStaff()?.deleteSalary
    if (local) { await local(id); return }
    await api.delete(`/api/v1/salary/${id}`)
  },
}
