# Форсаж CRM/ERP — МАЙСТЕР-СПЕЦИФІКАЦІЯ

> ⚠️ **ЦЕЙ ФАЙЛ ЗАМІНЮЄ ВСІ СТАРІ SPEC ФАЙЛИ**
> Версія: 1.0 (виправлена після аудиту)
> Дата: 2026-05-07

---

## 1. ПРО ПРОЕКТ

### 1.1 Що це таке

CRM/ERP система для магазину автозапчастин "Форсаж" (Україна).
Замінює Excel + зошити + Telegram на єдину систему.

### 1.2 Хто користується

| Роль | Доступ | Опис |
|------|--------|------|
| **Owner** (власник) | Все | Створює магазин, бачить всю аналітику, підтверджує оверрайди |
| **Admin** | Все крім налаштувань тенанта | Керує користувачами, цінами, довідниками |
| **Manager** | CRM, замовлення, клієнти | Працює з клієнтами, замовленнями, постачальниками |
| **Cashier** | POS + клієнти | Тільки продажі, створення клієнтів |
| **Storekeeper** | Склад + приймання | Приймання товару, інвентаризація, списання |
| **STO Viewer** | Тільки перегляд | СТО дивиться наявність і ціни |

### 1.3 Технологічний стек (НЕ ЗМІНЮВАТИ)

| Компонент | Технологія | Чому |
|-----------|------------|------|
| Frontend | React 18 + TypeScript + Vite | Швидкий, популярний, AI-friendly |
| State | Zustand | Легкий, без boilerplate |
| CSS | Tailwind CSS 4 | Швидка розробка |
| UI компоненти | Самописні (@/components/ui/) | shadcn/ui — занадто багато залежностей |
| Іконки | lucide-react | Краща бібліотека іконок |
| Backend | Express.js + TypeScript | AI-френдлі, багато прикладів |
| Database | Supabase PostgreSQL | Managed, RLS, Realtime |
| Auth | Supabase Auth + JWT | Вбудовано в Supabase |
| Forms | react-hook-form + zod | Валідація на обох кінцях |
| Дати | date-fns | Легкий, tree-shakable |
| Графіки | recharts | Прості звіти |
| Хостинг | Railway або VPS (визначити пізніше) |

### 1.4 Структура проекту

`
/crm-forsage/
├── apps/
│   └── web/                     # React SPA (адмінка + POS)
│       ├── src/
│       │   ├── components/      # Загальні React компоненти
│       │   │   └── ui/          # Базові UI (Button, Input, Modal...)
│       │   ├── features/        # Фічі (sales/, products/, customers/)
│       │   │   ├── pos/         # POS каса
│       │   │   ├── products/    # Товари
│       │   │   ├── customers/   # Клієнти CRM
│       │   │   ├── orders/      # Замовлення
│       │   │   ├── inventory/   # Склад
│       │   │   ├── payments/    # Платежі
│       │   │   ├── reports/     # Звіти
│       │   │   └── admin/       # Адмінка
│       │   ├── hooks/           # Кастомні хуки
│       │   ├── lib/             # Утиліти, API клієнт
│       │   ├── stores/          # Zustand store
│       │   ├── types/           # Локальні типи
│       │   ├── App.tsx
│       │   └── main.tsx
│       └── package.json
├── server/                      # Express.js API
│   ├── src/
│   │   ├── middlewares/         # auth, validation, error handler
│   │   ├── routes/              # Маршрути (products, sales...)
│   │   ├── services/            # Бізнес-логіка
│   │   ├── validators/          # Zod схеми
│   │   ├── db/                  # Supabase client, queries
│   │   └── types/               # Типи
│   ├── index.ts                 # Вхідна точка
│   └── package.json
├── supabase/
│   ├── migrations/              # Нумеровані SQL міграції
│   └── seed.sql                 # Початкові дані
└── package.json                 # Кореневий (workspaces)
`

### 1.5 Ключові правила (НЕ ПОРУШУВАТИ)

**БД:**
- Кожна таблиця має: 	enant_id UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ
- Гроші: **ТІЛЬКИ INTEGER в копійках**. Ніколи float, ніколи decimal для грошей
- Кількість товару: NUMERIC(12,3). Ніколи INTEGER для qty
- Soft delete через deleted_at IS NULL. Ніколи фізичне DELETE
- RLS policy на кожній таблиці
- Всі міграції — нумеровані файли

