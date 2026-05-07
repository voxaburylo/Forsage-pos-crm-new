# SPEC: Журнал постачальників

## Концепція

Постачальник в системі — це довідник з повною історією взаємодій.
Ніякого автоматичного замовлення — тільки фіксація фактів:
що купили, що повернули, які гарантійні випадки були.

---

## Таблиці БД

```sql
-- Журнал закупівель у постачальника
CREATE TABLE supplier_purchases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  supplier_id     UUID NOT NULL REFERENCES suppliers(id),
  receipt_id      UUID REFERENCES inventory_receipts(id), -- якщо пов'язано з прийманням
  invoice_number  TEXT,                    -- номер накладної від постачальника
  invoice_date    DATE NOT NULL,
  total_kopecks   INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- Позиції закупівлі
CREATE TABLE supplier_purchase_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  supplier_purchase_id  UUID NOT NULL REFERENCES supplier_purchases(id),
  product_id            UUID REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,   -- назва на момент закупівлі
  article_snapshot      TEXT,            -- артикул на момент закупівлі
  quantity              NUMERIC(12,3) NOT NULL,
  unit_price_kopecks    INTEGER NOT NULL,
  total_kopecks         INTEGER NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Повернення постачальнику
CREATE TABLE supplier_returns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  supplier_id     UUID NOT NULL REFERENCES suppliers(id),
  purchase_id     UUID REFERENCES supplier_purchases(id), -- повернення з якої закупівлі
  return_date     DATE NOT NULL,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending / sent / accepted / rejected / refunded
  refund_kopecks  INTEGER DEFAULT 0,
  note            TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- Позиції повернення
CREATE TABLE supplier_return_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id),
  supplier_return_id   UUID NOT NULL REFERENCES supplier_returns(id),
  product_id           UUID REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  quantity             NUMERIC(12,3) NOT NULL,
  unit_price_kopecks   INTEGER NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Гарантійні випадки
CREATE TABLE supplier_warranty_claims (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  supplier_id     UUID NOT NULL REFERENCES suppliers(id),
  product_id      UUID REFERENCES products(id),
  purchase_id     UUID REFERENCES supplier_purchases(id),
  -- від клієнта (якщо гарантія прийшла від клієнта через нас)
  customer_id     UUID REFERENCES customers(id),
  sale_id         UUID REFERENCES sales(id),
  claim_date      DATE NOT NULL,
  description     TEXT NOT NULL,          -- опис проблеми
  status          TEXT NOT NULL DEFAULT 'open',
  -- open / sent_to_supplier / waiting / resolved_replacement
  -- resolved_refund / resolved_rejected / closed
  resolution      TEXT,                   -- рішення по гарантії
  resolved_at     TIMESTAMPTZ,
  note            TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
```

---

## Логіка статусів

### Повернення постачальнику
```
pending    → Зафіксовано, ще не відправлено
sent       → Відправлено постачальнику (фізично або документально)
accepted   → Постачальник прийняв повернення
rejected   → Постачальник відмовив
refunded   → Гроші повернуто або зараховано в рахунок наступної закупівлі
```

### Гарантійний випадок
```
open               → Відкрито, аналізується
sent_to_supplier   → Передано постачальнику
waiting            → Чекаємо рішення постачальника
resolved_replacement → Вирішено: замінено товар
resolved_refund    → Вирішено: повернуто гроші
resolved_rejected  → Постачальник відмовив у гарантії
closed             → Закрито
```

---

## API ендпоінти

### Закупівлі
```
GET  /api/suppliers/:id/purchases          — список закупівель у постачальника
POST /api/suppliers/:id/purchases          — зафіксувати закупівлю
GET  /api/suppliers/:id/purchases/:pid     — деталі закупівлі
PUT  /api/suppliers/:id/purchases/:pid     — редагувати
```

