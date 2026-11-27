import { SupplierApiCard } from '@/features/settings/SupplierApiCard'
import { PhotoAiSettingsCard } from '@/features/photoAi/PhotoAiSettingsCard'

/**
 * «Сайт → Налаштування → Ключі API» (27.11.2026, слово власника: «зроби в сайті налаштування і винесемо туди все, що
 * стосується налаштувань, у тому числі ключі API і ті, які я маю вставити від Серпера»).
 * Усі ключі, які вставляє власник, — в одному місці: постачальники з API (Омега, GPL) і пошук фото (Serper.dev).
 * Ключі зберігає лише сервер; назад видно тільки кінець ключа.
 */
export function SiteKeysTab() {
  return (
    <div className="max-w-4xl space-y-4" data-site-keys>
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-1 text-base font-semibold">Постачальники з API</h2>
        <p className="mb-3 text-xs text-gray-500">Товари постачальників під замовлення: ціна, склад, залишок. На склад магазину не додаються; на сайті показуються разом із нашими.</p>
        <SupplierApiCard />
      </section>
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-1 text-base font-semibold">Фото ШІ</h2>
        <p className="mb-3 text-xs text-gray-500">Пошук фото товарів в інтернеті: ключ Serper.dev і правила. Сам пошук — у картці товару й кнопкою «Фото ШІ» в «Товарах».</p>
        <PhotoAiSettingsCard />
      </section>
    </div>
  )
}
