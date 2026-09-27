import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Plus, Trash2, Percent,
  DollarSign, Award, AlertTriangle, ArrowDownRight,
  User, Shield,
  Settings, CreditCard, History, Lock, Save, ChevronLeft, ChevronRight
} from 'lucide-react'
import { adminApi, ROLE_LABELS } from '@/features/admin/adminApi'
import type { AdminUser, UserRole } from '@/features/admin/adminApi'
import { commissionApi } from '@/features/settings/commissionApi'
import type { CommissionRule } from '@/features/settings/commissionApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal, Input, Badge, Table, ConfirmDialog } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { staffApi } from './staffApi'
import type { EmployeeSummary, SalaryPayment, DailySummary } from './staffApi'
import { formatMoney } from '@/lib/utils'
import { shiftApi } from '@/features/pos/shiftApi'
import { normalizedStaffPhone, staffPaySettings, staffTransactionAmount } from './staffFormModel'
import { useScopedAction } from '@/hooks/useScopedAction'

type BadgeColor = 'green' | 'orange' | 'red' | 'blue' | 'gray' | 'yellow'
const ROLE_COLORS: Record<UserRole, BadgeColor> = { owner:'yellow', admin:'blue', manager:'green', cashier:'gray', storekeeper:'orange', sto_viewer:'gray', tire_worker:'orange' } as const
type SalaryMode = 'only_rate' | 'only_pct' | 'rate_and_pct'

const TYPE_CONFIG = {
  salary:  { label: 'Ставка',  color: 'bg-green-100 text-green-700',  icon: <DollarSign size={12}/> },
  bonus:   { label: 'Премія',  color: 'bg-yellow-100 text-yellow-700', icon: <Award size={12}/> },
  advance: { label: 'Виплата', color: 'bg-blue-100 text-blue-700',     icon: <ArrowDownRight size={12}/> },
  penalty: { label: 'Штраф',   color: 'bg-red-100 text-red-700',       icon: <AlertTriangle size={12}/> },
}
const METHOD_LABELS: Record<string,string> = { cash:'Готівка', card:'Картка', transfer:'Переказ' }

function currentPeriod() { return localDate().slice(0,7) }
function localDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function periodLabel(p:string) {
  const [y,m] = p.split('-')
  const months = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень']
  return `${months[parseInt(m)-1]} ${y}`
}