### Повернення
```
GET  /api/suppliers/:id/returns            — список повернень
POST /api/suppliers/:id/returns            — зафіксувати повернення
PUT  /api/suppliers/:id/returns/:rid       — оновити статус
```

### Гарантія
```
GET  /api/suppliers/:id/warranty-claims    — список гарантійних випадків
POST /api/suppliers/:id/warranty-claims    — відкрити гарантійний випадок
PUT  /api/suppliers/:id/warranty-claims/:wid — оновити статус / рішення
```

### Зведення по постачальнику
```
GET  /api/suppliers/:id/summary
→ {
    total_purchased_kopecks: 1250000,
    total_returned_kopecks: 45000,
    open_warranty_claims: 2,
    last_purchase_date: "2025-03-15",
    purchase_count_90d: 12
  }
```

---

## UI: Картка постачальника

```
┌─────────────────────────────────────────────────────────┐
│ АВТОРОС                              [Редагувати]       │
│ Контакт: Сергій +380 67 xxx xxxx                        │
│ Сайт: avtoros.ua                                        │
├─────────────────┬─────────────────┬─────────────────────┤
│ Закупівель      │ Повернень        │ Гарантій відкритих  │
│ 48 на 312к грн  │ 3 на 12к грн    │ 2                   │
├─────────────────┴─────────────────┴─────────────────────┤
│ [Закупівлі] [Повернення] [Гарантія]      [+ Додати]     │
├─────────────────────────────────────────────────────────┤
│ ЗАКУПІВЛІ                                               │
│ 15.03.2025  Накл. №АР-4521   38 поз.   12 400 грн  [>] │
│ 02.03.2025  Накл. №АР-4489   15 поз.    4 200 грн  [>] │
│ 18.02.2025  Накл. №АР-4401   52 поз.   18 900 грн  [>] │
├─────────────────────────────────────────────────────────┤
│ ГАРАНТІЙНІ ВИПАДКИ                                      │
│ ● Фільтр Mann W712 — відправлено — чекаємо 12.03  [>]  │
│ ● Ремінь Gates — відкрито — 08.03.2025            [>]  │
└─────────────────────────────────────────────────────────┘
```

---

## UI: Форма фіксації закупівлі

```
Постачальник: [вже вибраний з картки]
Номер накладної: [АР-4521______]
Дата накладної:  [15.03.2025]
Пов'язати з прийманням: [Приймання #42 від 15.03 ▼] (необов'язково)

Позиції: (або імпортувати з прийману)
┌──────────────────────┬────────┬─────────────┬──────────┐
│ Товар                │ Кіл-ть │ Ціна закуп. │ Сума     │
├──────────────────────┼────────┼─────────────┼──────────┤
│ Фільтр Mann W712     │ 10     │ 120 грн     │ 1200 грн │
│ [+ додати позицію]   │        │             │          │
└──────────────────────┴────────┴─────────────┴──────────┘
Разом: 1200 грн
Нотатка: [___________________]
[Зберегти]
```

---

## Зв'язок із прийманням товару

Коли оператор проводить приймання товару (`inventory_receipt`):
- Система пропонує: "Зафіксувати як закупівлю у постачальника?"
- Якщо так → автоматично створює `supplier_purchase` з позиціями з накладної
- Закупівельні ціни беруться з позицій накладної (`unit_price_kopecks`)
- Ручне додавання закупівлі також доступне незалежно від приймання

---

## Звіт: Статистика постачальника

```
За період: [01.01.2025 — сьогодні]

Постачальник | Закуплено грн | Повернуто грн | Гарантій | Процент браку
─────────────┼───────────────┼───────────────┼──────────┼──────────────
Авторос      │ 312 400       │ 12 000        │ 2 відкр. │ 3.8%
Феро-Луцьк   │ 145 200       │ 0             │ 0        │ 0%
Автодеталь   │ 89 500        │ 4 500         │ 1 закр.  │ 5.0%
```
