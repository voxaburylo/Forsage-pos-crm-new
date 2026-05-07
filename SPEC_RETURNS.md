# SPEC: Повернення від клієнта та гарантія

## Концепція

Три окремі флоу:
1. Повернення — клієнт повертає товар (передумав, не підійшов)
2. Гарантійний обмін — товар зламався в гарантійний строк → обмін
3. Гарантійний повернення через постачальника — потрібно відправити постачальнику і чекати рішення

---

## Таблиці БД

```sql
-- Повернення від клієнта
CREATE TABLE customer_returns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  customer_id       UUID REFERENCES customers(id),
  sale_id           UUID REFERENCES sales(id),        -- з якого продажу
  order_id          UUID REFERENCES orders(id),        -- або з якого замовлення
  return_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  return_type       TEXT NOT NULL,
  -- 'refund'       — повернення грошей
  -- 'exchange'     — обмін на інший товар
  -- 'credit'       — залишок на рахунку клієнта (бонус/кредит)
  -- 'warranty_supplier' — по гарантії через постачальника
  reason            TEXT NOT NULL,
  -- 'wrong_part'   — не та деталь
  -- 'defective'    — бракована
  -- 'changed_mind' — передумав
  -- 'warranty'     — гарантійний випадок
  -- 'other'        — інше
  reason_note       TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  -- draft / approved / rejected / completed
  refund_method     TEXT,           -- 'cash' / 'terminal' / 'debt_reduction'
  refund_kopecks    INTEGER DEFAULT 0,
  stock_action      TEXT NOT NULL DEFAULT 'return_to_stock',
  -- return_to_stock — повернути на склад
  -- write_off       — списати як брак
  -- send_to_supplier— відправити постачальнику
  warranty_claim_id UUID REFERENCES supplier_warranty_claims(id),
  approved_by       UUID REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  note              TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

-- Позиції повернення
CREATE TABLE customer_return_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  return_id         UUID NOT NULL REFERENCES customer_returns(id),
  product_id        UUID NOT NULL REFERENCES products(id),
  sale_item_id      UUID REFERENCES sale_items(id),    -- з якого рядка продажу
  quantity          NUMERIC(12,3) NOT NULL,
  unit_price_kopecks INTEGER NOT NULL,                 -- ціна за якою продали
  total_kopecks     INTEGER NOT NULL,
  condition         TEXT NOT NULL DEFAULT 'good',
  -- good / damaged / opened_packaging / defective
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Бізнес-правила

### Коли дозволено повернення

```
1. Товар куплений у нас (є sale_id або order_id в системі)
2. Строк не минув:
   - Звичайне повернення: до 14 днів з дати продажу (налаштовується)
   - Гарантійне: до 12 місяців (або строк гарантії виробника)
3. Товар не відноситься до заборонених для повернення
   (налаштовується категорія "без повернення")

Якщо умови не виконані → попередження, але дозволити власнику Override з PIN
```

### Що відбувається з товаром після повернення

```
return_to_stock:
  → inventory_receipts запис типу 'customer_return'
  → кількість товару на складі збільшується
  → якщо товар був зі стану 'немає' — стає 'є'

write_off:
  → inventory_writeoffs запис типу 'defective_return'
  → кількість НЕ збільшується
  → фіксується як збиток

send_to_supplier:
  → створюється supplier_warranty_claim автоматично
  → товар резервується в статус 'sent_to_supplier' (не на складі)
```

### Що відбувається з грошима

```
refund / cash:
  → cash_operations запис типу 'customer_return_refund'
  → зменшує готівку в касі

refund / terminal:
  → payments запис типу 'return'
  → фіксується для звірки

debt_reduction:
  → зменшує борг клієнта на суму повернення
  → або додає кредит на майбутні покупки
```

---

## Флоу: Звичайне повернення

```
1. Менеджер → "Повернення" → ввести номер чека або знайти клієнта
2. Система показує позиції продажу → вибрати що повертають
3. Вказати причину і кількість (може бути часткове повернення)
4. Вибрати: гроші назад / обмін / кредит
5. Вибрати: товар на склад / списати / до постачальника
6. Якщо гроші → вибрати готівка / термінал / зменшення боргу
7. [Підтвердити] → касир бачить суму до виплати
8. Роздрукувати акт повернення
```

## Флоу: Гарантійний випадок через постачальника

```
1. Менеджер → "Повернення" → тип "Гарантія через постачальника"
2. Вибрати товар і продаж
3. Описати дефект
4. Система автоматично:
   - Створює customer_return зі статусом 'draft'
   - Створює supplier_warranty_claim
   - Зв'язує їх між собою
5. Власник вирішує: клієнту гроші одразу чи чекаємо постачальника
   - Одразу → виплатити і чекати повернення від постачальника
   - Чекати → клієнт чекає рішення, статус 'pending'
6. Коли постачальник вирішив → закрити обидва записи
```

---

## API ендпоінти

```
POST /api/returns/check-eligibility
  body: { sale_id | order_id, product_id, quantity }
  → { eligible: true/false, reason, days_remaining }

POST /api/returns
  body: { customer_id, sale_id, items[], return_type, reason, stock_action, refund_method }
  → { return_id, refund_kopecks }

GET  /api/returns                 — список повернень (фільтри: дата, статус, клієнт)
GET  /api/returns/:id             — деталі повернення
PUT  /api/returns/:id/approve     — підтвердити (Owner/Admin)
PUT  /api/returns/:id/complete    — завершити (гроші видані)
PUT  /api/returns/:id/reject      — відхилити з причиною
```

---

## UI: Екран повернення

```
┌─────────────────────────────────────────────────────────┐
│ ПОВЕРНЕННЯ ВІД КЛІЄНТА                                  │
│ Чек/Замовлення: [Ввести номер або 🔍 знайти клієнта]    │
├─────────────────────────────────────────────────────────┤
│ Клієнт: Петренко Василь  |  Чек #1234  |  10.03.2025   │
│ (14 днів — до 24.03.2025 ✓ в строку)                   │
├─────────────────────────────────────────────────────────┤
│ ПОЗИЦІЇ ПРОДАЖУ:                                        │
│ ☑ Фільтр Mann W712    x1   450 грн   [повертати: 1 ▼] │
│ ☐ Масло Castrol 5W40  x1   680 грн                     │
├─────────────────────────────────────────────────────────┤
│ Причина: [Не та деталь ▼]                               │
│ Коментар: [________________________]                    │
│                                                         │
│ Що робити з товаром: (•) На склад  ( ) Списати  ( ) До пост.
│ Повернення грошей:   (•) Готівка   ( ) Термінал ( ) Борг
│                                                         │
│ Сума до повернення: 450 грн                             │
│ [Скасувати]                              [Підтвердити →]│
└─────────────────────────────────────────────────────────┘
```

---

## Звіт повернень

```
За місяць: 12 повернень на 4 200 грн
Топ причини:
  Не та деталь:    5 (42%)
  Брак:            4 (33%)
  Передумав:       3 (25%)

Топ товари що повертають:
  Фільтр Mann W712  — 3 рази
  Гальмівні колодки — 2 рази
```