**Код:**
- TypeScript strict mode. Ніколи ny без коментаря
- Ніколи console.log — тільки structured logger
- Ніколи SQL конкатенація — тільки параметризовані запити
- Zod валідація на кожному API endpoint
- Кожен endpoint потребує auth middleware
- tenant_id фільтрація в кожному запиті до БД
- Error format: { error: { code, message, status, details? } }

**UI:**
- Мова інтерфейсу: **УКРАЇНСЬКА** (лейбли, кнопки, помилки)
- Код і коментарі: **АНГЛІЙСЬКА**
- Акцентний колір: #FFD000 (жовтий Форсаж)
- POS темна тема: bg #1A1A1A, surface #2C2C2C
- Іконки: lucide-react (не font-awesome, не heroicons)
- Кнопки POS: мінімум 56px висота

---

## 2. MVP — МІНІМАЛЬНО ЖИТТЄЗДАТНИЙ ПРОДУКТ

### 2.1 Що входить в MVP

MVP = система, якою можна реально працювати в магазині.

| Модуль | Входить? | Чому |
|--------|----------|------|
| Auth + ролі | ✅ ТАК | Без цього ніяк |
| Товари (CRUD + пошук) | ✅ ТАК | Основа всього |
| POS каса | ✅ ТАК | Головний інструмент |
| Клієнти (швидке створення) | ✅ ТАК | Продаж без клієнта неможливий |
| Звіти (продажі за день) | ✅ ТАК | Власник бачить гроші |
| Зміни касира | ✅ ТАК | Облік готівки |
| Повернення | ✅ ТАК | Без цього не можна |
| **Бонуси/Лояльність** | ❌ НІ | Відкладено на Expansion |
| **Telegram інтеграція** | ❌ НІ | Вручну, через адмінку |
| **VIN/OCR** | ❌ НІ | Рідко потрібно |
| **Імпорт накладних** | ❌ НІ | Вводити вручну |
| **PRRO (фіскалізація)** | ❌ НІ | Тільки не-фіскальні чеки |
| **Мультитенантність** | ❌ НІ | Один магазин поки що |
| **Electron Desktop** | ❌ НІ | Тільки Web |

### 2.2 Спрощення в MVP

| Аспект | Як спрощено |
|--------|-------------|
| POS | Тільки Web (React), без Electron |
| Пошук товарів | Тільки по тексту (без OCR/VIN) |
| Клієнти | Тільки телефон + ім'я, мінімум полів |
| Звіти | Тільки базова таблиця, без графіків |
| Чек | Простий HTML-чекант для друку |
| Безпека | Базова jwt auth, без audit log |
| Налаштування | Hardcoded значення, без UI |

### 2.3 Чого НЕ буде навіть в MVP (але в специфікації є)

- Електронна каса (Desktop)
- Telegram/Viber боти
- VIN розпізнавання
- Програма лояльності
- Імпорт накладних (розумний парсер)
- Журнал постачальників (повний)
- Захист від дублікатів
- Повний audit log
- Автоматичні сповіщення
- Друк етикеток (тільки чек)
- Мобільна версія

---

## 3. ДЕТАЛЬНА СПЕЦИФІКАЦІЯ MVP

### 3.1 AUTH (Вхід і ролі)

**Ендпоінти:**
`
POST /api/auth/login        — Вхід по телефону + пароль
POST /api/auth/register     — Реєстрація (Owner створює користувачів)
POST /api/auth/refresh      — Оновити JWT токен
POST /api/auth/logout       — Вийти
`

**Як це працює:**
1. Користувач вводить телефон + пароль
2. Сервер перевіряє через Supabase Auth
3. JWT містить: { sub: user_id, role: "cashier", tenant_id: "uuid" }
4. Access token живе 15 хв, refresh token — 7 днів
5. Кожен запит: Authorization: Bearer <token>
6. Middleware перевіряє token і роль

**Сторінки UI:**
- /login — форма входу (телефон + пароль)
- Після входу — редірект на POS (cashier) або дашборд (owner/admin)

### 3.2 ТОВАРИ (PRODUCTS)

**Що можна робити:**
- Створити товар (артикул, назва, ціна, категорія, кількість)
- Шукати товар (по артикулу, назві, штрих-коду)
- Редагувати товар
- Переглянути картку товару (ціна, залишок, історія)

