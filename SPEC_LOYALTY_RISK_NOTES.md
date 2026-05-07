# SPEC: Лояльність, ризик-профіль, нотатки клієнта

## Модуль 1: Програма лояльності (бонуси)

### Концепція
Клієнт накопичує бонуси за кожну покупку. Бонуси списуються при наступних покупках.
Бонус = реальні гроші (1 бонус = 1 гривня знижки).

### Таблиці БД

```sql
-- Налаштування програми лояльності (в таблиці tenants або окремо)
CREATE TABLE loyalty_settings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) UNIQUE,
  is_enabled            BOOLEAN NOT NULL DEFAULT false,
  accrual_pct           NUMERIC(5,2) NOT NULL DEFAULT 2.0, -- % від суми покупки
  max_redeem_pct        NUMERIC(5,2) NOT NULL DEFAULT 30.0, -- макс. % покупки бонусами
  expiry_days           INT DEFAULT NULL,                   -- NULL = не згорають
  min_purchase_kopecks  INTEGER DEFAULT 0,                  -- мін. сума для нарахування
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Транзакції бонусів
CREATE TABLE loyalty_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  customer_id     UUID NOT NULL REFERENCES customers(id),
  type            TEXT NOT NULL,
  -- 'accrual'    — нарахування за покупку
  -- 'redemption' — списання при оплаті
  -- 'expiry'     — згоряння
  -- 'manual_add' — ручне нарахування (власник)
  -- 'manual_sub' — ручне списання (власник)
  amount_kopecks  INTEGER NOT NULL,  -- позитивне = нарахування, негативне = списання
  sale_id         UUID REFERENCES sales(id),
  order_id        UUID REFERENCES orders(id),
  note            TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Додати до customers:
ALTER TABLE customers
  ADD COLUMN bonus_balance_kopecks INTEGER NOT NULL DEFAULT 0;
```

### Логіка нарахування

```
При завершенні продажу (sale.status = 'completed'):
  IF loyalty_settings.is_enabled:
    IF sale.total_kopecks >= loyalty_settings.min_purchase_kopecks:
      accrual = ROUND(sale.total_kopecks * accrual_pct / 100)
      INSERT INTO loyalty_transactions (type='accrual', amount=accrual)
      UPDATE customers SET bonus_balance_kopecks += accrual

При списанні бонусів у POS:
  max_redeem = ROUND(sale.total_kopecks * max_redeem_pct / 100)
  actual_redeem = MIN(requested_redeem, max_redeem, customer.bonus_balance_kopecks)
  INSERT INTO loyalty_transactions (type='redemption', amount=-actual_redeem)
  UPDATE customers SET bonus_balance_kopecks -= actual_redeem
  sale.discount_kopecks += actual_redeem
```

### UI в POS

```
Клієнт прив'язаний до чеку:
  Петренко Василь  |  Бонуси: 245 грн  |  [Списати бонуси]

Після натискання [Списати бонуси]:
  Доступно: 245 грн
  Максимум до списання (30% від суми): 152 грн
  Списати: [152] грн
  [Підтвердити]
```

---

## Модуль 2: Ризик-профіль клієнта

### Концепція
Автоматичні прапори ризику на основі поведінки клієнта.
Не блокують продаж — але попереджають менеджера.

### Таблиці БД

```sql
-- Додати до customers:
ALTER TABLE customers
  ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'normal',
  -- normal / attention / high_risk / blocked
  ADD COLUMN risk_note  TEXT,            -- пояснення від власника
  ADD COLUMN risk_updated_at TIMESTAMPTZ,
  ADD COLUMN risk_updated_by UUID REFERENCES users(id);
```

### Автоматичні тригери (перевіряються при відкритті картки клієнта)

```
→ HIGH RISK автоматично:
  - Борг > 30 днів і > 1000 грн
  - Більше 3 повернень за 90 днів без поважної причини
  - Платіж повернений банком (NSF) — якщо фіксується вручну

→ ATTENTION автоматично:
  - Борг 14-30 днів
  - 2 повернення за 30 днів
  - Замовлення скасовані 2+ рази поспіль

→ BLOCKED:
  - Тільки вручну власником
  - Продаж заблокований повністю (тільки готівка або повна передоплата)
```

