# CRM-FORSAGE — ПОВНИЙ ОПИС СИСТЕМИ

> **Дата:** 2026-05-22  
> **Міграцій:** 001–089  
> **Backend:** Express.js + TypeScript (40+ роутів, 25+ сервісів)  
> **Frontend:** React 18 + Vite + Zustand (40+ сторінок, 20+ розділів)  
> **DB:** PostgreSQL 15+ (Supabase), RPC, RLS  

---

## 1. ЗАГАЛЬНА СТРУКТУРА

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND (apps/web)                    │
│  React 18 + Vite + TypeScript + Zustand + Recharts       │
│  45+ lazy-loaded pages, feature-based структура           │
├─────────────────────────────────────────────────────────┤
│                    BACKEND (server)                       │
│  Express.js + TypeScript                                 │
│  Routes → Middleware (auth, RBAC, validation) → Services │
│  DB calls: supabase-js (PostgREST) + db.rpc()            │
│  Auth: Supabase Auth (email OTP, sessions)               │
│  Messaging: Telegraf (Telegram) + MessengerService       │
│  Background: JobWorker + sys_background_jobs             │
├─────────────────────────────────────────────────────────┤
│                 DATABASE (Supabase / PostgreSQL)          │
│  89 міграцій, ~80 таблиць                               │
│  RLS: permissive (service role bypass)                   │
│  RPC: process_sale_v3, claim_next_job, reserve_order... │
│  Triggers: trg_prevent_negative_qty                     │
│  Sequences: sale_number_seq, suspend_number_seq          │
└─────────────────────────────────────────────────────────┘
```

---

## 2. МОДУЛІ

### 2.1. POS (Каса) — ядро системи

**Ключові файли:**
- `apps/web/src/features/pos/POSPage.tsx` — головний екран
- `apps/web/src/features/pos/PaymentModal.tsx` — оплата (5 методів)
- `apps/web/src/features/pos/SearchPanel.tsx` — пошук + сканер
- `apps/web/src/features/pos/ReceiptPanel.tsx` — чек + numpad
- `apps/web/src/stores/posStore.ts` — Zustand (tabs, items, customer)
- `apps/web/src/features/pos/usePOS.ts` — хук-міст
- `server/src/services/saleService.ts` — `createSale()` + idempotency + terminal + fiscal
- `server/src/routes/sales.ts` — `POST /suspend`, `POST /`, `GET /check-after-payment`

**API ендпоїнти:**
- `POST /api/v1/sales` — створити продаж (з Idempotency-Key)
- `POST /api/v1/sales/suspend` — відкласти чек
- `POST /api/v1/sales/:id/resume` — відновити чек
- `GET /api/v1/sales/check-after-payment` — перевірка після крашу
- `POST /api/v1/sales/calculate-price` — розрахунок ціни

**Потік продажу:**
```
1. Касир відкриває зміну → POST /shifts/open
2. Шукає товар → GET /products?search=
3. Додає в чек (Zustand posStore)
4. Вибирає клієнта (опціонально)
5. Оплата → PaymentModal → вибір методу
6. Термінал (якщо card/mixed) → ПІДТВЕРДЖУЄ ДО process_sale
7. process_sale_v3 → FOR UPDATE → INSERT sale → списання stock + бонуси
8. Фіскалізація (ПРРО: Кашалот/Mock)
9. Audit log
10. Зберегти idempotency key
```

**5 методів оплати:** готівка, термінал, переказ, борг, split

**RPC (process_sale_v3):**
- FOR UPDATE на всі товари
- qty_available = qty_on_hand - активні резерви
- Атомарне списання/нарахування бонусів (в тій же транзакції)
- GREATEST(0, ...) захист від від'ємних залишків
- Feature flags: `USE_BONUS_ATOMIC_SALE`, `USE_RESERVE_AWARE_SALE`

**Чеки:** мультивкладочність (до 5), swipe, localStorage crash recovery, hotkeys (F1-F12)

---

### 2.2. Товари (Products)

**Файли:** `routes/products.ts`, `services/productService.ts`, `features/products/`

**API:**
- `GET /products` — список з пошуком, пагінацією, фільтрами
- `GET /products/:id` — деталі з stock breakdown
- `POST /products` — створити
- `PUT /products/:id` — оновити
- `POST /products/:id/upload-photo` — фото
- `GET /products/:id/stock` — on_hand, reserved, available

**Сутності:**
- `products` — sku, name, barcode, brand_id, category_id, qty_on_hand, purchase_price, retail_price, storage_bin, reorder_point
- `product_barcodes` — додаткові штрихкоди
- `product_aliases` — псевдоніми
- `product_analogs` — аналоги (substitute, compatible)
- `product_supplier_codes` — коди постачальників
- `product_price_history` — історія цін
- `product_fitment` — сумісність з авто
- `brands`, `categories` — бренди та категорії

---

### 2.3. Клієнти (Customers)

**Файли:** `routes/customers.ts`, `services/customerService.ts`, `features/customers/`

**API:**
- `GET /customers` — список з пошуком, групами
- `POST /customers` — створити
- `GET /customers/:id` — деталі (баланс, авто, нотатки, лояльність)
- `PUT /customers/:id` — оновити
- `POST /customers/:id/debt-payment` — оплата боргу

**Сутності:**
- `customers` — phone, full_name, debt_balance, bonus_balance, vip_level, risk_profile
- `customer_vehicles` — авто клієнта (brand, model, vin, year)
- `customer_notes` — нотатки (pinned, color)
- `customer_groups` — групи
- `customer_segments` — сегменти
- `customer_barcodes` — штрихкоди клієнта

---

### 2.4. Замовлення клієнтів (Customer Orders)

**Файли:** `routes/customerOrders.ts`, `features/orders/`

**API:**
- `GET /customer-orders` — список
- `POST /customer-orders` — створити (з резервацією)
- `PUT /customer-orders/:id/draft` — оновити чернетку
- `PATCH /customer-orders/:id/status` — змінити статус
- `POST /customer-orders/:id/complete` — завершити
- `POST /customer-orders/:id/cancel` — скасувати
- `POST /customer-orders/:id/payments` — додати платіж
- `POST /customer-orders/:id/send-telegram` — відправити КП

**Статуси замовлення:** lead → new → in_progress → ordered → arrived → ready → completed | canceled

**Логіка статусів (RPC `update_customer_order_status`):**
- `new`/`in_progress` → викликає `reserve_order_items` (FOR UPDATE)
- `completed` → списує qty_on_hand (GREATEST), звільняє резерви, позначає handed
- `canceled`/`lead` → звільняє резерви
- Автоматичне оновлення статусу при зміні статусу позицій (`updateOrderStatus`)
- При `ready` → встановлюється `pickup_deadline_at`

**Комісії:**
- При `/complete` → `calculateAndRecordCommission()` (scoring: user +100, brand +10, category +1)
- `salary_payments.commission_source_order_id` UNIQUE — захист від дублів

---

### 2.5. Постачальники та закупки (Suppliers)

**Файли:** `routes/suppliers.ts`, `services/supplierService.ts`, `features/suppliers/`

**API:**
- CRUD постачальників
- CRUD накладних (supply_invoices)
- `POST /suppliers/invoices/:id/post` — провести накладну (RPC `post_supply_invoice`)
- `POST /suppliers/invoices/:id/cancel` — скасувати
- `GET /suppliers/import` — імпорт прайсів
- `POST /suppliers/bulk-import` — масовий імпорт

**Базові сутності:**
- `suppliers` — name, contact, phone, is_active
- `supply_invoices` — supplier_id, status (draft/posted/cancelled), total
- `supply_invoice_items` — product_id, qty, purchase_price, total

**Розширені:**
- `supplier_purchases` — історія закупок
- `supplier_returns` — повернення постачальнику
- `supplier_warranty_claims` — гарантійні справи
- `auto_purchase_rules` — правила автозакупки (Етап E-15)

---

### 2.6. Склад та інвентаризація (Inventory)

**Файли:** `routes/inventory.ts`, `routes/writeoffs.ts`, `routes/internalConsumptions.ts`, `routes/reserves.ts`, `routes/picking.ts`, `routes/warehouseMovements.ts`, `features/inventory/`

**API:**
- `POST /inventory` — створити сесію інвентаризації
- `POST /inventory/:id/scan` — сканувати товар
- `POST /inventory/:id/complete` — завершити (оновлює qty_on_hand)
- `GET /writeoffs` — акти списання
- `POST /writeoffs` — створити (RPC `process_writeoff` з allow_negative_qty)
- `GET /internal-consumptions` — внутрішній відпуск
- `POST /internal-consumptions` — створити (RPC `process_internal_consumption`)
- `GET /reserves` — активні резерви з даними про товар/клієнта/замовлення
- `POST /reserves` — ручний резерв (RPC `create_manual_reserve`)
- `DELETE /reserves/:id` — зняти резерв
- `GET /picking/orders` — замовлення на збірку
- `GET /picking/orders/:id` — деталі з сортуванням по storage_bin
- `PATCH /picking/items/:itemId` — відмітити зібраним
- `GET /warehouse-movements` — історія переміщень
- `POST /warehouse-movements` — перемістити товар між комірками

**Сутності:**
- `inventory_sessions` + `inventory_items` — сесії перерахунку
- `inventory_writeoffs` + `inventory_writeoff_items` — списання
- `internal_consumptions` — внутрішній відпуск (JSONB items)
- `inventory_reserves` — резерви (expires_at, released_at)
- `warehouse_movements` — переміщення між комірками
- `inventory_receipts` + `inventory_receipt_items` — приймання товару

---

### 2.7. Співробітники та зарплата (Staff & Salary)

**Файли:** `routes/salary.ts`, `routes/commission.ts`, `features/staff/`

**API:**
- `GET /salary` — виплати
- `POST /salary` — створити виплату
- `GET /salary/summary` — зведення по співробітниках
- `GET /commission/rules` — правила комісій
- `POST /commission/rules` — створити правило
- `DELETE /commission/rules/:id` — видалити

**Сутності:**
- `salary_payments` — employee_id, amount, type (salary/bonus/advance/penalty), method, period, commission_source_order_id (UNIQUE)
- `commission_rules` — user_id, brand_id, category_id, pct_from_revenue, pct_from_profit
- `staff_pin_codes` — PIN-коди для POS

---

### 2.8. Каса та фінанси (Cash & Finance)

**Файли:** `routes/shifts.ts`, `routes/cashOperations.ts`, `services/shiftService.ts`, `features/cashflow/`

**API:**
- `GET /shifts/current` — поточна зміна
- `POST /shifts/open` — відкрити (з початковою касою)
- `POST /shifts/:id/close` — закрити (з variance)
- `POST /shifts/current/reconcile` — звірка каси
- `GET /shifts/current/expected-cash` — розрахунок очікуваної готівки
- `GET /shifts/:id/report` — звіт по зміні
- `GET /cash-operations` — касові операції
- `POST /cash-operations` — внесення/вилучення

**Формула закриття зміни:**
```
expected = opening_cash + cash_sales - returns + cash_in - cash_out
variance = actual_closing - expected
```

**Звірка:** обов'язкова перед закриттям зміни. `cash_reconciliations` — expected, actual, diff.

---

### 2.9. Звіти та аналітика (Reports & Analytics)

**Файли:** `routes/reports.ts`, `routes/analytics.ts`, `services/reportService.ts`, `features/reports/`, `features/analytics/`

**API:**
- `GET /reports/daily` — денний звіт
- `GET /reports/period` — звіт за період
- `GET /reports/profit-loss` — P&L (виручка, COGS, валова, чиста)
- `GET /reports/low-stock` — товари з малим залишком
- `GET /reports/debtors` — боржники
- `GET /reports/weekly-sales` — тижневі продажі (графік)
- `GET /reports/top-products` — топ товарів
- `GET /analytics/dashboard` — метрики дашборду
- `GET /analytics/abc` — ABC-аналіз
- `GET /analytics/staff-kpi` — KPI персоналу
- `GET /analytics/staff-profitability` — прибутковість співробітників

**Сторінки:**
- `/reports` — DailyReport (P&L, графіки, експорт)
- `/abc` — ABCAnalysis (ABC-класифікація)
- `/staff-kpi` — KPI (цілі, тренди)
- `/staff-profitability` — прибутковість (Recharts, таблиця, маржинальність)

---

### 2.10. Система лояльності (Loyalty)

**Файли:** `routes/loyalty.ts`, `services/loyaltyService.ts`

**API:**
- `GET /loyalty/settings` — налаштування
- `PUT /loyalty/settings` — оновити
- `GET /loyalty/customer/:id/balance` — баланс бонусів
- `GET /loyalty/customer/:id/transactions` — історія
- `POST /loyalty/customer/:id/accrue` — нарахувати
- `POST /loyalty/customer/:id/redeem` — списати
- `GET /loyalty/customer/:id/max-redeem` — макс. списання на чек

**Сутності:**
- `loyalty_settings` — is_enabled, accrual_pct, max_redeem_pct, expiry_days
- `loyalty_transactions` — accrual, redemption, expiry, correction
- `bonus_transactions` — списання/нарахування (через process_sale_v3)

---

### 2.11. Сповіщення (Notifications)

**Файли:** `routes/notifications.ts`, `features/notifications/`

**API:**
- `GET /notifications/inbox` — сповіщення користувача
- `PATCH /notifications/inbox/:id/read` — відмітити прочитаним
- `GET /notifications/unread-count` — кількість непрочитаних

**Сутності:**
- `in_app_notifications` — user_id, event_type, title, body, link, is_read
- `notification_templates` — event_type, channel, title_template, body_template, is_active
- Telegram: `telegram_channels`, `messenger_chats`

**Telegram:** Бот для замовлень, повідомлення клієнтам про статус, КП

---

### 2.12. Фонові задачі (Background Jobs)

**Файли:** `workers/jobWorker.ts`, `services/taskQueue.ts`

**RPC:** `claim_next_job` — `FOR UPDATE SKIP LOCKED` з пріоритетом

**Зареєстровані handlers:**
- `test_job` — тестовий
- `cleanup_expired_reserves` — очищення прострочених резервів (кожну годину)
- `close_stale_shifts` — закриття завислих змін (кожні 6 годин)
- `cleanup_suspended_sales` — очищення прострочених відкладених чеків (кожні 6 годин)
- `validate_stock_integrity` — перевірка цілісності залишків

**Job table:** `sys_background_jobs` (id, job_type, payload, status, priority, scheduled_at, max_attempts)
**Індекс:** `(priority DESC, scheduled_at ASC) WHERE status = 'pending'`
**Backoff:** експоненційний (`Math.pow(2, attempts) * 30`, max 3600s)

---

### 2.13. Друк (Print Center)

**Файли:** `routes/print.ts`, `features/print/`

**API:**
- `POST /print` — створити задачу
- `GET /print/jobs` — список задач
- `GET /print/jobs/:id` — статус

**Форми друку:**
- Чек (ReceiptPrint)
- Збірний лист (PickingListPrint)
- Етикетки (LabelDesigner, LabelPrinter)
- Накладна

---

### 2.14. Автозакупки (Auto-Purchasing)

**Файли:** `routes/autoPurchase.ts`, `features/autoPurchase/`

**API:**
- `GET /auto-purchase/suggestions` — список рекомендацій
- `POST /auto-purchase/confirm` — створити накладну з рекомендації
- `POST /auto-purchase/rules` — CRUD правил

**Сутності:**
- `auto_purchase_rules` — product_id, supplier_id, min_qty, max_qty, is_active
- **RPC:** `generate_purchase_suggestions` — qty_on_hand < reorder_point

---

### 2.15. Безпека та аудит (Security & Audit)

**Файли:** `routes/audit.ts`, `services/auditService.ts`, `features/admin/AuditLogPage.tsx`

**Аудит:** `audit_log` (user_id, action, entity_type, entity_id, old_value, new_value, ip_address)

**Захист:**
- Idempotency-Key на `POST /sales` — захист від дублікатів
- `idempotency_keys` таблиця (PRIMARY KEY (key, tenant_id))
- RBAC: owner, admin, manager, cashier, storekeeper
- Rate limit: 300/хв глобальний, 10/год на login
- Discount: тільки owner/admin/manager (перевірка на бекенді)
- Negative stock: DB-тригер `trg_prevent_negative_qty`

---

## 3. БАЗА ДАНИХ — ПОВНА КАРТА ТАБЛИЦЬ

### 3.1. Core (01-10)
| Таблиця | Міграція | Призначення |
|---------|----------|-------------|
| `brands` | 001 | Бренди |
| `categories` | 001 | Категорії (ієрархічні) |
| `products` | 001 | Товари |
| `customers` | 001 | Клієнти |
| `customer_vehicles` | 001 | Авто клієнтів |
| `users` | 001 | Користувачі (через auth.users) |
| `sales` | 001 | Продажі |
| `sale_items` | 001 | Позиції продажу |
| `shifts` | 001 | Зміни |
| `returns` | 001 | Повернення |
| `return_items` | 001 | Позиції повернення |

### 3.2. Catalog & Products (11-20)
| `product_barcodes` | 003 | Додаткові штрихкоди |
| `product_aliases` | 003 | Псевдоніми |
| `product_analogs` | 003 | Аналоги |
| `product_supplier_codes` | 003 | Коди постачальників |
| `product_price_history` | 003 | Історія цін |
| `product_fitment` | 003 | Сумісність з авто |
| `price_tiers` | 003 | Цінові рівні |
| `volume_discounts` | 003 | Об'ємні знижки |
| `category_markups` | 003 | Націнки категорій |

### 3.3. Orders (50-55)
| `customer_orders` | 003+ | Замовлення клієнтів |
| `customer_order_items` | 003+ | Позиції замовлень |
| `order_payments` | 020 | Платежі замовлень |
| `order_activity_log` | 050 | Лог активності |
| `order_status_history` | 003 | Історія статусів |

### 3.4. Inventory & Warehouse (40-70)
| `inventory_sessions` | 040 | Сесії інвентаризації |
| `inventory_items` | 040 | Позиції інвентаризації |
| `inventory_writeoffs` | 007 | Акти списання |
| `inventory_writeoff_items` | 007 | Позиції списання |
| `inventory_reserves` | 003 | Резерви товарів |
| `inventory_receipts` | 003 | Приймання |
| `internal_consumptions` | 057 | Внутрішній відпуск |
| `warehouse_movements` | 070 | Переміщення |
| `auto_purchase_rules` | 078 | Правила автозакупки |

### 3.5. Financial (09-57)
| `cash_operations` | 009 | Касові операції |
| `cash_reconciliations` | 049 | Звірка каси |
| `expense_categories` | 046 | Статті витрат |
| `salary_payments` | 057 | Виплати ЗП |
| `commission_rules` | 066 | Правила комісій |

### 3.6. Loyalty & Customers (36-45)
| `loyalty_settings` | 003 | Налаштування лояльності |
| `loyalty_transactions` | 003 | Транзакції лояльності |
| `bonus_transactions` | 037 | Бонусні транзакції |
| `customer_notes` | 003 | Нотатки клієнтів |
| `customer_groups` | 056 | Групи клієнтів |
| `customer_segments` | 043 | Сегменти |
| `customer_barcodes` | 045 | Штрихкоди клієнтів |

### 3.7. Infrastructure (62-84)
| `sys_background_jobs` | 062 | Черга фонових задач |
| `idempotency_keys` | 080 | Ключі ідемпотентності |
| `audit_log` | 003 | Журнал аудиту |
| `in_app_notifications` | 076 | Сповіщення |
| `notification_templates` | 076 | Шаблони сповіщень |
| `print_jobs` | 077 | Завдання друку |

### 3.8. Messaging (23-51)
| `telegram_channels` | 023 | Telegram-канали |
| `messenger_chats` | 034 | Чати месенджерів |
| `messenger_channels` | 034 | Канали месенджерів |

### 3.9. Staff (47-57)
| `staff_pin_codes` | 047 | PIN-коди |
| `staff_kpi_targets` | 071 | KPI-цілі |
| `waitlist` | 048 | Лист очікування |

### 3.10. Settings (05-88)
| `shop_settings` | 005 | Головні налаштування |
| `pricing_rules` | 008 | Правила ціноутворення |

---

## 4. RBAC — РОЛІ ТА ДОСТУП

| Роль | POS | Товари | Клієнти | Замовлення | Склад | Звіти | Адмін |
|------|-----|--------|---------|-----------|-------|-------|-------|
| **owner** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **admin** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **manager** | ✅ | ✅ | ✅ | ✅ | ✅ читати | ✅ | ❌ |
| **cashier** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **storekeeper** | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |

---

## 5. КЛЮЧОВІ ПАТЕРНИ

### 5.1. FOR UPDATE — скрізь де модифікується stock
Всі RPC: `process_sale_v3`, `process_internal_consumption`, `process_writeoff`, `post_supply_invoice`, `reserve_order_items`, `create_manual_reserve` — блокують рядки products.

### 5.2. Дві фази — lock + modify
1-й прохід: FOR UPDATE + перевірка
2-й прохід: INSERT/UPDATE

### 5.3. INTEGER копійки — ніколи float
Всі гроші: INTEGER (копійки). Конвертація тільки у відображенні (`kopecksToHryvnia`, `formatMoney`).

### 5.4. RPC як атомарний кордон
Вся бізнес-логіка модифікації даних — в PostgreSQL RPC. Жоден сервіс не робить `INSERT/UPDATE` напряму для критичних операцій.

### 5.5. Feature flags
- `USE_BONUS_ATOMIC_SALE` — вмикає process_sale_v3 (бонуси всередині)
- `USE_RESERVE_AWARE_SALE` — вмикає process_sale_v2 (qty_available)
- Через env, без деплою

### 5.6. Crash recovery
- localStorage autosave корзини
- Idempotency-Key для відновлення після timeout
- `GET /sales/check-after-payment` — перевірка чи продаж пройшов

---

## 6. ІНТЕГРАЦІЇ ЯКІ ПОТРІБНО НАЛАШТУВАТИ

### Існуючі (реальні):
- **Telegram Bot** — Telegraf, прийом/відправка повідомлень

### Реалізовані (код є, але через env):
- **ПриватБанк термінал** — `PrivatBankTerminalService.ts` (по IP/port)
- **Кашалот ПРРО** — `KashalotService.ts` (license_key + pin)
- **Mock** — `MockBankTerminalService.ts`, `MockPrroService.ts` (тихо проходять)

---

## 7. ФАЙЛОВА СТРУКТУРА (BACKEND)

```
server/src/
├── index.ts                       # Точка входу + JobWorker реєстрація
├── seed.ts                        # Сід дані
├── config/constants.ts            # Константи
├── db/
│   ├── supabase.ts                # Клієнт БД
│   └── supabaseAdmin.ts           # Admin клієнт (service_role)
├── lib/
│   └── logger.ts                  # Pino логгер
├── middleware/
│   ├── auth.ts                    # requireAuth
│   └── errorHandler.ts            # Централізований error handler
├── routes/                        # 40 файлів
│   ├── sales.ts, shifts.ts, customers.ts, ...
│   ├── picking.ts, reserves.ts, warehouseMovements.ts
│   ├── commission.ts, salary.ts, loyalty.ts
│   ├── autoPurchase.ts, notifications.ts, print.ts
│   └── stockIntegrity.ts
├── services/                      # 25+ файлів
│   ├── saleService.ts, shiftService.ts, ...
│   ├── reserveService.ts, movementService.ts
│   ├── commissionService.ts, stockValidatorService.ts
│   ├── integrations/
│   │   ├── MockBankTerminalService.ts
│   │   ├── MockPrroService.ts
│   │   ├── PrivatBankTerminalService.ts
│   │   └── KashalotService.ts
│   └── messengers/
│       └── MessengerService.ts
├── validators/                    # Zod-схеми
│   ├── saleSchema.ts, shiftSchema.ts, ...
│   └── reportSchema.ts, supplierSchema.ts
├── workers/
│   └── jobWorker.ts               # Фоновий воркер
└── types/
    └── index.ts                   # Спільні типи
