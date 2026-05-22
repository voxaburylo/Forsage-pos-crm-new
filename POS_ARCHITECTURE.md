# Архитектура и логика работы кассы (POS) — CRM-Forsage

> **Автор:** Claude Opus 4.7 (Lead Developer)
> **Дата:** 2026-05-22
> **Файлы:** 20+ файлов в `apps/web/src/features/pos/`, `server/src/routes/sales.ts`, `server/src/routes/shifts.ts`, `server/src/services/saleService.ts`, `server/src/services/shiftService.ts`, `apps/web/src/stores/posStore.ts`

---

## 1. ОБЩАЯ АРХИТЕКТУРА

### 1.1. Схема потоков данных

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React)                             │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────────┐   │
│  │  POSPage.tsx  │  │  usePOS.ts   │  │   posStore.ts (Zustand) │   │
│  │  (оркестратор)│──┤  (хук-мост)  ├──┤   - currentShift       │   │
│  │               │  │              │  │   - tabs[]             │   │
│  ├───────────────┤  │              │  │   - items[]            │   │
│  │  SearchPanel  │  │              │  │   - customer           │   │
│  │  ReceiptPanel │  │              │  │   - total              │   │
│  │  PaymentModal │  │              │  └─────────────────────────┘   │
│  │  NumpadModal  │  │              │                                │
│  └──────┬───────┘  └──────┬───────┘                                │
│         │                 │                                          │
│         ▼                 ▼                                          │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │  saleApi.ts / shiftApi.ts (HTTP клиенты)                 │       │
│  └───────────────────────┬──────────────────────────────────┘       │
└──────────────────────────┼──────────────────────────────────────────┘
                           │ POST /api/v1/sales
                           │ GET  /api/v1/shifts/current
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        BACKEND (Express)                             │
│                                                                     │
│  routes/sales.ts  ──→  services/saleService.ts                      │
│  routes/shifts.ts ──→  services/shiftService.ts                     │
│                           │                                          │
│                           ▼                                          │
│                    db.rpc('process_sale', {...})                      │
└───────────────────────────┼──────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    POSTGRESQL (Supabase)                             │
│                                                                     │
│  RPC: process_sale()                                                │
│  ──────────────────────                                              │
│  1. SELECT ... FOR UPDATE (блокировка строк products)               │
│  2. INSERT INTO sales                                               │
│  3. INSERT INTO sale_items                                          │
│  4. UPDATE products SET qty_on_hand = qty_on_hand - qty            │
│  5. UPDATE customers SET debt_balance (если debt)                   │
│  ─────── Всё в одной транзакции ───────                             │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2. Структура файлов

```
Frontend (apps/web/src/features/pos/):
├── POSPage.tsx              # Главный экран кассы — оркестратор
├── usePOS.ts                # React hook — мост между компонентами и store
├── SearchPanel.tsx           # Поиск товаров (текст + камера)
├── ReceiptPanel.tsx          # Панель чека (список товаров, numpad)
├── PaymentModal.tsx          # Модалка оплаты (5 методов)
├── ReceiptPrint.tsx          # Печать чека
├── saleApi.ts                # HTTP-клиент для продаж
├── shiftApi.ts               # HTTP-клиент для смен
├── cashOperationApi.ts       # Кассовые операции
├── returnApi.ts              # Возвраты
│
├── ShiftCloseModal.tsx       # Закрытие смены
├── CashOperationModal.tsx    # Внесение/изъятие наличных
├── CashReconciliationModal.tsx # Зверка кассы
├── DebtPaymentModal.tsx      # Оплата долга клиентом
├── SuspendModal.tsx          # Отложить чек
├── SuspendedListModal.tsx    # Список отложенных чеков
│
├── FavoritesPanel.tsx        # Избранное (быстрые товары)
├── DashboardPanel.tsx        # Дашборд с категориями
├── CrossSellPanel.tsx        # Cross-sell рекомендации
├── SnackDropdown.tsx         # Быстрые товары (кафе)
├── CameraScanner.tsx         # Сканер штрихкода через камеру
├── HelpModal.tsx             # Хоткеи/помощь
├── LockScreenOverlay.tsx     # Блокировка экрана
│
├── SearchPanel.tsx → productApi (внешний)
└── ReceiptPrint.tsx → OrderReceiptPrint.tsx (внешний)

Store:
├── stores/posStore.ts        # Zustand store — вся логика состояния

Backend (server/src/):
├── routes/sales.ts           # POST /api/v1/sales, suspend, resume
├── routes/shifts.ts          # open, close, reconcile
├── services/saleService.ts   # createSale, resumeSale, markReadyForPickup
├── services/shiftService.ts  # openShift, closeShift, getCurrentShift
├── services/integrations/
│   ├── MockBankTerminalService.ts  # Эмуляция терминала
│   └── MockPrroService.ts          # Эмуляция ПРРО (фискализация)
```

