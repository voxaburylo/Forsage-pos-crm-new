# ТЕХНИЧЕСКОЕ ЗАДАНИЕ
## CRM/ERP система для магазина автозапчастей "Форсаж"

**Версия:** 3.0 (полная — после аудита всех 14 SPEC файлов)
**Дата:** 2026-05-07
**Статус:** Готово к разработке

> ⚠️ **РЕШЕНО:** API использует `/api/v1/` (по большинству SPEC файлов). Этот документ объединяет все 14 SPEC файлов.

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
POST   /api/v1/auth/login          — Вход по телефону + пароль
POST   /api/v1/auth/logout         — Выход
POST   /api/v1/auth/refresh        — Обновить access token
GET    /api/v1/auth/me             — Текущий пользователь
```

### 6.3 PRODUCTS

```
GET    /api/v1/products            — Список (поиск, фильтры, пагинация)
GET    /api/v1/products/:id        — Карточка товара
POST   /api/v1/products            — Создать (admin+)
PUT    /api/v1/products/:id        — Обновить (admin+)
DELETE /api/v1/products/:id        — Soft delete (admin+)
GET    /api/v1/products/search?q=  — Быстрый поиск для POS (оптимизированный)
GET    /api/v1/products/:id/price-history — История цен
```

### 6.4 CUSTOMERS

```
GET    /api/v1/customers           — Список (поиск по телефону/имени)
GET    /api/v1/customers/:id       — Карточка клиента
POST   /api/v1/customers           — Создать клиента
POST   /api/v1/customers/quick     — Быстрое создание (только phone + name)
PUT    /api/v1/customers/:id       — Обновить
GET    /api/v1/customers/:id/sales — История покупок
GET    /api/v1/customers/:id/debts — История долгов
POST   /api/v1/customers/:id/pay-debt — Погасить долг
```

### 6.5 SHIFTS (Смены)

```
GET    /api/v1/shifts/current      — Текущая открытая смена
POST   /api/v1/shifts/open         — Открыть смену
POST   /api/v1/shifts/:id/close    — Закрыть смену
GET    /api/v1/shifts/:id          — Детали смены
GET    /api/v1/shifts/:id/report   — Отчёт по смене
```

### 6.6 SALES (Продажи)

```
POST   /api/v1/sales                      — Создать продажу
GET    /api/v1/sales/:id                  — Детали чека
GET    /api/v1/sales                      — Список (с фильтрами)
POST   /api/v1/sales/calculate-price      — Предварительный расчёт чека
```

### 6.7 RETURNS (Возвраты)

```
POST   /api/v1/returns             — Оформить возврат
GET    /api/v1/returns/:id         — Детали возврата
GET    /api/v1/returns             — Список возвратов
```

### 6.8 SUPPLY INVOICES (Приёмка)

```
GET    /api/v1/supply-invoices              — Список накладных
POST   /api/v1/supply-invoices              — Создать накладную (draft)
PUT    /api/v1/supply-invoices/:id          — Редактировать (пока draft)
POST   /api/v1/supply-invoices/:id/post     — Провести (увеличивает остатки)
POST   /api/v1/supply-invoices/:id/cancel   — Отменить
```

### 6.9 REPORTS

```
GET    /api/v1/reports/sales/today          — Продажи сегодня
GET    /api/v1/reports/sales/period?from=&to= — Продажи за период
GET    /api/v1/reports/products/low-stock   — Товары с низким остатком
GET    /api/v1/reports/customers/debtors    — Клиенты с долгами
GET    /api/v1/reports/shift/:id            — Отчёт по смене
```

### 6.10 ADMIN

```
GET    /api/v1/admin/users         — Список пользователей
POST   /api/v1/admin/users         — Создать пользователя
PUT    /api/v1/admin/users/:id     — Изменить роль/статус
DELETE /api/v1/admin/users/:id     — Деактивировать

GET    /api/v1/admin/categories    — Список категорий
POST   /api/v1/admin/categories    — Создать
PUT    /api/v1/admin/categories/:id — Изменить
DELETE /api/v1/admin/categories/:id — Удалить