```

---

## 8. ФАЙЛОВА СТРУКТУРА (FRONTEND)

```
apps/web/src/
├── App.tsx                        # 45+ lazy-loaded routes
├── main.tsx                       # Точка входу
├── components/
│   ├── Layout.tsx                 # Загальний layout
│   ├── Sidebar.tsx                # Навігація + badges
│   ├── ProtectedRoute.tsx         # Auth guard
│   └── ui/                        # UI kit (Button, Card, Modal, Table...)
├── features/
│   ├── pos/                (18 файлів) — POS
│   ├── products/           (10 файлів) — Товари
│   ├── customers/          (12 файлів) — Клієнти
│   ├── orders/             (8 файлів) — Замовлення
│   ├── suppliers/          (10 файлів) — Постачальники
│   ├── inventory/          (10 файлів) — Склад
│   ├── admin/              (6 файлів) — Адмінка
│   ├── analytics/          (4 файли) — Аналітика
│   ├── reports/            (3 файли) — Звіти
│   ├── settings/           (2 файли) — Налаштування
│   ├── notifications/      (1 файл) — Сповіщення
│   ├── autoPurchase/       (1 файл) — Автозакупки
│   └── print/              (1 файл) — Друк
├── stores/
│   ├── authStore.ts               # Auth (Zustand)
│   └── posStore.ts                # POS стан (Zustand, 300 рядків)
├── lib/
│   ├── api.ts                     # HTTP клієнт
│   ├── supabase.ts                # Supabase клієнт
│   ├── auth.ts                    # Auth helpers
│   └── utils.ts                   # Утиліти
└── types/                         # TypeScript типи
    ├── product.ts, customer.ts, sale.ts, shift.ts
    └── cashOperation.ts, return.ts, writeoff.ts...
