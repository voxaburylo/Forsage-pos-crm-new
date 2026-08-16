import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'

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
}
export interface TireServiceReport {
  data: TireServiceReportRow[]; receipts: TireServiceReceipt[]; date: string
  totals: { services_qty: number; service_revenue: number; cash_revenue: number; cash_handed_over: number; cash_pending: number; due: number; payable_due: number }
}
export interface TireCashHandoverInput {
  employee_id: string; employee_name: string; work_date: string
  shift_id: string; amount: number; operation_id: string
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
    if (local) return { data: await local({ period }) as SalaryPayment[] }
    return api.get<{ data: SalaryPayment[] }>(`/api/v1/salary?period=${period}`)
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
    if (local) return { data: await local(body) as SalaryPayment }
    return api.post<{ data: SalaryPayment }>('/api/v1/salary', body)
  },
  async dailyPayout(body: any): Promise<{ data: { amount: number } }> {
    const local = localStaff()?.dailyPayout
    if (local) return { data: await local(body) as { amount: number } }
    return api.post<{ data: { amount: number } }>('/api/v1/salary/daily-payout', body)
  },
  async deleteSalary(id: string): Promise<void> {
    const local = localStaff()?.deleteSalary
    if (local) { await local(id); return }
    await api.delete(`/api/v1/salary/${id}`)
  },
}
