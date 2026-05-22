# CRM-Forsage — План промышленной разработки (Chief Architect)

> Составитель: Claude Opus 4.7 (Chief Architect + Enterprise Product Owner)
> Дата: 2026-05-22
> Статус: ПРОЕКТ (к исполнению)
> Ветка: main

---

## СОДЕРЖАНИЕ

1. [ТЕХНИЧЕСКИЙ ОТЧЁТ О ТЕКУЩЕМ СОСТОЯНИИ](#1-технический-отчёт-о-текущем-состоянии)
2. [КАРТА ЗАВИСИМОСТЕЙ](#2-карта-зависимостей)
3. [ЧТО УЖЕ СУЩЕСТВУЕТ](#3-что-уже-существует)
4. [ЧТО МОЖНО ПЕРЕИСПОЛЬЗОВАТЬ](#4-что-можно-переиспользовать)
5. [ЧТО КАТЕГОРИЧЕСКИ НЕЛЬЗЯ МЕНЯТЬ](#5-что-категорически-нельзя-менять)
6. [РАЗБИВКА НА МОДУЛИ (ЭТАПЫ)](#6-разбивка-на-модули-этапы)
7. [ДЕТАЛЬНЫЙ ПЛАН КАЖДОГО ЭТАПА](#7-детальный-план-каждого-этапа)
8. [СВОДНАЯ ТАБЛИЦА](#8-сводная-таблица)
9. [КРИТИЧЕСКИЙ ПУТЬ](#9-критический-путь)
10. [СТОП-УСЛОВИЯ](#10-стоп-условия)
11. [ЧЕГО НЕ ДЕЛАТЬ ДО КОНЦА ПРОЕКТА](#11-чего-не-делать-до-конца-проекта)

---

## 1. ТЕХНИЧЕСКИЙ ОТЧЁТ О ТЕКУЩЕМ СОСТОЯНИИ

### 1.1. Архитектура системы

```
┌─────────────────────────────────────────────────────────────┐
│  apps/web (React 18 + Vite + TypeScript + Zustand)          │
│  Feature-based organisation: pos/, orders/, inventory/, ... │
│  Supabase client (supabase-js)                              │
├─────────────────────────────────────────────────────────────┤
│  server (Express + TypeScript)                              │
│  Routes → Services → Validators (Zod)                       │
│  DB: Supabase (PostgREST) + direct RPC calls               │
├─────────────────────────────────────────────────────────────┤
│  supabase (PostgreSQL + PostgREST)                          │
│  Migrations: 001-065                                       │
│  RLS: permissive (service-role bypass)                     │
│  RPC: process_sale, process_return, reserve_order_items,   │
│        process_internal_consumption, process_writeoff,      │
│        post_supply_invoice, claim_next_job, ...             │
└─────────────────────────────────────────────────────────────┘
```

### 1.2. Технологический стек

| Компонент | Технология | Статус |
|-----------|-----------|--------|
| Frontend | React 18 + Vite + TypeScript | Production |
| State | Zustand + URL params | Production |
| Backend | Express.js + TypeScript | Production |
| Database | PostgreSQL 15+ (Supabase) | Production |
| Auth | Supabase Auth (email OTP) | Production |
| RLS | Supabase RLS | Production (permissive) |
| Messaging | Telegraf (Telegram Bot) | Production |
| Background jobs | pg + setInterval + sys_background_jobs | Production |
| Notifications | Telegram direct messages | Partial |
| Print | Browser `window.print()` | Partial |

### 1.3. База данных (ключевые таблицы)

| Таблица | Назначение | Сущ. |
|---------|-----------|------|
| `products` | Товары (qty_on_hand, purchase_price, retail_price, storage_bin) | 003 |
| `customers` | Клиенты (debt_balance, loyalty, etc.) | 001 |
| `sales` / `sale_items` | Продажи | 001 |
| `shifts` | Кассовые смены | 001 |
| `customer_orders` / `customer_order_items` | Заказы клиентов | 003+ |
| `inventory_sessions` / `inventory_items` | Инвентаризация | 040 |
| `inventory_writeoffs` / `inventory_writeoff_items` | Списание | 007 |
| `inventory_reserves` | Резервы (expires_at, released_at) | 003 |
| `inventory_receipts` / `inventory_receipt_items` | Приёмка товара | 003 |
| `internal_consumptions` | Внутренний отпуск | 057 |
| `salary_payments` | Зарплата (salary, bonus, advance, penalty) | 057 |
| `expense_categories` | Статьи расходов | 046 |
| `cash_operations` | Кассовые операции | 009 |
| `sys_background_jobs` | Фоновые задачи (FOR UPDATE SKIP LOCKED) | 062 |
| `loyalty_settings` / `loyalty_transactions` | Программа лояльности | 036 |
| `audit_log` | Аудит действий | 001 |
| `order_activity_log` | Лог активности заказов | 050 |
| `telegram_channels` | Telegram-каналы | 023 |
| `notification_triggers` | Настройки уведомлений | 044 |
| `supply_invoices` / `supply_invoice_items` | Накладные поставщиков | 003 |

### 1.4. API-маршруты (Express, 35+)

| Route | Назначение | Статус |
|-------|-----------|--------|
| `/api/v1/auth/*` | Аутентификация | ✅ |
| `/api/v1/products/*` | Товары (CRUD, фото, спецификации) | ✅ |
| `/api/v1/customers/*` | Клиенты (CRUD, группы, авто) | ✅ |
| `/api/v1/sales/*` | Продажи (журнал) | ✅ |
| `/api/v1/shifts/*` | Смены (открыть/закрыть) | ✅ |
| `/api/v1/returns/*` | Возвраты | ✅ |
| `/api/v1/cash-operations/*` | Кассовые операции | ✅ |
| `/api/v1/suppliers/*` | Поставщики | ✅ |
| `/api/v1/import/*` | Импорт прайсов | ✅ |
| `/api/v1/inventory/*` | Инвентаризация | ✅ |
| `/api/v1/writeoffs/*` | Списание | ✅ |
| `/api/v1/picking/*` | Сборка заказов (WMS) | ✅ |
| `/api/v1/reserves/*` | Резервы | ✅ |
| `/api/v1/customer-orders/*` | Заказы клиентов | ✅ |
| `/api/v1/salary/*` | Зарплата | ✅ |
| `/api/v1/internal-consumptions/*` | Внутренний отпуск | ✅ |
| `/api/v1/reports/*` | Отчёты | ✅ |
| `/api/v1/analytics/*` | Аналитика (ABC, KPI) | ✅ |
| `/api/v1/loyalty/*` | Лояльность | ✅ |
| `/api/v1/admin/*` | Администрирование | ✅ |
| `/api/v1/audit/*` | Аудит | ✅ |
| `/api/v1/chats/*` | Чаты | ✅ |
| `/api/v1/channels/*` | Каналы связи | ✅ |
| `/api/v1/telegram/*` | Telegram | ✅ |
| `/api/v1/waitlist/*` | Лист ожидания | ✅ |

### 1.5. UI-страницы (React, 30+)

| Путь | Компонент | Статус |
|------|----------|--------|
| `/login` | LoginPage | ✅ |
| `/dashboard` | DashboardPage | ✅ |
| `/pos` | POSPage | ✅ |
| `/products` | ProductsPage | ✅ |
| `/customers` | CustomersPage | ✅ |
| `/orders` | OrdersPage | ✅ |
| `/inventory` | InventoryPage | ✅ |
| `/inventory/picking` | WarehousePicking | ✅ |
| `/inventory/writeoffs` | WriteoffsPage | ✅ |
| `/inventory/reserves` | ReservesList | ✅ |
| `/internal` | InternalConsumptionsPage | ✅ |
| `/reports` | DailyReport | ⚠️ (только базовый) |
| `/abc` | ABCAnalysis | ✅ |
| `/staff-kpi` | StaffKPI | ⚠️ (базовый) |
| `/staff` | StaffPage | ✅ |
| `/staff-salary` | StaffSalaryPage | ✅ |
| `/labels` | LabelDesigner | ✅ |
| `/pricing` | PricingPage | ✅ |
| `/settings` | SettingsPage | ✅ |

### 1.6. Существующие RPC (PostgreSQL)

```sql
-- Ключевые RPC (полный список)
process_sale                  -- Продажа (POS)
process_sale_v2               -- Версия с cost_price snapshot
process_return                -- Возврат
process_internal_consumption  -- Внутренний отпуск
process_writeoff              -- Списание
post_supply_invoice           -- Проводка накладной
cancel_supply_invoice         -- Отмена накладной
upsert_product_import         -- Импорт товаров
reserve_order_items           -- Резерв по заказу
create_manual_reserve         -- Ручной резерв
update_customer_order_status  -- Статус заказа
release_expired_reserves      -- Очистка просроченных резервов
claim_next_job                -- Захват фоновой задачи (SKIP LOCKED)
```

---

## 2. КАРТА ЗАВИСИМОСТЕЙ

### 2.1. Слой 0 — Ядро (существует, НЕ ТРОГАТЬ)
```
┌──────────────────────────────────────────────────┐
│  001: auth / tenants / staff                      │
│  003: products / customers / categories           │
│  RLS policies (permissive)                        │
└──────────────────────────────────────────────────┘
```

### 2.2. Слой 1 — Базовая логика (расширять осторожно)
```
┌──────────────────────────────────────────────────┐
│  POS: process_sale, process_return, shifts        │
│  Orders: customer_orders, customer_order_items     │
│  Suppliers: supply_invoices, imports               │
│  Inventory: writeoffs, internal_consumptions       │
└──────────────────────────────────────────────────┘
```

### 2.3. Слой 2 — Дополнительные модули
```
┌──────────────────────────────────────────────────┐
│  Inventory: sessions, reserves, stocktake         │
│  Loyalty: points, transactions                    │
│  Cash: operations, reconciliation                 │
│  Reports: daily, shift, sales, profit             │
└──────────────────────────────────────────────────┘
```

### 2.4. Слой 3 — Инфраструктура
```
┌──────────────────────────────────────────────────┐
│  Background jobs: sys_background_jobs, worker     │
│  Telegram bot, messengers                         │
│  Audit log                                        │
└──────────────────────────────────────────────────┘
```

### 2.5. Граф зависимостей новых этапов

```
ЭТАП-0 [сущ.] → ЭТАП-1 [резервы] → ЭТАП-2 [process_sale v2] → ЭТАП-3 [complete_order]
                 ↓                                               ↓
           ЭТАП-4 [COGS] ─────────────────────────────────→ ЭТАП-5 [commissions]
                 ↓
           ЭТАП-6 [negative balance] → ЭТАП-7 [inventory movement]
                 ↓
           ЭТАП-8 [KPI] (независим от 6,7)
                 ↓
ЭТАП-9 [notifications] → ЭТАП-10 [print center] (зависит от 9 по событиям)
                 ↓
ЭТАП-11 [auto-purchasing] → ЭТАП-12 [reports extended] → ЭТАП-13 [analytics]
```

---

## 3. ЧТО УЖЕ СУЩЕСТВУЕТ

См. [ROADMAP.md](ROADMAP.md) — этапы 1-10 покрывают резервы, picking, COGS, комиссии, job queue, импорт.

**Уже реализовано в коде (вне ROADMAP.md):**

| Функция | Статус | Где |
|---------|--------|-----|
| Инвентаризация (сессии, сканирование) | ✅ Полностью | migration 040, `routes/inventory.ts` |
| Списание товаров | ✅ Полностью | migration 007/063, `routes/writeoffs.ts` |
| Внутренний отпуск | ✅ Полностью | migration 057/063, `routes/internalConsumptions.ts` |
| Резервы с expires_at | ✅ Полностью | migration 003/064, `routes/reserves.ts` |
| Сборка заказов (WMS) | ✅ Полностью | migration 065, `routes/picking.ts` |
| Зарплата (выплаты) | ✅ Полностью | migration 057, `routes/salary.ts` |
| Кассовые операции | ✅ Полностью | migration 009, `routes/cashOperations.ts` |
| KPI персонала | ✅ Базово | `features/analytics/StaffKPI.tsx` |
| ABC-анализ | ✅ Базово | `features/analytics/ABCAnalysis.tsx` |
| Telegram-уведомления | ✅ Базово | `services/telegramBot.ts`, migration 044 |
| Фоновые задачи | ✅ Полностью | migration 062, `workers/jobWorker.ts` |
| Онлайн-заказы | ✅ Полностью | `routes/customerOrders.ts` |
| Программа лояльности | ✅ Полностью | `services/loyaltyService.ts` |
| Ожидание товара (waitlist) | ✅ Полностью | `routes/waitlist.ts` |
| Расходы (OPEX) | ✅ Полностью | migration 046 |
| Отчёты (день/смена/период) | ✅ Базово | `services/reportService.ts` |
| Dashboard | ✅ Базово | `DashboardPage.tsx` |
| Предотвращение race conditions | ✅ `FOR UPDATE` везде | migrations 063 |

---

## 4. ЧТО МОЖНО ПЕРЕИСПОЛЬЗОВАТЬ

| Для фичи | Что переиспользовать |
|----------|---------------------|
| **Reserve** | `inventory_reserves` (таблица), `release_expired_reserves` (RPC), `ReserveService` |
| **Negative balance** | `allow_negative_qty` (setting), `GREATEST(0, ...)` паттерн в RPC |
| **WMS Lite** | `storage_bin` (products), `pickup_cell` (orders), `picking.ts` (route), `WarehousePicking.tsx` |
| **Commissions** | `salary_payments` (таблица), `salary.ts` (route), `StaffSalaryPage.tsx` |
| **KPI** | `StaffKPI.tsx` (страница), `process_sale` (данные sales) |
| **Background jobs** | `sys_background_jobs` (таблица), `jobWorker.ts`, `claim_next_job` (RPC) |
| **Notifications** | `telegramBot.ts`, `orderReminders.ts`, `notification_triggers` (таблица) |
| **Print Center** | `LabelDesigner.tsx`, `LabelPrinter.tsx`, `ReceiptPrint.tsx`, `OrderReceiptPrint.tsx` |
| **Auto-purchasing** | `supply_invoices` (таблица), `product_supplier_codes` (таблица), `importService.ts` |
| **Reports** | `reportService.ts`, `DailyReport.tsx`, `analytics.ts` (route) |
| **Analytics** | `ABCAnalysis.tsx`, `StaffKPI.tsx`, `analytics.ts` (route) |
| **Movement (warehouse)** | `internal_consumptions` (таблица), `process_internal_consumption` (RPC, паттерн) |

---

## 5. ЧТО КАТЕГОРИЧЕСКИ НЕЛЬЗЯ МЕНЯТЬ

```yaml
CRITICAL (изменение = поломка работающей системы):
  - process_sale (создать v2, не трогать оригинал)
  - process_return (не трогать вообще)
  - shift open/close (не трогать)
  - auth flow (login/logout/session)
  - существующие RLS policies (только ADD новых)

DANGER (изменять только через feature flag):
  - customer_orders.status workflow (строгая машина состояний)
  - sale_items (cost_price только ADD column)
  - products.qty_on_hand (все изменения через RPC)
  - payment flow (POS) - cat-1

CAN EXTEND (добавлять, не рефакторить):
  - sidebar (ADD items, не перестраивать)
  - services (ADD methods, не переписывать)
  - types (ADD fields, не менять существующие)
```

---

## 6. РАЗБИВКА НА МОДУЛИ (ЭТАПЫ)

### 6.1. Сопоставление 12 фич с этапами

| # | Фича | Этап(ы) | Статус | Тип |
|---|------|---------|--------|-----|
| 1 | Управление запасами | E-7 (movement), остальное EXISTS | 90% есть | EXTEND |
| 2 | Запрет отрицательных остатков | E-6 | 70% есть | EXTEND |
| 3 | Временное резервирование | EXISTS (expires_at, release_expired) | 95% есть | EXTEND |
| 4 | Комиссии сотрудников | E-5 | 0% есть | NEW |
| 5 | KPI сотрудников | E-8 | 60% есть | EXTEND |
| 6 | Фоновые задачи | EXISTS (jobWorker, sys_background_jobs) | 90% есть | EXTEND |
| 7 | WMS Lite | EXISTS (picking, storage_bin, pickup_cell) | 85% есть | EXTEND |
| 8 | Уведомления | E-9 | 40% есть | EXTEND |
| 9 | Центр печати | E-10 | 40% есть | EXTEND |
| 10 | Автозакупки | E-11 | 0% есть | NEW |
| 11 | Отчёты | E-12 | 50% есть | EXTEND |
| 12 | Аналитика | E-13 | 30% есть | EXTEND |

### 6.2. Порядок внедрения

```
Фаза 0 (P0 — существующий ROADMAP, уже спланирован):
  ├── E-0: Available qty view (read-only, foundation)
  ├── E-1: Warehouse reservation in customer_orders
  ├── E-2: process_sale respects reserves
  ├── E-3: Atomic order completion
  ├── E-4: Ready orders in POS       ─── 5 фич готовы
  └── E-5: Picking + cell

Фаза 1 (P1 — финансы):
  ├── E-6: COGS snapshot + profit report
  └── E-7: Employee commissions (manager)

Фаза 2 (P2 — инфраструктура):
  ├── E-8: Job queue (упорядочивание существующего)
  └── E-9: Import wizard improvement

Фаза 3 (P3 — новая функциональность):
  ├── E-10: Negative balance hardening (DB constraint)
  ├── E-11: Inventory movement (warehouse-to-warehouse)
  ├── E-12: Employee KPI enhancement
  ├── E-13: Notification system multi-channel
  ├── E-14: Print Center (consolidation)
  ├── E-15: Auto-purchasing (reorder engine)
  ├── E-16: Reports extension (dynamic, export)
  └── E-17: Analytics (forecasting, dashboards)
```

---

## 7. ДЕТАЛЬНЫЙ ПЛАН КАЖДОГО ЭТАПА

### ЭТАП 0 — P0

_Полностью описан в ROADMAP.md: ЭТАПЫ 1-10. См. ROADMAP.md строки 16-560._

Краткая карта:

| Этап ROADMAP | Суть | Прогонов |
|-------------|------|---------|
| 1 | `v_product_stock` VIEW + `get_available_qty` | 1 |
| 2 | Резервирование warehouse-позиций в заказах | 1 |
| 3 | `process_sale_v2` с учётом резервов | 1 |
| 4 | `complete_customer_order` атомарно | 1 |
| 5 | Готовые заказы в POS | 1-2 |
| 6 | Picking + комірка | 1 |
| 7 | COGS-snapshot + profit report | 1 |
| 8 | Комиссии менеджерам | 1 |
| 9 | Job queue | 1-2 |
| 10 | Импорт прайса wizard | 1-2 |

---

### ЭТАП 6 (NEW — Negative Balance Hardening)

**Тип:** EXTEND

**Почему именно сейчас:** Базовая логика reserve/release уже работает (этапы 0-5 ROADMAP). Сейчас система защищает от ухода в минус через `GREATEST(0, ...)` и `allow_negative_qty`, но нет **DB-level constraint**, который гарантирует инвариант даже при баге в RPC.

**Существующее:**
- таблицы: `products.qty_on_hand`, `shop_settings.allow_negative_qty`
- RPC: `process_sale`, `process_internal_consumption`, `process_writeoff` — уже используют `FOR UPDATE` и `GREATEST(0, ...)`
- сервисы: `saleService.ts`, `writeoffService.ts`
- миграция: `063_prevent_race_conditions.sql`

**Создать:**
- таблицы: нет
- RPC: `validate_negative_stock()` — триггерная функция, `CHECK (qty_on_hand >= 0)` условный (только если `allow_negative_qty = false`)
- сервисы: `server/src/services/stockValidatorService.ts` — периодическая проверка целостности
- API: `GET /api/v1/admin/stock-integrity` — проверка расхождений
- UI: `apps/web/src/features/admin/StockIntegrityPage.tsx` — страница для владельца
- cron: `validate_stock_integrity` каждые 6ч через job queue

**Изменить:**
- `supabase/migrations/066_negative_balance_hardening.sql` — добавить триггер `BEFORE UPDATE OF qty_on_hand ON products`, который проверяет `allow_negative_qty` и блокирует отрицательное значение. **Важно:** триггер должен проверять setting на tenant_id, а не жестко запрещать.
- `server/src/index.ts` — зарегистрировать `validate_stock_integrity` handler в jobWorker

**НЕ ТРОГАТЬ:**
- Существующие RPC (process_sale, process_writeoff и т.д.)
- `shop_settings` структуру
- POS/UI для кассира
- `GREATEST(0, ...)` в существующих RPC (оставить как двойную защиту)

**Бизнес поток:**
1. Владелец вкл/выкл `allow_negative_qty` в настройках
2. Если запрещено → триггер блокирует `UPDATE qty_on_hand < 0`
3. Если разрешено → триггер пропускает (backward compatibility)
4. Интеграция-проверка запускается по расписанию, логирует расхождения в audit_log

**Прогон 1:**
- Создать триггерную функцию и триггер на `products`
- Проверить: `UPDATE products SET qty_on_hand = -5` → блокируется (если allow_negative=false)

**Прогон 2:** (если нужно)
- Страница StockIntegrityPage + endpoint
- cron-задача

**Верификация:**
- Позитивный: `allow_negative_qty=false` → UPDATE на 0 проходит, на -5 блокируется
- Краевой: `allow_negative_qty=true` → UPDATE на -5 проходит (старое поведение)
- Краевой: UPDATE на NULL → не блокируется
- Нагрузочный: 1000 параллельных UPDATE на один product_id → ни один не уходит в минус

**Риски:** Низкий — триггер только на UPDATE, read-only. Откат: DROP TRIGGER + DROP FUNCTION.

**Откат:** `DROP TRIGGER IF EXISTS trg_prevent_negative_qty ON products; DROP FUNCTION IF EXISTS fn_prevent_negative_qty;`

**Definition of Done:**
- Триггер блокирует отрицательный qty_on_hand при запрете
- Все существующие RPC продолжают работать
- TS проверка зелёная (`npx tsc --noEmit`)

> **РАЗРЕШЕНО ПЕРЕХОДИТЬ К СЛЕДУЮЩЕМУ ЭТАПУ:** ДА (после прогона 1 — триггер работает)

---

### ЭТАП 7 (NEW — Inventory Movement Warehouse-to-Warehouse)

**Тип:** NEW

**Почему именно сейчас:** Единственная missing-функция в inventory management — перемещение между складами/витринами. Без неё учёт товара неполный.

**Существующее:**
- таблицы: `products.storage_bin`, `internal_consumptions` (шаблон движения)
- RPC: `process_internal_consumption` (паттерн списания с FOR UPDATE)
- сервисы: нет для movement

**Создать:**
- таблицы: `warehouse_movements (id, tenant_id, from_bin, to_bin, product_id, qty, moved_by, note, created_at)`
- RPC: `process_warehouse_movement(p_tenant_id, p_product_id, p_qty, p_from_bin, p_to_bin, p_moved_by, p_note)` — блокирует строку товара, проверяет остаток, обновляет qty (нетто — не меняется, только `storage_bin`)
- сервисы: `server/src/services/movementService.ts` — `createMovement()`, `listMovements()`
- API: `GET /api/v1/warehouse/movements` — список, `POST /api/v1/warehouse/movements` — создать
- UI: `apps/web/src/features/inventory/WarehouseMovementPage.tsx` — форма: выбор товара, from → to, qty
- В sidebar: пункт «Перемещения» в группе Склад

**Изменить:**
- `apps/web/src/components/Sidebar.tsx` — добавить `/inventory/movements`
- `server/src/index.ts` — добавить роут

**НЕ ТРОГАТЬ:**
- `products.qty_on_hand` (нетто не меняется)
- `process_sale`, `process_internal_consumption`
- Существующие страницы инвентаризации

**Бизнес поток:**
1. Сотрудник открывает страницу «Перемещения»
2. Сканирует/выбирает товар, указывает `from_storage_bin`, `to_storage_bin`, qty
3. Система проверяет: товар есть в `from_bin` в достаточном количестве
4. Создаёт запись в `warehouse_movements`, обновляет `products.storage_bin` (на новое расположение)
5. Логируется в `audit_log`

**Прогон 1:**
- Миграция + RPC + route + service
- Тест: переместить товар, проверить storage_bin изменился

**Прогон 2:** (если нужно)
- UI-страница + sidebar

**Верификация:**
- Позитивный: перемещение 5шт из A → B → `storage_bin` = B
- Краевой: from_bin не указан → перемещение только в B (без проверки)
- Краевой: товар не найден → 422
- Нагрузочный: 50 перемещений в минуту → OK

**Риски:** Низкий — не затрагивает qty_on_hand.

**Откат:** DROP TABLE warehouse_movements; удалить UI-маршрут и sidebar.

**Definition of Done:**
- Перемещение создаётся и видно в истории
- storage_bin обновляется
- audit_log содержит запись
- TS проверка зелёная

> **РАЗРЕШЕНО ПЕРЕХОДИТЬ К СЛЕДУЮЩЕМУ ЭТАПУ:** ДА

---

### ЭТАП 8 (NEW — Employee KPI Enhancement)

**Тип:** EXTEND

**Почему именно сейчас:** `StaffKPI.tsx` уже существует и показывает базовые метрики. Требуется расширение: цели (targets), периоды, визуализация трендов, связь с комиссиями (Этап 5).

**Существующее:**
- UI: `apps/web/src/features/analytics/StaffKPI.tsx`
- API: `server/src/routes/analytics.ts` — существующий аналитический роут
- данные: `sales.manager_id`, `sales.total`, `sale_items`
- таблицы: `salary_payments`, `shifts`

**Создать:**
- таблицы: `staff_kpi_targets (id, tenant_id, user_id, period, metric_type, target_value, created_at, updated_at)` — целевые показатели
- RPC: `calculate_kpi(p_user_id, p_period)` — считает факт против целей
- API: `GET /api/v1/analytics/kpi/:userId/:period` — KPI сотрудника за период
- API: `PATCH /api/v1/analytics/kpi/targets` — установка целей
- UI: Расширить `StaffKPI.tsx` — добавить блок «Цели», тренд (стрелка вверх/вниз), сравнение с прошлым периодом
- cron: `recalculate_kpi` — пересчёт в фоне (опционально)

**Изменить:**
- `apps/web/src/features/analytics/StaffKPI.tsx` — добавить: выбор периода, целевые показатели, тренды, экспорт в PDF
- `server/src/routes/analytics.ts` — добавить эндпоинты KPI
- `server/src/services/reportService.ts` — добавить методы KPI-расчётов

**НЕ ТРОГАТЬ:**
- Механику продаж (process_sale)
- Salary-логику
- Существующий ABC-анализ
- Dashboard (независимые страницы)

**Бизнес поток:**
1. Владелец задаёт KPI-цели сотруднику: «продаж на 500 000 в месяц», «5 заказов в день»
2. Система считает факт: сумма продаж за период
3. Сотрудник на странице KPI видит: цель / факт / %
4. Владелец видит сводку по всем сотрудникам

**Прогон 1:**
- Таблица KPI targets + endpoint установки целей
- RPC расчёта

**Прогон 2:**
- UI-расширение (тренды, цели, период)

**Верификация:**
- Позитивный: цель 100 000, факт 120 000 → 120%
- Краевой: цели нет → показывать только факт
- Краевой: 0 продаж → 0%
- Нагрузочный: 50 сотрудников × 12 месяцев → <1с

**Риски:** Низкий — аддитивная функциональность.

**Откат:** удалить таблицу KPI targets, скрыть UI-блоки.

**Definition of Done:**
- Владелец устанавливает цели, видит исполнение
- Сотрудник видит свои KPI с трендом
- TS проверка зелёная

> **РАЗРЕШЕНО ПЕРЕХОДИТЬ К СЛЕДУЮЩЕМУ ЭТАПУ:** ДА

---

### ЭТАП 9 (NEW — Notification System Multi-Channel)

**Тип:** EXTEND

**Почему именно сейчас:** Telegram-уведомления работают, но только для заказов. Нужны: SMS (через API), email, внутриприложение (toast/badge), шаблоны, настройки каналов для клиента.

**Существующее:**
- `server/src/services/telegramBot.ts` — Telegram bot
- `server/src/services/messengers/MessengerService.ts` — абстракция мессенджеров
- `server/src/services/orderReminders.ts` — напоминания
- таблицы: `telegram_channels`, `notification_triggers` (044)
- UI: `SettingsChannels.tsx`

**Создать:**
- таблицы:
  - `notification_templates (id, tenant_id, event_type, channel, title_template, body_template, is_active)`
  - `customer_notification_preferences (id, customer_id, channel, event_type, is_enabled)`
- RPC: нет (логика в service)
- сервисы:
  - `server/src/services/notifications/templateService.ts` — рендеринг шаблонов (Mustache-like)
  - `server/src/services/notifications/channelSms.ts` — SMS-провайдер (заглушка, конфигурируемый)
  - `server/src/services/notifications/channelInApp.ts` — внутриприложение (таблица `in_app_notifications`, badge на sidebar)
  - `server/src/services/notifications/dispatcher.ts` — выбирает каналы по preferences → отправляет
- API:
  - `GET /api/v1/notifications/templates` — список шаблонов
  - `PUT /api/v1/notifications/templates/:id` — обновить шаблон
  - `GET /api/v1/notifications/preferences/:customerId` — настройки клиента
  - `GET /api/v1/notifications/inbox` — внутриприложение уведомления
  - `PATCH /api/v1/notifications/inbox/:id/read` — отметить прочитанным
- UI:
  - `apps/web/src/features/notifications/TemplateEditor.tsx` — редактор шаблонов
  - `apps/web/src/features/notifications/InboxPage.tsx` — внутриприложение уведомления
  - Бейдж на sidebar (кол-во непрочитанных)
- cron: `dispatch_queued_notifications` каждые 1 мин

**Изменить:**
- `server/src/index.ts` — подключить роуты + инициализировать диспетчер
- `apps/web/src/components/Sidebar.tsx` — добавить бейдж уведомлений
- `apps/web/src/App.tsx` — добавить роуты

**НЕ ТРОГАТЬ:**
- Существующий Telegram bot (просто расширить его использование)
- `processOrderDeadlines` (диспетчер сам решает кому и как)
- POS и другие модули (они только инициируют события)

**Бизнес поток:**
1. Событие: заказ готов, просрочка, новый чат, напоминание
2. `dispatcher.ts` получает событие, проверяет `notification_templates` + `customer_notification_preferences`
3. Отправляет через выбранные каналы: Telegram, SMS (заглушка), InApp
4. Клиент видит: в Telegram сообщение, в приложении бейдж
5. Владелец настраивает шаблоны в TemplateEditor

**Прогон 1:**
- dispatcher + template engine + in-app таблица/endpoint
- Страница InboxPage

**Прогон 2:**
- SMS-канал (заглушка)
- TemplateEditor
- Интеграция с orderReminders через диспетчер

**Верификация:**
- Позитивный: событие → уведомление во всех выбранных каналах
- Краевой: ни один канал не настроен → тихий success
- Краевой: шаблон сломан → fallback "У вас новое уведомление"
- Нагрузочный: 1000 уведомлений → очередь в БД, не блокирует API

**Риски:** Средний — новая подсистема. Рекомендуется feature flag.

**Откат:** отключить диспетчер, оставить старый Telegram-бот. DROP новых таблиц.

**Definition of Done:**
- События проходят через диспетчер
- InApp-уведомления видны в приложении
- Шаблоны редактируются через UI
- TS проверка зелёная

> **РАЗРЕШЕНО ПЕРЕХОДИТЬ К СЛЕДУЮЩЕМУ ЭТАПУ:** ДА

---

### ЭТАП 10 (NEW — Print Center Consolidation)

**Тип:** EXTEND

**Почему именно сейчас:** Принты разбросаны: `LabelDesigner.tsx`, `LabelPrinter.tsx`, `ReceiptPrint.tsx`, `OrderReceiptPrint.tsx`, `PickingListPrint.tsx`. Нужен единый центр с очередью, предпросмотром и повторной печатью.

**Существующее:**
- UI: `LabelDesigner.tsx`, `LabelPrinter.tsx`, `ReceiptPrint.tsx`, `OrderReceiptPrint.tsx`, `PickingListPrint.tsx`
- сервисы: Нет серверного — весь принт в браузере через `window.print()`

**Создать:**
- таблицы: `print_jobs (id, tenant_id, document_type, document_id, template_id, status, copies, printed_at, printed_by)`
- сервисы: `server/src/services/printService.ts` — создание задачи печати, статус
- API:
  - `POST /api/v1/print` — создать задачу
  - `GET /api/v1/print/jobs?status=` — список задач
  - `GET /api/v1/print/jobs/:id` — статус задачи
- UI:
  - `apps/web/src/features/print/PrintCenterPage.tsx` — центр печати с историей
  - Переиспользовать существующие компоненты принта как renderers

**Изменить:**
- `apps/web/src/components/Sidebar.tsx` — добавить «Центр печати» в группу Управление
- `apps/web/src/App.tsx` — добавить маршрут `/print-center`
- Существующие компоненты принта: обернуть через `printService.createJob()` вместо прямого `window.print()`

**НЕ ТРОГАТЬ:**
- Логику формирования содержимого печати (LabelDesigner, ReceiptPrint и т.д.)
- POS-поток (просто добавить вызов createJob перед print)
- Принт этикеток (LabelDesigner остаётся как редактор шаблонов)

**Бизнес поток:**
1. Кассир нажимает «Печать чека» → `printService.createJob({ type: 'receipt', document_id: saleId, copies: 1 })`
2. Открывается окно предпросмотра (переиспользовать ReceiptPrint)
3. Кассир подтверждает → `window.print()` или отправка на принтер
4. В PrintCenterPage: история всех печатных задач, повторная печать

**Прогон 1:**
- Таблица print_jobs + API
- Обёртка над ReceiptPrint и PickingListPrint

**Прогон 2:** (если нужно)
- PrintCenterPage UI
- Интеграция с LabelDesigner

**Верификация:**
- Позитивный: создать задачу → статус, повторная печать
- Краевой: невалидный document_id → 404
- Краевой: повторная печать без оригинала → 404

**Риски:** Низкий — аддитивная инфраструктура.

**Откат:** убрать UI, оставить прямой `window.print()`. DROP таблицы.

**Definition of Done:**
- Все печатные формы логируются
- Центр печати показывает историю
- Повторная печать работает
- TS проверка зелёная

> **РАЗРЕШЕНО ПЕРЕХОДИТЬ К СЛЕДУЮЩЕМУ ЭТАПУ:** ДА

---

### ЭТАП 11 (NEW — Auto-Purchasing / Reorder Engine)

**Тип:** NEW

**Почему именно сейчас:** Самостоятельная новая фича. Позволяет автоматически создавать заказы поставщикам на основании `reorder_point` и `product_supplier_codes`.

**Существующее:**
- таблицы: `products.reorder_point`, `product_supplier_codes (supplier_id, supplier_code, lead_time_days, is_preferred)`
- сервисы: `supplierService.ts`, `importService.ts`
- UI: `SuppliersPage.tsx`, `InvoiceFormPage.tsx`, `ImportPage.tsx`

**Создать:**
- таблицы:
  - `auto_purchase_rules (id, tenant_id, product_id, supplier_id, min_qty, max_qty, lead_time_days, is_active)`
  - `auto_purchase_orders (id, tenant_id, status, created_from_rules, items JSONB, total_cost, created_at, confirmed_at)`
- RPC: `generate_purchase_suggestions(p_tenant_id)` — сканирует товары с `qty_on_hand < reorder_point`, группирует по поставщикам
- сервисы: `server/src/services/autoPurchaseService.ts` — `suggest()`, `confirmOrder()`, `dismiss()`
- API:
  - `GET /api/v1/auto-purchase/suggestions` — список рекомендаций
  - `POST /api/v1/auto-purchase/confirm` — создать накладную из рекомендации
  - `POST /api/v1/auto-purchase/rules` — CRUD правил
- UI:
  - `apps/web/src/features/autoPurchase/AutoPurchasePage.tsx` — список рекомендаций: товар, поставщик, текущий остаток, reorder_point, рекомендуемое кол-во
  - `apps/web/src/features/autoPurchase/RulesEditor.tsx` — настройка правил
- cron: `generate_purchase_suggestions` — ежедневно, через job queue

**Изменить:**
- `apps/web/src/components/Sidebar.tsx` — добавить «Автозакупки» в группу Поставщики
- `apps/web/src/App.tsx` — добавить маршруты

**НЕ ТРОГАТЬ:**
- Существующий импорт (ImportPage, importService)
- Supply invoices (просто использовать как шаблон)
- Products CRUD

**Бизнес поток:**
1. Владелец настраивает правила: «товар X заказывать у Y, мин 10, макс 50, lead 3 дня»
2. Ежедневно cron запускает `generate_purchase_suggestions`
3. Владелец видит страницу с рекомендациями: «Товар X (остаток 2, порог 10) → заказать 8 у Y»
4. Подтверждает → создаётся supply_invoice draft, готов к редактированию и проводке
5. Результат: накладная в обычном списке накладных

**Прогон 1:**
- Таблицы + RPC + сервис
- API suggestions + confirm

**Прогон 2:**
- Rules CRUD
- UI AutoPurchasePage + RulesEditor

**Прогон 3:** (если нужно)
- cron-задача
- Интеграция с job queue

**Верификация:**
- Позитивный: товар с qty_on_hand=2, reorder_point=10 → suggestion на 8 шт
- Краевой: товар не имеет поставщика → excluded
- Краевой: несколько поставщиков на товар → берётся preferred
- Нагрузочный: 10 000 товаров → <5с

**Риски:** Средний — создаёт draft-накладные, не изменяет остатки. Ошибка ведёт к лишнему предложению, не к списанию.

**Откат:** DROP таблиц auto_purchase, скрыть UI.

**Definition of Done:**
- Сгенерированные рекомендации видны на странице
- Подтверждение создаёт supply_invoice draft
- TS проверка зелёная

> **РАЗРЕШЕНО ПЕРЕХОДИТЬ К СЛЕДУЮЩЕМУ ЭТАПУ:** ДА

---

### ЭТАП 12 (NEW — Reports Extension)

**Тип:** EXTEND

**Почему именно сейчас:** `reportService.ts` считает базовые метрики. Нужны: P&L (прибыль/убыток), динамика, сравнение периодов, экспорт (PDF, Excel), кастомизируемые дашборды.

**Существующее:**
- `server/src/routes/reports.ts` — базовые эндпоинты
- `server/src/services/reportService.ts` — методы: getSalesToday, getSalesPeriod, getLowStockProducts, getDebtors, getWeeklySales, getTopProducts, getWriteoffsSummary, getShiftReport
- UI: `DailyReport.tsx` — базовый дневной отчёт
- данные: `sales`, `sale_items`, `products`, `expense_categories`, `cash_operations`

**Создать:**
- таблицы: `saved_reports (id, tenant_id, name, config JSONB, created_by, created_at)`
- RPC: `report_profit_loss(p_tenant_id, p_from, p_to)` — P&L: revenue, cogs, gross_margin, expenses (OPEX), net_profit
- сервисы: `server/src/services/reportService.ts` — добавить:
  - `getProfitLoss(from, to)`
  - `exportReport(type, from, to, format: 'pdf'|'xlsx')` (заглушка: возвращает JSON, конверсия на клиенте)
  - `comparePeriods(basePeriod, comparisonPeriod)` — динамика
- API:
  - `GET /api/v1/reports/profit-loss?from=&to=` — P&L
  - `GET /api/v1/reports/compare?base_from=&base_to=&compare_from=&compare_to=` — сравнение
  - `POST /api/v1/reports/saved` — сохранить отчёт
  - `GET /api/v1/reports/saved` — список сохранённых
- UI:
  - Расширить `DailyReport.tsx`:
    - Вкладки: День / Неделя / Месяц / Произвольный период
    - Блок P&L (выручка, себестоимость, валовая прибыль, расходы, чистая прибыль)
    - График динамики (Recharts или Chart.js)
    - Кнопка «Экспорт PDF» и «Экспорт Excel»
    - Сохранение конфигурации отчёта

**Изменить:**
- `apps/web/src/features/reports/DailyReport.tsx` — расширить (см. выше)
- `server/src/routes/reports.ts` — добавить новые эндпоинты

**НЕ ТРОГАТЬ:**
- POS (независимая страница)
- Существующий ABC и KPI (отдельные страницы)
- `process_sale` / `sale_items` (только чтение)

**Бизнес поток:**
1. Владелец открывает /reports
2. Выбирает период, видит P&L: выручка 1 000 000, себестоимость 600 000, валовая 400 000, расходы 150 000, чистая 250 000
3. Сравнивает с прошлым месяцем: +15% к прибыли
4. Нажимает «Экспорт Excel» → скачивает .xlsx
5. Сохраняет конфигурацию отчёта для регулярного просмотра

**Прогон 1:**
- RPC `report_profit_loss`
- P&L endpoint + UI-блок

**Прогон 2:**
- Сравнение периодов
- Экспорт (заглушка, client-side)

**Прогон 3:** (если нужно)
- Сохранённые отчёты
- Графики

**Верификация:**
- Позитивный: P&L за период с продажами и расходами
- Краевой: период без данных → все нули
- Краевой: нет расходов → gross = net
- Нагрузочный: год с 50 000 продаж → <3с

**Риски:** Низкий — read-only отчёты.

**Откат:** убрать UI-блоки, старые endpoint остаются.

**Definition of Done:**
- P&L отчёт работает с реальными данными
- Экспорт доступен
- Сравнение периодов показывает дельту
- TS проверка зелёная

> **РАЗРЕШЕНО ПЕРЕХОДИТЬ К СЛЕДУЮЩЕМУ ЭТАПУ:** ДА

---

### ЭТАП 13 (NEW — Analytics Dashboard)

**Тип:** EXTEND

**Почему именно сейчас:** ABC-анализ есть, KPI есть, P&L будет (Этап 12). Нужна единая аналитическая dashboard: тренды продаж, прогнозы, аномалии.

**Существующее:**
- `ABCAnalysis.tsx` — ABC-анализ товаров
- `StaffKPI.tsx` — KPI сотрудников
- `reportService.ts` — данные отчётов
- `DashboardPage.tsx` — текущий дашборд (базовый)

**Создать:**
- таблицы: `analytics_dashboards (id, tenant_id, name, widgets JSONB, created_by)`, `analytics_cache (metric_key, value JSONB, computed_at)` — кеш метрик
- RPC: нет (расчёт в service)
- сервис: `server/src/services/analyticsService.ts`:
  - `getDashboardMetrics(period)` — сводка: revenue, margin, top products, low stock, debtors, cash
  - `getForecast(metric, periodsBack)` — линейная экстраполяция на основе history
  - `getAnomalies()` — необычные паттерны (резкий спад продаж, аномальные возвраты)
- API:
  - `GET /api/v1/analytics/dashboard?period=` — метрики дашборда
  - `GET /api/v1/analytics/forecast?metric=sales&months=3` — прогноз
  - `GET /api/v1/analytics/anomalies` — аномалии
- UI:
  - Расширить `DashboardPage.tsx`: виджеты (выручка, прибыль, топ товаров, касса, должники), графики (Recharts), переключатель периода (день/неделя/месяц)
  - Виджет «Прогноз на 3 месяца»
  - Виджет «Аномалии» (красный флаг, если что-то не так)

**Изменить:**
- `apps/web/src/pages/DashboardPage.tsx` — полная переработка (аддитивно, сохранить старые блоки)
- `server/src/routes/analytics.ts` — добавить эндпоинты

**НЕ ТРОГАТЬ:**
- ABC и KPI страницы (остаются как детализация)
- POS, orders
- Старые блоки дашборда (можно скрыть, но не удалять)

**Бизнес поток:**
1. Владелец открывает /dashboard
2. Видит сводку: выручка сегодня / неделя / месяц, прибыль, топ-5 товаров
3. Видит прогноз: «При текущем тренде через 3 месяца выручка составит 1.2M»
4. Видит аномалии: «Продажи товара X упали на 80% за неделю»

**Прогон 1:**
- analyticsService.getDashboardMetrics
- API + расширение DashboardPage (виджеты)

**Прогон 2:**
- Прогноз (простая линейная регрессия)
- Аномалии (правила: спад > 50% = аномалия)

**Верификация:**
- Позитивный: dashboard показывает актуальные цифры
- Краевой: нет данных за период → "нет данных"
- Краевой: 0 продаж → "0"
- Нагрузочный: 100 000 записей → <1с (с кешем)

**Риски:** Низкий — read-only, кешируемые метрики.

**Откат:** вернуть старую DashboardPage, скрыть новые виджеты.

**Definition of Done:**
- Dashboard с виджетами работает
- Прогноз показывает разумные значения
- Аномалии детектятся
- TS проверка зелёная

> **РАЗРЕШЕНО ПЕРЕХОДИТЬ К СЛЕДУЮЩЕМУ ЭТАПУ:** ДА

---

## 8. СВОДНАЯ ТАБЛИЦА

| Этап | Что добавляет | Что использует | Что меняет | Риск | Прогонов | Польза |
|------|-------------|---------------|-----------|------|---------|-------|
| E-0 (ROADMAP 1) | VIEW v_product_stock, get_available_qty | products, inventory_reserves | productService, ProductDetailPage | 🟢 Low | 1 | База для резервов |
| E-1 (ROADMAP 2) | reserve_order_items RPC, reserve_id | E-0, inventory_reserves | customerOrders route | 🟡 Mid | 1 | Резервация в заказах |
| E-2 (ROADMAP 3) | process_sale_v2, USE_RESERVE_AWARE_SALE | E-0/E-1, process_sale | saleService, SearchPanel | 🔴 High | 1 | POS не продаёт резервы |
| E-3 (ROADMAP 4) | complete_customer_order RPC | E-2, customerOrders | route POST /complete | 🔴 High | 1 | Атомарная выдача |
| E-4 (ROADMAP 5) | ReadyOrdersPanel, posStore.loadReadyOrder | E-3, POSPage | POSPage, PaymentModal | 🟡 Mid | 1-2 | Удобная выдача |
| E-5 (ROADMAP 6) | pickup_cell, PickingPage | E-4, sales, telegram | telegram msg | 🟢 Low | 1 | Клиент знает куда идти |
| E-6 (ROADMAP 7) | sale_items.cost_price, profit report | process_sale_v2 | RPC, reports | 🟢 Low | 1 | Реальная прибыль |
| E-7 (ROADMAP 8) | commission_pct, salary preview/payout | E-6, salary_payments | StaffSalaryPage | 🟡 Mid | 1 | Мотивация менеджеров |
| E-8 (ROADMAP 9) | jobs table, worker, handlers | sys_background_jobs, setInterval | index.ts | 🟡 Mid | 1-2 | Стабильные async-задачи |
| E-9 (ROADMAP 10) | import preview wizard | importService, ImportModal | ImportModal | 🟢 Low | 1-2 | Импорт за 1 мин |
| **E-10 (NEW 6)** | **Триггер negative qty, integrity check** | shop_settings, products | **Триггер на products** | 🟢 Low | 1-2 | **Нет ухода в минус** |
| **E-11 (NEW 7)** | **warehouse_movements, перемещение** | products, storage_bin | **Sidebar, index.ts** | 🟢 Low | 1-2 | **Полный учёт товара** |
| **E-12 (NEW 8)** | **staff_kpi_targets, target vs fact** | StaffKPI, sales | **AnalyticsPage** | 🟢 Low | 2 | **KPI с целями** |
| **E-13 (NEW 9)** | **dispatcher, in-app, SMS (заглушка), шаблоны** | telegramBot, notification_triggers | **Sidebar, index.ts** | 🟡 Mid | 2 | **Multi-channel уведомления** |
| **E-14 (NEW 10)** | **print_jobs, PrintCenterPage** | ReceiptPrint, LabelDesigner | **Существующие принты** | 🟢 Low | 1-2 | **Журнал печати** |
| **E-15 (NEW 11)** | **auto_purchase_rules, suggestions** | products, suppliers, job queue | **Sidebar** | 🟡 Mid | 2-3 | **Автоматические закупки** |
| **E-16 (NEW 12)** | **P&L, сравнение, экспорт** | sales, expenses, reportService | **DailyReport** | 🟢 Low | 2-3 | **Полноценные отчёты** |
| **E-17 (NEW 13)** | **dashboard widgets, прогноз, аномалии** | ABC, KPI, reports | **DashboardPage** | 🟢 Low | 2 | **CEO dashboard** |

---

## 9. КРИТИЧЕСКИЙ ПУТЬ

```
E-0 ─→ E-1 ─→ E-2 ─→ E-3 ─→ E-4 ─→ E-5 ─→ E-6 ─→ E-7
  │      │       │       │       │       │       │       │
  │      │       │       │       │       │       │       ↓
  │      │       │       │       │       │       │     E-13 (notifications)
  │      │       │       │       │       │       │       │
  │      │       │       │       │       │       │       ↓
  │      │       │       │       │       │       │     E-14 (print center)
  │      │       │       │       │       │       │
  │      │       │       │       │       │       ↓
  │      │       │       │       │       │     E-15 (auto-purchasing)
  │      │       │       │       │       │
  │      │       │       │       │       ↓
  │      │       │       │       │     E-16 (reports)
  │      │       │       │       │       ↓
  │      │       │       │       │     E-17 (analytics)
  │      │       │       │       │
  │      │       │       │       ↓
  │      │       │       │     E-12 (KPI)
  │      │       │       │
  │      │       │       ↓
  │      │       │     E-10 (negative balance) ─→ E-11 (movement)
  │      │       │
  │      │       ↓
  │      │     E-9 (import wizard)
  │      │
  │      ↓
  │    E-8 (job queue)
  │
  ↓
(существующий ROADMAP)
```

**Критический путь (должен быть выполнен в порядке):**
`E-0 → E-1 → E-2 → E-3 → E-4 → E-5 → E-6 → E-7 → [E-15 | E-16 | E-17]`

**Могут выполняться параллельно (после E-6):**
- E-8 (job queue) с E-7 (commissions) — независимы
- E-10 (negative balance) с E-12 (KPI) — независимы
- E-13 (notifications) с E-15 (auto-purchasing) — независимы, но E-14 лучше после E-13
- E-16, E-17 — после E-6

---

## 10. СТОП-УСЛОВИЯ

1. **Не начинать E-N+1 до «зелёного» E-N.** «Зелёный» = миграция применена, `npx tsc --noEmit` чистый, smoke-test из блока Definition of Done пройден.

2. **Feature flag для этапов с High риском:** E-2, E-3. Переключатель в env, сервер запускается с выключенным флагом, проверяется, потом включается. Остальные — аддитивные.

3. **DDL миграции — в нерабочее время.** Особенно E-1 (новые колонки в customer_order_items), E-10 (триггер на products).

4. **Порядок деплоя:** server → migration → frontend. Старый frontend должен работать с новым backend ≥24ч.

5. **Каждый этап имеет откат.** Если новый process_sale_v2 ломается — env-флаг обратно на process_sale. Если auto_purchase_suggestions сломана — скрыть UI.

6. **Никакой этап не трогает файлы другого этапа.** Если план говорит «НЕ ТРОГАТЬ POSPage» — изменение там в этом же прогоне = негативный результат.

7. **Один прогон модели = один этап.** Если этап не влезает — расщепить на N.a / N.b, не «дописать в следующем прогоне».

8. **Никакого дублирования логики.** Если существует `process_internal_consumption` с FOR UPDATE — новый RPC использует тот же паттерн. Не писать новую блокировку с нуля.

---

## 11. ЧЕГО НЕ ДЕЛАТЬ ДО КОНЦА ПРОЕКТА

```yaml
НЕ ДЕЛАТЬ:
  - Переписывать auth систему (менять только через Supabase dashboard)
  - Менять существующие RPC process_sale, process_return (только v2)
  - Рефакторить POSPage (только аддитивные компоненты)
  - Менять структуру products (id, sku, barcode — неизменный ключ)
  - Удалять существующие миграции (только ADD новых)
  - Перестраивать Sidebar навигацию (только ADD пунктов)
  - Переписывать types/index.ts (только ADD новых типов)
  - Удалять старые endpoint без deprecation notice
  - Вводить новую ORM (оставить supabase-js + PostgREST)
  - Менять систему ролей (owner, admin, manager, cashier, storekeeper)
  - Добавлять тесты старого кода (только новые тесты для нового кода)
  - Менять формат денег (INTEGER копейки — СВЯЩЕННЫЙ)

ПОСТАВИТЬ НА ПАУЗУ:
  - Миграция на другую облачную платформу
  - Переход на GraphQL
  - Мобильное приложение (React Native)
  - Multi-tenant (упрощён: tenant_id = UUID default)
```

---

*Конец плана. Версия 1.0 от 2026-05-22.*