GET    /api/v1/admin/brands        — Список брендов
POST   /api/v1/admin/brands        — Создать
PUT    /api/v1/admin/brands/:id    — Изменить

GET    /api/v1/settings            — Настройки магазина
PUT    /api/v1/settings            — Обновить (только owner)
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

---

## 13. ДЕТАЛИ ИЗ ВСЕХ SPEC ФАЙЛОВ (дополнения к разделам выше)

> Этот раздел содержит всё важное из 13 дополнительных SPEC файлов, которых не было в основном ТЗ.

---

### 13.1 ТОВАРЫ — дополнения из SPEC_PRODUCTS.md

#### Нормализация артикулов (ОБЯЗАТЕЛЬНО для поиска)
Перед поиском и сохранением — нормализовать все коды:
- Удалить пробелы, тире, точки, слеши, подчёркивания
- Привести к UPPERCASE
- Удалить ведущие нули
- Пример: `"04465-33471"` → `"0446533471"`, `"w 712"` → `"W712"`

#### Дополнительные поля товара (MVP + Expansion)
```
oem_number        VARCHAR(100)   — OEM номер производителя
supplier_article  VARCHAR(100)   — артикул поставщика
wholesale_price   INTEGER        — оптовая цена (копейки)
min_price         INTEGER        — минимальная цена (защита маржи, копейки)
qty_reserved      NUMERIC(12,3)  — зарезервировано для заказов
status            ENUM           — active / inactive / discontinued / order_only
is_weight_based   BOOLEAN        — товар на вес (дробное qty)
is_quick_cash     BOOLEAN        — универсальный товар без отслеживания (скрепки и т.п.)
is_order_only     BOOLEAN        — только под заказ, не хранится на складе
photo_urls        TEXT[]         — массив URL фотографий
search_vector     TSVECTOR       — для полнотекстового поиска (gin индекс)
```

#### Дополнительные таблицы товаров
```sql
-- Несколько штрихкодов на товар
product_barcodes (product_id, barcode, barcode_type, is_primary)

-- Псевдонимы (как сотрудники называют товар)
product_aliases (product_id, alias)

-- Система аналогов
product_analogs (product_id, analog_product_id, analog_type, priority)

-- Коды поставщиков на товар
product_supplier_codes (product_id, supplier_id, supplier_code, supplier_price, lead_time_days)

-- История цен
product_price_history (product_id, price_type, old_price, new_price, changed_by, changed_at)

-- Совместимость с автомобилями
product_fitment (product_id, make, model, year_from, year_to, engine_code, body_code)
```

#### Бренд-тиры (приоритет аналогов)
```
original  — OEM оригинал (Toyota Genuine, BMW) — 100% baseline
premium   — TRW, Bosch, Brembo               — 60-80% OEM
standard  — Remsa, Ferodo, Kayaba             — 40-60% OEM
budget    — Rider, AURORA                     — 20-40% OEM
```
Поле `brands.tier` — ENUM этих значений. При показе аналогов: сначала same-tier, потом tier-up, потом tier-down.

#### Новые API endpoints (товары)
```
GET  /api/v1/products/:id/analogs       — аналоги товара
GET  /api/v1/products/:id/price-history — история цен
POST /api/v1/products/:id/barcodes      — добавить штрихкод
GET  /api/v1/products/search?q=&normalize=true — поиск с нормализацией
```

---

### 13.2 POS КАССА — дополнения из SPEC_POS.md

#### Полный список горячих клавиш
| Клавиша | Действие |
|---|---|
| `F1` | Справка |
| `F2` | Поиск товара (фокус на поле поиска) |
| `F4` | Новый клиент |
| `F5` | Приостановить чек (suspend) |
| `F6` | Восстановить чек (resume) |
| `F7` | Добавить заметку к чеку |
| `F8` | Открыть оплату |
| `F9` | Скидка на чек |
| `F10` | Открыть смену / закрыть смену |
| `F11` | Последняя продажа |
| `F12` | Печать последнего чека |
| `Esc` | Очистить поиск |
| `Enter` | Добавить первый результат (qty=1) |
| `+` / `-` | Изменить qty выбранной позиции |
| `Del` | Удалить выбранную позицию |
| `Ctrl+Z` | Отменить последнее добавление |

