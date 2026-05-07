# SPEC: Ціноутворення

## Концепція

Кожен товар має одну базову ціну (роздрібна). Для різних клієнтів застосовуються цінові рівні зі знижками від базової ціни. Захист мінімальної маржі — обов'язковий.

---

## Таблиці БД

```sql
-- Цінові рівні (рівень клієнта)
CREATE TABLE price_tiers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  name          TEXT NOT NULL,                    -- 'Роздріб', 'Опт', 'СТО'
  discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,  -- знижка від базової ціни %
  is_default    BOOLEAN NOT NULL DEFAULT false,   -- роздріб = default
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- Прив'язка рівня до клієнта
-- Додати поле до таблиці customers:
ALTER TABLE customers
  ADD COLUMN price_tier_id UUID REFERENCES price_tiers(id),
  ADD COLUMN personal_discount_pct NUMERIC(5,2) DEFAULT 0; -- індивідуальна знижка поверх рівня

-- Мінімальна ціна на товар (захист маржі)
-- Додати поля до таблиці products:
ALTER TABLE products
  ADD COLUMN purchase_price_kopecks  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN min_price_kopecks       INTEGER NOT NULL DEFAULT 0, -- мінімум до якого можна знижувати
  ADD COLUMN markup_pct              NUMERIC(5,2);               -- наценка % від закупівельної

-- Об'ємні знижки (чим більше — тим дешевше)
CREATE TABLE volume_discounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  price_tier_id   UUID REFERENCES price_tiers(id), -- NULL = для всіх рівнів
  product_id      UUID REFERENCES products(id),     -- NULL = для всіх товарів
  category_id     UUID REFERENCES categories(id),   -- NULL = для всіх категорій
  min_quantity    NUMERIC(12,3) NOT NULL,
  discount_pct    NUMERIC(5,2) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- Наценки за категорією (автоматична ціна при додаванні товару)
CREATE TABLE category_markups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  category_id   UUID NOT NULL REFERENCES categories(id),
  markup_pct    NUMERIC(5,2) NOT NULL,  -- % наценки від закупівельної
  min_markup_pct NUMERIC(5,2) NOT NULL DEFAULT 0, -- мінімальна наценка
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Логіка розрахунку ціни при продажу

### Алгоритм (виконується в сервісі при додаванні товару в чек)

```
1. Взяти базову ціну товару: price_kopecks

2. Визначити рівень клієнта:
   - Якщо клієнт прив'язаний до чеку → взяти його price_tier_id
   - Якщо клієнта немає → взяти price_tier з is_default = true (роздріб)

3. Застосувати знижку рівня:
   tier_price = price_kopecks * (1 - price_tier.discount_pct / 100)

4. Застосувати індивідуальну знижку клієнта (якщо є):
   personal_price = tier_price * (1 - customer.personal_discount_pct / 100)

5. Перевірити об'ємну знижку (якщо кількість >= поріг):
   volume_price = personal_price * (1 - volume_discount.discount_pct / 100)

6. Перевірити мінімум:
   final_price = MAX(volume_price, product.min_price_kopecks)

7. Повернути final_price як ціну продажу
```

### Пріоритет знижок
```
Базова ціна
  → Рівень клієнта (tier)
    → Індивідуальна знижка клієнта
      → Об'ємна знижка
        → Ручна знижка касира (обмежена min_price)
          = Фінальна ціна (не нижче min_price_kopecks)
```

---

## Логіка наценки

### Автоматичний розрахунок при створенні товару

```
Коли задається purchase_price_kopecks (закупівельна) і категорія:
  1. Взяти markup_pct з category_markups для цієї категорії
  2. price_kopecks = purchase_price_kopecks * (1 + markup_pct / 100)
  3. min_price_kopecks = purchase_price_kopecks * (1 + min_markup_pct / 100)
  4. Показати ціну та запитати підтвердження (касир може змінити)
```

### Відображення маржі (тільки для Owner/Admin)
```
При перегляді товару або позиції в чеку:
  Закупівельна:  [purchase_price] грн
  Ціна продажу:  [price] грн
  Маржа:         [price - purchase_price] грн ([markup_pct]%)
```

---

## Захист мінімальної ціни

### При ручній знижці в POS

```
Касир намагається зробити знижку:
  IF final_price < product.min_price_kopecks:
    → Показати попередження: "Ціна нижче мінімуму. Потрібен PIN власника"
    → Запросити PIN (owner_pin з налаштувань тенанта)
    → Якщо PIN правильний → дозволити знижку і зафіксувати в логу
    → Якщо PIN неправильний → відмовити
    → Зафіксувати в audit_log: хто, коли, товар, ціна, чи підтверджено
```

### Поле pin в налаштуваннях
```sql
ALTER TABLE tenants
  ADD COLUMN owner_pin VARCHAR(6),           -- PIN для підтвердження знижок нижче мін.
  ADD COLUMN min_price_override_requires_pin BOOLEAN DEFAULT true;
```

---

## API ендпоінти

```
GET  /api/price-tiers                    — список рівнів
POST /api/price-tiers                    — створити рівень
PUT  /api/price-tiers/:id               — оновити рівень
DEL  /api/price-tiers/:id               — видалити рівень

GET  /api/price-tiers/:id/products      — товари з цінами для цього рівня
POST /api/pricing/calculate             — розрахувати ціну для клієнта + товар + кількість

GET  /api/category-markups              — наценки по категоріях
PUT  /api/category-markups/:categoryId  — встановити наценку для категорії

GET  /api/volume-discounts              — об'ємні знижки
POST /api/volume-discounts              — створити правило
DEL  /api/volume-discounts/:id          — видалити правило
```

### POST /api/pricing/calculate — тіло запиту
```json
{
  "product_id": "uuid",
  "customer_id": "uuid | null",
  "quantity": 3,
  "manual_discount_pct": 5
}
```

### Відповідь
```json
{
  "base_price_kopecks": 45000,
  "tier_price_kopecks": 40500,
  "volume_price_kopecks": 38700,
  "manual_discount_kopecks": 1935,
  "final_price_kopecks": 36765,
  "min_price_kopecks": 30000,
  "below_minimum": false,
  "margin_pct": 22.5,
  "applied_tier": "СТО",
  "applied_volume_discount_pct": 4.5
}
```

---

## UI: Налаштування цінових рівнів (адмінка)

```
Рівні цін:
┌──────────────┬───────────┬──────────────────────────────┐
│ Назва        │ Знижка %  │ Дії                          │
├──────────────┼───────────┼──────────────────────────────┤
│ Роздріб (=)  │ 0%        │ [за замовчуванням]           │
│ СТО          │ 10%       │ [Редагувати] [Видалити]      │
│ Оптовик      │ 18%       │ [Редагувати] [Видалити]      │
│ VIP клієнт   │ 25%       │ [Редагувати] [Видалити]      │
└──────────────┴───────────┴──────────────────────────────┘
[+ Додати рівень]

Наценки по категоріях:
┌──────────────────┬──────────┬──────────────┐
│ Категорія        │ Наценка  │ Мінімальна   │
├──────────────────┼──────────┼──────────────┤
│ Фільтри          │ 45%      │ 20%          │
│ Масла            │ 30%      │ 15%          │
│ Гальмівна система│ 50%      │ 25%          │
└──────────────────┴──────────┴──────────────┘
```

---

## UI: Картка клієнта — ціновий рівень

```
Ціновий рівень: [СТО ▼]
Індивідуальна знижка: [5] %
Ліміт боргу: [10 000] грн

При відкритті чеку для цього клієнта — система автоматично
застосовує ціни СТО + індивідуальну знижку 5%.
```
