# PROJECT CONTEXT — Форсаж CRM/ERP

**Вставляти першим у кожну AI-сесію разом із SESSION_START_PROMPT.md**

---

## Що це за проект

Повна система управління магазином автозапчастин "Форсаж".
Канали: фізична точка + Telegram + сайт (майбутнє) + опт.
Режими: роздріб, замовлення під клієнта, оптові продажі.

---

## Архітектура

| Шар | Технологія |
|---|---|
| Монорепо | Turborepo + pnpm |
| Frontend | React 18 + TypeScript + Vite + Zustand + Tailwind |
| POS Desktop | Electron (обгортка над React) |
| Backend | Node.js + Express.js + TypeScript |
| Database | Supabase PostgreSQL + RLS |
| Storage | Supabase Storage (фото товарів, вкладення) |
| Edge Functions | Supabase Functions (Telegram bot, вебхуки) |
| Shared | @packages/ui, @packages/types, @packages/api-client |

---

## Структура репозиторію

```
/apps/web           — React CRM (адмінка, каталог, замовлення)
/apps/desktop       — Electron POS (каса)
/packages/ui        — спільні компоненти (Форсаж дизайн-система)
/packages/types     — спільні TypeScript типи
/packages/api-client — HTTP клієнт для frontend
/server             — Express.js API
/supabase           — міграції, seeds, edge functions
/docs               — вся документація
/repo_embedded      — контекст для AI сесій
```

---

## Модулі системи

| # | Модуль | Статус |
|---|---|---|
| 1 | Auth / Ролі | planned |
| 2 | Товари + пошук | planned |
| 3 | Склад + приймання | planned |
| 4 | **Імпорт накладної** (розумний парсер) | planned |
| 5 | POS / Каса | planned |
| 6 | **Ціноутворення** (рівні, об'єм, наценка) | planned |
| 7 | Клієнти CRM | planned |
| 8 | **Лояльність + бонуси** | planned |
| 9 | **Ризик-профіль клієнта** | planned |
| 10 | **Нотатки до клієнта** | planned |
| 11 | Замовлення під клієнта | planned |
| 12 | Оплати / Ledger | planned |
| 13 | **Повернення від клієнта** | planned |
| 14 | **Гарантія** (клієнт → ви → постачальник) | planned |
| 15 | Постачальники + **Журнал** (закупки/повернення/гарантія) | planned |
| 16 | Резервування товару | planned |
| 17 | Messaging (Telegram bot + CRM відповідь) | planned |
| 18 | VIN OCR + Підбір | planned |
| 19 | Звіти + Аналітика | planned |
| 20 | **Дашборд власника** | planned |
| 21 | **Лог дій персоналу** (Audit Trail) | planned |
| 22 | **Захист** (антидублікат, мін. залишок, PIN) | planned |
| 23 | **Друк етикеток** | planned |
| 24 | **Авто-нагадування** (Telegram тригери) | planned |
| 25 | Адмін / Налаштування | planned |

---

## Ключові технічні правила

```
✓ tenant_id на КОЖНІЙ таблиці (мультитенантність)
✓ deleted_at на КОЖНІЙ бізнес-таблиці (м'яке видалення)
✓ Гроші = INTEGER копійки (1 грн = 100 коп). НІКОЛИ float
✓ Кількість = NUMERIC(12,3)
✓ RLS policy на кожній таблиці
✓ Zod валідація на кожному ендпоінті
✓ TypeScript strict mode, без any
✓ Без console.log в коді (структурований logger)
✓ Параметризовані SQL запити, без конкатенації
✓ Auth middleware на кожному ендпоінті
✓ Мова UI: українська. Мова коду: англійська
```

---

## Бренд Форсаж

```
Акцент:       #FFD000 (жовтий)
POS темна:    bg #1A1A1A, surface #2C2C2C
Логотип:      нахилена F +15°
Іконки:       lucide-react
Кнопки POS:   мінімум 56px висота
```

---

## Поточний стан

**Фаза:** [ОНОВЛЮВАТИ — наприклад "MVP Sprint 0: Foundation"]
**Остання задача:** [ОНОВЛЮВАТИ — наприклад "TASK-015"]
**Поточна задача:** [ОНОВЛЮВАТИ — наприклад "TASK-016"]
**Блокери:** [ОНОВЛЮВАТИ — наприклад "Немає"]

---

## Документація (читати перед кодуванням)

```
/docs/specs/SPEC_DATABASE.md            — повна схема БД з SQL
/docs/specs/SPEC_POS.md                 — логіка каси
/docs/specs/SPEC_PRODUCTS.md            — товари, пошук, аналоги
/docs/specs/SPEC_MODULES_ALL.md         — Auth, CRM, Склад, Замовлення, Оплати, Telegram, VIN
/docs/specs/SPEC_AUTOMOTIVE_LOGIC.md    — OEM, аналоги, підбір по VIN, ролі
/docs/specs/SPEC_PRICING.md             — ціноутворення, рівні, наценка ← НОВЕ
/docs/specs/SPEC_RETURNS.md             — повернення та гарантія ← НОВЕ
/docs/specs/SPEC_IMPORT_INVOICE.md      — імпорт накладної ← НОВЕ
/docs/specs/SPEC_SUPPLIER_JOURNAL.md    — журнал постачальників ← НОВЕ
/docs/specs/SPEC_PROTECTION_AUDIT.md    — захист і лог дій ← НОВЕ
/docs/specs/SPEC_LOYALTY_RISK_NOTES.md  — лояльність, ризики, нотатки ← НОВЕ
/docs/specs/SPEC_DESIGN_SYSTEM.md       — дизайн Форсаж ← НОВЕ
/docs/tasks/TASK_CHAIN_ROADMAP.md       — 300+ задач з критеріями
/docs/prompts/PROMPT_FACTORY.md         — шаблони промптів
/docs/qa/QA_CHECKLISTS.md               — чек-листи перевірки
/repo_embedded/SESSION_START_PROMPT.md  — майстер-промпт для сесії ← НОВЕ
```
