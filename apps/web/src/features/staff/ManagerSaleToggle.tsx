import { useEffect, useState } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'
import { toast } from '@/components/ui/Toast'
import { roleRights, roleSwitches } from './staffRights'

/**
 * 21.11.2026 (рішення власника): менеджер продає лише з дозволу власника.
 * Перемикач діє одразу (не чекає «Зберегти») і зберігається в базі головного ПК.
 */
/**
 * 22.11.2026 (рішення власника): «Може приймати задаток» — менеджер відкриває свою зміну й приймає
 * передоплату та оплату замовлень, але не продає з каси. Якщо ввімкнено «Може продавати», цей дозвіл уже входить у нього.
 */
export function ManagerDepositToggle({ userId }: { userId: string }) {
  const staff = desktopBridge()?.staff
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setAllowed(null)
    staff?.depositAccess?.().then(ids => { if (!cancelled) setAllowed(ids.includes(userId)) }).catch(() => { if (!cancelled) setAllowed(false) })
    return () => { cancelled = true }
  }, [staff, userId])

  if (!staff?.depositAccess || !staff.setDepositAccess) return null

  async function change(next: boolean) {
    if (busy || !staff?.setDepositAccess) return
    setBusy(true)
    try {
      const ids = await staff.setDepositAccess(userId, next)
      setAllowed(ids.includes(userId))
      toast.success(next ? 'Менеджеру дозволено приймати задаток' : 'Приймання задатку для менеджера вимкнено')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося змінити дозвіл')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex items-start gap-3 pt-1">
      <input type="checkbox" id={`deposit_access_${userId}`} checked={allowed === true} disabled={allowed === null || busy}
        onChange={(event) => void change(event.target.checked)} className="mt-0.5 w-4 h-4 rounded text-amber-500 focus:ring-amber-300" />
      <label htmlFor={`deposit_access_${userId}`} className="text-sm text-gray-700">
        <span className="font-medium">Може приймати задаток</span>
        <span className="block text-xs text-gray-500">Своя зміна, передоплата й оплата замовлень. Продаж із каси, повернення й касові операції — лише з «Може продавати». Діє одразу.</span>
      </label>
    </div>
  )
}

/**
 * 23.11.2026 (план B3): касир працює через веб лише з цим дозволом. Права у вебі — ті самі, що в нього на касі
 * (прихід, ревізія, товари, клієнти); продаж і гроші в касі з вебу закриті для всіх.
 */
export function WebWorkToggle({ userId }: { userId: string }) {
  const staff = desktopBridge()?.staff
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setAllowed(null)
    staff?.webAccess?.().then(ids => { if (!cancelled) setAllowed(ids.includes(userId)) }).catch(() => { if (!cancelled) setAllowed(false) })
    return () => { cancelled = true }
  }, [staff, userId])

  if (!staff?.webAccess || !staff.setWebAccess) return null

  async function change(next: boolean) {
    if (busy || !staff?.setWebAccess) return
    setBusy(true)
    try {
      const ids = await staff.setWebAccess(userId, next)
      setAllowed(ids.includes(userId))
      toast.success(next ? 'Касиру дозволено працювати через веб' : 'Роботу через веб для касира вимкнено')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося змінити дозвіл')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex items-start gap-3 pt-1">
      <input type="checkbox" id={`web_access_${userId}`} checked={allowed === true} disabled={allowed === null || busy}
        onChange={(event) => void change(event.target.checked)} className="mt-0.5 w-4 h-4 rounded text-amber-500 focus:ring-amber-300" />
      <label htmlFor={`web_access_${userId}`} className="text-sm text-gray-700">
        <span className="font-medium">Працює через веб</span>
        <span className="block text-xs text-gray-500">З телефона чи з дому, коли головний ПК увімкнено: прихід, ревізія, товари, клієнти — те саме, що йому дозволено на касі. Продаж і гроші — лише на касі. Діє за кілька хвилин.</span>
      </label>
    </div>
  )
}

export function ManagerSaleToggle({ userId }: { userId: string }) {
  const staff = desktopBridge()?.staff
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setAllowed(null)
    staff?.saleAccess?.().then(ids => { if (!cancelled) setAllowed(ids.includes(userId)) }).catch(() => { if (!cancelled) setAllowed(false) })
    return () => { cancelled = true }
  }, [staff, userId])

  if (!staff?.saleAccess || !staff.setSaleAccess) return null

  async function change(next: boolean) {
    if (busy || !staff?.setSaleAccess) return
    setBusy(true)
    try {
      const ids = await staff.setSaleAccess(userId, next)
      setAllowed(ids.includes(userId))
      toast.success(next ? 'Менеджеру дозволено продавати' : 'Продаж для менеджера вимкнено')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося змінити дозвіл')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex items-start gap-3 pt-1">
      <input type="checkbox" id={`sale_access_${userId}`} checked={allowed === true} disabled={allowed === null || busy}
        onChange={(event) => void change(event.target.checked)} className="mt-0.5 w-4 h-4 rounded text-amber-500 focus:ring-amber-300" />
      <label htmlFor={`sale_access_${userId}`} className="text-sm text-gray-700">
        <span className="font-medium">Може продавати</span>
        <span className="block text-xs text-gray-500">Каса, відкриття й закриття зміни, оплата замовлень, повернення. Діє одразу, і на ПК менеджера теж.</span>
      </label>
    </div>
  )
}

/**
 * 24.11.2026 (власник): блок «Права» в картці працівника — що дозволяє роль, що закрито, і перемикачі в одному місці.
 * Перемикачі зберігає головний ПК; без звʼязку з ним (веб у режимі перегляду) показуємо підказку замість них.
 */
export function StaffRightsBlock({ userId, role, savedRole }: { userId: string; role: string; savedRole: string }) {
  const rights = roleRights(role)
  const switches = roleSwitches(role)
  const online = Boolean(desktopBridge()?.staff?.webAccess)
  return (
    <div className="bg-blue-50/60 rounded-xl p-4 space-y-3 border border-blue-100" data-staff-rights={role}>
      <h4 className="text-sm font-bold text-gray-800">Права</h4>
      {rights.can.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-emerald-800">Дозволено за роллю</p>
          <ul className="mt-1 space-y-0.5 text-sm text-gray-700">{rights.can.map(line => <li key={line}>✓ {line}</li>)}</ul>
        </div>
      )}
      {rights.cannot.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-600">Закрито</p>
          <ul className="mt-1 space-y-0.5 text-sm text-gray-500">{rights.cannot.map(line => <li key={line}>— {line}</li>)}</ul>
        </div>
      )}
      {switches.length > 0 && (
        <div className="space-y-2 border-t border-blue-100 pt-3">
          <p className="text-xs font-semibold text-gray-700">Вмикає власник</p>
          {role !== savedRole
            ? <p className="text-xs text-amber-800">Спершу збережіть нову роль — перемикачі зʼявляться після збереження.</p>
            : !online
              ? <p className="text-xs text-amber-800">Перемикачі доступні, коли головний ПК увімкнено й на звʼязку.</p>
              : <>
                {switches.includes('web') && <WebWorkToggle userId={userId} />}
                {switches.includes('sale') && <ManagerSaleToggle userId={userId} />}
                {switches.includes('deposit') && <ManagerDepositToggle userId={userId} />}
              </>}
        </div>
      )}
      <p className="text-xs text-gray-500">Інші права дає роль: змініть «Роль» у профілі вище.</p>
    </div>
  )
}
