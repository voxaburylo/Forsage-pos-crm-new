import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'

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
  async tireServiceReport(date: string): Promise<{ data: TireServiceReportRow[] }> {
    const local = localStaff()?.tireServiceReport
    if (local) return { data: await local(date) as TireServiceReportRow[] }
    return api.get<{ data: TireServiceReportRow[] }>('/api/v1/salary/tire-service-report?date=' + encodeURIComponent(date))
  },
  async setPin(userId: string, pin: string): Promise<void> {
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