```

---

## 9. БІЗНЕС-ПОКАЗНИКИ

**Що система вміє рахувати:**
- Денний/тижневий/місячний дохід (готівка/картка/переказ)
- Собівартість (COGS) по продажах через purchase_price
- Валовий прибуток (Revenue - COGS)
- Чистий прибуток (Gross - Expenses - Salary)
- Маржинальність по співробітниках
- ABC-аналіз товарів (A/B/C/Z)
- KPI персоналу (виручка, знижки, середній чек)
- Прибутковість співробітників (зарплата vs прибуток)
- Резерви, прострочені замовлення, боржники
- Очікувана каса при закритті зміни

---

## 10. ЩО МОЖНА ДОДАТИ (ДЛЯ РОЗДУМІВ)

### Малий пріоритет (легко):
- WebSocket для оновлень badge в POS (зараз polling 2min)
- Підтвердження дій при втраті з'єднання (toast "Немає інтернету")
- Експорт звітів у PDF/Excel (серверна генерація)
- Друк з чергою та retry
- Масове оновлення цін (групова операція)

### Середній пріоритет (бізнес-цінність):
- Касові апарати (ПРРО Кашалот) у production — готово, але не ввімкнено
- Реальний банківський термінал (ПриватБанк) — готово, але не ввімкнено
- Multi-tenant (прибрати hardcoded TENANT_ID) — технічний борг
- Залишок на складі в реальному часі через WebSocket
- Офлайн-режим POS (Service Worker + IndexedDB)
- Мобільний POS (PWA або React Native)

### Великий пріоритет (нова функціональність):
- Складський облік з партіями (FIFO — зараз усе усереднене)
- Інтеграція з сайтом/інтернет-магазином
- CRM: воронка продажів, автоматичні нагадування
- Розширена аналітика: прогнозування, тренди, ML
- Каса самообслуговування (Self-checkout кіоск)
- API для сторонніх інтеграцій (REST API ключі)
- Складні знижки: акції, купони, періодичні знижки