---

## 2. ПОТОК ПРОДАЖИ (ПОЛНЫЙ ЦИКЛ)

### 2.1. Открытие смены

```
User → POSPage
  ↓ (нет currentShift)
OpenShiftScreen
  ↓ ввод начальной кассы "1000.00"
POST /api/v1/shifts/open { opening_cash: 100000 }  // копейки
  ↓
shiftService.openShift() → INSERT INTO shifts (status='open')
  ↓
POSPage получает shift → posStore.setCurrentShift(shift)
```

**Бизнес-правила:**
- `requireAuth` — только аутентифицированный пользователь
- Проверка `getCurrentShift()` — если уже есть открытая смена → `409 SHIFT_ALREADY_OPEN`
- `opening_cash` — в копейках (INTEGER)

### 2.2. Добавление товара в чек

```
User вводит в SearchPanel: "масло моторное" или "460702"
  ↓ debounced 200ms
GET /api/v1/products?search=масло&per_page=8
  ↓
Результаты отображаются в SearchPanel
  ↓ User нажимает Enter или кликает на товар
store.addItem({
  productId, sku, name, unit,
  qty: 1,
  unitPrice: product.retail_price,     // копейки
  discount: tierDiscountPct > 0 ? Math.round(retail_price * tierPct / 100) : 0,
  qtyOnHand: product.qty_on_hand
})
  ↓
posStore.ts:
  - Если товар уже есть в чеке → увеличивает qty
  - Если нет → добавляет новую строку
  - Пересчитывает subtotal, totalDiscount, total
```

**Варианты поиска:**
- По названию/артикулу (текстовый поиск)
- По штрихкоду (ENTER с 8+ цифрами → `GET /api/v1/search/barcode/{code}`)
- По камере (сканирование через `CameraScanner.tsx`)
- По категориям (кнопки-фильтры "Кава/Напои", "Снеки/Хотдоги")
- **Штрихкод может идентифицировать и товар, и клиента** (customer barcode → привязка к чеку)

**Логика `qty_available` в SearchPanel:**
```typescript
const qtyAvailable = p.qty_available ?? p.qty_on_hand
const existingQty = store.items.filter(i => i.productId === p.id).reduce(...)
const newTotalQty = existingQty + 1
const lowStock = qtyAvailable < newTotalQty
if (lowStock) { toast.warning('Недостатньо на складі') }
```

### 2.3. Редактирование чека (ReceiptPanel)

```
ReceiptPanel.tsx:
  ┌──────────────────────────────────┐
  │  ЧЕК              [Клиент ▲]     │  ← шапка с клиентом
  ├──────────────────────────────────┤
  │  ┌─ Товар X ──────────────────┐  │
  │  │  имя товара            🗑  │  │
  │  │  [−]   3 шт   [+]   150₴  │  │  ← qty controls
  │  │  Скидка: [  0.00  ] ₴     │  │  ← только для owner/admin/manager
  │  └────────────────────────────┘  │
  │  ┌─ Товар Y ──────────────────┐  │
  │  │  ...                        │  │
  │  └────────────────────────────┘  │
  ├──────────────────────────────────┤
  │  Товаров: 5    Знижка: -50₴    │
  │  ДО ОПЛАТЫ:         1 250 ₴    │
  │  ┌──────────┐ ┌──────────────┐  │
  │  │  Сбросить │ │  ОПЛАТИТЬ   │  │
  │  └──────────┘ └──────────────┘  │
  └──────────────────────────────────┘
```

**Возможности:**
- +/- кнопки для qty (с проверкой `qtyOnHand`)
- Numpad (полноэкранная цифровая клавиатура для точного ввода qty)
- Свайп влево → удалить товар
- Скидка на товар (только owner/admin/manager — проверка по `user_metadata.role`)
- Привязка/отвязка клиента
- Мультивкладочность (до 5 одновременных чеков, swipe между ними)
- Звуковые эффекты (успех/ошибка) через `audioService.ts`