### UI: Попередження при відкритті клієнта

```
При відкритті картки клієнта або прив'язці до чеку:

⚠️ УВАГА: Клієнт має прострочений борг 42 дні / 2 400 грн
   [Переглянути борги] [Закрити]

🔴 РИЗИК: 4 повернення за 60 днів. Рекомендуємо повну передоплату.
   Нотатка власника: "Постійно повертає без причини"
   [Зрозуміло]
```

### API

```
GET  /api/customers/:id/risk           — поточний ризик-профіль
PUT  /api/customers/:id/risk           — встановити вручну (Owner/Admin)
POST /api/customers/risk/recalculate   — перерахувати всіх (cron або вручну)
```

---

## Модуль 3: Нотатки до клієнта (прилипала)

### Концепція
Швидкі нотатки які бачить будь-який менеджер при відкритті картки.
Не плутати з повною CRM-ймою — це просто "стікер на моніторі".

### Таблиці БД

```sql
CREATE TABLE customer_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  text        TEXT NOT NULL,             -- текст нотатки
  is_pinned   BOOLEAN NOT NULL DEFAULT false, -- відображати при відкритті
  color       TEXT DEFAULT 'yellow',     -- yellow / red / green / blue
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
```

### Приклади нотаток

```
🟡 "Завжди торгується — дати максимум 5% знижку, не більше"
🔴 "Платить тільки безготівково, НЕ в борг"
🟢 "VIP клієнт, власник СТО Профі-Авто, завжди великі замовлення"
🔵 "Не дзвонити до 10:00, краще писати в Telegram"
```

### UI: Відображення в картці клієнта

```
┌──────────────────────────────────────────────────────┐
│ Петренко Василь                          [Редагувати]│
│ +380 67 xxx xxxx  |  СТО Рівень          ризик: ● ok│
├──────────────────────────────────────────────────────┤
│ 📌 Завжди торгується. Максимум 5% знижка.            │
│ 📌 Дзвонити тільки після 10:00           [+ нотатка] │
├──────────────────────────────────────────────────────┤
│ Бонуси: 245 грн   Борг: 0 грн    Покупок: 48        │
└──────────────────────────────────────────────────────┘
```

### UI: Попап при відкритті клієнта в POS

```
Якщо є закріплена нотатка → показати popup при прив'язці клієнта до чеку:

┌────────────────────────────────────┐
│ 📌 Нотатка по клієнту             │
│ "Завжди торгується.                │
│  Максимум знижка 5%"               │
│                                    │
│              [Зрозуміло]           │
└────────────────────────────────────┘
```

### API

```
GET  /api/customers/:id/notes          — список нотаток
POST /api/customers/:id/notes          — створити нотатку
PUT  /api/customers/:id/notes/:nid     — редагувати / закріпити
DEL  /api/customers/:id/notes/:nid     — видалити
```

---

## Модуль 4: Автоматичні сповіщення клієнту (Telegram тригери)

### Тригери (Expansion фаза)

```
TRIGGER: order.status змінився на 'arrived'
  → Надіслати клієнту: "Ваша деталь [назва] прибула! Чекаємо вас. Форсаж"

TRIGGER: order.expected_date + 2 дні, статус все ще 'ordered'
  → Повідомити менеджера: "Замовлення #123 для Петренко прострочено на 2 дні"

TRIGGER: customer.balance_kopecks < -5000 і > 30 днів
  → Повідомити менеджера: "Борг Петренко 2500 грн вже 32 дні"

TRIGGER: order.status = 'issued' (видано)
  → Через 7 днів: "Все добре з деталлю? Якщо є питання — пишіть! Форсаж"
  (тільки якщо клієнт підключений у Telegram)
```

### Таблиця тригерів

```sql
CREATE TABLE notification_triggers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  event_type    TEXT NOT NULL,    -- 'order_arrived' / 'order_overdue' / 'debt_overdue'
  is_enabled    BOOLEAN NOT NULL DEFAULT true,
  delay_hours   INT DEFAULT 0,    -- затримка перед відправкою
  template      TEXT NOT NULL,    -- шаблон повідомлення з {змінними}
  recipient     TEXT NOT NULL DEFAULT 'customer', -- 'customer' / 'manager' / 'owner'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