#### Приостановка чека (Suspend/Resume)
- `is_suspended = true` — чек сохраняется в БД, освобождает экран
- Кассир может обслужить другого клиента
- Resume восстанавливает чек целиком
- Максимум 5 приостановленных чеков одновременно

#### Обнаружение дублей
- Если тот же товар + тот же клиент продавался < 5 минут назад → предупреждение
- Кассир может проигнорировать

#### Продажа ниже min_price
- Система предупреждает: "Ціна нижче мінімальної!"
- Требует PIN-код владельца для override
- `POST /api/v1/sales/override-min-price` — отдельный endpoint (только Owner/Admin)
- Все override логируются в `audit_log`

#### Crash recovery
- Текущий чек сохраняется в `localStorage` каждые 10 секунд
- При открытии после сбоя — предложение восстановить

#### Звуковые эффекты
- Успешное сканирование штрихкода → `beep.mp3`
- Ошибка (товар не найден) → `error.mp3`
- Оплата принята → `success.mp3`
- Можно отключить в настройках

#### Правила при debt-продаже
- Клиент обязателен (нельзя продать в долг анонимно)
- Проверка `customer.debt_limit` — если превышен → блокировка (можно override с PIN)
- Клиент с `risk_level = blocked` → продажа только наличными

---

### 13.3 ЦІНОУТВОРЕННЯ — из SPEC_PRICING.md

#### Ценовые уровни (price tiers)
```sql
price_tiers (id, tenant_id, name, discount_pct, is_default, sort_order)
```
Примеры уровней:
- Роздріб (0% скидки) — default
- Опт (-15%)
- СТО (-20%)
- VIP (-25%)

Клиент привязывается к уровню через `customers.price_tier_id`.

#### Объёмные скидки
```sql
volume_discounts (price_tier_id, product_id, category_id, min_quantity, discount_pct)
```
Пример: купить > 10 шт фильтров → скидка ещё 5%.

#### Наценки по категориям
```sql
category_markups (category_id, markup_pct, min_markup_pct)
```
При создании товара в категории — розничная цена = закупочная × (1 + markup_pct).

#### Расчёт цены (endpoint)
```
POST /api/v1/pricing/calculate
Body: { product_id, customer_id?, qty, override_price? }
Response: { base_price, tier_discount, volume_discount, final_price, margin_pct }
```
Маржу видит только Owner/Admin.

---

### 13.4 ПОВЕРНЕННЯ — дополнения из SPEC_RETURNS.md

#### Четыре типа возвратов (не только один!)
| Тип | Описание |
|---|---|
| `refund` | Деньги назад (наличные или терминал) |
| `exchange` | Обмен на другой товар |
| `credit` | Остаток на счёте клиента |
| `warranty_supplier` | Гарантийный через поставщика |

#### Условия допустимости
- До 14 дней с даты продажи (настраивается в settings)
- Гарантийный — до 12 месяцев
- Проверка запрещённых категорий (например, ГСМ — не возвращается)
- Override с PIN владельца

#### Действие с товаром (stock action)
```
return_to_stock     — вернуть на склад (хорошее состояние)
write_off           — списать как брак
send_to_supplier    — отправить поставщику (гарантийный)
```

#### Частичный возврат
- В MVP — только полный возврат чека
- В Expansion — по позициям (return_items)

#### Новые таблицы
```sql
customer_returns (customer_id, sale_id, return_date, return_type, reason,
                  reason_note, status, refund_method, refund_kopecks,
                  stock_action, warranty_claim_id, approved_by)

customer_return_items (return_id, product_id, quantity, unit_price_kopecks,
                       condition: good/damaged/opened_packaging/defective)
```

---

### 13.5 СКЛАД — дополнения из SPEC_MODULES_ALL.md