**Спрощена БД для MVP:**
`sql
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  sku             VARCHAR(50) NOT NULL,     -- артикул
  name            VARCHAR(500) NOT NULL,    -- назва
  barcode         VARCHAR(100),             -- штрих-код
  category_id     UUID REFERENCES categories(id),
  purchase_price  INTEGER NOT NULL DEFAULT 0,  -- копійки
  retail_price    INTEGER NOT NULL DEFAULT 0,  -- копійки
  qty_on_hand     NUMERIC(12,3) NOT NULL DEFAULT 0,
  reorder_point   NUMERIC(12,3) NOT NULL DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE(tenant_id, sku)
);
`

**Ендпоінти:**
`
GET    /api/products?search=&category=&page=&per_page=  — Список/пошук
GET    /api/products/:id                                — Деталі
POST   /api/products                                    — Створити
PUT    /api/products/:id                                — Оновити
DELETE /api/products/:id                                — Видалити (soft)
`

**Пошук:**
- ?search=W712 — шукає по sku, name, barcode
- ILIKE '%' + search + '%'
- Результат: id, sku, name, retail_price, qty_on_hand

**UI: Список товарів**
`
+------------------------------------------------------------------+
| 🔍 [Пошук товару...                          ] [Новий товар +]  |
+------------------------------------------------------------------+
| Артикул  | Назва              | Ціна    | Залишок | Статус      |
|----------|-------------------|---------|---------|-------------|
| W712     | Фільтр Mann W712  | 450 грн |    12   | 🟢 є        |
| 5W40-4L  | Масло Castrol 5W40| 680 грн |     0   | 🔴 нема     |
+------------------------------------------------------------------+
`

**UI: Картка товару**
`
+------------------------------------------------------------------+
| Фільтр Mann W712                      [Редагувати] [Видалити]   |
| Артикул: W712  |  ШК: 4011558...                                |
+------------------------------------------------------------------+
| Категорія: Фільтри                                              |
| Ціна закупівлі: 220 грн                                         |
| Ціна продажу:   450 грн                                         |
| Залишок: 12 шт  |  Мінімум: 5 шт                               |
| Нотатка: ___________________________________                     |
+------------------------------------------------------------------+
`

### 3.3 POS — КАСА

**Це найважливіший модуль MVP.**

**Логіка роботи:**
1. Касир бачить екран: зліва — чек, справа — пошук товарів
2. Сканує штрих-код або вводить назву
3. Товар додається в чек
4. Кнопки: [Cash] [Card] [Split] [Debt]
5. Після оплати — чек збережено, залишок зменшено

**Спрощена БД для MVP:**
`sql
CREATE TABLE sales (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  sale_number   VARCHAR(50) NOT NULL,
  customer_id   UUID REFERENCES customers(id),
  cashier_id    UUID NOT NULL REFERENCES users(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'completed', -- completed, returned, voided
  subtotal      INTEGER NOT NULL DEFAULT 0,   -- копійки
  discount      INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  payment_method VARCHAR(20) NOT NULL,  -- cash, card, split
  is_debt       BOOLEAN DEFAULT false,
  notes         TEXT,
  shift_id      UUID REFERENCES shifts(id),
  completed_at  TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE(tenant_id, sale_number)
);

CREATE TABLE sale_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  sale_id       UUID NOT NULL REFERENCES sales(id),
  product_id    UUID NOT NULL REFERENCES products(id),
  qty           NUMERIC(12,3) NOT NULL,
  unit_price    INTEGER NOT NULL,       -- ціна на момент продажу
  total         INTEGER NOT NULL,       -- qty * unit_price
  created_at    TIMESTAMPTZ DEFAULT now()
);
`

**Ендпоінти POS:**
`
POST   /api/sales                    — Створити продаж
GET    /api/sales/current            — Поточний чек
POST   /api/sales/calculate-price    — Розрахувати ціну для товару
GET    /api/products/search?q=       — Пошук для POS
POST   /api/shifts/open              — Відкрити зміну
POST   /api/shifts/:id/close         — Закрити зміну
GET    /api/shifts/current           — Поточна зміна
`