export default function StaffPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const loadGeneration = useRef(0)
  const [period, setPeriod] = useState(currentPeriod())
  const [summary, setSummary] = useState<EmployeeSummary[]>([])
  const [payments, setPayments] = useState<SalaryPayment[]>([])
  const [rules, setRules] = useState<CommissionRule[]>([])
  const [dailySummary, setDailySummary] = useState<DailySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [payrollReady, setPayrollReady] = useState(false)
  const [editRulesLoaded, setEditRulesLoaded] = useState(false)
  const action = useScopedAction('staff')
  const saving = action.busy
  const [addOpen, setAddOpen] = useState(false)
  const [deleteConfirmUser, setDeleteConfirmUser] = useState<AdminUser|null>(null)
  const [selectedUser, setSelectedUser] = useState<AdminUser|null>(null)
  const [modalTab, setModalTab] = useState<'settings'|'payouts'>('settings')
  const [addForm, setAddForm] = useState({phone:'',password:'',full_name:'',role:'cashier' as UserRole,base_rate:'',rate_period:'day' as 'day'|'month',salaryMode:'only_rate' as SalaryMode,pos_revenue:'',pos_profit:'',order_revenue:'',order_profit:'',tire_revenue:'',tire_profit:''})
  const [editForm, setEditForm] = useState({role:'cashier' as UserRole,is_active:true,full_name:'',phone:'',base_rate:'',rate_period:'day' as 'day'|'month',salaryMode:'only_rate' as SalaryMode,pos_revenue:'',pos_profit:'',order_revenue:'',order_profit:'',tire_revenue:'',tire_profit:''})
  const [newPass, setNewPass] = useState('')

  const [actionForm, setActionForm] = useState({type:'salary' as 'salary'|'bonus'|'advance'|'penalty',method:'cash' as 'cash'|'card'|'transfer',amount:'',note:'',period:currentPeriod()})

  const loadData = useCallback(async () => {
    const generation = ++loadGeneration.current
    setLoading(true)
    setPayrollReady(false)
    try {
      const [usersRes,summaryRes,paymentsRes,rulesRes,dailyRes] = await Promise.allSettled([adminApi.listUsers(true),staffApi.summary(period),staffApi.listSalary(period),commissionApi.listRules(),staffApi.dailySummary(localDate())])
      if(generation!==loadGeneration.current)return
      if(usersRes.status==='rejected')throw usersRes.reason
      setUsers(usersRes.value.data)
      setSummary(summaryRes.status==='fulfilled'?summaryRes.value.data??[]:[])
      setPayments(paymentsRes.status==='fulfilled'?paymentsRes.value.data??[]:[])
      setRules(rulesRes.status==='fulfilled'?rulesRes.value.data??[]:[])
      setDailySummary(dailyRes.status==='fulfilled'?dailyRes.value.data??[]:[])
      setPayrollReady([summaryRes,paymentsRes,rulesRes,dailyRes].every(result=>result.status==='fulfilled'))
      if([summaryRes,paymentsRes,rulesRes,dailyRes].some(result=>result.status==='rejected'))toast.warning('Команду завантажено, але частина даних зарплати недоступна. Оновіть сторінку перед редагуванням оплати.')
    } catch { if(generation===loadGeneration.current)toast.error('Помилка завантаження даних') } finally { if(generation===loadGeneration.current)setLoading(false) }
  },[period])
  useEffect(()=>{void loadData();return()=>{loadGeneration.current++}},[loadData])

  const employeeSummary = useMemo(()=>{ if(!selectedUser) return null; return summary.find(s=>s.employee_id===selectedUser.id)||null },[selectedUser,summary])
  const employeePayments = useMemo(()=>{ if(!selectedUser) return []; return payments.filter(p=>p.employee_id===selectedUser.id) },[selectedUser,payments])
  const employeeRules = useMemo(()=>{ if(!selectedUser) return []; return rules.filter(r=>r.user_id===selectedUser.id) },[selectedUser,rules])
  const employeeToday = useMemo(()=>{ if(!selectedUser) return null; return dailySummary.find(s=>s.employee_id===selectedUser.id)||null },[selectedUser,dailySummary])
  // Власник керує зарплатою, але не є працівником, якому магазин винен ЗП.
  // Його старі комісійні записи лишаються в аудиті, проте не показуються як борг.
  const payrollUsers = useMemo(()=>users.filter((user)=>user.role!=='owner').filter(user=>Boolean(user.deleted_at)===showArchived),[users,showArchived])

  function shiftPeriod(d:number){if(action.isBusy())return;const[y,m]=period.split('-').map(Number);const dt=new Date(y,m-1+d,1);setPeriod(`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`)}

  async function performAction(task: (isCurrent: () => boolean) => Promise<void>, errorMessage: string): Promise<boolean> {
    const attempt = action.begin()
    if (!attempt) return false
    try { await task(attempt.isCurrent); return true }
    catch (error) { if (attempt.isCurrent()) toast.error(error instanceof Error ? error.message : errorMessage); return false }
    finally { attempt.finish() }
  }

  async function handleCreate(e:React.FormEvent){
    e.preventDefault()
    await performAction(async isCurrent => {
      const {base_rate:rate,rules:newRules}=staffPaySettings(addForm)
      const noProgramAccess=addForm.role==='tire_worker'
      if(!noProgramAccess && users.some(user=>normalizedStaffPhone(user.phone)===normalizedStaffPhone(addForm.phone))) throw new Error('Працівник із цим телефоном уже є в команді або архіві. Відкрийте його картку чи натисніть «Відновити» в архіві.')
      const created=await adminApi.createUser({phone:noProgramAccess?undefined:addForm.phone,password:noProgramAccess?undefined:addForm.password,full_name:addForm.full_name,role:addForm.role,base_rate:rate,rate_period:addForm.rate_period})
      let rulesSaved=true
      if(newRules.length){
        try {
          await adminApi.saveUserSettings(created.data.id,{},newRules)
        } catch { rulesSaved=false }
      }
      if (!isCurrent()) return
      setAddOpen(false)
      setAddForm({phone:'',password:'',full_name:'',role:'cashier',base_rate:'',rate_period:'day',salaryMode:'only_rate',pos_revenue:'',pos_profit:'',order_revenue:'',order_profit:'',tire_revenue:'',tire_profit:''})
      await loadData()
      if (!isCurrent()) return
      if(rulesSaved)toast.success('Співробітника додано разом із налаштуваннями оплати')
      else toast.warning('Співробітника створено, але частину процентів не збережено. Відкрийте його картку та перевірте оплату.')
    }, 'Помилка створення')
  }

  function openModal(u:AdminUser){
    if(u.deleted_at || action.isBusy())return
    setSelectedUser(u)
    setEditRulesLoaded(payrollReady)
    const ur=rules.filter(r=>r.user_id===u.id); const hasRate=(u.base_rate||0)>0; const hasPct=ur.some(r=>(r.pct_from_revenue>0||r.pct_from_profit>0))
    let sm:SalaryMode='only_rate'; if(hasRate&&hasPct)sm='rate_and_pct'; else if(hasPct&&!hasRate)sm='only_pct'
    const findRule=(type:string)=>ur.find(r=>r.rule_type===type&&!r.brand_id&&!r.category_id)
    const legacy=findRule('personal_sales'); const pos=findRule('pos_sales')??legacy; const order=findRule('order_sales')??legacy; const tire=findRule('tire_service')
    setEditForm({role:u.role as UserRole,is_active:u.is_active,full_name:u.full_name,phone:u.phone||'',base_rate:u.base_rate?(u.base_rate/100).toString():'',rate_period:u.rate_period??'month',salaryMode:sm,pos_revenue:pos?.pct_from_revenue?.toString()??'',pos_profit:pos?.pct_from_profit?.toString()??'',order_revenue:order?.pct_from_revenue?.toString()??'',order_profit:order?.pct_from_profit?.toString()??'',tire_revenue:tire?.pct_from_revenue?.toString()??'',tire_profit:tire?.pct_from_profit?.toString()??''})
    setNewPass('');setModalTab('settings')
    setActionForm({type:'salary',method:'cash',amount:u.base_rate?(u.base_rate/100).toString():'',note:'',period})
  }

  async function handleSaveAll(e:React.FormEvent){
    e.preventDefault(); if(!selectedUser||action.isBusy()) return
    if(!payrollReady||!editRulesLoaded){toast.error('Дані оплати не завантажено. Оновіть сторінку й повторно відкрийте картку.');return}
    await performAction(async isCurrent => {
      const {base_rate:rate,rules:newRules}=staffPaySettings(editForm)
      await adminApi.saveUserSettings(selectedUser.id,{role:editForm.role,is_active:editForm.is_active,full_name:editForm.full_name,base_rate:rate,rate_period:editForm.rate_period,phone:editForm.role==='tire_worker'?undefined:(editForm.phone||undefined)},newRules)
      if (!isCurrent()) return
      toast.success('Всі налаштування збережено')
      setSelectedUser({...selectedUser,role:editForm.role,is_active:editForm.is_active,full_name:editForm.full_name,phone:editForm.phone||selectedUser.phone,base_rate:rate,rate_period:editForm.rate_period})
      await loadData()
    }, 'Помилка збереження')
  }

  async function handleResetPassword(e:React.FormEvent) {
    e.preventDefault()
    if (!selectedUser || action.isBusy()) return
    if (newPass.length < 8) { toast.error('Мінімум 8 символів'); return }
    await performAction(async isCurrent => {
      await adminApi.resetPassword(selectedUser.id, newPass)
      if (isCurrent()) { toast.success('Пароль успішно змінено'); setNewPass('') }
    }, 'Помилка зміни пароля')
  }

  async function handleDeleteUser() {
    if (!deleteConfirmUser) return false
    return performAction(async isCurrent => {
      await adminApi.deleteUser(deleteConfirmUser.id)
      if (!isCurrent()) return
      toast.success('Працівника перенесено в архів'); setDeleteConfirmUser(null)
      if (selectedUser?.id === deleteConfirmUser.id) setSelectedUser(null)
      await loadData()
    }, 'Помилка архівування')
  }
  async function handleRestoreUser(user: AdminUser) {
    if (action.isBusy() || !window.confirm(`Відновити ${user.full_name} зі збереженням історії та пароля?`)) return
    await performAction(async isCurrent => {
      await adminApi.restoreUser(user.id)
      if (!isCurrent()) return
      toast.success('Працівника відновлено. Пароль та історію збережено.'); await loadData()
    }, 'Помилка відновлення')
  }
  async function handleAddTransaction() {
    if (!selectedUser) return
    await performAction(async isCurrent => {
      const amount = staffTransactionAmount(actionForm.amount)
      const shift = actionForm.type === 'advance' && actionForm.method === 'cash' ? await shiftApi.current() : null
      if (!isCurrent()) return
      const shiftId = (shift as any)?.data?.id ?? null
      if (actionForm.type === 'advance' && actionForm.method === 'cash' && !shiftId) throw new Error('Спочатку відкрийте касову зміну')
      await staffApi.createSalary({employee_id:selectedUser.id,employee_name:selectedUser.full_name||selectedUser.email,amount,type:actionForm.type,method:actionForm.method,period:actionForm.period||period,note:actionForm.note||null,shift_id:shiftId,work_date:localDate()})
      if (!isCurrent()) return
      toast.success('Операцію збережено'); setActionForm({...actionForm,amount:'',note:''}); await loadData()
    }, 'Помилка збереження операції')
  }
  async function handleDailyPayout(fundSource:'cashbox'|'owner_funds') {
    if (!selectedUser) return
    await performAction(async isCurrent => {
      const shift = await shiftApi.current()
      if (!isCurrent()) return
      const shiftId = (shift as any)?.data?.id ?? null
      if (!shiftId) throw new Error('Спочатку відкрийте касову зміну')
      if (fundSource === 'owner_funds' && !window.confirm(`Внести власні кошти власника та виплатити заробіток ${selectedUser.full_name}? Залишок каси не зміниться.`)) return
      const result = await staffApi.dailyPayout({employee_id:selectedUser.id,employee_name:selectedUser.full_name||selectedUser.email,method:'cash',fund_source:fundSource,shift_id:shiftId,work_date:localDate()})
      if (!isCurrent()) return
      toast.success(fundSource==='owner_funds'?`Видано власними коштами ${formatMoney(result.data.amount)}`:`Видано з каси ${formatMoney(result.data.amount)}`); await loadData()
    }, 'Помилка виплати')
  }
  async function handleDeleteTransaction(id:string) {
    if (action.isBusy() || !window.confirm('Скасувати цю операцію зарплати? Пов’язаний рух коштів буде перевірено.')) return
    await performAction(async isCurrent => {
      await staffApi.deleteSalary(id)
      if (isCurrent()) { toast.success('Операцію скасовано'); await loadData() }
    }, 'Помилка скасування операції')
  }

  const columns = [
    { key:'full_name' as const, header:'Співробітник', render:(u:AdminUser)=>(
      <button onClick={()=>openModal(u)} className="text-left group"><div className="flex items-center gap-3"><div className="w-9 h-9 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center text-sm font-bold text-gray-600 ring-2 ring-white shadow-sm group-hover:ring-yellow-200 transition-all">{(u.full_name||'?')[0]?.toUpperCase()}</div><div><p className="text-sm font-semibold text-gray-900 group-hover:text-yellow-700 transition-colors">{u.full_name||'Без імені'}</p><p className="text-[11px] text-gray-400">{u.role==='tire_worker'?'Без доступу до програми':u.phone}</p></div></div></button>
    )},
    { key:'role' as const, header:'Роль', render:(u:AdminUser)=>(<Badge color={ROLE_COLORS[u.role as UserRole]||'gray'}>{ROLE_LABELS[u.role as UserRole]||u.role}</Badge>) },
    { key:'base_rate' as const, header:'Ставка', render:(u:AdminUser)=>(<span className="text-sm font-medium text-gray-700">{u.base_rate?`${formatMoney(u.base_rate)} / ${u.rate_period==='day'?'день':'місяць'}`:'—'}</span>) },
    { key:'today' as const, header:'Сьогодні', render:(u:AdminUser)=>{const s=dailySummary.find(x=>x.employee_id===u.id);return <span className={`text-sm font-bold ${s?.balance?'text-amber-700':'text-gray-300'}`}>{s?formatMoney(s.balance):'—'}</span>} },
    { key:'summary' as const, header:`Баланс (${periodLabel(period)})`, render:(u:AdminUser)=>{const s=summary.find(x=>x.employee_id===u.id);if(!s)return<span className="text-xs text-gray-300">—</span>;return(<div className="text-right"><p className={`text-sm font-bold ${s.balance>=0?'text-green-600':'text-red-500'}`}>{s.balance>=0?'+':''}{formatMoney(s.balance)}</p><p className="text-[10px] text-gray-400">Нарах: {formatMoney(s.earned)} · Випл: {formatMoney(s.paid)}</p></div>)} },
    { key:'is_active' as const, header:'Статус', render:(u:AdminUser)=>(<Badge color={u.is_active?'green':'red'}>{u.deleted_at?'Архів':u.is_active?'Активний':'Неактивний'}</Badge>) },
    { key:'actions' as const, header:'', render:(u:AdminUser)=>(
      <div className="flex gap-1 justify-end">
        {u.deleted_at ? <Button disabled={saving} onClick={() => handleRestoreUser(u)}>Відновити</Button> : <>
        <button onClick={(e)=>{e.stopPropagation();openModal(u)}} className="p-1.5 text-gray-400 hover:text-yellow-600 rounded-lg hover:bg-yellow-50 transition-all" title="Налаштувати"><Settings size={15}/></button>
        <button disabled={saving} onClick={(e)=>{e.stopPropagation();if(!action.isBusy())setDeleteConfirmUser(u)}} className="p-1.5 text-gray-300 hover:text-red-500 rounded-lg hover:bg-red-50 transition-all" title="Видалити"><Trash2 size={15}/></button>
        </>}
      </div>
    )},
  ]

  return (
    <Layout title="Команда та ЗП">
      <div className="space-y-5">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button onClick={()=>shiftPeriod(-1)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm hover:bg-gray-50 transition-colors"><ChevronLeft size={16}/></button>
            <span className="text-sm font-semibold text-gray-800 min-w-[140px] text-center">{periodLabel(period)}</span>
            <button onClick={()=>shiftPeriod(1)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm hover:bg-gray-50 transition-colors"><ChevronRight size={16}/></button>
          </div>
          <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end">
            <p className="text-xs text-gray-500">Всього співробітників: <span className="font-semibold text-gray-900">{payrollUsers.length}</span></p>
            <Button disabled={saving} icon={<Plus size={16}/>} onClick={()=>{if(!action.isBusy())setAddOpen(true)}}>Додати співробітника</Button>
            <Button disabled={saving} onClick={()=>{if(!action.isBusy())setShowArchived(!showArchived)}}>{showArchived?'До команди':'Архів працівників'}</Button>
          </div>
        </div>

        <Card padding="none">
          <Table columns={columns} data={payrollUsers} keyFn={(u)=>u.id} loading={loading} empty={<p className="text-gray-400 text-sm py-12 text-center">Співробітників не знайдено</p>}/>
        </Card>
      </div>

      {/* УНІФІКОВАНЕ МОДАЛЬНЕ ВІКНО */}
      <Modal open={!!selectedUser} onClose={()=>{if(!action.isBusy())setSelectedUser(null)}} title={selectedUser?.full_name||'Редагування'} size="xl">
        {selectedUser && (
          <fieldset disabled={saving} className="space-y-0 min-w-0">
            <div className="flex items-center gap-4 pb-4 mb-4 border-b border-gray-100">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-yellow-100 to-amber-200 flex items-center justify-center text-lg font-bold text-amber-700 shadow-sm">{(selectedUser.full_name||'?')[0]?.toUpperCase()}</div>
              <div className="flex-1 min-w-0"><h3 className="text-lg font-bold text-gray-900">{selectedUser.full_name||'Без імені'}</h3><p className="text-xs text-gray-500">{selectedUser.role==='tire_worker'?'Без доступу до програми':selectedUser.phone} · {ROLE_LABELS[selectedUser.role as UserRole]||selectedUser.role}</p></div>
              <Badge color={selectedUser.is_active?'green':'red'}>{selectedUser.is_active?'Активний':'Неактивний'}</Badge>
            </div>

            <div className="flex border-b border-gray-100 mb-5 gap-1">
              <button onClick={()=>setModalTab('settings')} className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all rounded-t-lg ${modalTab==='settings'?'border-amber-400 text-gray-900 bg-amber-50/50':'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}><Settings size={15}/>Налаштування та Оплата</button>
              <button onClick={()=>setModalTab('payouts')} className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all rounded-t-lg ${modalTab==='payouts'?'border-amber-400 text-gray-900 bg-amber-50/50':'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}><CreditCard size={15}/>Виплати та Історія{employeePayments.length>0&&<span className="ml-1 px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded-full text-[10px] font-bold">{employeePayments.length}</span>}</button>
            </div>

            {modalTab==='settings' && (
              <form onSubmit={handleSaveAll} className="space-y-5">
                <fieldset disabled={saving} className="space-y-5 min-w-0">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="space-y-5">
                    <div className="bg-gray-50/70 rounded-xl p-4 space-y-3 border border-gray-100">
                      <h4 className="text-sm font-bold text-gray-800 flex items-center gap-2"><User size={14} className="text-gray-500"/>Профіль</h4>
                      <Input label="Повне ім'я" value={editForm.full_name} onChange={(e)=>setEditForm({...editForm,full_name:e.target.value})} required/>
                      <div><label className="block text-sm font-medium text-gray-700 mb-1">Роль</label><select value={editForm.role} onChange={(e)=>setEditForm({...editForm,role:e.target.value as UserRole,phone:e.target.value==='tire_worker'?'':editForm.phone})} className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 bg-white">{Object.entries(ROLE_LABELS).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
                      {editForm.role==='tire_worker'?(
                        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">Шиномонтажник використовується тільки як виконавець робіт. Логін, пароль і доступ до програми для нього не створюються.</div>
                      ):(<>
                        <Input label="Телефон (логін)" type="tel" value={editForm.phone} onChange={(e)=>setEditForm({...editForm,phone:e.target.value})} placeholder="+380671234567"/>
                        <div className="flex items-center gap-3 pt-1"><input type="checkbox" id="edit_active_modal" checked={editForm.is_active} onChange={(e)=>setEditForm({...editForm,is_active:e.target.checked})} className="w-4 h-4 rounded text-amber-500 focus:ring-amber-300"/><label htmlFor="edit_active_modal" className="text-sm text-gray-700 font-medium">Активний акаунт (дозволити вхід)</label></div>
                      </>)}
                    </div>
                    {editForm.role!=='tire_worker'&&(
                      <div className="bg-gray-50/70 rounded-xl p-4 space-y-3 border border-gray-100">
                        <h4 className="text-sm font-bold text-gray-800 flex items-center gap-2"><Shield size={14} className="text-gray-500"/>Безпека</h4>
                        <div className="space-y-2"><label className="text-xs font-medium text-gray-500">Новий пароль для входу</label><div className="flex gap-2"><input type="password" value={newPass} onChange={(e)=>setNewPass(e.target.value)} placeholder="Мінімум 8 символів" className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"/><Button type="button" size="sm" onClick={handleResetPassword} variant="secondary"><Lock size={14}/></Button></div></div>

                      </div>
                    )}
                  </div>
                  <div className="space-y-5">
                    <div className="bg-gradient-to-br from-amber-50/80 to-yellow-50/40 rounded-xl p-4 space-y-4 border border-amber-100/60">
                      <h4 className="text-sm font-bold text-gray-800 flex items-center gap-2"><DollarSign size={14} className="text-amber-600"/>Оплата праці</h4>
                      <div><label className="block text-xs font-medium text-gray-500 mb-2">Тип нарахування</label>
                        <div className="grid grid-cols-3 gap-1.5">
                          {([{v:'only_rate' as SalaryMode,l:'Тільки ставка',icon:<DollarSign size={13}/>},{v:'only_pct' as SalaryMode,l:'Тільки %',icon:<Percent size={13}/>},{v:'rate_and_pct' as SalaryMode,l:'Ставка + %',icon:<><DollarSign size={13}/><Percent size={13}/></>}]).map(opt=>(
                            <button key={opt.v} type="button" onClick={()=>setEditForm({...editForm,salaryMode:opt.v})} className={`flex items-center justify-center gap-1 px-2 py-2 rounded-lg text-xs font-medium border transition-all ${editForm.salaryMode===opt.v?'bg-amber-100 border-amber-300 text-amber-800 shadow-sm':'bg-white border-gray-200 text-gray-500 hover:border-amber-200 hover:bg-amber-50/30'}`}>{opt.icon}{opt.l}</button>
                          ))}
                        </div>
                      </div>
                      {editForm.salaryMode!=='only_pct'&&(
                        <div className="grid grid-cols-2 gap-3">
                          <Input label={`Ставка (грн/${editForm.rate_period==='day'?'день':'місяць'})`} type="number" min="0" step="0.01" value={editForm.base_rate} onChange={(e)=>setEditForm({...editForm,base_rate:e.target.value})} placeholder={editForm.rate_period==='day'?'наприклад: 800':'наприклад: 15000'}/>
                          <div><label className="block text-sm font-medium text-gray-700 mb-1">Період ставки</label><select value={editForm.rate_period} onChange={(e)=>setEditForm({...editForm,rate_period:e.target.value as 'day'|'month'})} className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm bg-white"><option value="day">За робочий день</option><option value="month">За місяць</option></select></div>
                        </div>
                      )}
                      {editForm.salaryMode!=='only_rate'&&(
                        <div className="space-y-3 bg-white/60 rounded-lg p-3 border border-amber-100/50">
                          <p className="text-xs font-semibold text-amber-700">Окремі правила за видом роботи</p>
                          <div className="grid grid-cols-[minmax(0,1fr)_90px_90px] items-end gap-2 text-xs">
                            <span className="pb-2 font-medium text-gray-600">Джерело</span><span className="pb-2 text-center text-gray-400">% виручки</span><span className="pb-2 text-center text-gray-400">% прибутку</span>
                            <span className="font-medium text-gray-700">Продажі в касі<br/><small className="font-normal text-gray-400">товари, кава, вільний продаж</small></span><input type="number" min="0" max="100" step="0.1" value={editForm.pos_revenue} onChange={(e)=>setEditForm({...editForm,pos_revenue:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/><input type="number" min="0" max="100" step="0.1" value={editForm.pos_profit} onChange={(e)=>setEditForm({...editForm,pos_profit:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/>
                            <span className="font-medium text-gray-700">Замовлення<br/><small className="font-normal text-gray-400">після видачі клієнту</small></span><input type="number" min="0" max="100" step="0.1" value={editForm.order_revenue} onChange={(e)=>setEditForm({...editForm,order_revenue:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/><input type="number" min="0" max="100" step="0.1" value={editForm.order_profit} onChange={(e)=>setEditForm({...editForm,order_profit:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/>
                            <span className="font-medium text-gray-700">Шиномонтаж<br/><small className="font-normal text-gray-400">виконавець з каси</small></span><input type="number" min="0" max="100" step="0.1" value={editForm.tire_revenue} onChange={(e)=>setEditForm({...editForm,tire_revenue:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/><input type="number" min="0" max="100" step="0.1" value={editForm.tire_profit} onChange={(e)=>setEditForm({...editForm,tire_profit:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/>
                          </div>
                          <p className="text-[10px] text-gray-500">Для шиномонтажу обов’язково вибирається активний працівник зі статусом «Шиномонтажник». Касир не вважається виконавцем цих робіт.</p>
                        </div>                      )}
                      {employeeRules.length>0&&(
                        <div className="bg-white/60 rounded-lg p-3 border border-amber-100/50">
                          <p className="text-xs font-semibold text-gray-600 mb-2">Активні правила комісії</p>
                          {employeeRules.map(r=>(
                            <div key={r.id} className="flex items-center justify-between py-1.5 text-xs">
                              <span className="text-gray-600">{{pos_sales:'Каса',order_sales:'Замовлення',tire_service:'Шиномонтаж',personal_sales:'Старе загальне правило'}[r.rule_type]??r.rule_type}{r.brand_id&&' (бренд)'}{r.category_id&&' (категорія)'}</span>
                              <div className="flex gap-2 text-gray-500">{r.pct_from_revenue>0&&<span>Виручка: <strong className="text-amber-700">{r.pct_from_revenue}%</strong></span>}{r.pct_from_profit>0&&<span>Прибуток: <strong className="text-amber-700">{r.pct_from_profit}%</strong></span>}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {employeeSummary&&(
                      <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
                        <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Баланс за {periodLabel(period)}</h4>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="text-center p-2 bg-green-50/50 rounded-lg"><p className="text-[10px] text-gray-400">Нараховано</p><p className="text-sm font-bold text-green-700">{formatMoney(employeeSummary.earned)}</p></div>
                          <div className="text-center p-2 bg-blue-50/50 rounded-lg"><p className="text-[10px] text-gray-400">Виплачено</p><p className="text-sm font-bold text-blue-700">{formatMoney(employeeSummary.paid)}</p></div>
                          <div className="text-center p-2 bg-yellow-50/50 rounded-lg"><p className="text-[10px] text-gray-400">Премії</p><p className="text-sm font-bold text-yellow-700">{formatMoney(employeeSummary.bonus)}</p></div>
                          <div className="text-center p-2 rounded-lg" style={{backgroundColor:employeeSummary.balance>=0?'rgba(34,197,94,0.06)':'rgba(239,68,68,0.06)'}}><p className="text-[10px] text-gray-400">Залишок</p><p className={`text-sm font-bold ${employeeSummary.balance>=0?'text-green-600':'text-red-500'}`}>{formatMoney(employeeSummary.balance)}</p></div>
                        </div>
                      </div>
                    )}
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div><p className="text-xs font-bold uppercase tracking-wider text-emerald-800">Заробіток сьогодні</p><p className="mt-1 text-xs text-emerald-700">Ставка за день + автоматичний відсоток</p></div>
                        <p className="text-xl font-bold text-emerald-800">{formatMoney(employeeToday?.balance??0)}</p>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Button type="button" onClick={()=>handleDailyPayout('cashbox')} loading={saving} disabled={(employeeToday?.balance??0)<=0 && !(selectedUser.base_rate>0 && selectedUser.rate_period==='day')} className="w-full">
                          Видати з каси
                        </Button>
                        <button type="button" onClick={()=>handleDailyPayout('owner_funds')} disabled={saving || ((employeeToday?.balance??0)<=0 && !(selectedUser.base_rate>0 && selectedUser.rate_period==='day'))} className="w-full rounded-lg bg-amber-400 px-3 py-2 text-sm font-bold text-black hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50">
                          Кошти власника
                        </button>
                      </div>
                      <p className="mt-2 text-[10px] text-emerald-700">Для коштів власника програма одночасно зафіксує внесення та виплату. Залишок каси не зміниться.</p>
                    </div>
                  </div>
                </div>
                  <div className="pt-3 border-t border-gray-100">{(!payrollReady||!editRulesLoaded)&&<p role="alert" className="mb-2 text-sm text-amber-800">Дані оплати недоступні. Оновіть сторінку й повторно відкрийте картку, щоб безпечно зберегти налаштування.</p>}<Button type="submit" disabled={!payrollReady||!editRulesLoaded} loading={saving} className="w-full"><Save size={16}/>Зберегти всі налаштування</Button></div>
                </fieldset>
              </form>
            )}

            {modalTab==='payouts' && (
              <div className="space-y-5">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="bg-gray-50/70 rounded-xl p-4 space-y-4 border border-gray-100">
                    <h4 className="text-sm font-bold text-gray-800 flex items-center gap-2"><CreditCard size={14} className="text-gray-500"/>Нарахувати або Виплатити</h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div><label className="block text-xs font-medium text-gray-500 mb-1">Тип операції</label><select value={actionForm.type} onChange={(e)=>setActionForm({...actionForm,type:e.target.value as any})} className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 bg-white"><option value="salary">Ставка (Нарахування)</option><option value="bonus">Премія / Бонус</option><option value="advance">Виплата / Аванс</option><option value="penalty">Штраф (Утримання)</option></select></div>
                      <div><label className="block text-xs font-medium text-gray-500 mb-1">Метод</label><select value={actionForm.method} onChange={(e)=>setActionForm({...actionForm,method:e.target.value as any})} className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 bg-white"><option value="cash">Готівка</option><option value="card">Картка</option><option value="transfer">Переказ</option></select></div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Input label="Сума (грн)" inputMode="decimal" value={actionForm.amount} onChange={(e)=>setActionForm({...actionForm,amount:e.target.value})} placeholder="0,00"/>
                      <div><label className="block text-xs font-medium text-gray-500 mb-1">Період (місяць)</label><input type="month" value={actionForm.period} onChange={(e)=>setActionForm({...actionForm,period:e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 bg-white"/></div>
                    </div>
                    <div><label className="block text-xs font-medium text-gray-500 mb-1">Примітка</label><textarea value={actionForm.note} onChange={(e)=>setActionForm({...actionForm,note:e.target.value})} rows={3} placeholder="Наприклад: Видача залишку зарплати за травень..." className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 resize-none bg-white"/></div>
                    <Button onClick={handleAddTransaction} loading={saving} className="w-full">Зберегти операцію</Button>
                  </div>
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-gray-800 flex items-center gap-2"><History size={14} className="text-gray-500"/>Операції за {periodLabel(period)}</h4>
                    <div className="border border-gray-100 rounded-xl divide-y divide-gray-50 bg-white overflow-y-auto max-h-[420px]">
                      {employeePayments.length===0?(<p className="text-xs text-gray-400 text-center py-12">Операцій у цьому місяці ще не було</p>):(
                        employeePayments.map(p=>{const conf=TYPE_CONFIG[p.type];const isMinus=p.type==='penalty'||p.type==='advance';return(
                          <div key={p.id} className="p-3.5 flex items-start gap-3 hover:bg-gray-50/30 transition-all">
                            <div className="flex-1 min-w-0 space-y-0.5"><div className="flex items-center gap-2"><span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${conf.color}`}>{conf.icon} {conf.label}</span><span className="text-[10px] text-gray-400">{METHOD_LABELS[p.method]}</span><span className="text-[10px] text-gray-400 font-mono">{new Date(p.created_at).toLocaleDateString('uk-UA')}</span></div>{p.note&&<p className="text-xs text-gray-600 leading-relaxed font-medium break-all">{p.note}</p>}</div>
                            <div className="text-right shrink-0 flex items-center gap-3"><div><p className={`text-sm font-bold ${isMinus?'text-red-500':'text-green-600'}`}>{isMinus?'\u2212':'+'}{formatMoney(p.amount)}</p></div><button onClick={()=>handleDeleteTransaction(p.id)} className="text-gray-300 hover:text-red-500 p-1 rounded transition-colors"><Trash2 size={13}/></button></div>
                          </div>
                        )})
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </fieldset>
        )}
      </Modal>

      <Modal open={addOpen} onClose={()=>{if(!action.isBusy())setAddOpen(false)}} title="Додати співробітника" size="xl">
        <form onSubmit={handleCreate} className="space-y-5">
          <fieldset disabled={saving} className="space-y-5 min-w-0">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input label="Повне ім'я *" value={addForm.full_name} onChange={(e)=>setAddForm(f=>({...f,full_name:e.target.value}))} placeholder="Іванов Іван Іванович" required/>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Роль *</label><select value={addForm.role} onChange={(e)=>setAddForm(f=>({...f,role:e.target.value as UserRole,phone:e.target.value==='tire_worker'?'':f.phone,password:e.target.value==='tire_worker'?'':f.password}))} className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 bg-white">{Object.entries(ROLE_LABELS).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
            {addForm.role==='tire_worker'?(
              <div className="md:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">Для шиномонтажника потрібне тільки ім’я. Він з’явиться у виборі виконавця робіт, але не матиме логіна, пароля чи доступу до програми.</div>
            ):(<>
              <Input label="Телефон *" type="tel" value={addForm.phone} onChange={(e)=>setAddForm(f=>({...f,phone:e.target.value}))} placeholder="+380671234567" required/>
              <Input label="Пароль *" type="password" value={addForm.password} onChange={(e)=>setAddForm(f=>({...f,password:e.target.value}))} placeholder="Мінімум 8 символів" required/>
            </>)}
          </div>
          <div className="rounded-xl border border-amber-100 bg-gradient-to-br from-amber-50/80 to-yellow-50/40 p-4 space-y-4">
            <h4 className="flex items-center gap-2 text-sm font-bold text-gray-800"><DollarSign size={14} className="text-amber-600"/>Оплата праці відразу при створенні</h4>
            <div><label className="mb-2 block text-xs font-medium text-gray-500">Тип нарахування</label><div className="grid grid-cols-3 gap-1.5">
              {([{v:'only_rate' as SalaryMode,l:'Тільки ставка',icon:<DollarSign size={13}/>},{v:'only_pct' as SalaryMode,l:'Тільки %',icon:<Percent size={13}/>},{v:'rate_and_pct' as SalaryMode,l:'Ставка + %',icon:<><DollarSign size={13}/><Percent size={13}/></>}]).map(opt=><button key={opt.v} type="button" onClick={()=>setAddForm({...addForm,salaryMode:opt.v})} className={`flex items-center justify-center gap-1 rounded-lg border px-2 py-2 text-xs font-medium transition-all ${addForm.salaryMode===opt.v?'border-amber-300 bg-amber-100 text-amber-800 shadow-sm':'border-gray-200 bg-white text-gray-500 hover:border-amber-200'}`}>{opt.icon}{opt.l}</button>)}
            </div></div>
            {addForm.salaryMode!=='only_pct'&&<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input label={`Ставка (грн/${addForm.rate_period==='day'?'день':'місяць'})`} type="number" min="0" step="0.01" value={addForm.base_rate} onChange={(e)=>setAddForm(f=>({...f,base_rate:e.target.value}))} placeholder={addForm.rate_period==='day'?'наприклад: 800':'наприклад: 15000'}/>
              <div><label className="block text-sm font-medium text-gray-700 mb-1">Період ставки</label><select value={addForm.rate_period} onChange={(e)=>setAddForm(f=>({...f,rate_period:e.target.value as 'day'|'month'}))} className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm bg-white"><option value="day">За робочий день</option><option value="month">За місяць</option></select></div>
            </div>}
            {addForm.salaryMode!=='only_rate'&&<div className="space-y-3 rounded-lg border border-amber-100/50 bg-white/70 p-3">
              <p className="text-xs font-semibold text-amber-700">Окремі правила за видом роботи</p>
              <div className="grid grid-cols-[minmax(0,1fr)_90px_90px] items-end gap-2 text-xs">
                <span className="pb-2 font-medium text-gray-600">Джерело</span><span className="pb-2 text-center text-gray-400">% виручки</span><span className="pb-2 text-center text-gray-400">% прибутку</span>
                <span className="font-medium text-gray-700">Продажі в касі</span><input type="number" min="0" max="100" step="0.1" value={addForm.pos_revenue} onChange={(e)=>setAddForm({...addForm,pos_revenue:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/><input type="number" min="0" max="100" step="0.1" value={addForm.pos_profit} onChange={(e)=>setAddForm({...addForm,pos_profit:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/>
                <span className="font-medium text-gray-700">Замовлення</span><input type="number" min="0" max="100" step="0.1" value={addForm.order_revenue} onChange={(e)=>setAddForm({...addForm,order_revenue:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/><input type="number" min="0" max="100" step="0.1" value={addForm.order_profit} onChange={(e)=>setAddForm({...addForm,order_profit:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/>
                <span className="font-medium text-gray-700">Шиномонтаж</span><input type="number" min="0" max="100" step="0.1" value={addForm.tire_revenue} onChange={(e)=>setAddForm({...addForm,tire_revenue:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/><input type="number" min="0" max="100" step="0.1" value={addForm.tire_profit} onChange={(e)=>setAddForm({...addForm,tire_profit:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-center"/>
              </div>
              <p className="text-[10px] text-gray-500">Нульове поле не створює правило. Проценти можна змінити пізніше в цій же картці працівника.</p>
            </div>}
          </div>
          <div className="flex gap-3 pt-1"><Button type="submit" loading={saving} className="flex-1">Створити з налаштуваннями оплати</Button><Button type="button" variant="secondary" onClick={()=>setAddOpen(false)}>Скасувати</Button></div>
          </fieldset>
        </form>
      </Modal>

      <ConfirmDialog open={deleteConfirmUser!==null} onClose={()=>{if(!saving)setDeleteConfirmUser(null)}} onConfirm={handleDeleteUser} title="Перенести працівника в архів" message={<>Вимкнути доступ для <strong>{deleteConfirmUser?.full_name}</strong>?<br/><span className="text-gray-600 text-xs mt-2 block">Продажі, зарплата та історія залишаться пов’язаними з цією карткою. За потреби її можна відновити в архіві працівників.</span></>} confirmLabel="В архів" danger/>
    </Layout>
  )
}

