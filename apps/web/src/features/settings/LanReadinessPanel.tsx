import { useState } from 'react'
import { AlertTriangle, CheckCircle2, HelpCircle, ShieldCheck, Stethoscope } from 'lucide-react'
import { Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import type { DesktopLanCheck, DesktopLanDiagnosis } from '@/lib/desktopBridge'

interface LanReadinessApi {
  diagnose?: () => Promise<DesktopLanDiagnosis>
  allowFirewall?: () => Promise<DesktopLanDiagnosis>
}

function CheckIcon({ state }: { state: DesktopLanCheck['state'] }) {
  if (state === 'ok') return <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" aria-label="Гаразд" />
  if (state === 'problem') return <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" aria-label="Потрібна дія" />
  return <HelpCircle size={16} className="mt-0.5 shrink-0 text-amber-600" aria-label="Не вдалося перевірити" />
}

export function LanCheckList({ checks }: { checks: DesktopLanCheck[] }) {
  return (
    <ul className="space-y-2">
      {checks.map(item => (
        <li key={item.id} className="flex gap-2 text-xs" data-lan-check={item.id} data-lan-state={item.state}>
          <CheckIcon state={item.state} />
          <span>
            <span className="block font-semibold text-gray-800">{item.title}</span>
            <span className="block leading-4 text-gray-600">{item.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Одна кнопка замість здогадок: що саме заважає другому ПК підключитися.
 * Перевірка лише читає стан; брандмауер змінює сама Windows після свого запиту.
 */
export function LanReadinessPanel({ lan }: { lan: LanReadinessApi }) {
  const [diagnosis, setDiagnosis] = useState<DesktopLanDiagnosis | null>(null)
  const [checking, setChecking] = useState(false)
  const [allowing, setAllowing] = useState(false)
  if (!lan.diagnose) return null

  async function check() {
    setChecking(true)
    try { setDiagnosis(await lan.diagnose!()) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Не вдалося перевірити мережу') }
    finally { setChecking(false) }
  }

  async function allow() {
    setAllowing(true)
    try {
      const next = await lan.allowFirewall!()
      setDiagnosis(next)
      const firewall = next.checks.find(item => item.id === 'firewall')
      if (firewall?.state === 'ok') toast.success('Windows дозволила підключення в локальній мережі')
      else toast.warning('Правило додано, але перевірка його ще не бачить. Натисніть «Перевірити готовність» ще раз.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося змінити брандмауер')
    } finally { setAllowing(false) }
  }

  async function copyCommand() {
    if (!diagnosis?.firewallCommand) return
    await navigator.clipboard.writeText(diagnosis.firewallCommand)
    toast.success('Команду скопійовано. Виконайте її в PowerShell від імені адміністратора.')
  }

  const firewallProblem = diagnosis?.checks.some(item => item.id === 'firewall' && item.state !== 'ok') ?? false

  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4" data-lan-readiness>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" loading={checking} onClick={check}>
          <Stethoscope size={15} /> Перевірити готовність
        </Button>
        {diagnosis && (
          <span role="status" className={`text-xs font-semibold ${diagnosis.ready ? 'text-emerald-700' : 'text-red-700'}`}>
            {diagnosis.ready ? 'Усе готово: другий ПК може підключатися' : 'Є що виправити — дивіться нижче'}
          </span>
        )}
      </div>
      {!diagnosis && <p className="text-[11px] leading-4 text-gray-500">Якщо другий ПК не знаходить цей або не підключається, перевірка назве причину й підкаже, що зробити.</p>}
      {diagnosis && <LanCheckList checks={diagnosis.checks} />}
      {diagnosis && firewallProblem && diagnosis.firewallCommand && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 p-3">
          {diagnosis.canAllowFirewall && lan.allowFirewall && (
            <Button type="button" loading={allowing} onClick={allow}>
              <ShieldCheck size={15} /> Дозволити в брандмауері
            </Button>
          )}
          <button type="button" onClick={copyCommand} className="text-xs text-gray-700 underline">Скопіювати команду для адміністратора</button>
          <p className="w-full text-[11px] leading-4 text-amber-900">Windows покаже власний запит на підтвердження. Дозвіл діє лише для комп’ютерів локальної мережі та не зникає після оновлення програми.</p>
        </div>
      )}
    </div>
  )
}