**POS екран (ASCII макет):**
`
┌─────────────────────────────────────────────────────────────┐
│ [Ф] Форсаж   Зміна #42   Іванов І.            [💰 12 450] │
├────────────────────────┬────────────────────────────────────┤
│  ПОШУК                 │  ЧЕК #00234                       │
│  [🔍 W712____________] │  ────────────────────────────     │
│                        │  Фільтр Mann W712   x1   450 грн  │
│  РЕЗУЛЬТАТИ:           │  Прокладка піддону  x2    80 грн  │
│  ┌────────────────┐    │  ────────────────────────────     │
│  │ Mann W712      │    │  Сума:                 530 грн    │
│  │ Фільтр олійний │    │  До оплати:            530 грн    │
│  │ 450 грн   ● 12 │    │                                    │
│  └────────────────┘    │  [ГОТІВКА] [КАРТКА] [БОРГ]        │
│                        │  [ЗНИЖКА] [ПРИБРАТИ] [✓ ОПЛАТА]  │
│  [Зупинити чек]       │                                    │
│  [Новий чек]          │                                    │
└────────────────────────┴────────────────────────────────────┘
`

**Правила POS:**
- Фокус завжди на полі пошуку (можна сканувати без кліка)
- Esc — очистити пошук
- Enter — додати перший результат в чек (qty=1)
- + / - — збільшити/зменшити кількість
- Delete — видалити рядок з чека
- F8 — оплата (швидка кнопка)
- При оплаті готівкою: ввести суму → показати здачу
- При нестачі товару: попередження, але продати можна

### 3.4 КЛІЄНТИ (CUSTOMERS)

