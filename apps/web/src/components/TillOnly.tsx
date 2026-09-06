import { Link } from 'react-router-dom'
import { Monitor } from 'lucide-react'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { Layout } from '@/components/Layout'
import { Card } from '@/components/ui'

/**
 * Розділи, які змінюють дані, у веб-версії не відкриваються.
 *
 * Рішення власника (06.09.2026): робоча база одна — та, що на касі. Через веб
 * можна дивитися продажі, аналітику, шукати й переглядати товари. Продавати,
 * правити картки, приймати накладні й робити ревізію — тільки на касі, звідти
 * зміни самі приїжджають на сервер.
 *
 * Причина не в недовірі, а в порядку: дві точки запису в одну базу неминуче
 * дають розбіжність — саме її ми ловили тижнями під виглядом «залишки не
 * сходяться».
 *
 * Сервер це теж стереже (`localFirstWriteGuard`), тож тут ідеться не про
 * захист, а про те, щоб людина не витрачала час на екран, який однаково не
 * збереже.
 */
export function TillOnly({ children, what }: { children: React.ReactNode; what: string }) {
  if (isDesktopRuntime()) return <>{children}</>

  return (
    <Layout>
      <div className="mx-auto max-w-lg py-10">
        <Card>
          <div className="flex flex-col items-center gap-4 px-6 py-8 text-center">
            <span className="rounded-full bg-amber-50 p-3 text-amber-600">
              <Monitor size={28} />
            </span>
            <div>
              <h1 className="text-lg font-semibold text-gray-900">{what} — тільки на касі</h1>
              <p className="mt-2 text-sm text-gray-600">
                Робоча база одна: вона на касі в магазині. Звідти всі зміни самі приїжджають сюди.
                Через веб можна дивитися продажі й аналітику, шукати товари та переглядати картки.
              </p>
            </div>
            <Link
              to="/analytics"
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
            >
              До аналітики
            </Link>
          </div>
        </Card>
      </div>
    </Layout>
  )
}