#### Приёмка товара (inventory_receipts)
```sql
inventory_receipts (receipt_number, supplier_id, supplier_invoice_number,
                    status: draft/confirmed/cancelled, total_amount,
                    received_by, confirmed_at)

inventory_receipt_items (receipt_id, product_id, qty, purchase_price, total)
```
При `confirm` → транзакция: `products.qty_on_hand += qty` для каждой позиции.

#### Списание товара
```sql
inventory_writeoffs (product_id, qty, reason: damaged/expired/lost/defective/correction/other,
                     written_off_by, created_at)
```
При списании → `products.qty_on_hand -= qty`.

#### Инвентаризация
```sql
inventory_sessions (session_name, status: in_progress/completed/cancelled, started_by)
inventory_session_items (session_id, product_id, expected_qty, counted_qty, variance)
```
При `complete` → применить расхождения к `qty_on_hand`.

#### Резервы под заказы
```sql
inventory_reserves (product_id, order_id, customer_id, qty, expires_at, released_at)
```
`qty_available = qty_on_hand - qty_reserved`

---

### 13.6 ЗАМОВЛЕННЯ — полная машина состояний

#### Статусы и переходы
```
draft → quoted → prepaid → ordered_from_supplier → arrived → issued → completed
                                                                     ↓
любой статус →                                                   cancelled
completed →                                                      lost (ретроспективно)
```

#### Причины потери заказа (для аналитики)
```
price_too_high, found_elsewhere, wrong_part,
customer_changed_mind, delivery_too_slow, other
```

#### Новые таблицы
```sql
orders (order_number, customer_id, manager_id, status, source,
        quoted_total, prepayment_amount, final_total, promised_date,
        is_overdue, supplier_id, vehicle_id, cancel_reason, lost_reason)

order_items (order_id, product_id, custom_description, oem_number,
             qty, quoted_price, purchase_price)

order_status_history (order_id, old_status, new_status, changed_by, notes)

order_attachments (order_id, attachment_type, file_url, file_name, uploaded_by)
```

---

### 13.7 ПОСТАВЩИКИ — дополнения из SPEC_SUPPLIER_JOURNAL.md

#### Speed score
- `(delivered_on_time / total_orders) * 100`
- Пересчитывается еженедельно (последние 90 дней)
- Хранится в `suppliers.speed_score`

#### Приоритет поставщика при заказе
1. Наличие → 2. Цена (дешевле) → 3. Speed score → 4. Lead time

#### Журнал закупок от поставщика
```sql
supplier_purchases (supplier_id, receipt_id, invoice_number, invoice_date, total_kopecks)
supplier_purchase_items (product_id, product_name_snapshot, quantity, unit_price_kopecks)
```

#### Возвраты поставщику
```sql
supplier_returns (supplier_id, purchase_id, return_date, reason,
                  status: pending/sent/accepted/rejected/refunded, refund_kopecks)
```

#### Гарантийные претензии
```sql
supplier_warranty_claims (supplier_id, product_id, customer_id, sale_id,
                          description, status: open/sent/waiting/resolved, resolved_at)
```

---

### 13.8 ЛОЯЛЬНОСТЬ И РИСК — из SPEC_LOYALTY_RISK_NOTES.md

#### Бонусная программа (Expansion, не MVP)
```sql
loyalty_settings (is_enabled, accrual_pct DEFAULT 2, max_redeem_pct DEFAULT 30, expiry_days)
loyalty_transactions (customer_id, type: accrual/redemption, amount_kopecks, sale_id)
```
1 бонус = 1 грн скидки при следующей покупке.

#### Риск-профиль клиента (AUTO)
| Уровень | Условие |
|---|---|
| `attention` | Долг 14-30 дней ИЛИ 2+ возврата за 30 дней |
| `high_risk` | Долг > 30 дней + > 1000 грн ИЛИ 3+ возврата за 90 дней |
| `blocked` | Только вручную Owner. Продажа только наличными |

Поля: `customers.risk_level`, `risk_note`, `risk_updated_at`