**Мінімум для MVP:**
- Швидке створення при продажу (тільки телефон + ім'я)
- Перегляд історії покупок клієнта
- Пошук клієнта по телефону

**Спрощена БД:**
`sql
CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  phone         VARCHAR(20) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  debt_balance  INTEGER NOT NULL DEFAULT 0,  -- копійки
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE(tenant_id, phone)
);
`

**Ендпоінти:**
`
GET    /api/customers?search=       — Пошук по телефону/імені
POST   /api/customers               — Створити
POST   /api/customers/quick         — Швидке створення (телефон + ім'я)
GET    /api/customers/:id           — Деталі + історія покупок
GET    /api/customers/:id/debts     — Борги клієнта
`

### 3.5 ЗМІНИ (SHIFTS)

**Логіка:**
- Касир не може продавати без відкритої зміни
- Зміна відкривається з початковим залишком готівки
- В кінці дня — закриття зміни з підрахунком
- Розбіжність > 10 грн вимагає коментаря

`sql
CREATE TABLE shifts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  cashier_id      UUID NOT NULL REFERENCES users(id),
  status          VARCHAR(20) DEFAULT 'open',  -- open, closed
  opening_cash    INTEGER DEFAULT 0,           -- копійки
  closing_cash    INTEGER,                     -- копійки
  expected_cash   INTEGER,                     -- розрахункова сума
  cash_variance   INTEGER,                     -- різниця
  opened_at       TIMESTAMPTZ DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
`

### 3.6 ЗВІТИ (REPORTS) — MVP

**Тільки базові:**
`
GET /api/reports/sales/today    — Продажі за сьогодні
GET /api/reports/sales/period   — Продажі за період (date_from, date_to)
GET /api/reports/shift/:id      — Звіт по зміні
`

**Формат відповіді:**
`json
{
  "total_sales": 24,
  "total_revenue_kopecks": 452000,
  "total_discount_kopecks": 12000,
  "by_method": {
    "cash": { "count": 15, "total": 280000 },
    "card": { "count": 7, "total": 140000 },
    "debt": { "count": 2, "total": 32000 }
  },
  "items": [
    { "time": "10:15", "number": "0001", "total": 45000, "method": "cash" }
  ]
}
`

### 3.7 ПОВЕРЕННЯ (RETURNS) — MVP

**Спрощена логіка:**
- Повне повернення всього чека (не часткове)
- Причина: брак, не та деталь, передумав
- Гроші назад: готівка або зменшення боргу
- Товар повертається на склад

`sql
CREATE TABLE returns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  sale_id         UUID NOT NULL REFERENCES sales(id),
  customer_id     UUID REFERENCES customers(id),
  reason          VARCHAR(50) NOT NULL,
  refund_amount   INTEGER NOT NULL,        -- копійки
  refund_method   VARCHAR(20) NOT NULL,    -- cash, debt_reduction
  status          VARCHAR(20) DEFAULT 'completed',
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
`

**Ендпоінти:**
`
POST /api/returns                  — Створити повернення
GET  /api/returns?sale_id=         — Отримати повернення по продажу
`

---

## 4. БАЗА ДАНИХ — ПОВНА СХЕМА

### 4.1 Конвенції

- Всі ID: UUID PRIMARY KEY DEFAULT gen_random_uuid()
- Всі таблиці: 	enant_id UUID NOT NULL REFERENCES tenants(id)
- Всі дати: TIMESTAMPTZ (з часовим поясом)
- Гроші: INTEGER (копійки, 1 грн = 100 коп)
- Кількість: NUMERIC(12,3)
- Soft delete: deleted_at TIMESTAMPTZ
- Foreign keys: ON DELETE RESTRICT

### 4.2 Таблиці MVP

`sql
-- ============================================================
-- CORE
-- ============================================================

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(100) UNIQUE NOT NULL,
  settings    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer');

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  supabase_auth_id UUID UNIQUE,
  phone           VARCHAR(20) NOT NULL,
  email           VARCHAR(255),
  full_name       VARCHAR(255) NOT NULL,
  role            user_role NOT NULL DEFAULT 'cashier',
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE(tenant_id, phone)
);

-- ============================================================
-- PRODUCTS
-- ============================================================

CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  parent_id   UUID REFERENCES categories(id),
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(255) NOT NULL,
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  UNIQUE(tenant_id, slug)
);

CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  sku             VARCHAR(50) NOT NULL,
  name            VARCHAR(500) NOT NULL,
  barcode         VARCHAR(100),
  category_id     UUID REFERENCES categories(id),
  purchase_price  INTEGER NOT NULL DEFAULT 0,
  retail_price    INTEGER NOT NULL DEFAULT 0,
  qty_on_hand     NUMERIC(12,3) NOT NULL DEFAULT 0,
  reorder_point   NUMERIC(12,3) NOT NULL DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  notes           TEXT,
  photo_url       TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE(tenant_id, sku)
);

-- ============================================================
-- CUSTOMERS
-- ============================================================

CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  phone         VARCHAR(20) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  debt_balance  INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE(tenant_id, phone)
);

-- ============================================================
-- SALES & SHIFTS
-- ============================================================

CREATE TABLE shifts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  cashier_id      UUID NOT NULL REFERENCES users(id),
  status          VARCHAR(20) DEFAULT 'open',
  opening_cash    INTEGER DEFAULT 0,
  closing_cash    INTEGER,
  expected_cash   INTEGER,
  cash_variance   INTEGER,
  opened_at       TIMESTAMPTZ DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sales (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  sale_number     VARCHAR(50) NOT NULL,
  customer_id     UUID REFERENCES customers(id),
  cashier_id      UUID NOT NULL REFERENCES users(id),
  shift_id        UUID REFERENCES shifts(id),
  status          VARCHAR(20) NOT NULL DEFAULT 'completed',
  subtotal        INTEGER NOT NULL DEFAULT 0,
  discount        INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  payment_method  VARCHAR(20) NOT NULL,
  is_debt         BOOLEAN DEFAULT false,
  notes           TEXT,
  completed_at    TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE(tenant_id, sale_number)
);

CREATE TABLE sale_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  sale_id     UUID NOT NULL REFERENCES sales(id),
  product_id  UUID NOT NULL REFERENCES products(id),
  qty         NUMERIC(12,3) NOT NULL,
  unit_price  INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- RETURNS
-- ============================================================

CREATE TABLE returns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  sale_id         UUID NOT NULL REFERENCES sales(id),
  customer_id     UUID REFERENCES customers(id),
  reason          VARCHAR(50) NOT NULL,
  refund_amount   INTEGER NOT NULL,
  refund_method   VARCHAR(20) NOT NULL,
  status          VARCHAR(20) DEFAULT 'completed',
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
`

### 4.3 Індекси MVP

`sql
CREATE INDEX idx_products_search ON products(sku, name);
CREATE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_products_tenant ON products(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_customers_search ON customers(phone, name);
CREATE INDEX idx_customers_tenant ON customers(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_sales_tenant_date ON sales(tenant_id, created_at DESC);
CREATE INDEX idx_sales_customer ON sales(customer_id);
CREATE INDEX idx_sales_shift ON sales(shift_id);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
`

---

## 5. API — ПОВНИЙ ОПИС

### 5.1 Формат

**Запит:**
`
Authorization: Bearer <jwt_token>
Content-Type: application/json
X-Tenant-ID: <uuid>  (або з JWT)
`

**Успішна відповідь:**
`json
{
  "data": { ... },
  "meta": { "page": 1, "per_page": 20, "total": 100 }
}
`

**Помилка:**
`json
{
  "error": {
    "code": "PRODUCT_NOT_FOUND",
    "message": "Товар з таким ID не знайдено",
    "status": 404,
    "details": null
  }
}
`

### 5.2 Ендпоінти MVP (повний список)

`
# Auth
POST /api/auth/login                  # body: { phone, password }
POST /api/auth/register                # body: { phone, password, full_name, role }
POST /api/auth/refresh                 # body: { refresh_token }

# Products
GET    /api/products                   # query: search, category, page, per_page
GET    /api/products/:id               # 
POST   /api/products                   # body: { sku, name, barcode, category_id, purchase_price, retail_price, qty_on_hand, reorder_point }
PUT    /api/products/:id               # body: { name, barcode, ... }
DELETE /api/products/:id               # soft delete
PUT    /api/products/:id/stock         # body: { qty_on_hand } — корекція залишку

# Customers
GET    /api/customers                  # query: search, phone
POST   /api/customers                  # body: { phone, name }
POST   /api/customers/quick            # body: { phone, name } — швидке створення
GET    /api/customers/:id              #
GET    /api/customers/:id/sales        # історія покупок
PUT    /api/customers/:id              # body: { name, notes }

# Sales
POST   /api/sales                      # body: { items: [{ product_id, qty }], customer_id?, payment_method, cash_amount?, is_debt? }
GET    /api/sales/:id                  # деталі продажу
GET    /api/sales/:id/receipt          # чек для друку
GET    /api/sales/current              # поточні продажі (для звіту)
POST   /api/sales/calculate-price      # body: { product_id, customer_id? } → { unit_price }

# Shifts
POST   /api/shifts/open               # body: { opening_cash }
POST   /api/shifts/:id/close          # body: { closing_cash, notes? }
GET    /api/shifts/current            #
GET    /api/shifts/:id/sales          # продажі в цій зміні

# Returns
POST   /api/returns                    # body: { sale_id, reason, refund_method }
GET    /api/returns?sale_id=          #

# Reports
GET    /api/reports/sales/today       #
GET    /api/reports/sales/period      # query: date_from, date_to
`

---

## 6. UI ДИЗАЙН-СИСТЕМА

### 6.1 Кольори

`
#FFD000  — Акцент (жовтий Форсаж)
#1A1A1A  — POS фон
#2C2C2C  — POS картки
#F5F5F5  — Адмінка фон
#FFFFFF  — Адмінка картки

#22C55E  — Зелений (є в наявності)
#F59E0B  — Помаранчевий (мало)
#EF4444  — Червоний (немає, борг)
#3B82F6  — Синій (під замовлення)
#9CA3AF  — Сірий (архів)
`

### 6.2 Типографіка

`
Font: system-ui, -apple-system, sans-serif
Адмінка: 14px body, 18px H2, 24px H1
POS: 16px body, 32px ціна, 48px сума до оплати
Кнопки POS: min 56px height, 16px font
Кнопки нумпада: min 72×72px
`

### 6.3 Компоненти (базові)

- Button — primary (#FFD000), secondary, danger, ghost
- Input — text, number, search з іконкою
- Modal — slide-up анімація
- Table — сортування по колонках
- Select — кастомний з пошуком
- Badge — статус (зелений/жовтий/червоний)
- Card — поверхня з тінню
- Toast — сповіщення (успіх/помилка/попередження)
- SearchInput — з автопошуком (для POS)

---

## 7. ЩО НЕ ВВІЙШЛО В MVP (але є в старому ТЗ)

Ці модулі **ЗАДОКУМЕНТОВАНІ** для майбутнього, але НЕ будуть реалізовані в MVP:

| Модуль | Коли | Чому не зараз |
|--------|------|---------------|
| PRRO (фіскалізація) | Expansion | Складний API, рідко в автозапчастинах |
| Telegram бот | Sprint 8+ | Самодостатній модуль |
| Програма лояльності (бонуси) | Sprint 6+ | Не критично для старту |
| Імпорт накладних (розумний парсер) | Sprint 7+ | Складний алгоритм |
| Журнал постачальників (повний) | Sprint 5+ | Можна заповнювати вручну |
| Захист від дублікатів | Sprint 6+ | Косметика |
| Повний audit log | Sprint 4+ | Важливо, але не для MVP |
| Автосповіщення клієнтам | Sprint 8+ | Телеграм модуль |
| Друк етикеток | Sprint 5+ | Буде після товарів |
| Electron Desktop | Ніколи в найближчому | Web достатньо |
| Мультитенантність | SaaS фаза | Один магазин |
| VIN/OCR | Ніколи | Рідко потрібно |

---

## 8. СТРУКТУРА КОДУ — ДЕТАЛЬНО

### 8.1 Server (Express.js)

`
server/
├── index.ts                  # Express app + middleware
├── types/
│   ├── index.ts              # Загальні типи
│   ├── express.d.ts          # Розширення Express Request
│   └── supabase.ts           # Generated Supabase types
├── middlewares/
│   ├── auth.ts               # JWT перевірка
│   ├── roleGuard.ts          # Перевірка ролі
│   ├── validate.ts           # Zod валідація
│   └── errorHandler.ts       # Централізована обробка помилок
├── routes/
│   ├── auth.ts
│   ├── products.ts
│   ├── customers.ts
│   ├── sales.ts
│   ├── shifts.ts
│   ├── returns.ts
│   └── reports.ts
├── services/
│   ├── productService.ts     # Бізнес-логіка товарів
│   ├── saleService.ts        # Бізнес-логіка продажів
│   ├── customerService.ts
│   ├── shiftService.ts
│   └── reportService.ts
└── validators/
    ├── productSchema.ts      # Zod схеми
    ├── saleSchema.ts
    ├── customerSchema.ts
    └── shiftSchema.ts
`

### 8.2 Web App (React)

`
apps/web/src/
├── main.tsx                  # ReactDOM.createRoot
├── App.tsx                   # Router + Layout
├── index.css                 # Tailwind + глобальні стилі
├── components/
│   ├── ui/                   # Базові UI компоненти
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Modal.tsx
│   │   ├── Table.tsx
│   │   ├── Badge.tsx
│   │   ├── Card.tsx
│   │   ├── Select.tsx
│   │   ├── Toast.tsx
│   │   └── SearchInput.tsx
│   ├── Layout.tsx            # Загальний лейаут
│   ├── Sidebar.tsx           # Навігація
│   └── ProtectedRoute.tsx   # Захист маршрутів
├── features/
│   ├── pos/
│   │   ├── POSPage.tsx       # Головний POS екран
│   │   ├── ReceiptPanel.tsx  # Панель чека
│   │   ├── SearchPanel.tsx   # Пошук товарів
│   │   ├── PaymentModal.tsx  # Модалка оплати
│   │   ├── usePOS.ts         # Хук стану POS
│   │   └── posStore.ts       # Zustand store POS
│   ├── products/
│   │   ├── ProductList.tsx   # Список товарів
│   │   ├── ProductForm.tsx   # Створення/редагування
│   │   └── ProductCard.tsx   # Картка товару
│   ├── customers/
│   │   ├── CustomerList.tsx
│   │   ├── CustomerForm.tsx
│   │   └── CustomerCard.tsx
│   ├── sales/
│   │   └── SaleHistory.tsx   # Історія продажів
│   ├── reports/
│   │   └── DailyReport.tsx   # Заглушка звіту
│   └── admin/
│       └── UsersPage.tsx     # Керування користувачами
├── hooks/
│   ├── useAuth.ts
│   ├── useTenant.ts
│   └── useDebounce.ts
├── lib/
│   ├── api.ts               # API клієнт (fetch + auth)
│   ├── supabase.ts          # Supabase клієнт
│   └── utils.ts             # Форматування, константи
├── stores/
│   ├── authStore.ts         # Zustand auth
│   └── posStore.ts          # Zustand POS
└── types/
    └── index.ts             # Спільні типи
`

