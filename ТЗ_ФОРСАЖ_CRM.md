# ТЕХНИЧЕСКОЕ ЗАДАНИЕ
## CRM/ERP система для магазина автозапчастей "Форсаж"

**Версия:** 2.0 (после аудита)
**Дата:** 2026-05-07
**Статус:** Готово к разработке

---

## СОДЕРЖАНИЕ

1. [Общее описание системы](#1-общее-описание)
2. [Роли пользователей](#2-роли-пользователей)
3. [Функциональные требования — модули](#3-функциональные-требования)
4. [Нефункциональные требования](#4-нефункциональные-требования)
5. [Модель данных (БД)](#5-модель-данных)
6. [API — спецификация эндпоинтов](#6-api-спецификация)
7. [UI/UX требования](#7-uiux-требования)
8. [Безопасность](#8-безопасность)
9. [Технологический стек](#9-технологический-стек)
10. [Дорожная карта и приоритеты](#10-дорожная-карта)
11. [Критические правила разработки](#11-критические-правила)
12. [Аудит и найденные противоречия](#12-аудит-и-противоречия)

---

## 1. ОБЩЕЕ ОПИСАНИЕ

### 1.1 Назначение системы

**Форсаж CRM/ERP** — веб-система управления магазином автозапчастей. Заменяет ручной учёт в Excel, блокнотах и Telegram на единую цифровую систему.

**Цель:** Ускорить продажи, устранить ошибки учёта, дать владельцу полный контроль над бизнесом.

### 1.2 Что система решает

| Проблема (сейчас) | Решение (система) |
|---|---|
| Остатки в Excel — ошибки, дубли | Единая БД товаров с реальным остатком |
| Касса в блокноте — нет истории | POS с историей каждой продажи |
| Клиенты — в голове продавца | CRM с картой клиента и долгами |
| Поставщики — в Telegram | Журнал поставок с приходными накладными |
| Возвраты — ручной пересчёт | Автоматический возврат с восстановлением остатка |
| Отчёты — нет никаких | Дашборд по дням/неделям/месяцам |

### 1.3 Что система НЕ делает (MVP)

- ❌ Мультимагазинность — только один магазин
- ❌ Интернет-магазин (витрина для покупателей)
- ❌ Интеграция с маркетплейсами (Prom.ua, Rozetka)
- ❌ Мобильное приложение (только веб, адаптивный)
- ❌ Сканирование VIN / OCR накладных
- ❌ Telegram-бот для клиентов
- ❌ Учёт нескольких складов

---

## 2. РОЛИ ПОЛЬЗОВАТЕЛЕЙ

### 2.1 Матрица доступа

| Действие | Owner | Admin | Manager | Cashier | Storekeeper | STO Viewer |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Продажа (POS) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Просмотр остатков | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Просмотр цен | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Создание/редакт. товара | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Изменение цены | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Управление клиентами | ✅ | ✅ | ✅ | ✅ (только создание) | ❌ | ❌ |
| Просмотр истории продаж | ✅ | ✅ | ✅ | Свои | ❌ | ❌ |
| Возвраты | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Приёмка товара | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Инвентаризация | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Управление пользователями | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Отчёты и аналитика | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Настройки магазина | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Управление скидками | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Открытие/закрытие смены | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |

### 2.2 Описание ролей

**Owner (Владелец)** — создаёт учётную запись магазина. Видит всю аналитику, устанавливает политику скидок, управляет всеми пользователями. Единственный кто может изменять настройки магазина.

**Admin** — второй по уровню доступа. Управляет справочниками, ценами, пользователями. Не может менять настройки тенанта.

**Manager** — работает с клиентами, заказами, историей продаж. Может делать возвраты. Не меняет цены и не принимает товар.

**Cashier (Кассир)** — работает только с POS кассой. Открывает/закрывает смену, оформляет продажи, создаёт новых клиентов по телефону. Видит только свои смены.

**Storekeeper (Кладовщик)** — принимает товар от поставщиков, проводит инвентаризацию, списывает брак. Не имеет доступа к деньгам и отчётам.

**STO Viewer** — только чтение: смотрит наличие и цены. Нет возможности что-либо изменить.

---

## 3. ФУНКЦИОНАЛЬНЫЕ ТРЕБОВАНИЯ

### 3.1 МОДУЛЬ: POS КАССА ⭐ (ПРИОРИТЕТ 1)

**Описание:** Электронная касса для оформления продаж автозапчастей. Самый важный модуль — именно через него проходит весь товар и деньги.

#### 3.1.1 Рабочий процесс кассира

```
Начало дня:
  1. Кассир входит в систему
  2. Открывает смену — вводит начальный остаток наличных
  3. Система создаёт запись смены

Продажа:
  1. Кассир сканирует штрихкод ИЛИ вводит название/артикул
  2. Система находит товар и показывает: цену, остаток, название
  3. Кассир добавляет товар в чек (qty=1 по умолчанию)
  4. Может менять количество (+/-) и удалять строки
  5. Может добавить клиента (поиск по телефону или быстрое создание)
  6. Может применить скидку (только с разрешения роли)
  7. Выбирает метод оплаты: наличные / карта / в долг
  8. Система сохраняет продажу, уменьшает остаток товара
  9. Печатает чек (window.print для термо-принтера)

Конец дня:
  1. Кассир закрывает смену
  2. Вводит фактическую сумму наличных
  3. Система сравнивает с ожидаемой (расхождение = варіанс)
  4. Расхождение > 10 грн → обязательный комментарий
  5. Формируется отчёт по смене
```

#### 3.1.2 Требования к интерфейсу POS

- **Тёмная тема** (#1A1A1A фон) — для работы при искусственном освещении
- **Крупные кнопки** — минимум 56px высота, читать без очков
- **Фокус на поиске** — всегда, сразу можно сканировать
- **Горячие клавиши:**
  - `Enter` — добавить первый результат в чек
  - `Esc` — очистить поиск
  - `+` / `-` — изменить количество выбранной строки
  - `Delete` — удалить выбранную строку из чека
  - `F8` — открыть оплату

#### 3.1.3 Бизнес-правила POS

- Продажа невозможна без открытой смены
- Если товара нет в наличии — предупреждение, НО продать можно (отрицательный остаток допустим с подтверждением)
- Продажа "в долг" (борг) записывается на карточку клиента — клиент обязателен
- Скидку может применить только Manager/Admin/Owner
- Максимальная скидка по умолчанию — 20% (настраивается владельцем)
- Один кассир = одна активная смена одновременно

#### 3.1.4 Макет POS экрана

```
┌─────────────────────────────────────────────────────────────────┐
│ [Ф] ФОРСАЖ  │  Смена #042  │  Іваненко І.І.  │  💰 12 450 грн │
├──────────────────────────┬──────────────────────────────────────┤
│  ПОШУК ТОВАРУ            │  ЧЕК #00234                         │
│  ┌────────────────────┐  │  ──────────────────────────────     │
│  │ 🔍 W712___________│  │  Фільтр Mann W712    x1   450 грн   │
│  └────────────────────┘  │  Прокладка піддону   x2    80 грн   │
│                          │  Масло 5W30 4L        x1   320 грн  │
│  РЕЗУЛЬТАТИ:             │  ──────────────────────────────     │
│  ┌──────────────────┐    │  Сума:                   850 грн    │
│  │Mann W712         │    │  Знижка:                   0 грн    │
│  │Фільтр оливний    │    │  ДО ОПЛАТИ:             850 грн     │
│  │450 грн  ● 12 шт  │    │                                     │
│  ├──────────────────┤    │  ┌──────────┐ ┌──────────┐          │
│  │Knecht OX712      │    │  │ ГОТІВКА  │ │  КАРТКА  │          │
│  │Фільтр оливний    │    │  └──────────┘ └──────────┘          │
│  │420 грн  ● 5 шт   │    │  ┌──────────────────────┐          │
│  └──────────────────┘    │  │       БОРГ            │          │
│                          │  └──────────────────────┘          │
│  [Клієнт] [Знижка]       │  [СКИНУТИ ЧЕК]  [✓ ОПЛАТА F8]     │
└──────────────────────────┴──────────────────────────────────────┘
```

---

### 3.2 МОДУЛЬ: ТОВАРЫ И СКЛАД (ПРИОРИТЕТ 1)

#### 3.2.1 Карточка товара

Каждый товар содержит:
- **Артикул (SKU)** — уникальный в рамках магазина
- **Название** — полное
- **Штрихкод** — для сканера (может быть несколько)
- **Бренд** — производитель
- **Категория** — иерархическая (Фільтри → Оливні фільтри)
- **Единица измерения** — шт, л, кг, м, компл
- **Закупочная цена** — только admin+
- **Розничная цена** — видят все
- **Текущий остаток**
- **Минимальный остаток** (точка дозаказа)
- **Фото** (опционально)
- **Совместимость** — для каких автомобилей (марка/модель/год)
- **Примечания**

#### 3.2.2 Поиск товаров

- По артикулу (точный)
- По штрихкоду (точный)
- По названию (fuzzy search, минимум 2 символа)
- По бренду
- По категории
- Фильтр: в наличии / всё / под заказ
- Сортировка: по названию, цене, остатку

#### 3.2.3 Управление ценами

- Установка базовой розничной цены вручную
- Наценка от закупочной цены (%) — авторасчёт
- История изменения цен
- Групповое изменение цен по категории (в MVP — вручную)

#### 3.2.4 Приёмка товара (кладовщик)

```
Процесс приёмки:
  1. Кладовщик создаёт документ "Прихідна накладна"
  2. Выбирает поставщика
  3. Добавляет товары: артикул + количество + закупочная цена
  4. Проводит накладную → остатки автоматически увеличиваются
  5. Накладная сохраняется в журнале поставок
```

#### 3.2.5 Инвентаризация

- Список всех товаров с ожидаемым остатком
- Кладовщик вводит фактический остаток
- Система считает расхождение
- Документ списания/излишка

---

### 3.3 МОДУЛЬ: КЛИЕНТЫ (CRM) (ПРИОРИТЕТ 2)

#### 3.3.1 Карточка клиента

- **Телефон** — основной идентификатор, уникальный
- **Имя** — ФИО или краткое имя
- **Email** (необязательно)
- **Автомобили** — марка, модель, год, VIN (необязательно)
- **Задолженность** — общая сумма долга
- **История покупок** — все чеки клиента
- **История возвратов**
- **Теги** — VIP, проблемный, оптовик
- **Примечания** — заметки менеджера

#### 3.3.2 Быстрое создание клиента (из POS)

- Только телефон + имя (2 поля)
- 3 секунды максимум
- Остальные данные можно добавить потом

#### 3.3.3 Управление долгами

- Список клиентов с долгами
- Добавление платежа в счёт долга
- История платежей по долгу
- SMS/Telegram напоминания (Post-MVP)

---

### 3.4 МОДУЛЬ: ВОЗВРАТЫ (ПРИОРИТЕТ 2)

#### 3.4.1 Бизнес-правила

- Только менеджер/admin/owner может оформить возврат
- Возврат по номеру чека
- В MVP: возврат всего чека (не частичный)
- Причина возврата — обязательна:
  - Бракована деталь
  - Не та деталь
  - Клієнт передумав
  - Інше (текст)
- Возврат денег: наличными или уменьшение долга
- Товар автоматически возвращается на склад
- Срок возврата: до 14 дней (настраивается)

---

### 3.5 МОДУЛЬ: ОТЧЁТЫ И АНАЛИТИКА (ПРИОРИТЕТ 2)

#### 3.5.1 Отчёты MVP

| Отчёт | Описание | Кто видит |
|---|---|---|
| Продажи за сегодня | Сумма, кол-во чеков, по методам оплаты | Manager+ |
| Продажи за период | С фильтром по датам | Manager+ |
| Отчёт по смене | При закрытии смены | Cashier+ |
| Топ товаров | Самые продаваемые за период | Admin+ |
| Клиенты с долгами | Список и суммы | Manager+ |
| Товары с низким остатком | Ниже точки дозаказа | Admin+ |

#### 3.5.2 Дашборд владельца

```
┌─────────────────────────────────────────────────────┐
│  Сьогодні: 24 продажі    12 450 грн                 │
│  ──────────────────────────────────────────────────  │
│  📦 Готівка:   7 280 грн  │  💳 Картка:  4 920 грн  │
│  📋 Борги сьогодні: 250 грн  │  Всього боргів: 8 400│
│  ──────────────────────────────────────────────────  │
│  [График продаж за 7 дней]                          │
│  ──────────────────────────────────────────────────  │
│  ⚠️ Мало товару: Фільтр W712 (2 шт), Масло (1 л)    │
└─────────────────────────────────────────────────────┘
```

---

### 3.6 МОДУЛЬ: ПОСТАВЩИКИ (ПРИОРИТЕТ 3)

#### 3.6.1 MVP — минимум

- Справочник поставщиков (название, телефон, контакт)
- Привязка к приходным накладным
- История поставок от поставщика

#### 3.6.2 Post-MVP

- Заказы поставщикам
- Отслеживание статуса заказа
- Авторасчёт потребности (что заказать на основе продаж)

---

### 3.7 МОДУЛЬ: НАСТРОЙКИ (ПРИОРИТЕТ 3)

- Название и адрес магазина
- Рабочие часы
- Максимальная скидка без согласования (%)
- Разрешить продажу в минус остатка (да/нет)
- Дни возврата (1-30)
- Валюта (UAH)
- Управление пользователями (создание, блокировка, смена роли)

---

## 4. НЕФУНКЦИОНАЛЬНЫЕ ТРЕБОВАНИЯ

### 4.1 Производительность

| Метрика | Требование |
|---|---|
| Поиск товара (POS) | < 200мс от ввода до результатов |
| Загрузка страницы списка | < 1 сек |
| Создание продажи (сохранение) | < 500мс |
| Первая загрузка приложения | < 3 сек (на 4G) |
| Одновременных пользователей | до 10 (один магазин) |

### 4.2 Надёжность

- Offline-первый режим для POS: если интернет пропал — касса продолжает работать (данные синхронизируются при восстановлении) — **Post-MVP**
- В MVP: если нет интернета — касса показывает ошибку
- Резервное копирование БД: Supabase делает автоматически

### 4.3 Доступность (Uptime)

- 99.5% (не более 3.6 часов простоя в месяц)
- Supabase обеспечивает 99.9% uptime для БД
- Express сервер на Railway / VPS

### 4.4 Масштабируемость

MVP не требует масштабирования. При необходимости расширения до нескольких магазинов — рефакторинг с добавлением полной мультитенантности.

---

## 5. МОДЕЛЬ ДАННЫХ

### 5.1 Принципы работы с БД

- **Деньги:** ТОЛЬКО `INTEGER` в копейках (гривнях × 100). Пример: 450 грн = 45000
- **Количество:** `NUMERIC(12,3)` — поддержка дробных (литры, метры)
- **Soft delete:** `deleted_at TIMESTAMPTZ` — физически не удалять никогда
- **Временные метки:** `created_at`, `updated_at` — обязательно для всех таблиц
- **Многотенантность (будущее):** `tenant_id UUID` — на всех таблицах
- **Foreign keys:** `ON DELETE RESTRICT` — запрет каскадного удаления

### 5.2 Таблицы

#### users (пользователи)
```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  email         VARCHAR(255) UNIQUE,
  phone         VARCHAR(20),
  full_name     VARCHAR(200) NOT NULL,
  role          VARCHAR(20) NOT NULL CHECK (role IN (
                  'owner','admin','manager','cashier','storekeeper','sto_viewer'
                )),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
```

#### products (товары)
```sql
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  sku             VARCHAR(50) NOT NULL,           -- артикул
  name            VARCHAR(500) NOT NULL,           -- название
  barcode         VARCHAR(100),                   -- штрихкод EAN13
  brand_id        UUID REFERENCES brands(id),
  category_id     UUID REFERENCES categories(id),
  unit            VARCHAR(20) DEFAULT 'шт',        -- шт, л, кг, м, компл
  purchase_price  INTEGER NOT NULL DEFAULT 0,      -- КОПЕЙКИ (закупка)
  retail_price    INTEGER NOT NULL DEFAULT 0,      -- КОПЕЙКИ (продажа)
  qty_on_hand     NUMERIC(12,3) NOT NULL DEFAULT 0,-- текущий остаток
  reorder_point   NUMERIC(12,3) NOT NULL DEFAULT 0,-- точка дозаказа
  notes           TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (tenant_id, sku)
);
CREATE INDEX idx_products_sku ON products(tenant_id, sku);
CREATE INDEX idx_products_barcode ON products(tenant_id, barcode);
CREATE INDEX idx_products_name ON products USING gin(to_tsvector('simple', name));
```

#### customers (клиенты)
```sql
CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  phone         VARCHAR(20) NOT NULL,
  full_name     VARCHAR(200),
  email         VARCHAR(255),
  debt_balance  INTEGER NOT NULL DEFAULT 0,  -- КОПЕЙКИ (долг клиента)
  notes         TEXT,
  tags          TEXT[] DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (tenant_id, phone)
);
CREATE INDEX idx_customers_phone ON customers(tenant_id, phone);
```

#### customer_vehicles (автомобили клиентов)
```sql
CREATE TABLE customer_vehicles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  brand        VARCHAR(100) NOT NULL,    -- Toyota, BMW
  model        VARCHAR(100) NOT NULL,    -- Corolla, E46
  year         SMALLINT,
  vin          VARCHAR(17),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### shifts (кассовые смены)
```sql
CREATE TABLE shifts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  cashier_id     UUID NOT NULL REFERENCES users(id),
  status         VARCHAR(20) NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','closed')),
  opening_cash   INTEGER NOT NULL DEFAULT 0,   -- КОПЕЙКИ (открытие)
  closing_cash   INTEGER,                       -- КОПЕЙКИ (закрытие, факт)
  expected_cash  INTEGER,                       -- КОПЕЙКИ (по данным системы)
  cash_variance  INTEGER,                       -- КОПЕЙКИ (расхождение)
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_shifts_cashier ON shifts(tenant_id, cashier_id, status);
```

#### sales (продажи / чеки)
```sql
CREATE TABLE sales (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  sale_number    VARCHAR(20) NOT NULL,          -- человекочитаемый номер
  customer_id    UUID REFERENCES customers(id),
  cashier_id     UUID NOT NULL REFERENCES users(id),
  shift_id       UUID NOT NULL REFERENCES shifts(id),
  status         VARCHAR(20) NOT NULL DEFAULT 'completed'
                   CHECK (status IN ('draft','completed','returned')),
  subtotal       INTEGER NOT NULL DEFAULT 0,    -- КОПЕЙКИ (без скидки)
  discount       INTEGER NOT NULL DEFAULT 0,    -- КОПЕЙКИ (сумма скидки)
  total          INTEGER NOT NULL DEFAULT 0,    -- КОПЕЙКИ (к оплате)
  payment_method VARCHAR(20) NOT NULL
                   CHECK (payment_method IN ('cash','card','debt','mixed')),
  is_debt        BOOLEAN NOT NULL DEFAULT false,
  notes          TEXT,
  completed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sales_shift ON sales(shift_id);
CREATE INDEX idx_sales_customer ON sales(tenant_id, customer_id);
CREATE INDEX idx_sales_date ON sales(tenant_id, completed_at);
```

#### sale_items (строки чека)
```sql
CREATE TABLE sale_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  sale_id     UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty         NUMERIC(12,3) NOT NULL,
  unit_price  INTEGER NOT NULL,     -- КОПЕЙКИ (цена на момент продажи)
  discount    INTEGER NOT NULL DEFAULT 0,  -- КОПЕЙКИ (скидка на позицию)
  total       INTEGER NOT NULL,     -- КОПЕЙКИ (qty * unit_price - discount)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);
```

#### returns (возвраты)
```sql
CREATE TABLE returns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  sale_id        UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  customer_id    UUID REFERENCES customers(id),
  reason         VARCHAR(50) NOT NULL
                   CHECK (reason IN (
                     'defective','wrong_part','customer_changed_mind','other'
                   )),
  reason_text    TEXT,                         -- если reason='other'
  refund_amount  INTEGER NOT NULL,             -- КОПЕЙКИ
  refund_method  VARCHAR(20) NOT NULL
                   CHECK (refund_method IN ('cash','debt_reduction')),
  status         VARCHAR(20) NOT NULL DEFAULT 'completed',
  created_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### supply_invoices (приходные накладные)
```sql
CREATE TABLE supply_invoices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  supplier_id   UUID REFERENCES suppliers(id),
  invoice_number VARCHAR(100),                 -- номер накладной поставщика
  status        VARCHAR(20) NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','posted','cancelled')),
  total         INTEGER NOT NULL DEFAULT 0,    -- КОПЕЙКИ
  notes         TEXT,
  posted_by     UUID REFERENCES users(id),
  posted_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### supply_invoice_items (строки накладной)
```sql
CREATE TABLE supply_invoice_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  invoice_id        UUID NOT NULL REFERENCES supply_invoices(id),
  product_id        UUID NOT NULL REFERENCES products(id),
  qty               NUMERIC(12,3) NOT NULL,
  purchase_price    INTEGER NOT NULL,           -- КОПЕЙКИ (закупочная)
  total             INTEGER NOT NULL,           -- КОПЕЙКИ
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### suppliers (поставщики)
```sql
CREATE TABLE suppliers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  name         VARCHAR(300) NOT NULL,
  phone        VARCHAR(20),
  email        VARCHAR(255),
  contact_name VARCHAR(200),
  notes        TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
```

#### categories (категории товаров)
```sql
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  parent_id   UUID REFERENCES categories(id),  -- для иерархии
  name        VARCHAR(200) NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### brands (бренды)
```sql
CREATE TABLE brands (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  name       VARCHAR(200) NOT NULL,
  country    VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
```

---

## 6. API СПЕЦИФИКАЦИЯ

### 6.1 Общие правила

- Базовый URL: `/api`
- Формат: JSON
- Авторизация: `Authorization: Bearer <jwt_token>`
- Коды ошибок:

```json
{
  "error": {
    "code": "PRODUCT_NOT_FOUND",
    "message": "Товар з таким ID не знайдено",
    "status": 404
  }
}
```

- Пагинация для списков:
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 145,
    "total_pages": 8
  }
}
```

### 6.2 AUTH

```
POST   /api/auth/login          — Вход (phone/email + password)
POST   /api/auth/logout         — Выход
POST   /api/auth/refresh        — Обновить access token
GET    /api/auth/me             — Текущий пользователь
```

### 6.3 PRODUCTS

```
GET    /api/products            — Список (поиск, фильтры, пагинация)
GET    /api/products/:id        — Карточка товара
POST   /api/products            — Создать (admin+)
PUT    /api/products/:id        — Обновить (admin+)
DELETE /api/products/:id        — Soft delete (admin+)
GET    /api/products/search?q=  — Быстрый поиск для POS (оптимизированный)
GET    /api/products/:id/price-history — История цен
```

### 6.4 CUSTOMERS

```
GET    /api/customers           — Список (поиск по телефону/имени)
GET    /api/customers/:id       — Карточка клиента
POST   /api/customers           — Создать клиента
POST   /api/customers/quick     — Быстрое создание (только phone + name)
PUT    /api/customers/:id       — Обновить
GET    /api/customers/:id/sales — История покупок
GET    /api/customers/:id/debts — История долгов
POST   /api/customers/:id/pay-debt — Погасить долг
```

### 6.5 SHIFTS (Смены)

```
GET    /api/shifts/current      — Текущая открытая смена
POST   /api/shifts/open         — Открыть смену
POST   /api/shifts/:id/close    — Закрыть смену
GET    /api/shifts/:id          — Детали смены
GET    /api/shifts/:id/report   — Отчёт по смене
```

### 6.6 SALES (Продажи)

```
POST   /api/sales                      — Создать продажу
GET    /api/sales/:id                  — Детали чека
GET    /api/sales                      — Список (с фильтрами)
POST   /api/sales/calculate-price      — Предварительный расчёт чека
```

### 6.7 RETURNS (Возвраты)

```
POST   /api/returns             — Оформить возврат
GET    /api/returns/:id         — Детали возврата
GET    /api/returns             — Список возвратов
```

### 6.8 SUPPLY INVOICES (Приёмка)

```
GET    /api/supply-invoices              — Список накладных
POST   /api/supply-invoices              — Создать накладную (draft)
PUT    /api/supply-invoices/:id          — Редактировать (пока draft)
POST   /api/supply-invoices/:id/post     — Провести (увеличивает остатки)
POST   /api/supply-invoices/:id/cancel   — Отменить
```

### 6.9 REPORTS

```
GET    /api/reports/sales/today          — Продажи сегодня
GET    /api/reports/sales/period?from=&to= — Продажи за период
GET    /api/reports/products/low-stock   — Товары с низким остатком
GET    /api/reports/customers/debtors    — Клиенты с долгами
GET    /api/reports/shift/:id            — Отчёт по смене
```

### 6.10 ADMIN

```
GET    /api/admin/users         — Список пользователей
POST   /api/admin/users         — Создать пользователя
PUT    /api/admin/users/:id     — Изменить роль/статус
DELETE /api/admin/users/:id     — Деактивировать

GET    /api/admin/categories    — Список категорий
POST   /api/admin/categories    — Создать
PUT    /api/admin/categories/:id — Изменить
DELETE /api/admin/categories/:id — Удалить

GET    /api/admin/brands        — Список брендов
POST   /api/admin/brands        — Создать
PUT    /api/admin/brands/:id    — Изменить

GET    /api/settings            — Настройки магазина
PUT    /api/settings            — Обновить (только owner)
```

---

## 7. UI/UX ТРЕБОВАНИЯ

### 7.1 Дизайн-система

**Цвета:**
```
Акцент (жёлтый Форсаж): #FFD000
Фон адмінки:            #F5F5F5
Поверхность адмінки:    #FFFFFF
Фон POS (тёмный):       #1A1A1A
Поверхность POS:        #2C2C2C

Статусы:
  Есть в наличии:       #22C55E (зелёный)
  Мало (< reorder):     #F59E0B (оранжевый)
  Нет в наличии:        #EF4444 (красный)
  Под заказ:            #3B82F6 (синий)
  Архив:                #9CA3AF (серый)

Текст основной:         #111827
Текст вторичный:        #6B7280
```

**Типография:**
```
Адмінка:
  Заголовок H1:   24px, Bold
  Заголовок H2:   18px, SemiBold
  Тело:           14px, Regular
  Мелкий:         12px, Regular

POS:
  Название товара: 16px
  Цена в чеке:    20px, SemiBold
  ИТОГО:          32px, Bold
  Кнопки оплаты:  18px, Bold
```

**Компоненты (самописные, не shadcn):**
- `Button` (primary, secondary, danger, ghost, icon)
- `Input` (text, number, search с иконкой)
- `Modal` (slide-up анимация, backdrop)
- `Table` (заголовки, сортировка, пагинация)
- `Badge` (статус товара, роль пользователя)
- `Card` (контейнер с тенью)
- `Toast` (успех/ошибка/предупреждение)
- `SearchInput` (debounce 200мс, автопоиск)
- `Select` (кастомный с поиском)
- `Spinner` (загрузка)

### 7.2 Навигация

**Боковое меню (адмінка):**
```
🏠 Дашборд
📦 Товари
  └─ Список товарів
  └─ Категорії
  └─ Бренди
👥 Клієнти
🛒 Продажі
  └─ Журнал продажів
  └─ Повернення
📋 Постачальники
  └─ Список постачальників
  └─ Прихідні накладні
📊 Звіти
⚙️ Налаштування
  └─ Магазин
  └─ Користувачі
```

**POS касса — отдельный полноэкранный режим (без боковой навигации)**

### 7.3 Адаптивность

- **Desktop (1280px+):** Полное меню, двухколоночный POS
- **Tablet (768-1279px):** Сворачиваемое меню, адаптированный POS
- **Mobile (< 768px):** Адмінка работает, POS — ограниченно (не рекомендуется для продаж)

---

## 8. БЕЗОПАСНОСТЬ

### 8.1 Аутентификация

- JWT токены через Supabase Auth
- Access token: 15 минут TTL
- Refresh token: 7 дней TTL
- Хранение: `httpOnly` cookie (не localStorage — защита от XSS)
- При каждом запросе: проверка JWT + проверка роли

### 8.2 Авторизация

- Проверка роли на backend (не только фронтенд)
- `tenant_id` фильтрация в каждом запросе к БД
- Row Level Security (RLS) в Supabase — дополнительный уровень защиты

### 8.3 Защита от атак

- **SQL Injection:** Только параметризованные запросы, никогда строковая конкатенация
- **XSS:** Экранирование в React по умолчанию, `httpOnly` cookie
- **CSRF:** SameSite cookie policy
- **Rate Limiting:** max 100 запросов/минута с одного IP для API, 10 попыток входа/час
- **Brute Force:** Блокировка после 5 неверных паролей

### 8.4 Логирование

- Все входы в систему (успешные и неуспешные)
- Все изменения цен
- Все возвраты
- Изменения ролей пользователей
- Провоенные накладные

### 8.5 Переменные окружения (НИКОГДА НЕ В КОДЕ)

```bash
# server/.env
SUPABASE_URL=https://...
SUPABASE_SERVICE_KEY=...  # НЕ ANON KEY! Service key для бэкенда
JWT_SECRET=...
PORT=3001
NODE_ENV=production
CORS_ORIGIN=https://forsage-crm.com

# apps/web/.env
VITE_SUPABASE_URL=https://...
VITE_SUPABASE_ANON_KEY=...  # ТОЛЬКО anon key на фронтенде!
VITE_API_URL=https://api.forsage-crm.com
```

---

## 9. ТЕХНОЛОГИЧЕСКИЙ СТЕК

### 9.1 Окончательный стек (не менять без обоснования)

| Слой | Технология | Версия | Обоснование |
|---|---|---|---|
| **Frontend** | React | 18 | Стандарт индустрии, поддержка AI инструментов |
| | TypeScript | 5.3+ | Типобезопасность |
| | Vite | 5+ | Быстрая сборка |
| | Zustand | 4+ | Простой state management без boilerplate |
| | Tailwind CSS | 4 | Быстрая разработка UI |
| | react-hook-form + zod | latest | Валидация форм |
| | lucide-react | latest | Иконки |
| | recharts | latest | Графики отчётов |
| | date-fns | latest | Работа с датами |
| **Backend** | Node.js | 20 LTS | Долгосрочная поддержка |
| | Express.js | 4.x | Простота, много примеров |
| | TypeScript | 5.3+ | Типобезопасность |
| | zod | 3+ | Валидация входных данных |
| | pino | latest | Структурированное логирование (вместо console.log) |
| **Database** | Supabase PostgreSQL | 15+ | Managed БД, RLS, Realtime |
| **Auth** | Supabase Auth | - | Встроенная авторизация |
| **Package Manager** | pnpm | 8+ | Быстрее npm, экономия места |

### 9.2 Структура репозитория

```
crm-forsage/
├── apps/
│   └── web/                    # React SPA
│       ├── src/
│       │   ├── components/ui/  # Button, Input, Modal...
│       │   ├── features/
│       │   │   ├── pos/        # POS касса
│       │   │   ├── products/   # Товары
│       │   │   ├── customers/  # Клиенты
│       │   │   ├── sales/      # Продажи
│       │   │   ├── returns/    # Возвраты
│       │   │   ├── inventory/  # Склад/приёмка
│       │   │   ├── reports/    # Отчёты
│       │   │   └── admin/      # Настройки/пользователи
│       │   ├── hooks/
│       │   ├── lib/
│       │   │   ├── api.ts      # API клиент
│       │   │   └── supabase.ts
│       │   ├── stores/
│       │   │   ├── authStore.ts
│       │   │   └── posStore.ts # Состояние чека
│       │   ├── types/
│       │   ├── App.tsx
│       │   └── main.tsx
│       ├── package.json
│       └── vite.config.ts
│
├── server/
│   ├── src/
│   │   ├── middleware/
│   │   │   ├── auth.ts         # JWT проверка
│   │   │   ├── requireRole.ts  # Проверка роли
│   │   │   └── errorHandler.ts # Централизованные ошибки
│   │   ├── routes/
│   │   │   ├── auth.ts
│   │   │   ├── products.ts
│   │   │   ├── customers.ts
│   │   │   ├── sales.ts
│   │   │   ├── shifts.ts
│   │   │   ├── returns.ts
│   │   │   ├── supply.ts
│   │   │   ├── reports.ts
│   │   │   └── admin.ts
│   │   ├── services/           # Бизнес-логика
│   │   ├── validators/         # Zod схемы
│   │   ├── db/                 # Запросы к Supabase
│   │   ├── types/
│   │   └── index.ts
│   └── package.json
│
├── supabase/
│   ├── migrations/
│   │   ├── 001_initial_schema.sql
│   │   ├── 002_rls_policies.sql
│   │   └── 003_seed_categories.sql
│   └── config.toml
│
└── package.json               # pnpm workspaces
```

---

## 10. ДОРОЖНАЯ КАРТА

### 10.1 MVP (Фазы 1–4, ~8-12 недель)

| Фаза | Модули | Готово когда |
|---|---|---|
| **1: Скелет** | Auth, роли, базовый UI | Можно войти в систему |
| **2: Товары** | CRUD товаров, поиск, категории | Можно вести каталог |
| **3: Клиенты** | CRM, быстрое создание | Можно найти клиента |
| **4: POS Касса** | Продажи, смены, оплата, печать | Можно продавать |

### 10.2 Версия 1.1 (2–4 недели после MVP)

- Возвраты
- Базовые отчёты (дашборд, отчёт по смене)
- Управление долгами

### 10.3 Версия 1.2 (2–4 недели)

- Приёмка товара (накладные)
- Журнал поставщиков
- Отчёт по остаткам / низкий остаток

### 10.4 Версия 2.0 (Post-MVP, 2–3 месяца)

- Инвентаризация
- Бонусная программа лояльности
- Telegram-уведомления (низкий остаток, долги)
- Импорт товаров из Excel
- Печать этикеток со штрихкодом
- Расширенная аналитика

### 10.5 Версия 3.0 (Будущее)

- Мультимагазинность (SaaS)
- Интеграция с Checkbox (фискальный регистратор, Украина)
- Заказы поставщикам с отслеживанием
- Автозаказ на основе продаж
- Мобильное приложение (React Native)

---

## 11. КРИТИЧЕСКИЕ ПРАВИЛА РАЗРАБОТКИ

### 11.1 НЕ НАРУШАТЬ — БАЗА ДАННЫХ

```
✅ ПРАВИЛЬНО:                  ❌ НЕПРАВИЛЬНО:
INTEGER в копейках             DECIMAL / FLOAT для денег
NUMERIC(12,3) для qty          INTEGER для количества (нет дробей)
deleted_at IS NULL             DELETE FROM ...
параметризованные запросы      'SELECT ... WHERE id=' + id
tenant_id в каждом запросе     Запрос без фильтра по tenant_id
```

### 11.2 НЕ НАРУШАТЬ — КОД

```typescript
// ✅ ПРАВИЛЬНО:
import { logger } from '../lib/logger';
logger.info({ userId, action: 'sale_created' }, 'Sale created');

// ❌ НЕПРАВИЛЬНО:
console.log('Sale created', userId);

// ✅ ПРАВИЛЬНО:
const schema = z.object({ productId: z.string().uuid() });
const data = schema.parse(req.body);  // выбросит ошибку если невалидно

// ❌ НЕПРАВИЛЬНО:
const productId = req.body.productId as string;  // нет валидации

// ✅ ПРАВИЛЬНО:
// Хранение денег
const priceInKopecks = 45000;  // 450 грн
const displayPrice = (priceInKopecks / 100).toFixed(2) + ' грн';

// ❌ НЕПРАВИЛЬНО:
const price = 450.00;  // float для денег
```

### 11.3 НЕ НАРУШАТЬ — БЕЗОПАСНОСТЬ

- НИКОГДА `any` в TypeScript без явного `// eslint-disable-next-line @typescript-eslint/no-explicit-any` + комментария ПОЧЕМУ
- НИКОГДА секреты в коде — только в `.env`
- НИКОГДА не логировать пароли, токены, платёжные данные
- ВСЕГДА проверять роль на сервере (не доверять фронтенду)

### 11.4 ЯЗЫК

- **Интерфейс:** Украинский (мова магазину — Украина)
- **Код, переменные, комментарии:** Английский
- **ТЗ, документация:** Русский / Украинский

---

## 12. АУДИТ И ПРОТИВОРЕЧИЯ

### 12.1 Найденные противоречия в существующей документации

#### ❌ ПРОТИВОРЕЧИЕ 1: Мультитенантность

| Документ | Что говорит |
|---|---|
| `SPEC_MASTER.md` ✅ | Один магазин, мультитенантность — НЕТ |
| `ARCHITECTURE_OVERVIEW.md` ⚠️ | Полная SaaS архитектура с мультитенантностью |

**Решение:** SPEC_MASTER.md — единственный источник правды. ARCHITECTURE_OVERVIEW.md описывает будущее версии 3.0. Сейчас — один магазин.

#### ❌ ПРОТИВОРЕЧИЕ 2: Версионирование API

| Документ | Что говорит |
|---|---|
| `SPEC_MASTER.md` ✅ | `/api/` без версии |
| `ARCHITECTURE_OVERVIEW.md` ⚠️ | `/api/v1/` с версионированием |

**Решение:** Для MVP — `/api/`. Версионирование добавлять при выходе второй несовместимой версии.

#### ❌ ПРОТИВОРЕЧИЕ 3: Монорепо структура

| Документ | Что говорит |
|---|---|
| `SPEC_MASTER.md` ✅ | `apps/web/`, `server/`, `supabase/` |
| `ARCHITECTURE_OVERVIEW.md` ⚠️ | + `apps/desktop/`, `apps/mobile/`, `packages/ui/`, `packages/types/` |

**Решение:** Простая структура из SPEC_MASTER.md. Desktop и Mobile — в будущем.

#### ⚠️ ПРОБЕЛ 1: Деплой

Нигде конкретно не описан деплой. **Рекомендация:**
- Backend: Railway (простое CI/CD из GitHub)
- Frontend: Vercel (бесплатный tier, автодеплой)
- БД: Supabase cloud (managed)

#### ⚠️ ПРОБЕЛ 2: Тестирование

Нет описания стратегии тестирования. **Рекомендация для MVP:**
- Unit тесты для бизнес-логики (сервисы): Vitest
- Integration тесты для API endpoints: supertest
- E2E для критических путей (продажа, возврат): Playwright
- CI: GitHub Actions при каждом PR

#### ⚠️ ПРОБЕЛ 3: Логирование

Правило "не console.log" есть, но не указана конкретная библиотека. **Решение:** `pino` — самый быстрый структурированный логгер для Node.js.

#### ⚠️ ПРОБЕЛ 4: Миграции БД

Не описана организация миграций. **Решение:** Нумерованные файлы `001_initial_schema.sql`, `002_rls_policies.sql` и т.д. Применяются через `supabase db push` (локально) или через Supabase Dashboard (production).

### 12.2 Критические проблемы в коде vip.s.cars.ua (смежный проект)

Если часть кода из этого проекта будет переиспользована — исправить ПЕРЕД использованием:

1. **Хардкод Supabase URL в коде** → использовать только переменные окружения
2. **`any` типы без объяснения** → добавить Zod валидацию
3. **`console.error` вместо логгера** → заменить на pino
4. **`setInterval` вместо cron** → использовать `node-cron`
5. **Отсутствие error boundaries в React** → добавить на уровне роутов

---

## ПРИЛОЖЕНИЕ А: Глоссарий

| Термин | Описание |
|---|---|
| Артикул (SKU) | Уникальный код товара в магазине |
| Копейки | Хранение денег в целых числах (1 грн = 100 копеек) |
| Soft delete | Помечать удалённые записи флагом, не удалять физически |
| RLS | Row Level Security — защита на уровне строк в PostgreSQL |
| POS | Point of Sale — электронная касса |
| Смена | Рабочий период кассира с открытием и закрытием |
| Борг | Продажа в кредит (долг клиента) |
| Тенант | Магазин (для будущей мультиарендности) |
| Реorder point | Минимальный остаток, при котором нужно дозаказать |

---

## ПРИЛОЖЕНИЕ Б: Чеклист готовности к запуску

- [ ] Все env переменные настроены (не в коде)
- [ ] RLS policies активированы на всех таблицах
- [ ] Rate limiting включён
- [ ] HTTPS настроен (certbot / Vercel/Railway автоматически)
- [ ] Резервное копирование БД настроено (Supabase Pro / ежедневно)
- [ ] Мониторинг работает (Sentry или UptimeRobot)
- [ ] Протестированы все роли пользователей
- [ ] Продажа → остаток уменьшился → проверено
- [ ] Возврат → остаток восстановился → проверено
- [ ] Приёмка → остаток увеличился → проверено
- [ ] Отчёт по смене совпадает с реальными деньгами в кассе
- [ ] Печать чека работает на термопринтере
