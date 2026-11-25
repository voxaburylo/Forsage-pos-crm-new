# API Омеги — що є (прочитано 25.11.2026 зі swagger https://public.omega.page/swagger/docs/v1)

Усі методи — `POST https://public.omega.page/public/api/v1.0/...`, тіло JSON із полем `Key` (ключ лише в хмарі,
`supplier_api_connections`; ніколи у файлах і журналах). Відповідь: `{ Data, Success, Errors[] }`.
**Ліміт Омеги: 30 запитів/хв і/або 300/год — перевищення блокує обліковий запис.** У програмі всі виклики — лише через
лічильник `takeCall` (≤250/год, ≤20/хв), спільний для прайсу, фото й нового.

## Уже підключено
- `/profile/account` — доступ і підписка (у власника Access=Read, Gold).
- `/product/pricelist/paged` — увесь прайс сторінками: ProductId, Number, BrandDescription, Description/DescriptionUkr,
  Info, BarCode, Price, ImageUrl, **Rests[] (залишки по складах: Id, Key, Parent, Value)**, SupplierRests[] (під замовлення).
- `/product/image` — фото за ProductId (Gold), з водяним знаком OMEGA (власник 25.11: «не страшно»).

## Нове, корисне
- **`/product/getAllCrosses`** (Gold) — усі крос-номери/аналоги: запит `{ ProductId, Key }`, відповідь
  `[{ ProductId, Code, Brand, ReplacementType }]`. Один запит = один товар.
- **`/product/getTecDocCrosses`** (Gold) — крос-номери TecDoc, та сама форма.
- **`/product/details`** — опис товару пачкою: запит `{ ProductIdList: [..], Key }`, відповідь на кожен товар:
  `OECodeList [{ Code, CarModel }]` (оригінальні номери з моделлю авто), `ApplicabilityList` (дерево застосовності),
  `SpecificationList [{ Key, Value, Descr }]` (характеристики), BarCode. Суцільного тексту-опису немає.
- `/product/imagesInfo` (Gold) — список усіх фото товару (якщо їх кілька).
- `/searchcatalog/*` (Gold) — підбір за категоріями: шини, диски, АКБ, оливи, техрідини, лампи, оптика, ремені,
  підшипники, аксесуари… з фільтрами; у результаті є `Analogs`.

## Чого немає в опублікованому API
- Пошуку за артикулом/фразою (лише за внутрішнім ProductId Омеги — у нас він є: `supplier_offers.external_id`).
- Створення рахунку/замовлення: є лише кошик (`/basket/addProduct`, `/basket/getBasket`…) і робота з уже створеними
  рахунками (`/invoice8/*`). З ключем «лише читання» кошик, імовірно, недоступний — перевіряти лише зі згоди власника.

## Обмеження для планування
- Кроси — 1 запит на товар: для всіх 79 тис. товарів це ~2 тижні запитів. Тому кроси брати **на вимогу** (коли
  шукають артикул / відкривають товар) і зберігати; масово — лише для товарів, які ми продаємо (привʼязані картки).
- `details` — пачкою (кілька десятків ProductId за запит), але теж ділить спільний ліміт із прайсом і фото.