### 2.4. Оплата (PaymentModal)

```
User нажимает "ОПЛАТИТЬ" (или F8)
  ↓
PaymentModal открывается:
  ┌──────────────────────────────┐
  │  ДО ОПЛАТЫ:    1 250 ₴       │
  │  (бонусы: -50₴)              │
  ├──────────────────────────────┤
  │  Бонусы: 200₴  [   0  ]     │  ← списание бонусов
  ├──────────────────────────────┤
  │  [Готівка] [Термінал] [Переказ] │
  │        [Борг]    [Split]      │
  ├──────────────────────────────┤
  │  Отримано: [  200.00  ] ₴    │
  │  Решта: 0.50 ₴               │
  ├──────────────────────────────┤
  │  🧾 Фискальный чек [ON]      │  ← toggle
  │  ⚖️ Картка → фискализация   │  ← обязательна
  ├──────────────────────────────┤
  │  [Отмена]    [ПОДТВЕРДИТЬ]   │
  └──────────────────────────────┘
```

**5 методов оплаты:**

| Метод | Логика | Особенности |
|-------|--------|------------|
| **Готівка** | `cashReceived >= toPay`, рассчитывает сдачу | Кассир вводит полученную сумму |
| **Термінал** | Имитация ожидания 2с (MockBankTerminalService), `is_fiscal = true` | Фискализация обязательна по закону |
| **Переказ на карту** | `payment_method='transfer'`, фискализация опционально | Без cash_amount/card_amount |
| **Борг** | Только если выбран клиент. `debt_balance += total` | `requireCustomer` |
| **Split** | `cash_amount + card_amount = total` | Ручное разделение |

**Бонусы:**
- Загружается `balance` и `max_redeem` через `GET /api/v1/loyalty/customer/{id}/max-redeem?total=`
- Если `loyaltyEnabled` — показывается блок списания бонусов
- `bonusRedeemed` уменьшает `toPay` => `toPay = total - bonusRedeemed`

### 2.5. Проведение продажи (Backend)

**`POST /api/v1/sales` → `saleService.createSale()`:**

```
1. Проверка смены:        getCurrentShift(cashierId) → must exist
2. Проверка shift_id:     совпадает с текущей сменой
3. Пересчёт сумм:         subtotal, cashAmount, cardAmount (не доверяет клиенту)
                          проверка: cashAmount + cardAmount === total (split)
4. Вызов RPC:             db.rpc('process_sale', { p_tenant_id, p_cashier_id, p_shift_id, p_items, ... })
5. Парсинг результата:    JSONB → объект Sale
6. Если card/mixed:       MockBankTerminalService.processCardPayment()
7. Если is_fiscal:        MockPrroService.fiscalizeSale()
8. Обновление БД:         fiscal_number, bank_auth_code, is_fiscal
9. Аудит:                 logAction('sale.created', ...)
10. Если pickup_cell:     UPDATE sales SET pickup_cell
11. Списание бонусов:     db.rpc('process_bonus_spend')
12. Начисление бонусов:   db.rpc('process_bonus_earn')
```

### 2.6. PostgreSQL RPC `process_sale()` (атомарная транзакция)

```sql
CREATE OR REPLACE FUNCTION process_sale(p_tenant_id, p_cashier_id, p_shift_id, p_items JSONB, ...)

1. Читает shop_settings (allow_negative_qty)
2. Генерирует sale_number из последовательности
3. ПЕРВЫЙ ПРОХОД: блокировка + проверка
   FOR EACH item IN p_items:
     SELECT qty_on_hand FROM products WHERE id = ? FOR UPDATE;
     IF qty_on_hand < item.qty AND NOT allow_negative_qty THEN RAISE 'INSUFFICIENT_STOCK';

4. INSERT INTO sales (...) VALUES (...) RETURNING id;

5. ВТОРОЙ ПРОХОД: списание остатков
   FOR EACH item:
     INSERT INTO sale_items (...);
     UPDATE products SET qty_on_hand = qty_on_hand - item.qty;

6. Если debt + customer_id:
   UPDATE customers SET debt_balance = debt_balance + total;

7. RETURN JSONB sale;
```