#### Закреплённые заметки
```sql
customer_notes (customer_id, text, is_pinned, color: yellow/red/green/blue, created_by)
```
Закреплённые заметки показываются при добавлении клиента в чек.

---

### 13.9 ИМПОРТ НАКЛАДНОЙ — из SPEC_IMPORT_INVOICE.md (Expansion)

#### Алгоритм нормализации артикулов
```typescript
function normalizeArticle(raw: string): string {
  return raw.replace(/[\s\-\.\/\_]/g, '').toUpperCase().replace(/^0+/, '')
}
```

#### Типы совпадений
```
exact  (confidence 100%) — артикул найден точно
fuzzy  (confidence 60-95%) — Levenshtein distance ≤ 2
new    (confidence 0%) — товар не найден, нужно создать
```

#### Таблицы импорта
```sql
import_sessions (supplier_id, source_type: excel/csv/text, status, receipt_id)
import_session_rows (import_session_id, row_number, raw_article, raw_name,
                     normalized_article, match_type, matched_product_id,
                     confidence_score, user_decision: accept/reject/create_new)
```

---

### 13.10 АВТОМОБИЛЬНАЯ ЛОГИКА — из SPEC_AUTOMOTIVE_LOGIC_AND_ROLES.md

#### Поиск по совместимости (Fitment)
```
POST /api/v1/fitment/search
Body: { make, model, year, part_type }
Response: { in_stock: [...], can_order: [...], not_available: [...] }
```

#### VIN декодирование (Expansion)
- WMI (1-3 символ) → производитель
- VDS (4-9) → характеристики (модель, двигатель, тип кузова)
- VIS (10-17) → серийный номер + год выпуска (позиция 10)
- Чек-сумма на позиции 9
- `POST /api/v1/vin/decode` — принимает строку или URL фото

#### Часто продаваемые вместе
- Материализованное представление: `co_occurrence` (product_a, product_b, count)
- Порог: >= 3 раза в одном чеке
- Отображение в POS: "Часто купують разом"

---

### 13.11 AUDIT LOG — из SPEC_PROTECTION_AUDIT.md

```sql
audit_log (user_id, user_name, action, entity_type, entity_id,
           old_value JSONB, new_value JSONB, ip_address, created_at)
```

Что логируем ОБЯЗАТЕЛЬНО:
- Вход / выход из системы
- Изменения цен (старая → новая)
- Все возвраты
- Override min_price (с PIN)
- Изменения ролей пользователей
- Проведение накладных
- Закрытие смены
- Блокировка клиентов

---

### 13.12 ПОЛНАЯ ФАЗИРОВКА (уточнённая)

| Фаза | Что входит | Срок |
|---|---|---|
| **MVP (Фазы 1-4)** | Auth, Товары, POS, Клиенты, Смены, Возвраты (полные), Отчёты базовые | 4-6 нед |
| **v1.1** | Ценовые уровни, PIN-override, Приёмка товара, Инвентаризация | 2-3 нед |
| **v1.2** | Заказы (статус-машина), Журнал поставщиков, Гарантийные претензии | 2-3 нед |
| **v2.0** | Лояльность, Риск-профиль, Заметки клиентов, Импорт накладных | 2-3 нед |
| **v2.1** | Telegram/сообщения/лиды, Автоуведомления | 2-3 нед |
| **v3.0** | VIN/OCR/Fitment, Аудит лог полный, Мультимагазинность | 4+ нед |

---

### 13.13 ИСПРАВЛЕННЫЕ ПРОТИВОРЕЧИЯ

| Противоречие | Решение |
|---|---|
| API `/api/` vs `/api/v1/` | **Используем `/api/v1/`** (13 из 14 файлов) |
| Мультитенантность ДА/НЕТ | **MVP = один магазин**, `tenant_id` в схеме для будущего |
| Electron vs Web | **Только Web** в MVP. Electron — в v3.0+ |
| Простой возврат vs полный | **MVP = полный чек**, v1.1 = частичный + типы |
| `/login` rate limit 5 vs 10 | **10 попыток/час** (из SPEC_MASTER.md раздел 8) |
