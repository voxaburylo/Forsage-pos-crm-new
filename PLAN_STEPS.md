# ФОРСАЖ CRM/ERP — ПОКРОКОВИЙ ПЛАН РОЗРОБКИ

> ⚠️ **ЦЕЙ ПЛАН ЗАМІНЮЄ СТАРИЙ TASK_CHAIN_ROADMAP.md**
> Версія: 1.0 (адаптовано для DeepSeek Agent Mode)

---

## ЯК ПРАЦЮЄМО

1. **Я (DeepSeek) роблю**, ви перевіряєте
2. Кожен крок — це **конкретна зміна** (файл, компонент, endpoint)
3. Кроки **йдуть строго по порядку**
4. Кожен крок займає **1-2 години роботи**
5. Після кожного кроку ви **перевіряєте і говорите "ок"**
6. Якщо щось не так — ви **говорите що виправити**

---

## ФАЗА 0: ПІДГОТОВКА (виконується один раз)

**Крок 0.1:** Встановити Node.js + npm/pnpm
**Крок 0.2:** Створити Supabase проект (https://supabase.com)
**Крок 0.3:** Отримати Supabase URL + anon key + service role key
**Крок 0.4:** Налаштувати .env файл з ключами
**Крок 0.5:** Перевірити що проект запускається

---

## ФАЗА 1: КІСТЯК (Steps 1-6)

### Step 1: Ініціалізація проекту

**Що робимо:** Створюємо структуру проекту з package.json, tsconfig, базовим сервером і React app.

**Файли:**
- /package.json — кореневий з workspaces
- /server/package.json — Express.js
- /server/tsconfig.json
- /server/index.ts — запуск сервера
- /apps/web/package.json — React + Vite
- /apps/web/tsconfig.json
- /apps/web/vite.config.ts
- /apps/web/index.html
- /apps/web/src/main.tsx — ReactDOM.createRoot
- /apps/web/src/App.tsx — "Hello World"
- /apps/web/src/index.css — Tailwind
- /.env.example — шаблон змінних

**Перевірка:** pnpm dev → бачимо "Сервер запущено" + React сторінка

### Step 2: Supabase + міграція БД

**Що робимо:** Створюємо Supabase клієнт, запускаємо міграцію БД з таблицями MVP.

**Файли:**
- /server/src/db/index.ts — Supabase client
- /server/src/db/migrate.ts — запуск міграції
- /supabase/migrations/001_initial.sql — всі MVP таблиці
- /supabase/seed.sql — тестові дані

**Перевірка:** Запускаємо міграцію → таблиці створені в Supabase

### Step 3: Auth middleware + перший endpoint

**Що робимо:** JWT auth, реєстрація, логін, middleware.

**Файли:**
- /server/src/middlewares/auth.ts
- /server/src/middlewares/errorHandler.ts
- /server/src/routes/auth.ts
- /server/src/validators/authSchema.ts
- /server/src/types/express.d.ts

**Перевірка:** POST /api/auth/login → отримуємо JWT token

### Step 4: Base UI компоненти

**Що робимо:** Створюємо базові React компоненти: Button, Input, Modal, Table, Badge, Card, Toast.

**Файли:**
- /apps/web/src/components/ui/Button.tsx
- /apps/web/src/components/ui/Input.tsx
- /apps/web/src/components/ui/Modal.tsx
- /apps/web/src/components/ui/Table.tsx
- /apps/web/src/components/ui/Badge.tsx
- /apps/web/src/components/ui/Card.tsx
- /apps/web/src/components/ui/Toast.tsx
- /apps/web/src/components/ui/SearchInput.tsx
- /apps/web/src/components/ui/index.ts

**Перевірка:** Сторінка зі всіма компонентами → виглядають як в дизайні

### Step 5: Layout + Routing

**Що робимо:** Створюємо загальний лейаут (Sidebar, хедер), маршрутизацію, захист сторінок.

**Файли:**
- /apps/web/src/components/Layout.tsx
- /apps/web/src/components/Sidebar.tsx
- /apps/web/src/components/ProtectedRoute.tsx
- /apps/web/src/App.tsx — оновлюємо з роутами
- /apps/web/src/pages/LoginPage.tsx
- /apps/web/src/pages/POSPage.tsx
- /apps/web/src/pages/ProductsPage.tsx
- /apps/web/src/pages/CustomersPage.tsx
- /apps/web/src/pages/ReportsPage.tsx

**Перевірка:** Після логіна → бачимо сайдбар з пунктами

### Step 6: Store + API client

**Що робимо:** Zustand store для auth, API клієнт з токеном.

**Файли:**
- /apps/web/src/stores/authStore.ts
- /apps/web/src/stores/posStore.ts
- /apps/web/src/lib/api.ts
- /apps/web/src/lib/utils.ts

**Перевірка:** Auth store зберігає токен, API клієнт додає заголовки

---

## ФАЗА 2: ТОВАРИ (Steps 7-10)

### Step 7: Products API

**Що робимо:** CRUD для товарів + пошук.

**Файли:**
- /server/src/routes/products.ts
- /server/src/services/productService.ts
- /server/src/validators/productSchema.ts

**Перевірка:** GET /api/products?search=W712 → повертає товари

### Step 8: Products UI — список

**Що робимо:** Сторінка списку товарів з пошуком і таблицею.

**Файли:**
- /apps/web/src/features/products/ProductList.tsx
- /apps/web/src/features/products/ProductCard.tsx (у списку)

**Перевірка:** Відкриваємо /products → бачимо таблицю, працює пошук

### Step 9: Products UI — створення/редагування

**Що робимо:** Форма створення і редагування товару.

**Файли:**
- /apps/web/src/features/products/ProductForm.tsx
- /apps/web/src/features/products/productSchema.ts (zod)

**Перевірка:** Створюємо товар → з'являється в списку

### Step 10: Products UI — картка товару

**Що робимо:** Детальна картка з ціною, залишком, редагуванням.

**Файли:**
- /apps/web/src/features/products/ProductDetailPage.tsx

**Перевірка:** Клік по товару → бачимо картку

---

## ФАЗА 3: КЛІЄНТИ (Steps 11-13)

### Step 11: Customers API

**Що робимо:** CRUD для клієнтів.

**Файли:**
- /server/src/routes/customers.ts
- /server/src/services/customerService.ts
- /server/src/validators/customerSchema.ts

### Step 12: Customers UI

**Що робимо:** Список клієнтів, пошук, створення, картка.

**Файли:**
- /apps/web/src/features/customers/CustomerList.tsx
- /apps/web/src/features/customers/CustomerForm.tsx
- /apps/web/src/features/customers/CustomerCard.tsx

### Step 13: Quick Customer для POS

**Що робимо:** Модалка швидкого створення клієнта (тільки телефон + ім'я).

**Файли:**
- /apps/web/src/features/customers/QuickCustomerModal.tsx

---

## ФАЗА 4: POS — КАСА (Steps 14-20) ⭐ НАЙВАЖЛИВІШЕ

### Step 14: Shifts API

**Що робимо:** Відкриття/закриття зміни касира.

**Файли:**
- /server/src/routes/shifts.ts
- /server/src/services/shiftService.ts
- /server/src/validators/shiftSchema.ts

### Step 15: Sales API — створення продажу

**Що робимо:** Створення продажу з товарами, розрахунок ціни, зменшення залишку.

**Файли:**
- /server/src/routes/sales.ts
- /server/src/services/saleService.ts
- /server/src/validators/saleSchema.ts

### Step 16: POS Search Panel (React)

**Що робимо:** Панель пошуку товарів для POS (велике поле, результати).

**Файли:**
- /apps/web/src/features/pos/SearchPanel.tsx

### Step 17: POS Receipt Panel (React)

**Що робимо:** Панель чека з товарами, сумами, кількістю.

**Файли:**
- /apps/web/src/features/pos/ReceiptPanel.tsx

### Step 18: POS Payment Modal

**Що робимо:** Модалка оплати (готівка/картка/борг).

**Файли:**
- /apps/web/src/features/pos/PaymentModal.tsx

### Step 19: POS Zustand store

**Що робимо:** Стейт-менеджмент для POS (поточний чек, товари, клієнт).

**Файли:**
- /apps/web/src/stores/posStore.ts (оновлення)
- /apps/web/src/features/pos/usePOS.ts

### Step 20: POS Page — збірка

**Що робимо:** Головна POS сторінка, яка об'єднує всі панелі.

**Файли:**
- /apps/web/src/features/pos/POSPage.tsx (оновлення)

**ПЕРЕВІРКА ВСЬОГО POS:** Відкриваємо POS → шукаємо товар → додаємо в чек → оплачуємо → бачимо продаж в звіті

---

## ФАЗА 5: ПОВЕРНЕННЯ ТА ЗВІТИ (Steps 21-24)

### Step 21: Returns API

**Що робимо:** Просте повернення (повний чек).

**Файли:**
- /server/src/routes/returns.ts
- /server/src/services/returnService.ts

### Step 22: Returns UI

**Що робимо:** Форма повернення.

**Файли:**
- /apps/web/src/features/pos/ReturnForm.tsx

### Step 23: Reports API

**Що робимо:** Звіти продажів за день/період.

**Файли:**
- /server/src/routes/reports.ts
- /server/src/services/reportService.ts

### Step 24: Reports UI

**Що робимо:** Проста таблиця звіту.

**Файли:**
- /apps/web/src/features/reports/DailyReport.tsx

---

## ФАЗА 6: ШЛІФУВАННЯ (Steps 25-28)

### Step 25: Shift close UI

**Що робимо:** Екран закриття зміни з підрахунком готівки.

### Step 26: Друк чека

**Що робимо:** Кнопка друку чека (window.print для thermal printer).

### Step 27: Admin — користувачі

**Що робимо:** Сторінка керування користувачами (Owner/Admin).

### Step 28: Фінальне тестування

**Що робимо:** Перевіряємо всі флоу від початку до кінця.

---

## ПІСЛЯ MVP

Після MVP йдемо по розширенню функціоналу:

| # | Модуль | Приблизно |
|---|--------|-----------|
| 29 | Бонуси/Лояльність | Sprint 2 |
| 30 | Повний журнал постачальників | Sprint 3 |
| 31 | Audit log | Sprint 3 |
| 32 | Імпорт накладних | Sprint 4 |
| 33 | Telegram бот | Sprint 5 |
| 34 | Категорії + наценки | Sprint 5 |
| 35 | Друк етикеток | Sprint 6 |