**Ключевая защита:** Всё в одной транзакции. `FOR UPDATE` блокирует строки products, предотвращая race condition.

### 2.7. Пост-продажа

```
saleService.createSale() возвращает Sale
  ↓
usePOS.completeSale() → store.clearReceipt()
  ↓
POSPage → setLastSale(sale)
  → Кнопка "Печать чека" становится активной
  → ReceiptPrint.tsx генерирует HTML для window.print()
  → playCashRegister() звук
```

---

## 3. ОТЛОЖЕННЫЕ ЧЕКИ (SUSPEND / RESUME)

**Создание:**
```
POST /api/v1/sales/suspend
  → INSERT INTO sales (status='suspended')
  → INSERT INTO sale_items
  → НЕ вызывает process_sale (остатки НЕ списываются)
  → sale_number = 'S-' + Date.now().toString(36).toUpperCase().slice(-6)
```

**Восстановление:**
```
GET /api/v1/sales/suspended → список отложенных
  ↓
User выбирает чек → POST /api/v1/sales/:id/resume
  → UPDATE sales SET status='draft'
  → SuspendedListModal загружает items в posStore
  → User может продолжить → оплатить через process_sale
```

**Бейдж:** Счётчик отложенных чеков в хедере POSPage.

---

## 4. СМЕНЫ (SHIFTS)

**Жизненный цикл:**
```
1. OPEN:    POST /api/v1/shifts/open { opening_cash }
              → INSERT shifts (status='open')
              → Проверка: нет другой открытой смены

2. WORK:    Кассир работает:
              - Продажи (completed) → cash_amount суммируется
              - Возвраты → refund_kopecks вычитаются
              - Cash operations → in/out
              - Зверка кассы → cash_reconciliations (обязательно перед закрытием)

3. RECONCILE: POST /api/v1/shifts/current/reconcile { actual_amount }
              → INSERT cash_reconciliations
              → Рассчитывает expected: opening_cash + cash_sales - returns + cash_in - cash_out
              → Разница: actual - expected

4. CLOSE:   POST /api/v1/shifts/:id/close { closing_cash }
              → Проверка: есть reconcile
              → Рассчитывает variance = closing_cash - expected_cash
              → UPDATE shifts SET status='closed'
```

**Формула expected_cash:**
```
expected = opening_cash + SUM(cash_amount from completed sales) + SUM(cash_in)
           - SUM(refund_kopecks where refund_method='cash') - SUM(cash_out)
variance = actual_closing_cash - expected
```

---

## 5. КАССОВЫЕ ОПЕРАЦИИ И ЗВЕРКА

### 5.1. Cash Operations (внесение/изъятие)

```
POST /api/v1/cash-operations
  { shift_id, type: 'in' | 'out', amount, reason }
  → INSERT cash_operations
  → Используется при:
    - Инкассация (изъятие крупных сумм)
    - Подкрепление кассы (внесение разменной монеты)
    - Оплата расходов из кассы
```

### 5.2. Зверка кассы (Reconciliation)

```
POST /api/v1/shifts/current/reconcile
  { actual_amount: 15200, comment: "после смены" }
  → Рассчитывает expected по формуле выше
  → INSERT cash_reconciliations
  → Если разница > 0: излишек
  → Если разница < 0: недостача
  → Аудитируется в audit_log
```

---

## 6. БЛОКИРОВКА И БЕЗОПАСНОСТЬ

### 6.1. Lock Screen
```typescript
// POSPage.tsx
// По F12 или Ctrl+L: setLocked(true) → LockScreenOverlay
// Разблокировка: ввод PIN-кода сотрудника (проверка через staff_pin_codes)
```

### 6.2. Crash Recovery
```typescript
// POSPage.tsx
// Каждое изменение корзины → saveCart() → localStorage 'forsage_pos_cart'
// При монтировании: loadCart() → если есть → баннер "Восстановить корзину?"
// После успешной оплаты: clearSavedCart()
```

### 6.3. Горячие клавиши

| Клавиша | Действие |
|---------|----------|
| F1 | Help |
| F2 | Фокус на поиск |
| F3 | Новая вкладка чека |
| F5 | Отложить чек |
| F6 | Открыть список отложенных |
| F8 | Оплатить |
| F12 / Ctrl+L | Блокировка |
| Delete | Удалить товар из чека |
| +/- | Изменить количество |
| Escape | Очистить поиск |

### 6.4. RBAC (Role-Based Access)

| Действие | Роли |
|----------|------|
| Продажа (POS) | cashier, manager, admin, owner |
| Скидка > 0 | owner, admin, manager |
| Продажа в долг | owner, admin, manager (требует клиента) |
| Закрытие смены | cashier (только свою) |
| Зверка кассы | cashier, manager, admin, owner |
| Кассовые операции | owner, admin, manager |
| Возврат | owner, admin, manager |

---

## 7. КЛЮЧЕВЫЕ ДИЗАЙН-РЕШЕНИЯ

### 7.1. Все суммы в копейках (INTEGER)
Никаких `FLOAT`/`REAL` для денег. Все цены хранятся как INTEGER копеек. Frontend делит на 100 для отображения через `formatMoney()` / `kopecksToHryvnia()`. Это исключает ошибки округления с плавающей точкой.

### 7.2. Атомарная продажа через RPC
Вся логика продажи — в PostgreSQL функции `process_sale()`. Это гарантирует:
- Блокировку строк products (`FOR UPDATE`)
- Списание остатков и создание sale в одной транзакции
- Консистентность debt_balance

### 7.3. Двухфазная блокировка в RPC
Первый проход: блокировка всех строк products + проверка остатков.
Второй проход: списание.
Предотвращает deadlock при конкурентных продажах одного товара.

### 7.4. Мультивкладочность
Zustand store поддерживает до 5 одновременных чеков (tabs). Каждая вкладка — независимый набор товаров, клиент, скидки. После оплаты вкладка закрывается.

### 7.5. Сохранение корзины в localStorage
При аварийном закрытии браузера / перезагрузке POS восстанавливает корзину из `localStorage` с баннером "Восстановить?".

### 7.6. Моки интеграций
- `MockBankTerminalService` — эмуляция банковского терминала (2с задержка, auth_code)
- `MockPrroService` — эмуляция фискального регистратора (fiscal_number)

---

## 8. ТАБЛИЦЫ БАЗЫ ДАННЫХ (POS-RELATED)

```sql
-- Смены
shifts (id, tenant_id, cashier_id, status, opening_cash, closing_cash, 
        expected_cash, cash_variance, notes, opened_at, closed_at)

-- Продажи
sales (id, tenant_id, sale_number, customer_id, cashier_id, shift_id,
       manager_id, status, subtotal, discount, total, payment_method,
       cash_amount, card_amount, is_debt, is_fiscal, fiscal_number,
       bank_auth_code, pickup_cell, bonuses_spent, bonuses_earned,
       notes, completed_at)

-- Позиции продажи
sale_items (id, tenant_id, sale_id, product_id, qty, unit_price,
            discount, total)

-- Кассовые операции
cash_operations (id, tenant_id, shift_id, type, amount, note,
                 expense_category_id, created_by)

-- Зверка кассы
cash_reconciliations (id, tenant_id, shift_id, user_id,
                      expected_amount, actual_amount, difference_amount,
                      comment)

-- Возвраты
returns (id, sale_id, ..., refund_method, refund_kopecks, stock_action)
```

---

## 9. ПОТЕНЦИАЛЬНЫЕ УЛУЧШЕНИЯ (ДЛЯ МОДЕРНИЗАЦИИ)

### Backend
1. **`process_sale_v2`** — версия с `qty_available` (учитывает резервы). Уже спланирована в ROADMAP.md
2. **`sale_items.cost_price`** — snapshot себестоимости на момент продажи (сейчас берётся текущий `purchase_price`)
3. **Убрать MockBankTerminalService и MockPrroService** — заменить на реальные интеграции
4. **Multi-tenant** — сейчас hardcoded tenant_id

### Frontend
5. **Офлайн-режим** — кеширование товаров, очередь продаж при отсутствии интернета
6. **Сенсорная оптимизация** — увеличенные touch-targets (частично уже есть)
7. **Темы оформления** — сейчас тёмная тема только
8. **Эквайринг** — реальная интеграция с банковским терминалом вместо мока
9. **ПРРО** — реальная интеграция с фискальным регистратором

### Процессы
10. **Авто-зверка** — предложение зверки после N продаж или N часов
11. **Уведомление менеджера при проблемном клиенте** (high risk profile)
12. **Интеграция с весами** — прямой ввод весового товара
